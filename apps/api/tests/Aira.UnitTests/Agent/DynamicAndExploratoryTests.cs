using Aira.Application.Agent;
using Aira.Domain.Agent;
using Aira.Domain.Enums;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Agent;

/// <summary>
/// Reacting to what a run sees, and what exploration may do.
/// </summary>
/// <remarks>
/// Both are places where the agent does something nobody asked for, so both are held to the
/// same two rules: it may only ever add work rather than widen permission, and everything it
/// produces says where it came from.
/// </remarks>
public class DynamicSelectionModelTests
{
    private static MidRunObservation Observed(
        string where = "POST /api/payment", int? status = null, string? detail = null)
        => new($"call to {where}", where, status, detail);

    [Fact]
    public void A_server_error_mid_run_is_worth_reaching_directly()
    {
        var selections = DynamicSelectionModel.React(
            Observed(status: 500), securityAuthorized: false);

        var selection = selections.Should().ContainSingle().Subject;
        selection.Dimension.Should().Be(TestDimension.Api);
        selection.Risk.Should().Be(RiskLevel.High);
        // What it expects to learn, stated before it runs, so a reader can see whether it did.
        selection.Expectation.Should().Contain("fails on its own or only in the sequence");
    }

    [Fact]
    public void An_authorization_refusal_becomes_a_security_question_where_that_is_authorized()
    {
        var selections = DynamicSelectionModel.React(
            Observed(status: 403), securityAuthorized: true);

        var selection = selections.Should().ContainSingle().Subject;
        selection.Dimension.Should().Be(TestDimension.Security);
        // The interesting question is not whether this test passed. It is whether the control
        // is applied to everybody, and that is a finding rather than a failure.
        selection.Expectation.Should().Contain("which makes it a finding");
    }

    [Fact]
    public void The_same_refusal_without_authorization_says_what_it_cannot_establish()
    {
        var selections = DynamicSelectionModel.React(
            Observed(status: 403), securityAuthorized: false);

        var selection = selections.Should().ContainSingle().Subject;
        selection.Dimension.Should().Be(TestDimension.Api);
        // Saying nothing would leave the most interesting observation of the run unrecorded;
        // saying more than the API check can establish would overstate it.
        selection.Reason.Should().Contain("has not authorized");
        selection.Expectation.Should().Contain("cannot establish anything about other identities");
    }

    [Fact]
    public void An_ordinary_result_triggers_nothing()
    {
        DynamicSelectionModel.React(Observed(status: 200), securityAuthorized: true)
            .Should().BeEmpty();
    }

    [Fact]
    public void Every_selection_carries_the_observation_that_caused_it()
    {
        var observation = Observed(status: 500);

        var selection = DynamicSelectionModel.React(observation, false).Single();

        // "Why is this test here" is the question somebody asks about exactly these, because
        // they are the ones nobody asked for.
        selection.Trigger.Should().BeSameAs(observation);
    }

    [Fact]
    public void Reacting_to_evidence_cannot_become_the_whole_run()
    {
        var selections = Enumerable.Range(1, 40)
            .SelectMany(i => DynamicSelectionModel.React(
                Observed($"POST /api/thing-{i}", 500), false))
            .ToList();

        var bounded = DynamicSelectionModel.Bound(selections, limit: 5);

        // One broken endpoint producing forty 500s should not spend a whole pass on the
        // problem it had already found.
        bounded.Should().HaveCount(5);
    }

    [Fact]
    public void The_same_target_is_not_selected_twice()
    {
        var selections = Enumerable.Range(1, 5)
            .SelectMany(_ => DynamicSelectionModel.React(Observed(status: 500), false))
            .ToList();

        DynamicSelectionModel.Bound(selections, limit: 10).Should().ContainSingle();
    }

    [Fact]
    public void The_riskiest_selections_survive_the_bound()
    {
        var selections = DynamicSelectionModel.React(Observed("POST /api/a", 500), true)
            .Concat(DynamicSelectionModel.React(Observed("GET /api/b", 404, "template"), true))
            .ToList();

        DynamicSelectionModel.Bound(selections, limit: 1)
            .Single().Risk.Should().Be(RiskLevel.High);
    }
}

/// <summary>What an exploratory pass may do, and how it must describe what it found.</summary>
public class ExploratoryModelTests
{
    [Fact]
    public void Exploration_looks_before_it_touches()
    {
        var bounds = ExploratoryBounds.Default;

        bounds.MaySubmitForms.Should().BeFalse();
        bounds.MayBeDestructive.Should().BeFalse();
        ExploratoryModel.Permits(bounds, BrowserActionType.Navigate).Should().BeTrue();
        ExploratoryModel.Permits(bounds, BrowserActionType.Click).Should().BeTrue();
        ExploratoryModel.Permits(bounds, BrowserActionType.Fill).Should().BeFalse();
    }

    [Fact]
    public void What_exploration_may_do_is_a_closed_list_rather_than_a_deny_list()
    {
        var everything = ExploratoryBounds.Default with
        {
            MaySubmitForms = true, MayBeDestructive = true
        };

        // An agent exploring an application it has never seen finds controls nobody
        // anticipated. A deny-list only covers what somebody thought of in advance.
        ExploratoryModel.Permits(everything, BrowserActionType.Download).Should().BeFalse();
        ExploratoryModel.Permits(everything, BrowserActionType.ApiRequest).Should().BeFalse();
    }

    [Fact]
    public void Uploading_needs_both_flags_rather_than_either()
    {
        ExploratoryModel.Permits(
            ExploratoryBounds.Default with { MaySubmitForms = true },
            BrowserActionType.Upload).Should().BeFalse();

        ExploratoryModel.Permits(
            ExploratoryBounds.Default with { MaySubmitForms = true, MayBeDestructive = true },
            BrowserActionType.Upload).Should().BeTrue();
    }

    private static ExploratoryReport Report(
        int explored = 25, int known = 60, bool maySubmit = false, string? stoppedBy = null)
        => ExploratoryModel.Report(
            ExploratoryBounds.Default with { MaySubmitForms = maySubmit },
            explored, known, formsExplored: 4, apisObserved: 12,
            Array.Empty<ExploratoryObservation>(),
            new[] { "Register", "Sign in" },
            new[] { "Sign in with valid credentials" },
            new[] { "/reports renders an empty table with no message" },
            Array.Empty<string>(),
            stoppedBy);

    [Fact]
    public void A_report_says_how_much_it_did_not_reach()
    {
        var report = Report(explored: 25, known: 60);

        // "Explored 25 pages" reads as thorough. "25 of 60" reads accurately, and the
        // difference decides whether somebody runs it again.
        report.Summary.Should().Contain("25 page(s) of 60 known");
        report.NotExplored.Should().Contain(n => n.Contains("35 page(s)"));
    }

    [Fact]
    public void Not_submitting_forms_is_named_as_a_gap_rather_than_left_implicit()
    {
        Report(maySubmit: false).NotExplored.Should().Contain(n =>
            n.Contains("No form was submitted")
            && n.Contains("where most of an application's behaviour lives"));
    }

    [Fact]
    public void Everything_exploration_produces_is_described_as_a_proposal()
    {
        var report = Report();

        // A form that looks like registration is an inference. A candidate journey is not a
        // journey, and a potential defect is not a defect until somebody has looked.
        report.Summary.Should().Contain("Everything here is a proposal");
        report.Summary.Should().Contain("a candidate journey is not a journey");
    }

    [Fact]
    public void A_report_says_which_bound_stopped_it()
    {
        Report(stoppedBy: "it reached its page limit").Summary
            .Should().Contain("stopped because it reached its page limit");
    }

    [Fact]
    public void Exploration_that_reached_everything_still_lists_what_it_cannot_see()
    {
        var report = Report(explored: 60, known: 60);

        report.NotExplored.Should().NotBeEmpty();
        // The permanent one: exploration walks, it does not enumerate.
        report.NotExplored.Should().Contain(n => n.Contains("does not enumerate"));
    }
}

/// <summary>What earns a place in the permanent regression suite.</summary>
public class RegressionPromotionModelTests
{
    private static RegressionCandidate Candidate(
        RegressionOrigin origin, int observed = 1, bool confirmed = false,
        int confidence = 80, bool critical = false)
        => new(origin, "subject", observed, confirmed, confidence, critical);

    [Fact]
    public void A_confirmed_security_finding_is_promoted_without_waiting_for_anybody()
    {
        var decision = RegressionPromotionModel.Evaluate(
            Candidate(RegressionOrigin.ConfirmedSecurityFinding));

        // The one case with no judgement in it. Waiting for a person means the fix ships and
        // nothing watches it.
        decision.Promote.Should().BeTrue();
        decision.NeedsApproval.Should().BeFalse();
        decision.Priority.Should().Be(RiskLevel.Critical);
    }

    [Fact]
    public void A_journey_seen_once_is_not_proposed_at_all()
    {
        var decision = RegressionPromotionModel.Evaluate(
            Candidate(RegressionOrigin.ObservedJourney, observed: 1));

        decision.Promote.Should().BeFalse();
        decision.NeedsApproval.Should().BeFalse();
        decision.Reason.Should().Contain("Once is a coincidence");
    }

    [Fact]
    public void A_journey_that_keeps_holding_up_is_proposed_to_a_person()
    {
        var decision = RegressionPromotionModel.Evaluate(Candidate(
            RegressionOrigin.ObservedJourney,
            observed: RegressionPromotionModel.JourneyObservationsRequired,
            confidence: 85));

        decision.Promote.Should().BeFalse("the platform does not add to the permanent suite on its own authority");
        decision.NeedsApproval.Should().BeTrue();
        decision.Reason.Should().Contain("they are the one who will");
    }

    [Fact]
    public void A_low_confidence_journey_is_not_proposed_however_often_it_is_seen()
    {
        RegressionPromotionModel.Evaluate(Candidate(
            RegressionOrigin.ObservedJourney, observed: 20,
            confidence: RegressionPromotionModel.MinimumConfidence - 1))
            .NeedsApproval.Should().BeFalse();
    }

    [Fact]
    public void A_defect_nobody_has_confirmed_does_not_get_a_test_pinning_it()
    {
        RegressionPromotionModel.Evaluate(
            Candidate(RegressionOrigin.ConfirmedDefect, confirmed: false))
            .Reason.Should().Contain("pins the wrong thing");
    }

    [Fact]
    public void A_repaired_locator_never_becomes_the_specification()
    {
        var decision = RegressionPromotionModel.Evaluate(
            Candidate(RegressionOrigin.ApprovedHealing));

        decision.Promote.Should().BeFalse();
        decision.Reason.Should().Contain("turn the repair into the specification");
    }

    [Fact]
    public void A_security_regression_test_can_never_be_healed()
    {
        // The rule the healer must never be talked out of. A healer that "repairs" a security
        // regression test into passing has not fixed a locator, it has removed the alarm.
        RegressionPromotionModel.MayBeHealed(RegressionOrigin.ConfirmedSecurityFinding)
            .Should().BeFalse();

        RegressionPromotionModel.MayBeHealed(RegressionOrigin.ObservedJourney)
            .Should().BeTrue();
    }
}
