using QaNxt.Application.Diagnosis;
using QaNxt.Application.Testing;
using QaNxt.Domain.Enums;
using FluentAssertions;

namespace QaNxt.UnitTests.Diagnosis;

/// <summary>What the API was doing when a UI step failed.
///
/// The join these rules read — which step made which request — was a column nothing wrote
/// until BUG-0020. Before that, the classifier could only count responses across a whole
/// execution, which is the weaker statement: "server errors happened somewhere in these
/// twenty steps" does not tell anyone where to look, and "the step that failed asked for
/// /api/accounts and was answered 500" does.
///
/// The ordering matters as much as the rules. A correlated finding must beat an uncorrelated
/// count, and neither may beat the locator rule that BUG-0015 put in front of them.</summary>
public class ApiCorrelationTests
{
    private static NetworkEventPayload Call(
        string method, string url, int? status, int? actionOrder,
        bool failed = false, string? failureText = null, int durationMs = 12,
        string resourceType = "xhr")
        => new()
        {
            Method = method, Url = url, StatusCode = status, ActionOrder = actionOrder,
            IsFailed = failed || status >= 400, FailureText = failureText,
            DurationMs = durationMs, ResourceType = resourceType
        };

    private static ExecutionCompletionPayload Completion(params NetworkEventPayload[] calls)
        => new() { NetworkEvents = calls.ToList() };

    private static ClassificationInput Input(
        string message, string? failingAction, ApiCorrelation api,
        int serverErrors = 0, int authErrors = 0, int networkFailures = 0)
        => new(ExecutionStatus.Failed, message, false, null, 0,
            serverErrors, authErrors, networkFailures, failingAction, api);

    // ---- Building the correlation ------------------------------------------

    [Fact]
    public void Attributes_calls_to_the_step_that_made_them()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/dashboard", 200, actionOrder: 1),
            Call("GET", "http://bank/api/accounts", 500, actionOrder: 3),
            Call("GET", "http://bank/api/payees", 200, actionOrder: 3)), failingActionOrder: 3);

        correlation.DuringFailingStep.Should().HaveCount(2);
        correlation.FailedDuringFailingStep.Should().ContainSingle()
            .Which.StatusCode.Should().Be(500);
        correlation.FailedElsewhere.Should().BeEmpty();
    }

    [Fact]
    public void Separates_failures_that_belong_to_another_step()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/dashboard", 500, actionOrder: 1),
            Call("GET", "http://bank/api/accounts", 200, actionOrder: 5)), failingActionOrder: 5);

        correlation.FailedDuringFailingStep.Should().BeEmpty();
        correlation.FailedElsewhere.Should().ContainSingle();
        correlation.EveryCallDuringFailingStepSucceeded.Should().BeTrue();
    }

    [Fact]
    public void Ignores_page_loads_and_assets()
    {
        // A document navigation is a page load, not an API call. Counting one as a service
        // fault would make every redirect look like an outage.
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/dashboard", 302, actionOrder: 2, resourceType: "document"),
            Call("GET", "http://bank/app.css", 404, actionOrder: 2, resourceType: "stylesheet"),
            Call("GET", "http://bank/api/accounts", 200, actionOrder: 2)), failingActionOrder: 2);

        correlation.DuringFailingStep.Should().ContainSingle()
            .Which.Path.Should().Be("/api/accounts");
        correlation.FailedDuringFailingStep.Should().BeEmpty();
    }

    [Fact]
    public void Says_nothing_when_no_step_was_identified()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/accounts", 500, actionOrder: 3)), failingActionOrder: null);

        correlation.DuringFailingStep.Should().BeEmpty();
        correlation.EveryCallDuringFailingStepSucceeded.Should().BeFalse();
        // The failure is still visible, just not attributed.
        correlation.FailedElsewhere.Should().ContainSingle();
    }

    [Fact]
    public void Describes_a_call_the_way_a_report_should_read_it()
    {
        var responded = new CorrelatedApiCall("GET", "http://bank/api/accounts?page=2", 500, 34, true, null, 3);
        var never = new CorrelatedApiCall("POST", "http://bank/api/payments", null, 30_000, true, "ECONNREFUSED", 4);

        responded.Describe().Should().Be("GET /api/accounts → 500 in 34ms");
        never.Describe().Should().Be("POST /api/payments did not complete (ECONNREFUSED)");
    }

    // ---- The step before the one that failed -------------------------------

    [Fact]
    public void A_failure_caused_by_the_previous_steps_call_is_attributed_to_that_call()
    {
        // The common shape of a UI failure: a click starts a fetch and moves on, and the
        // assertion one step later is what notices the page is empty. Looking only at the
        // failing step finds nothing in exactly the case this feature exists for.
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/accounts/acc-1001/transactions", 500, actionOrder: 3)),
            failingActionOrder: 4);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "The element was found but was not visible.", "assertVisible", correlation, serverErrors: 1));

        verdict.Category.Should().Be(FailureCategory.ApplicationDefect);
        verdict.Confidence.Should().Be(90);
        verdict.Summary.Should().Contain("The step before this one");
        verdict.Evidence.Should().Contain("/api/accounts/acc-1001/transactions");
        verdict.SuggestedAction.Should().Contain("this call is the cause");
    }

    [Fact]
    public void The_failing_steps_own_call_still_outranks_the_previous_steps()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/earlier", 500, actionOrder: 3),
            Call("GET", "http://bank/api/current", 500, actionOrder: 4)), failingActionOrder: 4);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "The step failed.", "click", correlation, serverErrors: 2));

        verdict.Confidence.Should().Be(95);
        verdict.Evidence.Should().Contain("/api/current");
        verdict.Evidence.Should().NotContain("/api/earlier");
    }

    [Fact]
    public void A_failure_two_steps_back_is_not_attributed_to_the_failing_step()
    {
        // One step back is a causal chain; three steps back is a coincidence. Widening the
        // window would make the verdict confident about something it cannot know.
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/long-ago", 500, actionOrder: 1)), failingActionOrder: 4);

        correlation.FailedDuringFailingStep.Should().BeEmpty();
        correlation.FailedDuringPrecedingStep.Should().BeEmpty();
        correlation.FailedElsewhere.Should().ContainSingle();

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "The step failed.", "click", correlation, serverErrors: 1));

        verdict.Confidence.Should().Be(90);
        verdict.LikelyCause.Should().Contain("not made by the step that failed");
    }

    [Fact]
    public void A_previous_steps_refusal_never_overrides_a_locator_miss_either()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/session", 401, actionOrder: 1)), failingActionOrder: 2);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "testId=\"login-submit\" could not be used: No element matched testId=\"login-submit\".",
            "click", correlation, authErrors: 1));

        verdict.Category.Should().Be(FailureCategory.LocatorChange);
    }

    // ---- What the rules do with it -----------------------------------------

    [Fact]
    public void A_server_error_on_the_failing_steps_own_call_names_the_endpoint()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/accounts/acc-1001/transactions", 500, actionOrder: 4)),
            failingActionOrder: 4);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the element to be visible.", "assertVisible", correlation, serverErrors: 1));

        verdict.Category.Should().Be(FailureCategory.ApplicationDefect);
        verdict.Confidence.Should().Be(95, "a correlated finding is stronger than a count");
        verdict.Summary.Should().Contain("the API call it made returned 500");
        verdict.Evidence.Should().Contain("/api/accounts/acc-1001/transactions");
        verdict.IsLikelyApplicationDefect.Should().BeTrue();
    }

    [Fact]
    public void A_correlated_finding_beats_the_uncorrelated_count()
    {
        // Two 500s: one from the step that failed, one from a step that did not. The
        // verdict has to be about the first.
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/dashboard", 500, actionOrder: 1),
            Call("GET", "http://bank/api/statements", 500, actionOrder: 7)), failingActionOrder: 7);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "The step failed.", "click", correlation, serverErrors: 2));

        verdict.Confidence.Should().Be(95);
        verdict.Evidence.Should().Contain("/api/statements");
    }

    [Fact]
    public void An_uncorrelated_server_error_says_it_was_not_this_step()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/dashboard", 500, actionOrder: 1),
            Call("GET", "http://bank/api/accounts", 200, actionOrder: 6)), failingActionOrder: 6);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "The step failed.", "click", correlation, serverErrors: 1));

        verdict.Category.Should().Be(FailureCategory.ApplicationDefect);
        verdict.Confidence.Should().Be(90);
        verdict.LikelyCause.Should().Contain("not made by the step that failed");
        verdict.Evidence.Should().Contain("/api/dashboard");
    }

    [Fact]
    public void A_request_that_never_completed_is_a_network_issue_and_names_it()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("POST", "http://bank/api/payments", null, actionOrder: 5,
                failed: true, failureText: "net::ERR_CONNECTION_REFUSED")), failingActionOrder: 5);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "The step failed.", "click", correlation, networkFailures: 1));

        verdict.Category.Should().Be(FailureCategory.NetworkIssue);
        verdict.Confidence.Should().Be(90);
        verdict.LikelyCause.Should().Contain("/api/payments");
        verdict.LikelyCause.Should().Contain("ERR_CONNECTION_REFUSED");
    }

    [Fact]
    public void A_refused_call_on_the_failing_step_is_an_authentication_issue()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/statements", 403, actionOrder: 8)), failingActionOrder: 8);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the statements table to be visible.", "assertVisible", correlation, authErrors: 1));

        verdict.Category.Should().Be(FailureCategory.AuthenticationIssue);
        verdict.Confidence.Should().Be(90);
        verdict.Summary.Should().Contain("403");
    }

    [Fact]
    public void A_refused_call_never_overrides_a_locator_miss()
    {
        // BUG-0015, guarded again at the correlated level. A signed-out single-page
        // application asks who is signed in and is answered 401; the button is simply gone.
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/session", 401, actionOrder: 2)), failingActionOrder: 2);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "testId=\"login-submit\" could not be used: No element matched testId=\"login-submit\".",
            "click", correlation, authErrors: 1));

        verdict.Category.Should().Be(FailureCategory.LocatorChange);
        verdict.SuggestedAction.Should().NotContain("permissions");
        // And the 401 is still put in front of the reader, now with the call named.
        verdict.Evidence.Should().Contain("/api/session");
    }

    [Fact]
    public void A_client_error_on_the_failing_steps_own_call_is_reported_as_one()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/accounts/acc-1001/transactions", 400, actionOrder: 6)),
            failingActionOrder: 6);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the transactions table to be visible.", "assertVisible", correlation));

        verdict.Category.Should().Be(FailureCategory.ApplicationDefect);
        verdict.Confidence.Should().Be(85);
        verdict.Summary.Should().Contain("rejected with 400");
    }

    [Fact]
    public void An_assertion_that_fails_while_every_call_succeeded_points_at_the_front_end()
    {
        // The most useful thing correlation can say, and the one nothing could say before:
        // the data arrived correctly and the page showed something else.
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/dashboard", 200, actionOrder: 2)), failingActionOrder: 2);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the text \"£74,343.08\" but it read \"£81,796.38\".", "assertText", correlation));

        verdict.Category.Should().Be(FailureCategory.ApplicationDefect);
        verdict.Confidence.Should().Be(80);
        verdict.Summary.Should().Be("The API answered correctly and the page showed something else.");
        verdict.SuggestedAction.Should().Contain("Start with the rendering");
    }

    [Fact]
    public void An_assertion_with_no_api_calls_at_all_falls_through_to_the_ordinary_verdict()
    {
        // Nothing was observed, so nothing may be concluded. A static page failing an
        // assertion is not evidence about anybody's API.
        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the text \"Welcome\" but it read \"Goodbye\".", "assertText", ApiCorrelation.None));

        verdict.Category.Should().Be(FailureCategory.ApplicationDefect);
        verdict.Confidence.Should().Be(70);
        verdict.Summary.Should().Be("An assertion did not hold.");
    }

    [Fact]
    public void A_refusal_is_still_an_authorization_problem_when_nothing_was_correlated()
    {
        // The boundary of the widened negative. That rule needs calls observed around the
        // failing step; with none, an execution-wide 401 is the only evidence there is and
        // it must still be read as a session problem.
        //
        // The neighbouring no-calls test carries no auth errors, so it would keep passing if
        // the "calls were observed" clause were dropped from
        // EveryCallAroundTheFailingStepSucceeded — and every assertion failure would quietly
        // become a front-end defect. This is the test that goes red instead.
        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the text \"Welcome\" but it read \"Please sign in\".",
            "assertText", ApiCorrelation.None, authErrors: 1));

        verdict.Category.Should().Be(FailureCategory.AuthenticationIssue);
        verdict.Summary.Should().Be("The session was not authorised.");
    }

    [Fact]
    public void A_classification_with_no_correlation_behaves_exactly_as_it_did_before()
    {
        // Executions recorded before the link existed still classify. The correlation is
        // additional evidence, not a precondition.
        var withoutCorrelation = DeterministicFailureClassifier.Classify(
            new ClassificationInput(ExecutionStatus.Failed, "The step failed.", false, null,
                0, 1, 0, 0, "click"));

        withoutCorrelation.Category.Should().Be(FailureCategory.ApplicationDefect);
        withoutCorrelation.Confidence.Should().Be(90);
    }

    [Fact]
    public void Blocked_still_outranks_everything_the_api_says()
    {
        // The test never ran. Nothing observed while it was not running says anything about
        // the application's correctness.
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/accounts", 500, actionOrder: 1)), failingActionOrder: 1);

        var verdict = DeterministicFailureClassifier.Classify(
            new ClassificationInput(ExecutionStatus.Blocked, "Preconditions were not met.",
                false, null, 0, 1, 0, 0, "click", correlation));

        verdict.Category.Should().Be(FailureCategory.EnvironmentDefect);
        verdict.IsLikelyApplicationDefect.Should().BeFalse();
    }

    [Fact]
    public void A_verdict_cites_at_most_three_calls()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://bank/api/a", 500, actionOrder: 1),
            Call("GET", "http://bank/api/b", 500, actionOrder: 1),
            Call("GET", "http://bank/api/c", 500, actionOrder: 1),
            Call("GET", "http://bank/api/d", 500, actionOrder: 1),
            Call("GET", "http://bank/api/e", 500, actionOrder: 1)), failingActionOrder: 1);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "The step failed.", "click", correlation, serverErrors: 5));

        // A verdict that lists twenty requests is not a verdict.
        verdict.Evidence.Should().Contain("and 2 more");
    }

    // ---- Where the fetch is attributed must not change the diagnosis -------------
    //
    // COR-005 failed intermittently for two years' worth of runs' worth of reasons that all
    // came down to one: whether a page's fetch lands inside the navigate that started it or
    // the assertion that trips over the result is a matter of milliseconds. The data arrives
    // correctly either way, so the verdict must be the same either way.

    [Fact]
    public void A_wrong_page_is_a_front_end_defect_when_the_failing_step_made_the_calls()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://app/api/session", 200, 2),
            Call("GET", "http://app/api/dashboard", 200, 2)), failingActionOrder: 2);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the element to contain \"£74,343.08\" but it read \"£81,797.38\"",
            "assertText", correlation, authErrors: 1));

        verdict.Category.Should().Be(FailureCategory.ApplicationDefect);
        verdict.Summary.Should().Be("The API answered correctly and the page showed something else.");
    }

    [Fact]
    public void A_wrong_page_is_still_a_front_end_defect_when_the_step_before_made_the_calls()
    {
        // The same execution, with both calls attributed to the navigate instead. This is the
        // shape that produced "The session was not authorised." for a wrong total: the failing
        // step had made no calls of its own, so the negative could not be stated and the
        // verdict fell through to a rule that counts 401s across the whole execution. The 401
        // is the application's own signed-out probe, which every single-page application makes.
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://app/api/session", 200, 1),
            Call("GET", "http://app/api/dashboard", 200, 1)), failingActionOrder: 2);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the element to contain \"£74,343.08\" but it read \"£81,797.38\"",
            "assertText", correlation, authErrors: 1));

        verdict.Category.Should().Be(FailureCategory.ApplicationDefect);
        verdict.Summary.Should().Be("The API answered correctly and the page showed something else.");
        verdict.LikelyCause.Should().Contain("the step before it");
    }

    [Fact]
    public void A_refusal_on_the_failing_step_is_still_an_authorization_problem()
    {
        // The widened negative must not swallow the real thing. Here the call the failing step
        // made was itself refused, which is a session problem and must stay one.
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://app/api/dashboard", 401, 2)), failingActionOrder: 2);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the element to contain \"OK 42\" but it read \"failed\"",
            "assertText", correlation, authErrors: 1));

        verdict.Category.Should().Be(FailureCategory.AuthenticationIssue);
    }

    [Fact]
    public void A_refusal_on_the_preceding_step_is_still_an_authorization_problem()
    {
        var correlation = ApiCorrelation.Build(Completion(
            Call("GET", "http://app/api/dashboard", 403, 1)), failingActionOrder: 2);

        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the element to contain \"OK 42\" but it read \"failed\"",
            "assertText", correlation, authErrors: 1));

        verdict.Category.Should().Be(FailureCategory.AuthenticationIssue);
    }
}
