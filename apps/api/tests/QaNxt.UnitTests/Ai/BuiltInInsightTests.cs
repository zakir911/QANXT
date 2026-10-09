using System.Text.Json;
using System.Text.RegularExpressions;
using QaNxt.Application.Ai;
using QaNxt.Infrastructure.Ai.Providers;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace QaNxt.UnitTests.Ai;

/// <summary>The built-in rules have to answer a real question on their own.
///
/// A model provider is optional in this product, which means the rule engine is the
/// supported default rather than a placeholder. Two things made it look broken instead of
/// honest:
///
///  - It gave up whenever the window held no executions, answering "there is nothing to draw
///    conclusions from" to every question. That is the state a project is in when somebody
///    asks their first question, and the answer is indistinguishable from a fault.
///  - Intent was a chain of Contains checks over five phrases, so "which tests are slowest"
///    and "are we safe to release" both fell through to a generic pass-rate line.
///
/// What it must not do is overcorrect into confidence. These tests check both directions:
/// that a question gets a real answer from the right evidence, and that an answer never
/// claims more than the records support.</summary>
public class BuiltInInsightTests
{
    private static JsonElement Ask(string question, string contextJson)
    {
        var provider = new LocalProvider(NullLogger<LocalProvider>.Instance);
        var request = new LlmRequest
        {
            Messages = new[]
            {
                LlmMessage.User(
                    $"Answer this.\n{LocalProvider.ContextOpen}\n{contextJson}\n{LocalProvider.ContextClose}")
            },
            SchemaName = AiSchemaCatalog.QualityInsight,
            JsonSchema = "{}"
        };

        var response = provider.CompleteAsync(request).GetAwaiter().GetResult();
        return JsonDocument.Parse(response.Content).RootElement.Clone();
    }

    private static string Answer(JsonElement result) => result.GetProperty("answer").GetString()!;
    private static bool Insufficient(JsonElement result) => result.GetProperty("insufficientEvidence").GetBoolean();
    private static int FindingCount(JsonElement result) => result.GetProperty("findings").GetArrayLength();

    /// <summary>A project set up but never run: exactly the state the user was in.
    ///
    /// Assembled with plain concatenation rather than an interpolated raw string, because the
    /// JSON is full of braces and nesting the two makes the literal unreadable before it
    /// makes it wrong.</summary>
    private static string NothingRun(
        int applications = 1, int pages = 0, int testCases = 0,
        string? discoveryStatus = null, string? discoveryError = null)
    {
        var discovery = discoveryStatus is null
            ? "null"
            : "{ \"id\": \"11111111-1111-1111-1111-111111111111\", \"status\": \""
              + discoveryStatus + "\", \"pagesDiscovered\": " + pages + ", \"errorMessage\": "
              + (discoveryError is null ? "null" : JsonSerializer.Serialize(discoveryError))
              + " }";

        return "{"
            + "\"question\": \"placeholder\","
            + "\"windowDays\": 30,"
            + "\"totals\": { \"executions\": 0, \"passed\": 0, \"failed\": 0, \"skipped\": 0,"
            + " \"healed\": 0, \"flaky\": 0, \"blocked\": 0, \"passRate\": 0,"
            + " \"failureRate\": 0, \"averageDurationMs\": 0, \"openDefects\": 0,"
            + " \"pendingHealingProposals\": 0, \"newFailureCount\": 0 },"
            + "\"risk\": { \"score\": 0, \"rationale\": \"No executions to assess.\" },"
            + "\"coverage\": { \"applications\": " + applications
            + ", \"pagesDiscovered\": " + pages
            + ", \"apiEndpointsDiscovered\": 0, \"suites\": 0, \"schedules\": 0,"
            + " \"testCases\": " + testCases
            + ", \"enabledTestCases\": " + testCases
            + ", \"testCasesNeverRun\": " + testCases + " },"
            + "\"lastDiscovery\": " + discovery + ","
            + "\"slowestTests\": [],"
            + "\"security\": { \"anyScanRecorded\": false, \"lastScanAt\": null,"
            + " \"applications\": " + applications
            + ", \"applicationsNotAuthorized\": " + applications
            + ", \"applicationsNeverScanned\": 0, \"openCritical\": 0, \"openHigh\": 0,"
            + " \"openTotal\": 0, \"regressions\": 0, \"unjustifiedSuppressions\": 0,"
            + " \"summary\": \"No scan has run.\" },"
            + "\"trend\": [],"
            + "\"topFailingTests\": [], \"unstableTests\": [],"
            + "\"stability\": { \"testsRunMoreThanOnce\": 0 },"
            + "\"failureCategories\": [], \"newFailures\": [], \"healedTests\": [],"
            + "\"healingStatistics\": { \"total\": 0, \"applied\": 0, \"proposed\": 0,"
            + " \"approved\": 0, \"rejected\": 0, \"averageConfidence\": 0, \"verifiedCount\": 0 }"
            + "}";
    }

    /// <summary>A project with real history, for the questions that need one.</summary>
    private const string WithHistory = """
        {
          "question": "placeholder",
          "windowDays": 30,
          "totals": { "executions": 120, "passed": 100, "failed": 15, "skipped": 0, "healed": 3,
                      "flaky": 2, "blocked": 5, "passRate": 83, "failureRate": 12,
                      "averageDurationMs": 1200, "openDefects": 4,
                      "pendingHealingProposals": 2, "newFailureCount": 1 },
          "risk": { "score": 42, "rationale": "Two unstable tests and one new failure." },
          "coverage": { "applications": 2, "pagesDiscovered": 40, "apiEndpointsDiscovered": 12,
                        "suites": 3, "schedules": 1, "testCases": 50, "enabledTestCases": 48,
                        "testCasesNeverRun": 6 },
          "lastDiscovery": { "id": "22222222-2222-2222-2222-222222222222", "status": "Completed",
                             "pagesDiscovered": 40, "errorMessage": null },
          "slowestTests": [
            { "id": "aaaaaaaa-0000-0000-0000-000000000001", "name": "TC-9 Checkout journey",
              "averageDurationMs": 9600 },
            { "id": "aaaaaaaa-0000-0000-0000-000000000002", "name": "TC-4 Statement export",
              "averageDurationMs": 3100 }
          ],
          "security": { "anyScanRecorded": true, "lastScanAt": "2026-10-01T00:00:00Z",
                        "applications": 2, "applicationsNotAuthorized": 0,
                        "applicationsNeverScanned": 1, "openCritical": 1, "openHigh": 2,
                        "openTotal": 7, "regressions": 1, "unjustifiedSuppressions": 2,
                        "summary": "Findings are open." },
          "trend": [
            { "date": "2026-09-10", "passed": 20, "failed": 10, "passRate": 66 },
            { "date": "2026-09-20", "passed": 0, "failed": 0, "passRate": 0 },
            { "date": "2026-10-01", "passed": 40, "failed": 2, "passRate": 95 }
          ],
          "topFailingTests": [
            { "id": "bbbbbbbb-0000-0000-0000-000000000001", "name": "TC-1 Transfer funds",
              "failureCount": 8, "category": "applicationDefect",
              "lastMessage": "Expected balance 500, saw 400", "lastExecutionId": null }
          ],
          "unstableTests": [
            { "id": "cccccccc-0000-0000-0000-000000000001", "name": "TC-7 Search results",
              "flakinessScore": 60, "executionCount": 10, "resultChanges": 5 }
          ],
          "stability": { "testsRunMoreThanOnce": 30 },
          "failureCategories": [ { "category": "applicationDefect", "count": 8 },
                                 { "category": "locatorChange", "count": 7 } ],
          "newFailures": [
            { "id": "dddddddd-0000-0000-0000-000000000001", "name": "TC-12 Payee validation",
              "lastMessage": "Timed out waiting for the confirmation", "lastExecutionId": null }
          ],
          "healedTests": [
            { "id": "eeeeeeee-0000-0000-0000-000000000001", "testCaseName": "TC-3 Login",
              "originalLocator": "#old", "healedLocator": "#new", "confidence": 88 }
          ],
          "healingStatistics": { "total": 3, "applied": 1, "proposed": 2, "approved": 1,
                                 "rejected": 0, "averageConfidence": 85, "verifiedCount": 1 }
        }
        """;

    /// <summary>Blanks a whole array in the fixture.
    ///
    /// By regex rather than by matching the literal text: a raw string literal strips its
    /// common indentation, so a multi-line Replace silently matches nothing and the fixture
    /// quietly keeps the data the test meant to remove. That failed two of these tests on a
    /// first run, and a fixture that fails to set up the case is worse than no test.</summary>
    private static string Without(string context, string arrayName)
        => Regex.Replace(context, "\"" + arrayName + "\": \\[.*?\\]",
            "\"" + arrayName + "\": []", RegexOptions.Singleline);

    private static string With(string context, string question)
        => context.Replace("\"question\": \"placeholder\"", $"\"question\": {JsonSerializer.Serialize(question)}");

    // ---- The dead end that made it look broken ----------------------------

    [Fact]
    public void With_nothing_run_the_answer_says_what_exists_and_what_to_do_next()
    {
        var result = Ask("x", With(NothingRun(applications: 1, pages: 12, testCases: 0,
            discoveryStatus: "Completed"), "How is quality trending overall?"));

        var answer = Answer(result);
        answer.Should().Contain("Nothing has run");
        // The old engine stopped here. The point of the fix is what follows.
        answer.Should().Contain("1 application");
        answer.Should().Contain("12 page(s)");
        answer.Should().Contain("Next:", "a dead end is not an answer");
        answer.Should().Contain("generate tests");
        Insufficient(result).Should().BeTrue("nothing here is a conclusion about quality");
    }

    [Fact]
    public void With_nothing_run_a_failed_discovery_is_named_as_the_reason()
    {
        // The most common cause of "no tests have run", and it sits one table away. The old
        // engine could not say it because the context never carried it.
        var result = Ask("x", With(NothingRun(applications: 1, pages: 0,
            discoveryStatus: "Failed",
            discoveryError: "The browser Playwright needs is not installed on this worker."),
            "What should the QA team investigate first?"));

        var answer = Answer(result);
        answer.Should().Contain("discovery run failed");
        answer.Should().Contain("fix the discovery failure");
        var findings = result.GetProperty("findings").EnumerateArray()
            .Select(f => f.GetProperty("statement").GetString()!).ToList();
        findings.Should().Contain(s => s.Contains("Playwright"));
    }

    [Fact]
    public void With_no_application_at_all_the_answer_says_to_register_one()
    {
        var result = Ask("x", With(NothingRun(applications: 0), "How is quality?"));

        Answer(result).Should().Contain("No application is registered");
        Answer(result).Should().Contain("Applications page");
        Insufficient(result).Should().BeTrue();
    }

    [Fact]
    public void A_security_question_is_answered_even_with_no_executions()
    {
        // Security does not depend on executions, so the no-executions path must not swallow
        // it. Untested is not clean, and this is where a tool is most tempted to imply it is.
        var result = Ask("x", With(NothingRun(applications: 3), "What is our security posture?"));

        var answer = Answer(result);
        answer.Should().Contain("No security scan has ever been recorded");
        answer.Should().Contain("untested, not clean");
        answer.Should().Contain("3 application(s) have no enabled scope")
            .And.NotBeNull();
        Insufficient(result).Should().BeTrue();
    }

    [Fact]
    public void A_coverage_question_is_answered_even_with_no_executions()
    {
        var result = Ask("x", With(NothingRun(applications: 2, pages: 30, testCases: 0),
            "What is our test coverage?"));

        var answer = Answer(result);
        answer.Should().Contain("30 discovered page(s)");
        answer.Should().Contain("no tests written");
        // A page is not a unit of coverage, and a percentage here would be inventing a
        // denominator.
        answer.Should().Contain("does not report a coverage percentage");
    }

    // ---- Intents the old engine could not route ---------------------------

    [Fact]
    public void A_performance_question_is_answered_from_durations_not_the_pass_rate()
    {
        var result = Ask("x", With(WithHistory, "Which tests are slowest?"));

        var answer = Answer(result);
        answer.Should().Contain("TC-9 Checkout journey");
        answer.Should().Contain("9600ms");
        answer.Should().Contain("1200ms", "the suite average is what makes the number mean something");
        // The old engine fell through to the generic branch for this.
        answer.Should().NotContain("pass rate of");
    }

    [Fact]
    public void A_release_question_lists_what_argues_against_it_rather_than_giving_a_verdict()
    {
        var result = Ask("x", With(WithHistory, "Are we safe to release?"));

        var answer = Answer(result);
        answer.Should().Contain("Not clear to release");
        answer.Should().Contain("15 execution(s) failed");
        answer.Should().Contain("1 critical security finding");
        answer.Should().Contain("5 execution(s) were blocked");
        answer.Should().Contain("Quality Gates", "a gate is the rule somebody agreed to in advance");
        FindingCount(result).Should().BeGreaterThan(3);
    }

    [Fact]
    public void A_clean_release_answer_still_refuses_to_guarantee_the_product()
    {
        var clean = Without(WithHistory
            .Replace("\"failed\": 15", "\"failed\": 0")
            .Replace("\"blocked\": 5", "\"blocked\": 0")
            .Replace("\"openCritical\": 1", "\"openCritical\": 0")
            .Replace("\"openHigh\": 2", "\"openHigh\": 0")
            .Replace("\"testCasesNeverRun\": 6", "\"testCasesNeverRun\": 0"), "unstableTests");

        var result = Ask("x", With(clean, "Are we safe to release?"));
        var answer = Answer(result);

        answer.Should().Contain("Nothing in the record argues against releasing");
        // The sentence this product is most tempted to overstate.
        answer.Should().Contain("not a guarantee about the product");
        answer.Should().NotContain("zero bugs");
        answer.Should().NotContain("100%");
    }

    [Fact]
    public void A_trend_question_ignores_days_nobody_tested()
    {
        var result = Ask("x", With(WithHistory, "How is quality trending?"));

        var answer = Answer(result);
        answer.Should().Contain("66%").And.Contain("95%");
        answer.Should().Contain("improving");
        // The middle day has no runs. Counting it as a zero pass rate would invent a dip.
        answer.Should().Contain("2 day(s)");
        answer.Should().Contain("not a day the suite failed");
    }

    [Fact]
    public void A_trend_needs_two_days_of_runs_before_it_claims_a_direction()
    {
        // Drop the two earlier trend points, leaving a single day with runs.
        var onePoint = WithHistory
            .Replace("{ \"date\": \"2026-09-10\", \"passed\": 20, \"failed\": 10, \"passRate\": 66 },", "")
            .Replace("{ \"date\": \"2026-09-20\", \"passed\": 0, \"failed\": 0, \"passRate\": 0 },", "");

        var result = Ask("x", With(onePoint, "How is quality trending?"));

        Answer(result).Should().Contain("one point is a reading, not a direction");
        Insufficient(result).Should().BeTrue();
    }

    [Fact]
    public void A_priority_question_puts_an_open_critical_above_failing_tests()
    {
        var result = Ask("x", With(WithHistory, "What should we investigate first?"));

        var answer = Answer(result);
        answer.Should().Contain("Start with security");
        answer.Should().Contain("1 critical");
        answer.Should().Contain("live exposure");
    }

    [Fact]
    public void With_no_critical_findings_priority_falls_to_the_new_failures()
    {
        var noCritical = WithHistory.Replace("\"openCritical\": 1", "\"openCritical\": 0");
        var result = Ask("x", With(noCritical, "What should we investigate first?"));

        var answer = Answer(result);
        answer.Should().Contain("new in this window");
        answer.Should().Contain("most likely regressions");
        result.GetProperty("findings").EnumerateArray()
            .Select(f => f.GetProperty("statement").GetString()!)
            .Should().Contain(s => s.Contains("TC-12 Payee validation"));
    }

    // ---- Honesty the old engine already had, which must survive ----------

    [Fact]
    public void Stability_over_a_sample_of_nothing_is_still_refused()
    {
        // ISSUE-004. A rewrite is exactly where this regresses, so it is pinned here too.
        var noRepeats = Without(WithHistory, "unstableTests")
            .Replace("\"testsRunMoreThanOnce\": 30", "\"testsRunMoreThanOnce\": 0");

        var result = Ask("x", With(noRepeats, "Which tests are most unstable?"));

        Answer(result).Should().Contain("no test in the selected window has run more than once");
        Answer(result).Should().NotContain("produced a consistent result");
        Insufficient(result).Should().BeTrue();
    }

    [Fact]
    public void No_application_defects_is_not_reported_as_a_clean_application()
    {
        var noDefects = WithHistory.Replace(
            """ { "category": "applicationDefect", "count": 8 },""",
            """ { "category": "timing", "count": 3 },""");

        var result = Ask("x", With(noDefects, "Which failures are likely application defects?"));

        var answer = Answer(result);
        answer.Should().Contain("No failure in this window was classified as an application defect");
        answer.Should().Contain("not a clean bill of health");
        answer.Should().Contain("timing");
    }

    [Fact]
    public void Every_finding_carries_an_evidence_reference()
    {
        foreach (var question in new[]
                 {
                     "Which tests are most unstable?", "Which tests are slowest?",
                     "What is our security posture?", "What is our test coverage?",
                     "How is quality trending?", "Are we safe to release?",
                     "What should we investigate first?", "How is quality overall?"
                 })
        {
            var result = Ask("x", With(WithHistory, question));

            foreach (var finding in result.GetProperty("findings").EnumerateArray())
            {
                finding.GetProperty("evidenceRefs").GetArrayLength()
                    .Should().BeGreaterThan(0, $"\"{question}\" produced an uncited finding");
                finding.GetProperty("statement").GetString()
                    .Should().NotBeNullOrWhiteSpace();
            }
        }
    }

    [Fact]
    public void A_healing_question_says_a_repair_is_not_a_verdict()
    {
        var result = Ask("x", With(WithHistory,
            "Which tests were self-healed, and how confident were the repairs?"));

        var answer = Answer(result);
        answer.Should().Contain("1 test(s) were healed");
        answer.Should().Contain("a repair, not a verdict");
        answer.Should().Contain("2 still proposed");
    }

    [Fact]
    public void An_unrecognised_question_gets_the_overview_rather_than_a_refusal()
    {
        var result = Ask("x", With(WithHistory, "what do you make of all this then"));

        var answer = Answer(result);
        answer.Should().Contain("120 execution(s)");
        answer.Should().Contain("83%");
        // The pass rate excludes tests that never ran, and saying so is the difference between
        // a number and a misleading number.
        answer.Should().Contain("6 test case(s) have never run");
    }

    [Fact]
    public void A_context_missing_most_of_its_fields_still_produces_an_answer()
    {
        // Not hypothetical: a caller that builds only { question, totals } crashed the engine
        // outright, because TryGetProperty throws on the default JsonElement that an absent
        // property yields rather than returning false. One missing field took down the whole
        // answer with "the question could not be answered", which looks like the rules being
        // broken for a reason that has nothing to do with the rules.
        var minimal = """{ "question": "Which tests are most unstable?", "totals": { "executions": 0 } }""";

        var act = () => Ask("x", minimal);

        act.Should().NotThrow();
        var result = Ask("x", minimal);
        Answer(result).Should().NotBeNullOrWhiteSpace();
        Insufficient(result).Should().BeTrue("a context this thin supports no conclusion");
    }

    [Fact]
    public void A_context_missing_most_of_its_fields_still_answers_each_intent()
    {
        var minimal = """{ "question": "placeholder", "totals": { "executions": 0 } }""";

        foreach (var question in new[]
                 {
                     "Which tests are slowest?", "What is our security posture?",
                     "What is our test coverage?", "How is quality trending?",
                     "Are we safe to release?", "What should we investigate first?",
                     "Which failures are likely application defects?",
                     "Which tests were self-healed?", "anything at all"
                 })
        {
            var act = () => Ask("x", With(minimal, question));
            act.Should().NotThrow($"\"{question}\" must not crash on a thin context");

            Answer(Ask("x", With(minimal, question)))
                .Should().NotBeNullOrWhiteSpace($"\"{question}\" produced no answer");
        }
    }

    [Fact]
    public void Suppressions_with_no_written_reason_are_counted_as_open()
    {
        var result = Ask("x", With(WithHistory, "What is our security posture?"));

        Answer(result).Should().Contain("2 suppression(s) are unjustified and counted as open");
    }
}
