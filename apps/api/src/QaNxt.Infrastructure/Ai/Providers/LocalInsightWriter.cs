using System.Text.Json;

namespace QaNxt.Infrastructure.Ai.Providers;

/// <summary>Answers quality questions from the run statistics, citing what it counted.
///
/// It reports only what the numbers support, and says so explicitly when they support
/// nothing — an invented trend is worse than an admission that there is not enough data.
/// Every finding carries the identifiers a reader can go and check.</summary>
internal static class LocalInsightWriter
{
    public static string Write(JsonElement context)
    {
        var question = LocalJson.String(context, "question") ?? string.Empty;
        var lowered = question.ToLowerInvariant();

        var totals = context.TryGetProperty("totals", out var t) ? t : default;
        var executions = LocalJson.Int(totals, "executions");

        if (executions == 0)
        {
            return LocalJson.Serialize(new
            {
                answer = "There are no completed executions in the selected window, so there is nothing to draw conclusions from yet. Run the suite and ask again.",
                insufficientEvidence = true,
                findings = System.Array.Empty<object>()
            });
        }

        var findings = new List<object>();
        var unstable = LocalJson.Array(context, "unstableTests").ToList();
        var failing = LocalJson.Array(context, "topFailingTests").ToList();
        var healed = LocalJson.Array(context, "healedTests").ToList();
        var newFailures = LocalJson.Array(context, "newFailures").ToList();
        var categories = LocalJson.Array(context, "failureCategories").ToList();

        string answer;
        // Set by any branch whose numbers do not support a conclusion, so the console can
        // label the answer rather than presenting it as a finding.
        var insufficientEvidence = false;

        if (lowered.Contains("unstable") || lowered.Contains("flaky"))
        {
            if (unstable.Count == 0)
            {
                // An empty unstable list means one of two different things, and they must not
                // be reported the same way. Instability can only be observed across repeated
                // runs, so with nothing run twice the honest answer is that the question
                // cannot be answered yet — not that everything is stable. Saying "every test
                // that ran more than once produced a consistent result" when no test ran
                // more than once is true and useless, and it reads as reassurance.
                var repeated = LocalJson.Int(
                    context.TryGetProperty("stability", out var st) ? st : default, "testsRunMoreThanOnce");

                answer = repeated == 0
                    ? "Instability can only be seen across repeated runs, and no test in the selected "
                      + "window has run more than once, so there is nothing to judge stability from yet. "
                      + "Run the suite again and ask once a test has a second result to compare."
                    : $"No test in the selected window shows unstable behaviour: all {repeated} test(s) "
                      + "that ran more than once produced a consistent result.";
                insufficientEvidence = repeated == 0;
            }
            else
            {
                answer = $"{unstable.Count} test(s) are behaving inconsistently. The least stable is \"{LocalJson.String(unstable[0], "name")}\" with a flakiness score of {LocalJson.Int(unstable[0], "flakinessScore")}/100.";
                findings.AddRange(unstable.Take(10).Select(test => new
                {
                    statement = $"\"{LocalJson.String(test, "name")}\" changed result {LocalJson.Int(test, "resultChanges")} time(s) across {LocalJson.Int(test, "executionCount")} executions (flakiness {LocalJson.Int(test, "flakinessScore")}/100).",
                    evidenceRefs = new[] { $"testCase:{LocalJson.String(test, "id")}" },
                    confidence = Math.Min(95, 50 + LocalJson.Int(test, "executionCount") * 5)
                }));
            }
        }
        else if (lowered.Contains("defect") || lowered.Contains("application"))
        {
            var applicationDefects = categories.FirstOrDefault(c => LocalJson.String(c, "category") == "applicationDefect");
            var count = applicationDefects.ValueKind == JsonValueKind.Object ? LocalJson.Int(applicationDefects, "count") : 0;
            answer = count == 0
                ? "No failure in this window was classified as an application defect. The failures that occurred were attributed to locator changes, timing or the environment."
                : $"{count} failure(s) were classified as likely application defects. These are the ones worth taking to the development team first.";
            findings.AddRange(failing.Take(10)
                .Where(f => LocalJson.String(f, "category") == "applicationDefect")
                .Select(f => new
                {
                    statement = $"\"{LocalJson.String(f, "name")}\" failed {LocalJson.Int(f, "failureCount")} time(s): {LocalJson.String(f, "lastMessage")}",
                    evidenceRefs = new[] { $"testCase:{LocalJson.String(f, "id")}", $"execution:{LocalJson.String(f, "lastExecutionId")}" },
                    confidence = 75
                }));
        }
        else if (lowered.Contains("heal"))
        {
            answer = healed.Count == 0
                ? "No test was healed in this window."
                : $"{healed.Count} test(s) were healed. Each healing event records the original locator, the replacement, and the confidence behind it — review them before the replacements are made permanent.";
            findings.AddRange(healed.Take(10).Select(h => new
            {
                statement = $"\"{LocalJson.String(h, "testCaseName")}\": {LocalJson.String(h, "originalLocator")} -> {LocalJson.String(h, "healedLocator")} at {LocalJson.Int(h, "confidence")}% confidence.",
                evidenceRefs = new[] { $"healingEvent:{LocalJson.String(h, "id")}" },
                confidence = LocalJson.Int(h, "confidence")
            }));
        }
        else if (lowered.Contains("investigate") || lowered.Contains("first") || lowered.Contains("priority"))
        {
            if (newFailures.Count > 0)
            {
                answer = $"Start with the {newFailures.Count} failure(s) that are new in this window: they correlate with the most recent change and are the most likely regressions.";
                findings.AddRange(newFailures.Take(10).Select(f => new
                {
                    statement = $"\"{LocalJson.String(f, "name")}\" failed for the first time: {LocalJson.String(f, "lastMessage")}",
                    evidenceRefs = new[] { $"testCase:{LocalJson.String(f, "id")}", $"execution:{LocalJson.String(f, "lastExecutionId")}" },
                    confidence = 80
                }));
            }
            else if (failing.Count > 0)
            {
                answer = $"There are no new failures. The most persistent problem is \"{LocalJson.String(failing[0], "name")}\", which has failed {LocalJson.Int(failing[0], "failureCount")} time(s).";
                findings.AddRange(failing.Take(5).Select(f => new
                {
                    statement = $"\"{LocalJson.String(f, "name")}\" has failed {LocalJson.Int(f, "failureCount")} time(s): {LocalJson.String(f, "lastMessage")}",
                    evidenceRefs = new[] { $"testCase:{LocalJson.String(f, "id")}" },
                    confidence = 70
                }));
            }
            else
            {
                answer = "Nothing is failing in the selected window. The most useful next step is to widen coverage rather than investigate.";
            }
        }
        else
        {
            var passed = LocalJson.Int(totals, "passed");
            var failed = LocalJson.Int(totals, "failed");
            var healedCount = LocalJson.Int(totals, "healed");
            var passRate = executions == 0 ? 0 : passed * 100 / executions;

            answer = $"Across {executions} execution(s): {passed} passed, {failed} failed, {healedCount} healed — a pass rate of {passRate}%."
                + (failing.Count > 0 ? $" The most frequent failure is \"{LocalJson.String(failing[0], "name")}\"." : string.Empty);

            findings.Add(new
            {
                statement = $"Pass rate {passRate}% over {executions} executions.",
                evidenceRefs = new[] { "dashboard:summary" },
                confidence = 100
            });
        }

        // Answers are assembled from counted records, so what is stated is always checkable.
        return LocalJson.Serialize(new
        {
            answer,
            insufficientEvidence,
            findings = findings.Take(20).ToList()
        });
    }
}
