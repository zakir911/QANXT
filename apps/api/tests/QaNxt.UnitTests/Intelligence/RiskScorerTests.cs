using QaNxt.Application.Intelligence;
using QaNxt.Domain.Enums;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Intelligence;

/// <summary>The risk score decides what the autonomous agent works on first, so the order
/// it produces is the product. These assert the judgements the weights encode, not the
/// arithmetic — if a weight changes and the ordering stays right, these still pass.</summary>
public class RiskScorerTests
{
    private static RiskSignals Signals(Action<RiskSignalsBuilder>? configure = null)
    {
        var builder = new RiskSignalsBuilder();
        configure?.Invoke(builder);
        return builder.Build();
    }

    private sealed class RiskSignalsBuilder
    {
        public string Route { get; set; } = "/some-page";
        public PageKind Kind { get; set; } = PageKind.Unknown;
        public bool RequiresAuthentication { get; set; }
        public int InputElementCount { get; set; }
        public int ActionElementCount { get; set; }
        public int SensitiveInputCount { get; set; }
        public int CoveringTestCount { get; set; } = 1;
        public int AssertionCount { get; set; } = 3;
        public int RecentExecutionCount { get; set; } = 10;
        public int RecentFailureCount { get; set; }
        public int RecentFlakyCount { get; set; }
        public int OpenDefectCount { get; set; }
        public int ConsoleErrorCount { get; set; }
        public int InboundTransitionCount { get; set; }
        public int LoadTimeMs { get; set; } = 400;
        public int ChangedElementCount { get; set; }

        public RiskSignals Build() => new()
        {
            Route = Route, Kind = Kind, RequiresAuthentication = RequiresAuthentication,
            InputElementCount = InputElementCount, ActionElementCount = ActionElementCount,
            SensitiveInputCount = SensitiveInputCount, CoveringTestCount = CoveringTestCount,
            AssertionCount = AssertionCount, RecentExecutionCount = RecentExecutionCount,
            RecentFailureCount = RecentFailureCount, RecentFlakyCount = RecentFlakyCount,
            OpenDefectCount = OpenDefectCount, ConsoleErrorCount = ConsoleErrorCount,
            InboundTransitionCount = InboundTransitionCount, LoadTimeMs = LoadTimeMs,
            ChangedElementCount = ChangedElementCount
        };
    }

    [Fact]
    public void A_healthy_well_covered_page_scores_near_zero()
    {
        var assessment = RiskScorer.Score(Signals());

        assessment.Score.Should().BeLessThan(20);
        assessment.Level.Should().Be(RiskLevel.Low);
        assessment.Recommendation.Should().BeNull();
    }

    [Fact]
    public void An_untested_route_is_always_worth_attention()
    {
        var assessment = RiskScorer.Score(Signals(s => s.CoveringTestCount = 0));

        assessment.Factors.Should().Contain(f => f.Name == "No test coverage");
        assessment.Recommendation.Should().Contain("Generate a test");
    }

    [Fact]
    public void A_test_that_asserts_nothing_counts_as_a_coverage_gap()
    {
        // The platform already refuses to let a journey with no assertions look like a
        // passing test; the risk model has to agree with that.
        var assessment = RiskScorer.Score(Signals(s => { s.CoveringTestCount = 2; s.AssertionCount = 0; }));

        assessment.Factors.Should().Contain(f => f.Name == "Coverage without assertions");
        assessment.Recommendation.Should().Contain("assertions");
    }

    [Fact]
    public void An_untested_payment_form_outranks_a_flaky_read_only_page()
    {
        // The judgement the weights exist to encode: cost of failure beats frequency.
        var paymentForm = RiskScorer.Score(Signals(s =>
        {
            s.Route = "/payments";
            s.Kind = PageKind.Form;
            s.RequiresAuthentication = true;
            s.InputElementCount = 6;
            s.ActionElementCount = 2;
            s.SensitiveInputCount = 2;
            s.CoveringTestCount = 0;
        }));

        var flakyPage = RiskScorer.Score(Signals(s =>
        {
            s.Route = "/about";
            s.RecentFailureCount = 3;
            s.RecentFlakyCount = 3;
        }));

        paymentForm.Score.Should().BeGreaterThan(flakyPage.Score);
        paymentForm.Level.Should().BeOneOf(RiskLevel.Critical, RiskLevel.High);
    }

    [Fact]
    public void The_sign_in_page_carries_weight_because_everything_depends_on_it()
    {
        var login = RiskScorer.Score(Signals(s => { s.Route = "/login"; s.Kind = PageKind.Login; }));
        var ordinary = RiskScorer.Score(Signals(s => s.Route = "/help"));

        login.Score.Should().BeGreaterThan(ordinary.Score);
        login.Factors.Should().Contain(f => f.Name == "Authentication boundary");
    }

    [Fact]
    public void Every_point_awarded_is_attributed_to_a_named_factor()
    {
        // A score nobody can explain is a score nobody acts on.
        var assessment = RiskScorer.Score(Signals(s =>
        {
            s.Kind = PageKind.Form;
            s.CoveringTestCount = 0;
            s.InputElementCount = 4;
            s.ConsoleErrorCount = 2;
        }));

        assessment.Factors.Should().NotBeEmpty();
        assessment.Factors.Sum(f => f.Points).Should().Be(assessment.Score);
        assessment.Factors.Should().OnlyContain(f => !string.IsNullOrWhiteSpace(f.Explanation));
    }

    [Fact]
    public void Factors_are_ordered_so_the_biggest_reason_is_read_first()
    {
        var assessment = RiskScorer.Score(Signals(s =>
        {
            s.CoveringTestCount = 0;
            s.ConsoleErrorCount = 1;
            s.LoadTimeMs = 4000;
        }));

        assessment.Factors.Should().BeInDescendingOrder(f => f.Points);
    }

    [Fact]
    public void The_score_is_capped_rather_than_running_away()
    {
        var worst = RiskScorer.Score(Signals(s =>
        {
            s.Kind = PageKind.Login;
            s.RequiresAuthentication = true;
            s.InputElementCount = 50;
            s.ActionElementCount = 50;
            s.SensitiveInputCount = 50;
            s.CoveringTestCount = 0;
            s.RecentExecutionCount = 10;
            s.RecentFailureCount = 10;
            s.RecentFlakyCount = 10;
            s.OpenDefectCount = 10;
            s.ConsoleErrorCount = 50;
            s.InboundTransitionCount = 50;
            s.LoadTimeMs = 60_000;
            s.ChangedElementCount = 50;
        }));

        worst.Score.Should().Be(100);
        worst.Level.Should().Be(RiskLevel.Critical);
    }

    [Fact]
    public void Scoring_is_deterministic()
    {
        // A number that moves on its own cannot be used to prioritise anything.
        var signals = Signals(s => { s.Kind = PageKind.Form; s.CoveringTestCount = 0; s.ConsoleErrorCount = 3; });

        var first = RiskScorer.Score(signals);
        var second = RiskScorer.Score(signals);

        second.Score.Should().Be(first.Score);
        second.Summary.Should().Be(first.Summary);
        second.Factors.Select(f => f.Name).Should().Equal(first.Factors.Select(f => f.Name));
    }

    [Fact]
    public void A_failure_rate_raises_the_score_in_proportion_to_it()
    {
        var occasional = RiskScorer.Score(Signals(s => { s.RecentExecutionCount = 10; s.RecentFailureCount = 1; }));
        var constant = RiskScorer.Score(Signals(s => { s.RecentExecutionCount = 10; s.RecentFailureCount = 9; }));

        constant.Score.Should().BeGreaterThan(occasional.Score);
    }

    [Theory]
    [InlineData(0, RiskLevel.Low)]
    [InlineData(19, RiskLevel.Low)]
    [InlineData(20, RiskLevel.Medium)]
    [InlineData(44, RiskLevel.Medium)]
    [InlineData(45, RiskLevel.High)]
    [InlineData(69, RiskLevel.High)]
    [InlineData(70, RiskLevel.Critical)]
    [InlineData(100, RiskLevel.Critical)]
    public void Levels_have_stable_boundaries(int score, RiskLevel expected)
        => RiskScorer.LevelOf(score).Should().Be(expected);
}
