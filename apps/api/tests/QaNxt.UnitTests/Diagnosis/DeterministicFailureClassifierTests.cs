using QaNxt.Application.Diagnosis;
using QaNxt.Domain.Enums;
using FluentAssertions;

namespace QaNxt.UnitTests.Diagnosis;

/// <summary>The rules that decide what a failure is called, and in what order they win.
///
/// This classifier is the first thing a person reads about a failed run, and twice now it
/// has been wrong in a way that sent a reader to the wrong place — once by matching on
/// message prose the engine had stopped producing (BUG-0012), once by treating a signed-out
/// page's own 401 as evidence about a missing button (BUG-0015). Both were found by driving
/// the whole product; neither would have survived these tests.</summary>
public class DeterministicFailureClassifierTests
{
    private static ClassificationInput Input(
        string message,
        string? failingAction = null,
        int serverErrors = 0,
        int authErrors = 0,
        int networkFailures = 0,
        int consoleErrors = 0,
        bool healingAttempted = false,
        int? healingConfidence = null,
        ExecutionStatus status = ExecutionStatus.Failed)
        => new(status, message, healingAttempted, healingConfidence,
            consoleErrors, serverErrors, authErrors, networkFailures, failingAction);

    [Fact]
    public void A_missing_element_is_a_locator_change_even_when_the_signed_out_page_answered_401()
    {
        // The bank asks "is anyone signed in?" as it loads and is answered 401 when nobody
        // is. That is the sign-in page working, not a symptom of anything.
        var verdict = DeterministicFailureClassifier.Classify(Input(
            "testId=\"login-submit\" could not be used: No element matched testId=\"login-submit\".",
            failingAction: "click", authErrors: 2));

        verdict.Category.Should().Be(FailureCategory.LocatorChange);
        verdict.SuggestedAction.Should().NotContain("permissions");
    }

    [Fact]
    public void The_401_responses_are_still_shown_to_the_reader_as_context()
    {
        // A session that really did expire produces the same symptom — the page becomes the
        // sign-in page and the element vanishes. Suppressing the evidence would trade one
        // wrong answer for another.
        var verdict = DeterministicFailureClassifier.Classify(Input(
            "No element matched testId=\"download-statement\".", failingAction: "click", authErrors: 3));

        verdict.Evidence.Should().Contain("3 request(s) also returned 401 or 403");
    }

    [Fact]
    public void An_assertion_that_failed_while_the_application_returned_401_is_still_an_authentication_issue()
    {
        // Nothing here says the element was missing, so the auth evidence is the best on offer.
        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the element to contain \"OK 42\" but it read \"failed\".",
            failingAction: "assertText", authErrors: 1));

        verdict.Category.Should().Be(FailureCategory.AuthenticationIssue);
    }

    [Fact]
    public void A_server_error_outranks_a_missing_element()
    {
        // A 5xx is a real fault rather than routine traffic: the element is probably absent
        // *because* the page failed to render.
        var verdict = DeterministicFailureClassifier.Classify(Input(
            "No element matched testId=\"outcome\".", failingAction: "click", serverErrors: 1, authErrors: 1));

        verdict.Category.Should().Be(FailureCategory.ApplicationDefect);
        verdict.IsLikelyApplicationDefect.Should().BeTrue();
    }

    [Fact]
    public void A_network_level_failure_is_reported_from_the_network_evidence_not_the_message()
    {
        // The page caught the dropped request and rendered "failed", so the step's message
        // says nothing network-ish at all (BUG-0012).
        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Expected the element to contain \"OK 42\" but it read \"failed\".",
            failingAction: "assertText", networkFailures: 2));

        verdict.Category.Should().Be(FailureCategory.NetworkIssue);
    }

    [Fact]
    public void An_assertion_failure_is_recognised_by_its_action_rather_than_its_wording()
    {
        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Something the engine has never said before.", failingAction: "assertText"));

        verdict.Category.Should().NotBe(FailureCategory.Unknown);
    }

    [Fact]
    public void An_ambiguous_locator_is_a_test_defect_rather_than_a_change_in_the_application()
    {
        var verdict = DeterministicFailureClassifier.Classify(Input(
            "testId=\"row-action\" matched 4 elements.", failingAction: "click"));

        verdict.Category.Should().Be(FailureCategory.TestDefect);
        verdict.IsHealable.Should().BeFalse();
    }

    [Fact]
    public void A_run_that_never_started_is_an_environment_problem_and_implies_nothing_about_the_application()
    {
        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Sign-in failed.", status: ExecutionStatus.Blocked, authErrors: 1));

        verdict.Category.Should().Be(FailureCategory.EnvironmentDefect);
        verdict.IsLikelyApplicationDefect.Should().BeFalse();
    }
}
