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

    /// <summary>
    /// A dropdown option the test was built from and the page no longer offers.
    ///
    /// Measured: 26 failures on one freight run, every one of them on a select of invoices or
    /// stock items that other tests in the same run had created or consumed. Each was filed
    /// against the application, because nothing classified the symptom and an unclassified
    /// failure is treated as the application's fault.
    /// </summary>
    [Fact]
    public void An_option_the_page_no_longer_offers_is_the_tests_data_not_the_application()
    {
        var verdict = DeterministicFailureClassifier.Classify(Input(
            "Cannot select \"inv-0004\": that option is not offered. The select has 25 option(s): "
            + "\"inv-0011\" (INV-2026-5003 — £4,581.08), \"inv-0012\" (INV-2026-5004 — £912.30)",
            failingAction: "select"));

        verdict.Category.Should().Be(FailureCategory.DataIssue);
        verdict.IsLikelyApplicationDefect.Should().BeFalse();
        verdict.IsHealable.Should().BeFalse("a different option is a different test, not a healed locator");
        verdict.SuggestedAction.Should().Contain("Generate again");
        verdict.Evidence.Should().Contain("not offered",
            "the options the page does offer are the evidence, and they are kept verbatim");
    }

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
