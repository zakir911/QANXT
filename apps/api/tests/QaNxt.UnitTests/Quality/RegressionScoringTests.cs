using QaNxt.Application.Quality;
using QaNxt.Domain.Enums;
using FluentAssertions;

namespace QaNxt.UnitTests.Quality;

/// <summary>The regression selector's score, and the sentence attached to every part of it.
///
/// This is the product's answer to "why did you run these and not those?". A number without
/// that answer is worse than no number: a team that cannot see why a test was skipped has no
/// way to tell a good selection from a broken one, and will find out the expensive way. So
/// these tests assert the reasons as much as the arithmetic.</summary>
public class RegressionScoringTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 22, 12, 0, 0, TimeSpan.Zero);

    private static RegressionCandidate Test(
        string reference = "TC-0001",
        TestPriority priority = TestPriority.Medium,
        RiskLevel risk = RiskLevel.Medium,
        string[]? tags = null,
        string[]? routes = null,
        string[]? apiPaths = null,
        int executionCount = 10,
        int failCount = 0,
        int flakiness = 0,
        ExecutionStatus? lastStatus = ExecutionStatus.Passed,
        DateTimeOffset? lastExecutedAt = null,
        // Separate from a null lastExecutedAt, which the default below would fill in.
        bool neverExecuted = false)
        => new(Guid.NewGuid(), reference, "A test", TestCaseKind.Ui, priority, risk,
            tags ?? Array.Empty<string>(), routes ?? Array.Empty<string>(),
            apiPaths ?? Array.Empty<string>(), executionCount, failCount, flakiness,
            lastStatus, neverExecuted ? null : lastExecutedAt ?? Now.AddHours(-2));

    private static ImpactSet Impact(
        string[]? routes = null, string[]? apis = null, string[]? tags = null,
        string[]? references = null, bool everything = false)
        => new(
            new HashSet<string>(routes ?? Array.Empty<string>(), StringComparer.OrdinalIgnoreCase),
            new HashSet<string>(apis ?? Array.Empty<string>(), StringComparer.OrdinalIgnoreCase),
            new HashSet<string>(tags ?? Array.Empty<string>(), StringComparer.OrdinalIgnoreCase),
            new HashSet<string>(references ?? Array.Empty<string>(), StringComparer.OrdinalIgnoreCase),
            everything);

    private static int Points(ScoredTest scored, string component) =>
        scored.Components.Single(c => c.Name == component).Points;

    // ---- Impact -------------------------------------------------------------

    [Fact]
    public void A_test_that_visits_an_affected_route_scores_the_full_impact_weight()
    {
        var scored = RegressionScoring.Score(
            Test(routes: new[] { "/accounts", "/dashboard" }),
            Impact(routes: new[] { "/accounts" }), Now);

        Points(scored, "impact").Should().Be(RegressionScoring.ImpactWeight);
        scored.IsImpacted.Should().BeTrue();
        scored.Reasons.Should().Contain(reason => reason.Contains("/accounts") && reason.Contains("the change affects"));
    }

    [Fact]
    public void A_test_that_calls_an_affected_endpoint_scores_it_too()
    {
        var scored = RegressionScoring.Score(
            Test(apiPaths: new[] { "/api/accounts/acc-1001/transactions" }),
            Impact(apis: new[] { "/api/accounts/{id}/transactions" }), Now);

        // The affected thing is a template and the test calls a concrete path. Requiring
        // them to be spelled identically would miss every parameterised endpoint.
        Points(scored, "impact").Should().Be(RegressionScoring.ImpactWeight);
        scored.IsImpacted.Should().BeTrue();
    }

    [Fact]
    public void A_tag_match_counts_for_less_than_a_route_match()
    {
        // A tag says the team associates this test with the area. A route says the test
        // goes there. The second is the stronger statement.
        var byTag = RegressionScoring.Score(
            Test(tags: new[] { "payments" }), Impact(tags: new[] { "payments" }), Now);
        var byRoute = RegressionScoring.Score(
            Test(routes: new[] { "/payments" }), Impact(routes: new[] { "/payments" }), Now);

        Points(byTag, "impact").Should().BeLessThan(Points(byRoute, "impact"));
        Points(byTag, "impact").Should().BeGreaterThan(0);
    }

    [Fact]
    public void A_change_to_shared_code_reaches_everything()
    {
        var scored = RegressionScoring.Score(Test(), Impact(everything: true), Now);

        Points(scored, "impact").Should().Be(RegressionScoring.ImpactWeight);
        scored.Reasons.Should().Contain(reason => reason.Contains("shared code"));
    }

    [Fact]
    public void A_test_the_change_does_not_reach_scores_no_impact_and_says_so()
    {
        var scored = RegressionScoring.Score(
            Test(routes: new[] { "/profile" }), Impact(routes: new[] { "/accounts" }), Now);

        Points(scored, "impact").Should().Be(0);
        scored.IsImpacted.Should().BeFalse();
        scored.Components.Single(c => c.Name == "impact").Reason
            .Should().Contain("does not reach");
    }

    [Fact]
    public void A_rule_can_name_one_test_directly()
    {
        var scored = RegressionScoring.Score(
            Test(reference: "TC-0042"), Impact(references: new[] { "TC-0042" }), Now);

        Points(scored, "impact").Should().Be(RegressionScoring.ImpactWeight);
        scored.Reasons.Should().Contain(reason => reason.Contains("names TC-0042 directly"));
    }

    // ---- Risk, history, staleness, always ----------------------------------

    [Fact]
    public void Risk_rises_with_priority_and_with_risk_level()
    {
        var low = RegressionScoring.Score(Test(priority: TestPriority.Low, risk: RiskLevel.Low), ImpactSet.Empty, Now);
        var high = RegressionScoring.Score(Test(priority: TestPriority.High, risk: RiskLevel.High), ImpactSet.Empty, Now);
        var critical = RegressionScoring.Score(Test(priority: TestPriority.Critical, risk: RiskLevel.Critical), ImpactSet.Empty, Now);

        Points(low, "risk").Should().BeLessThan(Points(high, "risk"));
        Points(high, "risk").Should().BeLessThan(Points(critical, "risk"));
        Points(critical, "risk").Should().Be(RegressionScoring.RiskWeight);
    }

    [Fact]
    public void A_test_that_failed_last_time_is_worth_running_again()
    {
        var scored = RegressionScoring.Score(
            Test(lastStatus: ExecutionStatus.Failed, failCount: 3), ImpactSet.Empty, Now);

        Points(scored, "history").Should().BeGreaterThan(0);
        scored.Reasons.Should().Contain(reason => reason.Contains("failed last time"));
    }

    [Fact]
    public void An_unstable_test_scores_for_its_instability()
    {
        var scored = RegressionScoring.Score(Test(flakiness: 45), ImpactSet.Empty, Now);

        Points(scored, "history").Should().BeGreaterThan(0);
        scored.Reasons.Should().Contain(reason => reason.Contains("unstable"));
    }

    [Fact]
    public void A_test_that_has_never_run_is_not_treated_as_clean()
    {
        // Never executed is the state in which least is known, not the state in which
        // nothing is wrong.
        var scored = RegressionScoring.Score(
            Test(executionCount: 0, lastStatus: null, neverExecuted: true), ImpactSet.Empty, Now);

        Points(scored, "history").Should().BeGreaterThan(0);
        Points(scored, "staleness").Should().Be(RegressionScoring.StalenessWeight);
        scored.Reasons.Should().Contain(reason => reason.Contains("never run"));
    }

    [Fact]
    public void A_stable_test_run_recently_scores_nothing_for_history_or_staleness()
    {
        var scored = RegressionScoring.Score(
            Test(executionCount: 50, failCount: 0, lastExecutedAt: Now.AddMinutes(-30)),
            ImpactSet.Empty, Now);

        Points(scored, "history").Should().Be(0);
        Points(scored, "staleness").Should().Be(0);
    }

    [Fact]
    public void Staleness_rises_with_time_and_stops_at_its_ceiling()
    {
        var fresh = RegressionScoring.Score(Test(lastExecutedAt: Now.AddHours(-2)), ImpactSet.Empty, Now);
        var week = RegressionScoring.Score(Test(lastExecutedAt: Now.AddDays(-7)), ImpactSet.Empty, Now);
        var month = RegressionScoring.Score(Test(lastExecutedAt: Now.AddDays(-60)), ImpactSet.Empty, Now);

        Points(fresh, "staleness").Should().Be(0);
        Points(week, "staleness").Should().BeInRange(1, RegressionScoring.StalenessWeight - 1);
        Points(month, "staleness").Should().Be(RegressionScoring.StalenessWeight);
    }

    [Fact]
    public void A_smoke_test_always_scores_the_always_component()
    {
        foreach (var tag in new[] { "smoke", "critical", "always", "SMOKE" })
        {
            var scored = RegressionScoring.Score(Test(tags: new[] { tag }), ImpactSet.Empty, Now);
            Points(scored, "always").Should().Be(RegressionScoring.AlwaysWeight, $"of the tag {tag}");
        }
    }

    // ---- The whole score ----------------------------------------------------

    [Fact]
    public void Every_component_is_reported_whether_or_not_it_contributed()
    {
        var scored = RegressionScoring.Score(Test(), ImpactSet.Empty, Now);

        scored.Components.Select(c => c.Name).Should()
            .BeEquivalentTo(new[] { "impact", "risk", "history", "staleness", "always" });
        scored.Components.Should().OnlyContain(c => c.Reason.Length > 0 && c.Maximum > 0);
    }

    [Fact]
    public void Only_the_components_that_contributed_become_reasons()
    {
        // "history: 0, this test has never failed" is noise dressed as transparency.
        var scored = RegressionScoring.Score(
            Test(routes: new[] { "/accounts" }, executionCount: 50,
                lastExecutedAt: Now.AddMinutes(-10)),
            Impact(routes: new[] { "/accounts" }), Now);

        scored.Reasons.Should().HaveCount(2);
        scored.Reasons.Should().Contain(reason => reason.Contains("/accounts"));
        scored.Reasons.Should().Contain(reason => reason.Contains("Priority"));
    }

    [Fact]
    public void A_test_with_nothing_to_argue_for_it_says_that_rather_than_nothing()
    {
        var scored = RegressionScoring.Score(
            Test(priority: TestPriority.Low, risk: RiskLevel.Low, executionCount: 50,
                lastExecutedAt: Now.AddMinutes(-10)),
            ImpactSet.Empty, Now);

        // Risk always contributes something, so this is the floor rather than zero.
        scored.Reasons.Should().NotBeEmpty();
        scored.Score.Should().BeLessThan(RegressionScoring.ImpactWeight);
    }

    [Fact]
    public void The_score_is_the_sum_of_its_components_and_never_exceeds_a_hundred()
    {
        var scored = RegressionScoring.Score(
            Test(priority: TestPriority.Critical, risk: RiskLevel.Critical,
                tags: new[] { "smoke" }, routes: new[] { "/accounts" },
                executionCount: 10, failCount: 8, flakiness: 60,
                lastStatus: ExecutionStatus.Failed, lastExecutedAt: Now.AddDays(-30)),
            Impact(routes: new[] { "/accounts" }), Now);

        scored.Components.Sum(c => c.Points).Should().BeGreaterThanOrEqualTo(100);
        scored.Score.Should().Be(100);
    }

    [Fact]
    public void An_impacted_test_always_outranks_an_unimpacted_one_of_the_same_kind()
    {
        var impacted = RegressionScoring.Score(
            Test(routes: new[] { "/accounts" }), Impact(routes: new[] { "/accounts" }), Now);
        var not = RegressionScoring.Score(
            Test(routes: new[] { "/profile" }), Impact(routes: new[] { "/accounts" }), Now);

        impacted.Score.Should().BeGreaterThan(not.Score);
    }
}

/// <summary>The glob that maps repository paths to what they affect. Small on purpose: a
/// pattern language rich enough to surprise someone is a liability in the thing that
/// decides which tests to skip.</summary>
public class PathGlobTests
{
    [Theory]
    [InlineData("src/pages/accounts/**", "src/pages/accounts/List.tsx", true)]
    [InlineData("src/pages/accounts/**", "src/pages/accounts/detail/View.tsx", true)]
    [InlineData("src/pages/accounts/**", "src/pages/payments/List.tsx", false)]
    [InlineData("src/api/*.ts", "src/api/accounts.ts", true)]
    [InlineData("src/api/*.ts", "src/api/nested/accounts.ts", false)]
    [InlineData("**/*.css", "src/styles/app.css", true)]
    [InlineData("**/*.css", "app.css", true)]
    [InlineData("package.json", "package.json", true)]
    [InlineData("src/**/migrations/**", "src/db/migrations/001.sql", true)]
    [InlineData("SRC/Pages/**", "src/pages/List.tsx", true)]
    public void Matches_what_a_reader_would_expect(string pattern, string path, bool expected)
    {
        PathGlob.Matches(pattern, path).Should().Be(expected);
    }

    [Fact]
    public void Handles_leading_dots_and_backslashes()
    {
        PathGlob.Matches("src/**", "./src/app.ts").Should().BeTrue();
        PathGlob.Matches("src/**", "src\\app.ts").Should().BeTrue();
    }

    [Fact]
    public void An_empty_pattern_matches_nothing_rather_than_everything()
    {
        // A rule saved with a blank pattern must not quietly select the whole suite.
        PathGlob.Matches("", "anything").Should().BeFalse();
        PathGlob.Matches("   ", "anything").Should().BeFalse();
    }

    [Fact]
    public void A_pattern_is_anchored_at_both_ends()
    {
        PathGlob.Matches("src/app.ts", "other/src/app.ts").Should().BeFalse();
        PathGlob.Matches("src/app.ts", "src/app.ts.bak").Should().BeFalse();
    }
}
