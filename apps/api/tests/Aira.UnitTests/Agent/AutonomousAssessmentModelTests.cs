using Aira.Application.Agent;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Agent;

/// <summary>
/// What an autonomous run is allowed to say about a release.
/// </summary>
/// <remarks>
/// The brief forbids a mysterious overall score as the primary result, and the reason is in
/// these tests: every verdict here traces to named facts somebody can disagree with. The
/// verdict guarded hardest is NotAssessed — a run that executed almost nothing has found
/// nothing, and every other value in the enum would be read as a statement about the
/// application rather than about the run.
/// </remarks>
public class AutonomousAssessmentModelTests
{
    private static AssessmentInputs Inputs(
        int functional = 100, int functionalPassed = 100, int functionalFailed = 0,
        int api = 40, int apiPassed = 40, int apiFailed = 0,
        bool scanned = true, int critical = 0, int high = 0, int medium = 0, int regressions = 0,
        bool accessibility = true, int violations = 0,
        bool visual = true, int differences = 0,
        int criticalJourneysFailed = 0,
        bool gateConfigured = true, bool gatePassed = true,
        IReadOnlyList<string>? untested = null)
        => new(functional, functionalPassed, functionalFailed,
            api, apiPassed, apiFailed,
            scanned, critical, high, medium, regressions,
            accessibility, violations, visual, differences,
            criticalJourneysFailed, gateConfigured, gatePassed,
            untested ?? new[] { "Anything discovery did not reach." });

    // ---- The verdict that matters most ---------------------------------------

    [Fact]
    public void A_pass_that_executed_nothing_is_not_assessed_rather_than_clear()
    {
        var assessment = AutonomousAssessmentModel.Assess(
            Inputs(functional: 0, functionalPassed: 0, api: 0, apiPassed: 0, scanned: false));

        // Arithmetically there is nothing wrong, which is exactly the trap. Zero failures out
        // of zero tests is not a clean release.
        assessment.Verdict.Should().Be(ReleaseVerdict.NotAssessed);
        assessment.Summary.Should().Contain("statement about the run, not about the application");
        assessment.Summary.Should().Contain("not a clean result");
    }

    [Fact]
    public void A_pass_that_only_scanned_can_still_be_assessed()
    {
        var assessment = AutonomousAssessmentModel.Assess(
            Inputs(functional: 0, functionalPassed: 0, api: 0, apiPassed: 0, scanned: true));

        assessment.Verdict.Should().NotBe(ReleaseVerdict.NotAssessed);
    }

    // ---- Blocking ---------------------------------------------------------------

    [Fact]
    public void An_open_critical_security_finding_blocks_and_is_named()
    {
        var assessment = AutonomousAssessmentModel.Assess(Inputs(critical: 1));

        assessment.Verdict.Should().Be(ReleaseVerdict.Blocked);
        assessment.BlockingFactors.Should().Contain(f => f.Contains("critical security finding"));
    }

    [Fact]
    public void A_security_regression_blocks_whatever_its_severity()
    {
        var assessment = AutonomousAssessmentModel.Assess(Inputs(regressions: 1));

        assessment.Verdict.Should().Be(ReleaseVerdict.Blocked);
        assessment.BlockingFactors.Should().Contain(f => f.Contains("have come back"));
    }

    [Fact]
    public void A_failed_critical_journey_blocks()
    {
        AutonomousAssessmentModel.Assess(Inputs(criticalJourneysFailed: 2))
            .Verdict.Should().Be(ReleaseVerdict.Blocked);
    }

    [Fact]
    public void A_configured_gate_that_did_not_pass_blocks()
    {
        AutonomousAssessmentModel.Assess(Inputs(gateConfigured: true, gatePassed: false))
            .Verdict.Should().Be(ReleaseVerdict.Blocked);
    }

    [Fact]
    public void A_gate_nobody_configured_does_not_block()
    {
        AutonomousAssessmentModel.Assess(Inputs(gateConfigured: false, gatePassed: false))
            .Verdict.Should().Be(ReleaseVerdict.Clear);
    }

    // ---- Review -------------------------------------------------------------------

    [Fact]
    public void Failures_send_a_release_to_review_rather_than_blocking_it()
    {
        var assessment = AutonomousAssessmentModel.Assess(
            Inputs(functionalPassed: 95, functionalFailed: 5));

        assessment.Verdict.Should().Be(ReleaseVerdict.NeedsReview);
        assessment.Summary.Should().Contain("a person decides");
    }

    [Fact]
    public void A_pass_with_no_security_scan_goes_to_review_however_green_it_is()
    {
        var assessment = AutonomousAssessmentModel.Assess(Inputs(scanned: false));

        // Everything functional passed. Nothing is known about security, and a clean verdict
        // would be read as covering it.
        assessment.Verdict.Should().Be(ReleaseVerdict.NeedsReview);
        assessment.Lines.Single(l => l.Area == "Security").Measured.Should().BeFalse();
    }

    [Fact]
    public void An_unscanned_release_says_not_security_tested_in_its_first_two_words()
    {
        var security = AutonomousAssessmentModel.Assess(Inputs(scanned: false))
            .Lines.Single(l => l.Area == "Security");

        security.Detail.Should().StartWith("NOT SECURITY TESTED");
        security.Detail.Should().Contain("not the same as having been tested and found clean");
    }

    // ---- Clear -----------------------------------------------------------------------

    [Fact]
    public void A_clean_result_never_says_the_application_is_correct_or_secure()
    {
        var assessment = AutonomousAssessmentModel.Assess(Inputs());

        assessment.Verdict.Should().Be(ReleaseVerdict.Clear);
        assessment.Summary.Should().Contain("Within the scope and coverage of this pass");
        assessment.Summary.Should().Contain("not a statement that the application is correct or secure");
        assessment.Summary.Should().Contain("untested rather than clean");
    }

    [Fact]
    public void Every_area_says_whether_it_was_measured()
    {
        var assessment = AutonomousAssessmentModel.Assess(
            Inputs(accessibility: false, visual: false));

        // A threshold compared against a value nobody measured reads as a guarantee. Each
        // line says which it was rather than leaving a zero to be read as good news.
        assessment.Lines.Single(l => l.Area == "Accessibility").Measured.Should().BeFalse();
        assessment.Lines.Single(l => l.Area == "Visual").Measured.Should().BeFalse();
        assessment.Lines.Should().OnlyContain(l => !string.IsNullOrWhiteSpace(l.Detail));
    }

    [Fact]
    public void Untested_areas_travel_with_the_assessment()
    {
        var assessment = AutonomousAssessmentModel.Assess(
            Inputs(untested: new[] { "The admin area, which a person excluded." }));

        assessment.UntestedAreas.Should().Contain(u => u.Contains("admin area"));
    }

    [Fact]
    public void There_is_no_overall_score_anywhere_in_the_result()
    {
        var assessment = AutonomousAssessmentModel.Assess(Inputs());

        // Asserted on the type rather than on the text: a single number is what everybody
        // reads and nobody can act on, and adding one later should have to break this.
        typeof(AutonomousAssessment).GetProperties()
            .Select(p => p.Name)
            .Should().NotContain(n =>
                n.Contains("Score", StringComparison.OrdinalIgnoreCase)
                || n.Contains("Rating", StringComparison.OrdinalIgnoreCase));
        assessment.Should().NotBeNull();
    }

    [Fact]
    public void Blocking_factors_are_named_rather_than_folded_into_the_verdict()
    {
        var assessment = AutonomousAssessmentModel.Assess(
            Inputs(critical: 1, criticalJourneysFailed: 1, gatePassed: false));

        assessment.BlockingFactors.Should().HaveCount(3);
        assessment.Summary.Should().Contain("a number cannot be argued with and these can");
    }
}
