using System.Text.Json;

namespace QaNxt.Infrastructure.Ai.Providers;

/// <summary>Answers quality questions from the records, citing what it counted.
///
/// This is the engine behind "answers come from QA NXT's built-in rules". A model provider is
/// meant to be optional, which means this has to be able to answer a real question on its
/// own rather than being a placeholder that admits defeat until somebody supplies an API key.
///
/// Two things were wrong with the first version, and both made it look broken rather than
/// honest:
///
///  - It gave up whenever the window held no executions. "There are no completed executions,
///    so there is nothing to draw conclusions from" was the answer to every question on a
///    project that had been set up but not yet run, which is exactly when somebody is most
///    likely to be exploring the feature. It is true and useless, and it is indistinguishable
///    from a fault. There is almost always something to say: what exists, whether the last
///    crawl worked, whether anything is authorized for security testing, and what to do next.
///  - Intent was a chain of <c>Contains</c> checks over five phrases, so "which tests are
///    slowest" and "are we safe to release" both fell through to a generic pass-rate line.
///
/// It still reports only what the numbers support, and still says so when they support
/// nothing in particular. An invented trend is worse than an admission; so is a dead end.
/// </summary>
internal static class LocalInsightWriter
{
    /// <summary>What a question is asking about. Scored rather than first-match, because
    /// "which slow tests are flaky" is about both and the better answer is the stronger
    /// signal, not whichever branch happened to be written first.</summary>
    private enum Intent
    {
        Overview, Stability, ApplicationDefects, Healing, Priority,
        Performance, Security, Coverage, Trend, ReleaseReadiness
    }

    /// <summary>Phrases that signal each intent, with a weight. Longer, more specific phrases
    /// score higher so "ready to release" beats the bare word "test".</summary>
    private static readonly (Intent Intent, string Phrase, int Weight)[] Signals =
    {
        (Intent.Stability, "unstable", 3), (Intent.Stability, "flaky", 3),
        (Intent.Stability, "flakiness", 3), (Intent.Stability, "intermittent", 3),
        (Intent.Stability, "inconsistent", 2), (Intent.Stability, "reliable", 2),

        (Intent.ApplicationDefects, "application defect", 4), (Intent.ApplicationDefects, "real bug", 4),
        (Intent.ApplicationDefects, "defect", 3), (Intent.ApplicationDefects, "genuine", 2),
        (Intent.ApplicationDefects, "broken", 2), (Intent.ApplicationDefects, "regression", 2),

        (Intent.Healing, "heal", 3), (Intent.Healing, "healed", 3),
        (Intent.Healing, "self-healing", 4), (Intent.Healing, "locator", 2),
        (Intent.Healing, "selector", 2), (Intent.Healing, "repair", 2),

        (Intent.Priority, "investigate", 3), (Intent.Priority, "priority", 3),
        (Intent.Priority, "first", 2), (Intent.Priority, "focus", 2),
        (Intent.Priority, "what should", 3), (Intent.Priority, "where should", 3),
        (Intent.Priority, "most important", 3), (Intent.Priority, "next step", 3),

        (Intent.Performance, "slow", 3), (Intent.Performance, "slowest", 4),
        (Intent.Performance, "fast", 2), (Intent.Performance, "duration", 3),
        (Intent.Performance, "performance", 3), (Intent.Performance, "how long", 3),
        (Intent.Performance, "speed", 2), (Intent.Performance, "timing", 2),

        (Intent.Security, "security", 4), (Intent.Security, "vulnerab", 4),
        (Intent.Security, "owasp", 4), (Intent.Security, "cve", 3),
        (Intent.Security, "xss", 3), (Intent.Security, "injection", 3),
        (Intent.Security, "exposed", 2), (Intent.Security, "authoriz", 2),

        (Intent.Coverage, "coverage", 4), (Intent.Coverage, "covered", 3),
        (Intent.Coverage, "how many test", 3), (Intent.Coverage, "gaps", 3),
        (Intent.Coverage, "untested", 3), (Intent.Coverage, "never run", 3),
        (Intent.Coverage, "missing test", 3), (Intent.Coverage, "what do we test", 3),

        (Intent.Trend, "trend", 4), (Intent.Trend, "trending", 4),
        (Intent.Trend, "improving", 3), (Intent.Trend, "getting worse", 3),
        (Intent.Trend, "over time", 3), (Intent.Trend, "compared", 2),

        (Intent.ReleaseReadiness, "release", 4), (Intent.ReleaseReadiness, "ship", 4),
        (Intent.ReleaseReadiness, "safe to", 4), (Intent.ReleaseReadiness, "ready", 3),
        (Intent.ReleaseReadiness, "go live", 4), (Intent.ReleaseReadiness, "deploy", 3),
        (Intent.ReleaseReadiness, "sign off", 3)
    };

    public static string Write(JsonElement context)
    {
        var question = LocalJson.String(context, "question") ?? string.Empty;
        var intent = Classify(question);

        var totals = Property(context, "totals");
        var coverage = Property(context, "coverage");
        var security = Property(context, "security");
        var executions = LocalJson.Int(totals, "executions");

        var findings = new List<object>();
        var insufficient = false;
        string answer;

        // A project with nothing run is not a dead end. It is the most common state for
        // somebody asking their first question, and there is always something true to say.
        if (executions == 0 && intent is not (Intent.Security or Intent.Coverage))
        {
            answer = NothingRunYet(context, coverage, security, findings, out insufficient);
            return Emit(answer, insufficient, findings);
        }

        switch (intent)
        {
            case Intent.Stability:
                answer = Stability(context, findings, out insufficient);
                break;
            case Intent.ApplicationDefects:
                answer = ApplicationDefects(context, findings);
                break;
            case Intent.Healing:
                answer = Healing(context, findings);
                break;
            case Intent.Priority:
                answer = Priority(context, findings);
                break;
            case Intent.Performance:
                answer = Performance(context, totals, findings, out insufficient);
                break;
            case Intent.Security:
                answer = Security(security, findings, out insufficient);
                break;
            case Intent.Coverage:
                answer = Coverage(coverage, totals, findings, out insufficient);
                break;
            case Intent.Trend:
                answer = Trend(context, totals, findings, out insufficient);
                break;
            case Intent.ReleaseReadiness:
                answer = ReleaseReadiness(context, totals, security, findings, out insufficient);
                break;
            default:
                answer = Overview(context, totals, coverage, findings);
                break;
        }

        return Emit(answer, insufficient, findings);
    }

    // ---- Intent ------------------------------------------------------------

    private static Intent Classify(string question)
    {
        var lowered = question.ToLowerInvariant();
        var scores = new Dictionary<Intent, int>();

        foreach (var (intent, phrase, weight) in Signals)
        {
            if (!lowered.Contains(phrase, StringComparison.Ordinal)) continue;
            scores[intent] = scores.GetValueOrDefault(intent) + weight;
        }

        if (scores.Count == 0) return Intent.Overview;

        var best = scores.OrderByDescending(pair => pair.Value).ThenBy(pair => pair.Key).First();
        return best.Value >= 3 ? best.Key : Intent.Overview;
    }

    // ---- Handlers ----------------------------------------------------------

    /// <summary>The answer when nothing has run. Reports what exists and names the next step.
    ///
    /// <c>insufficientEvidence</c> is still set: nothing here is a conclusion about quality.
    /// But a user asking their first question gets the state of their project and what to do,
    /// instead of a sentence that reads like the feature is broken.</summary>
    private static string NothingRunYet(
        JsonElement context, JsonElement coverage, JsonElement security,
        List<object> findings, out bool insufficient)
    {
        insufficient = true;

        var applications = LocalJson.Int(coverage, "applications");
        var pages = LocalJson.Int(coverage, "pagesDiscovered");
        var testCases = LocalJson.Int(coverage, "testCases");
        var enabled = LocalJson.Int(coverage, "enabledTestCases");
        var discovery = Property(context, "lastDiscovery");

        var parts = new List<string>();
        var next = new List<string>();

        if (applications == 0)
        {
            parts.Add("No application is registered yet");
            next.Add("register one on the Applications page");
        }
        else
        {
            parts.Add($"{applications} application(s) registered");
            findings.Add(Finding(
                $"{applications} application(s) exist and {pages} page(s) have been discovered across them.",
                new[] { "dashboard:coverage" }, 100));
        }

        // The most common reason there is nothing to run, and it sits one table away from the
        // question. Naming it is the difference between a useful answer and a shrug.
        if (discovery.ValueKind == JsonValueKind.Object)
        {
            var status = LocalJson.String(discovery, "status") ?? "unknown";
            var discoveredPages = LocalJson.Int(discovery, "pagesDiscovered");
            var error = LocalJson.String(discovery, "errorMessage");

            if (string.Equals(status, "Failed", StringComparison.OrdinalIgnoreCase))
            {
                parts.Add("and the most recent discovery run failed");
                next.Add("fix the discovery failure and crawl again");
                findings.Add(Finding(
                    $"The last discovery run failed: {Truncate(error, 400) ?? "no reason was recorded"}",
                    new[] { $"discoveryRun:{LocalJson.String(discovery, "id")}" }, 100));
            }
            else if (string.Equals(status, "Running", StringComparison.OrdinalIgnoreCase)
                  || string.Equals(status, "Queued", StringComparison.OrdinalIgnoreCase))
            {
                parts.Add($"and a discovery run is still {status.ToLowerInvariant()}");
                next.Add("wait for the crawl to finish, then generate tests");
            }
            else if (discoveredPages > 0 && testCases == 0)
            {
                parts.Add($"and {discoveredPages} page(s) have been explored but no tests generated from them");
                next.Add("generate tests on the Tests page");
            }
        }
        else if (applications > 0)
        {
            parts.Add("and nothing has been explored yet");
            next.Add("run discovery against an application");
        }

        if (testCases > 0)
        {
            parts.Add($"{testCases} test case(s) exist ({enabled} enabled) and none has run in this window");
            next.Add("run the suite");
            findings.Add(Finding(
                $"{testCases} test case(s) exist, {enabled} enabled, with no executions in the window.",
                new[] { "dashboard:coverage" }, 100));
        }

        var securityNote = LocalJson.Int(security, "applications") > 0
                        && LocalJson.Int(security, "applicationsNotAuthorized") > 0
            ? $" {LocalJson.Int(security, "applicationsNotAuthorized")} application(s) are not authorized for"
              + " security testing, so nothing about their security has been established either."
            : string.Empty;

        return $"Nothing has run in this window, so there is no quality verdict to give. What exists: "
             + string.Join(", ", parts) + "."
             + (next.Count > 0 ? $" Next: {string.Join(", then ", next)}." : string.Empty)
             + securityNote;
    }

    private static string Stability(JsonElement context, List<object> findings, out bool insufficient)
    {
        insufficient = false;
        var unstable = LocalJson.Array(context, "unstableTests").ToList();

        if (unstable.Count == 0)
        {
            // An empty unstable list means one of two different things and they must not be
            // reported the same way. Instability can only be observed across repeated runs, so
            // with nothing run twice the honest answer is that the question cannot be answered
            // yet, not that everything is stable.
            var repeated = LocalJson.Int(Property(context, "stability"), "testsRunMoreThanOnce");
            insufficient = repeated == 0;
            return repeated == 0
                ? "Instability can only be seen across repeated runs, and no test in the selected "
                  + "window has run more than once, so there is nothing to judge stability from yet. "
                  + "Run the suite again and ask once a test has a second result to compare."
                : $"No test in the selected window shows unstable behaviour: all {repeated} test(s) "
                  + "that ran more than once produced a consistent result.";
        }

        findings.AddRange(unstable.Take(10).Select(test => Finding(
            $"\"{LocalJson.String(test, "name")}\" changed result {LocalJson.Int(test, "resultChanges")} "
            + $"time(s) across {LocalJson.Int(test, "executionCount")} executions "
            + $"(flakiness {LocalJson.Int(test, "flakinessScore")}/100).",
            new[] { $"testCase:{LocalJson.String(test, "id")}" },
            Math.Min(95, 50 + LocalJson.Int(test, "executionCount") * 5))));

        return $"{unstable.Count} test(s) are behaving inconsistently. The least stable is "
             + $"\"{LocalJson.String(unstable[0], "name")}\" with a flakiness score of "
             + $"{LocalJson.Int(unstable[0], "flakinessScore")}/100. Flaky tests cost more than they "
             + "look: a suite nobody trusts gets ignored when it is right.";
    }

    private static string ApplicationDefects(JsonElement context, List<object> findings)
    {
        var categories = LocalJson.Array(context, "failureCategories").ToList();
        var failing = LocalJson.Array(context, "topFailingTests").ToList();

        var defects = categories.FirstOrDefault(c =>
            LocalJson.String(c, "category") == "applicationDefect");
        var count = defects.ValueKind == JsonValueKind.Object ? LocalJson.Int(defects, "count") : 0;

        findings.AddRange(failing
            .Where(f => LocalJson.String(f, "category") == "applicationDefect")
            .Take(10)
            .Select(f => Finding(
                $"\"{LocalJson.String(f, "name")}\" failed {LocalJson.Int(f, "failureCount")} time(s): "
                + $"{Truncate(LocalJson.String(f, "lastMessage"), 300)}",
                new[] { $"testCase:{LocalJson.String(f, "id")}" }, 75)));

        if (count == 0)
        {
            var others = string.Join(", ", categories
                .Where(c => LocalJson.Int(c, "count") > 0)
                .Select(c => $"{LocalJson.String(c, "category")} ({LocalJson.Int(c, "count")})"));

            return others.Length == 0
                ? "No failure in this window was classified as an application defect, and no failures "
                  + "were classified at all, because nothing failed."
                : "No failure in this window was classified as an application defect. The failures "
                  + $"that occurred were attributed to: {others}. That is a statement about the "
                  + "tests and the environment, not a clean bill of health for the application.";
        }

        return $"{count} failure(s) were classified as likely application defects. These are the ones "
             + "worth taking to the development team first, because the other categories are fixed by "
             + "changing the test or the environment rather than the product.";
    }

    private static string Healing(JsonElement context, List<object> findings)
    {
        var healed = LocalJson.Array(context, "healedTests").ToList();
        var stats = Property(context, "healingStatistics");
        var pending = LocalJson.Int(Property(context, "totals"), "pendingHealingProposals");

        findings.AddRange(healed.Take(10).Select(h => Finding(
            $"\"{LocalJson.String(h, "testCaseName")}\": {LocalJson.String(h, "originalLocator")} -> "
            + $"{LocalJson.String(h, "healedLocator")} at {LocalJson.Int(h, "confidence")}% confidence.",
            new[] { $"healingEvent:{LocalJson.String(h, "id")}" },
            LocalJson.Int(h, "confidence"))));

        if (healed.Count == 0)
        {
            return pending > 0
                ? $"No test was healed in this window, but {pending} healing proposal(s) are waiting for "
                  + "approval. Nothing is applied until somebody approves it, so those tests are still "
                  + "failing in the meantime."
                : "No test was healed in this window, and no healing proposals are waiting.";
        }

        var applied = LocalJson.Int(stats, "applied");
        var proposed = LocalJson.Int(stats, "proposed");

        return $"{healed.Count} test(s) were healed in this window: {applied} applied, {proposed} still "
             + "proposed. Each healing event records the original locator, the replacement and the "
             + "confidence behind it. A healed locator is a repair, not a verdict: review them before "
             + "the replacements are made permanent.";
    }

    private static string Priority(JsonElement context, List<object> findings)
    {
        var newFailures = LocalJson.Array(context, "newFailures").ToList();
        var failing = LocalJson.Array(context, "topFailingTests").ToList();
        var security = Property(context, "security");
        var risk = Property(context, "risk");

        var critical = LocalJson.Int(security, "openCritical");
        var high = LocalJson.Int(security, "openHigh");

        // A critical security finding outranks a failing test. A list that put a flaky test
        // above an open critical would be ordering the work wrongly.
        if (critical > 0)
        {
            findings.Add(Finding(
                $"{critical} critical and {high} high security finding(s) are open.",
                new[] { "security:open" }, 95));
            return $"Start with security: {critical} critical finding(s) are open. Those outrank the "
                 + $"{failing.Count} failing test(s), because a critical finding is a live exposure "
                 + "rather than a signal that something might be wrong.";
        }

        if (newFailures.Count > 0)
        {
            findings.AddRange(newFailures.Take(10).Select(f => Finding(
                $"\"{LocalJson.String(f, "name")}\" failed for the first time: "
                + $"{Truncate(LocalJson.String(f, "lastMessage"), 300)}",
                new[] { $"testCase:{LocalJson.String(f, "id")}" }, 80)));

            return $"Start with the {newFailures.Count} failure(s) that are new in this window. They "
                 + "correlate with the most recent change and are the most likely regressions, which "
                 + "makes them both the most urgent and the cheapest to diagnose while the change is "
                 + "still fresh.";
        }

        if (failing.Count > 0)
        {
            findings.AddRange(failing.Take(5).Select(f => Finding(
                $"\"{LocalJson.String(f, "name")}\" has failed {LocalJson.Int(f, "failureCount")} time(s): "
                + $"{Truncate(LocalJson.String(f, "lastMessage"), 300)}",
                new[] { $"testCase:{LocalJson.String(f, "id")}" }, 70)));

            return "There are no new failures, so nothing here points at a recent change. The most "
                 + $"persistent problem is \"{LocalJson.String(failing[0], "name")}\", which has failed "
                 + $"{LocalJson.Int(failing[0], "failureCount")} time(s).";
        }

        var neverRun = LocalJson.Int(Property(context, "coverage"), "testCasesNeverRun");
        var rationale = LocalJson.String(risk, "rationale");

        if (neverRun > 0)
        {
            findings.Add(Finding(
                $"{neverRun} test case(s) have never been executed.",
                new[] { "dashboard:coverage" }, 100));
            return $"Nothing is failing. The most useful next step is coverage rather than "
                 + $"investigation: {neverRun} test case(s) have never run at all, so they are "
                 + "untested rather than passing."
                 + (rationale is null ? string.Empty : $" Regression risk: {rationale}");
        }

        return "Nothing is failing in the selected window and every test case has run at least once. "
             + "The most useful next step is widening coverage rather than investigating."
             + (rationale is null ? string.Empty : $" Regression risk: {rationale}");
    }

    private static string Performance(
        JsonElement context, JsonElement totals, List<object> findings, out bool insufficient)
    {
        insufficient = false;
        var slowest = LocalJson.Array(context, "slowestTests").ToList();
        var average = LocalJson.Int(totals, "averageDurationMs");

        if (slowest.Count == 0)
        {
            insufficient = true;
            return "No test has a recorded duration in this window, so there is nothing to compare. "
                 + "Durations are recorded per execution, so run the suite and ask again.";
        }

        findings.AddRange(slowest.Take(10).Select(t => Finding(
            $"\"{LocalJson.String(t, "name")}\" averages {LocalJson.Int(t, "averageDurationMs")}ms.",
            new[] { $"testCase:{LocalJson.String(t, "id")}" }, 100)));

        var top = slowest[0];
        var topMs = LocalJson.Int(top, "averageDurationMs");
        var multiple = average > 0 ? topMs / (double)average : 0;

        return $"The slowest test is \"{LocalJson.String(top, "name")}\" at {topMs}ms on average, "
             + $"against a suite average of {average}ms"
             + (multiple >= 2 ? $" — about {multiple:0.#} times the average" : string.Empty)
             + $". {slowest.Count} test(s) have recorded durations. Durations here are wall-clock per "
             + "execution and include waits, so a slow test is often waiting rather than computing.";
    }

    private static string Security(JsonElement security, List<object> findings, out bool insufficient)
    {
        insufficient = false;

        var applications = LocalJson.Int(security, "applications");
        var notAuthorized = LocalJson.Int(security, "applicationsNotAuthorized");
        var neverScanned = LocalJson.Int(security, "applicationsNeverScanned");
        var critical = LocalJson.Int(security, "openCritical");
        var high = LocalJson.Int(security, "openHigh");
        var total = LocalJson.Int(security, "openTotal");
        var regressions = LocalJson.Int(security, "regressions");
        var unjustified = LocalJson.Int(security, "unjustifiedSuppressions");

        if (!LocalJson.Bool(security, "anyScanRecorded"))
        {
            insufficient = true;
            findings.Add(Finding(
                $"{applications} application(s) exist; {notAuthorized} are not authorized for security "
                + "testing and no scan has ever been recorded.",
                new[] { "security:overview" }, 100));

            // Untested is not clean, and this is the single easiest place for a tool to imply
            // otherwise by staying quiet.
            return "No security scan has ever been recorded, so nothing is known about the security of "
                 + $"these applications. That is untested, not clean. {notAuthorized} of {applications} "
                 + "application(s) have no enabled scope, and nothing can be scanned without one: write "
                 + "an authorization on the Security page first.";
        }

        if (total > 0)
        {
            findings.Add(Finding(
                $"{total} open finding(s): {critical} critical, {high} high.",
                new[] { "security:open" }, 100));
        }

        if (regressions > 0)
        {
            findings.Add(Finding(
                $"{regressions} finding(s) are regressions: previously resolved and seen again.",
                new[] { "security:regressions" }, 100));
        }

        if (unjustified > 0)
        {
            findings.Add(Finding(
                $"{unjustified} suppression(s) carry no written reason or no named person, and are "
                + "counted as open.",
                new[] { "security:suppressions" }, 100));
        }

        var parts = new List<string>();
        if (total == 0) parts.Add("no findings are open");
        else parts.Add($"{total} finding(s) are open, {critical} critical and {high} high");
        if (regressions > 0) parts.Add($"{regressions} are regressions");
        if (neverScanned > 0) parts.Add($"{neverScanned} application(s) have been authorized but never scanned");
        if (unjustified > 0) parts.Add($"{unjustified} suppression(s) are unjustified and counted as open");

        return $"{string.Join("; ", parts)}. This covers only what the configured scopes permitted and "
             + "the checks that actually ran; an application nobody authorized contributes nothing to "
             + "this picture.";
    }

    private static string Coverage(
        JsonElement coverage, JsonElement totals, List<object> findings, out bool insufficient)
    {
        insufficient = false;

        var applications = LocalJson.Int(coverage, "applications");
        var pages = LocalJson.Int(coverage, "pagesDiscovered");
        var endpoints = LocalJson.Int(coverage, "apiEndpointsDiscovered");
        var tests = LocalJson.Int(coverage, "testCases");
        var enabled = LocalJson.Int(coverage, "enabledTestCases");
        var neverRun = LocalJson.Int(coverage, "testCasesNeverRun");
        var suites = LocalJson.Int(coverage, "suites");
        var schedules = LocalJson.Int(coverage, "schedules");

        if (applications == 0)
        {
            insufficient = true;
            return "No application is registered, so there is nothing to measure coverage against. "
                 + "Register one on the Applications page and run discovery.";
        }

        findings.Add(Finding(
            $"{applications} application(s), {pages} discovered page(s), {endpoints} discovered API "
            + $"endpoint(s), {tests} test case(s) in {suites} suite(s).",
            new[] { "dashboard:coverage" }, 100));

        if (neverRun > 0)
        {
            findings.Add(Finding(
                $"{neverRun} of {tests} test case(s) have never been executed.",
                new[] { "dashboard:coverage" }, 100));
        }

        var disabled = tests - enabled;
        if (disabled > 0)
        {
            findings.Add(Finding(
                $"{disabled} test case(s) are disabled and will not run.",
                new[] { "dashboard:coverage" }, 100));
        }

        // Pages discovered against tests written is the honest shape of a coverage answer
        // here: QA NXT knows what it found and what was written, and deliberately does not
        // claim a percentage, because a page is not a unit of coverage.
        var gap = pages > 0 && tests == 0
            ? $" {pages} page(s) have been discovered and no tests written against any of them."
            : string.Empty;

        return $"{tests} test case(s) exist across {suites} suite(s), {enabled} enabled, covering "
             + $"{applications} application(s) with {pages} discovered page(s) and {endpoints} "
             + $"discovered API endpoint(s)."
             + gap
             + (neverRun > 0 ? $" {neverRun} test case(s) have never run, so they are untested rather "
                               + "than passing." : string.Empty)
             + (schedules == 0 ? " No schedule is configured, so nothing runs unless somebody starts it."
                               : string.Empty)
             + " QA NXT does not report a coverage percentage: a discovered page is not a unit of "
             + "coverage, and a number that looked like one would be inventing a denominator.";
    }

    private static string Trend(
        JsonElement context, JsonElement totals, List<object> findings, out bool insufficient)
    {
        insufficient = false;
        var trend = LocalJson.Array(context, "trend").ToList();
        var withRuns = trend.Where(p => LocalJson.Int(p, "passed") + LocalJson.Int(p, "failed") > 0).ToList();

        if (withRuns.Count < 2)
        {
            insufficient = true;
            return $"A trend needs at least two days with executions to compare, and this window has "
                 + $"{withRuns.Count}. The current pass rate is {LocalJson.Int(totals, "passRate")}%, "
                 + "but one point is a reading, not a direction.";
        }

        var first = withRuns[0];
        var last = withRuns[^1];
        var firstRate = LocalJson.Int(first, "passRate");
        var lastRate = LocalJson.Int(last, "passRate");
        var delta = lastRate - firstRate;

        findings.Add(Finding(
            $"Pass rate went from {firstRate}% on {LocalJson.String(first, "date")} to {lastRate}% on "
            + $"{LocalJson.String(last, "date")}, across {withRuns.Count} day(s) with executions.",
            new[] { "dashboard:trend" }, 100));

        var direction = delta switch
        {
            > 5 => "improving",
            < -5 => "getting worse",
            _ => "roughly flat"
        };

        return $"Quality is {direction}: the pass rate moved from {firstRate}% to {lastRate}% "
             + $"({delta:+#;-#;0} points) over {withRuns.Count} day(s) with executions in this window. "
             + "Days with no runs are left out rather than counted as zero, because a day nobody tested "
             + "is not a day the suite failed.";
    }

    private static string ReleaseReadiness(
        JsonElement context, JsonElement totals, JsonElement security,
        List<object> findings, out bool insufficient)
    {
        insufficient = false;

        var executions = LocalJson.Int(totals, "executions");
        var failed = LocalJson.Int(totals, "failed");
        var blocked = LocalJson.Int(totals, "blocked");
        var passRate = LocalJson.Int(totals, "passRate");
        var critical = LocalJson.Int(security, "openCritical");
        var high = LocalJson.Int(security, "openHigh");
        var neverRun = LocalJson.Int(Property(context, "coverage"), "testCasesNeverRun");
        var unstable = LocalJson.Array(context, "unstableTests").Count();

        var blockers = new List<string>();
        if (failed > 0) blockers.Add($"{failed} execution(s) failed");
        if (blocked > 0) blockers.Add($"{blocked} execution(s) were blocked and produced no verdict");
        if (critical > 0) blockers.Add($"{critical} critical security finding(s) are open");
        if (high > 0) blockers.Add($"{high} high security finding(s) are open");
        if (!LocalJson.Bool(security, "anyScanRecorded")) blockers.Add("no security scan has ever run");
        if (neverRun > 0) blockers.Add($"{neverRun} test case(s) have never been executed");
        if (unstable > 0) blockers.Add($"{unstable} test(s) are unstable, so their results are not dependable");

        foreach (var blocker in blockers)
        {
            findings.Add(Finding(blocker, new[] { "dashboard:summary" }, 100));
        }

        if (blockers.Count == 0)
        {
            // Carefully worded. This is the sentence a tool is most tempted to overstate, and
            // the strongest thing the records support is what ran, not that the product is good.
            return $"Nothing in the record argues against releasing: {executions} execution(s) ran, "
                 + $"{passRate}% passed, no failures, no blocked executions, no open critical or high "
                 + "security findings, and every test case has run at least once. That is a statement "
                 + "about the tests that exist and ran, not a guarantee about the product. Whether this "
                 + "coverage is enough to release on is a judgement QA NXT cannot make for you.";
        }

        return $"Not clear to release on this evidence. {blockers.Count} thing(s) argue against it: "
             + string.Join("; ", blockers) + ". "
             + $"The window holds {executions} execution(s) at a {passRate}% pass rate. Decide against "
             + "the Quality Gates for this project rather than against this summary, since a gate is "
             + "the rule somebody agreed to in advance.";
    }

    private static string Overview(
        JsonElement context, JsonElement totals, JsonElement coverage, List<object> findings)
    {
        var executions = LocalJson.Int(totals, "executions");
        var passed = LocalJson.Int(totals, "passed");
        var failed = LocalJson.Int(totals, "failed");
        var healed = LocalJson.Int(totals, "healed");
        var blocked = LocalJson.Int(totals, "blocked");
        var passRate = LocalJson.Int(totals, "passRate");
        var failing = LocalJson.Array(context, "topFailingTests").ToList();
        var neverRun = LocalJson.Int(coverage, "testCasesNeverRun");

        findings.Add(Finding(
            $"Pass rate {passRate}% over {executions} execution(s): {passed} passed, {failed} failed, "
            + $"{healed} healed, {blocked} blocked.",
            new[] { "dashboard:summary" }, 100));

        if (neverRun > 0)
        {
            findings.Add(Finding(
                $"{neverRun} test case(s) have never been executed and are outside this pass rate.",
                new[] { "dashboard:coverage" }, 100));
        }

        return $"Across {executions} execution(s): {passed} passed, {failed} failed, {healed} healed, "
             + $"{blocked} blocked — a pass rate of {passRate}%."
             + (failing.Count > 0
                 ? $" The most frequent failure is \"{LocalJson.String(failing[0], "name")}\"."
                 : string.Empty)
             + (neverRun > 0
                 ? $" {neverRun} test case(s) have never run, and a pass rate says nothing about those."
                 : string.Empty);
    }

    // ---- Plumbing ----------------------------------------------------------

    private static JsonElement Property(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) ? value : default;

    private static object Finding(string statement, string[] evidenceRefs, int confidence)
        => new { statement, evidenceRefs, confidence };

    private static string? Truncate(string? value, int max)
        => value is null || value.Length <= max ? value : value[..max] + "…";

    /// <summary>Answers are assembled from counted records, so what is stated is always
    /// checkable against the identifiers each finding carries.</summary>
    private static string Emit(string answer, bool insufficientEvidence, List<object> findings)
        => LocalJson.Serialize(new
        {
            answer,
            insufficientEvidence,
            findings = findings.Take(20).ToList()
        });
}
