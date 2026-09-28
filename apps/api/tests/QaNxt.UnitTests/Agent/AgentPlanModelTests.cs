using QaNxt.Application.Agent;
using QaNxt.Domain.Agent;
using QaNxt.Domain.Enums;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Agent;

/// <summary>
/// What the agent proposes to test, before it tests anything.
/// </summary>
/// <remarks>
/// This is the screen where a person authorizes work against a live environment, so the plan
/// has to be arguable: every number traceable to something countable, every category carrying
/// the sentence that put it there, and the uncovered half named rather than left to be
/// inferred from absence.
/// </remarks>
public class AgentPlanModelTests
{
    private static PlanningInputs Inputs(
        int pages = 18, int endpoints = 42, int journeys = 12, int roles = 5, int forms = 8,
        int uploads = 3, bool securityAuthorized = true, int openFindings = 0,
        int recentFailures = 0,
        IReadOnlyList<string>? critical = null, IReadOnlyList<string>? excluded = null,
        IReadOnlyDictionary<TestDimension, int>? gaps = null,
        IReadOnlyDictionary<TestDimension, int>? existing = null,
        IReadOnlyDictionary<TestDimension, int>? observed = null)
        => new("Release validation", pages, endpoints, journeys, roles, forms, uploads,
            gaps ?? new Dictionary<TestDimension, int>(),
            existing ?? new Dictionary<TestDimension, int>(),
            critical ?? Array.Empty<string>(),
            excluded ?? Array.Empty<string>(),
            securityAuthorized, openFindings, recentFailures,
            observed ?? new Dictionary<TestDimension, int>());

    // ---- The shape of a plan --------------------------------------------------

    [Fact]
    public void A_discovered_application_produces_a_plan_across_categories()
    {
        var plan = AgentPlanModel.Build(Inputs());

        plan.Categories.Should().NotBeEmpty();
        plan.Categories.Select(c => c.Category).Should().Contain(new[]
        {
            AgentPlanCategory.Smoke, AgentPlanCategory.CriticalJourney,
            AgentPlanCategory.Api, AgentPlanCategory.Security,
            AgentPlanCategory.Accessibility, AgentPlanCategory.Visual
        });
        plan.TotalTests.Should().BeGreaterThan(0);
    }

    [Fact]
    public void Every_category_says_why_it_is_there_in_a_sentence()
    {
        var plan = AgentPlanModel.Build(Inputs());

        foreach (var category in plan.Categories)
        {
            // A category with a count and no reason is a number somebody has to take on faith,
            // which is the opposite of what this screen is for.
            category.Why.Should().NotBeNullOrWhiteSpace();
            category.Why.Length.Should().BeGreaterThan(20);
            category.Coverage.Should().NotBeNullOrWhiteSpace();
            category.PotentialImpact.Should().NotBeNullOrWhiteSpace();
        }
    }

    [Fact]
    public void The_plan_is_the_same_every_time_for_the_same_inputs()
    {
        var inputs = Inputs();

        var first = AgentPlanModel.Build(inputs);
        var second = AgentPlanModel.Build(inputs);

        // An operator cannot argue with a plan that changes between two identical runs, and
        // this is the property a model-written plan would not have.
        first.TotalTests.Should().Be(second.TotalTests);
        first.Summary.Should().Be(second.Summary);
        first.Categories.Select(c => (c.Category, c.TestCount))
            .Should().Equal(second.Categories.Select(c => (c.Category, c.TestCount)));
    }

    // ---- Business context ------------------------------------------------------

    [Fact]
    public void Areas_a_person_called_critical_raise_the_journey_category_to_critical()
    {
        var withContext = AgentPlanModel.Build(
            Inputs(critical: new[] { "payment", "login" }));
        var without = AgentPlanModel.Build(Inputs());

        var withRisk = withContext.Categories
            .Single(c => c.Category == AgentPlanCategory.CriticalJourney);
        var withoutRisk = without.Categories
            .Single(c => c.Category == AgentPlanCategory.CriticalJourney);

        withRisk.Risk.Should().Be(RiskLevel.Critical);
        withRisk.Why.Should().Contain("payment");
        withoutRisk.Risk.Should().Be(RiskLevel.High);
    }

    [Fact]
    public void Naming_a_critical_area_is_enough_even_with_no_journey_recorded()
    {
        var plan = AgentPlanModel.Build(Inputs(journeys: 0, critical: new[] { "payment" }));

        // Journeys are recorded by the recorder and by generation, never by discovery, so a
        // freshly crawled application has none. The first version only proposed journey tests
        // when some were already stored — so an operator could write "payment is critical",
        // watch the plan come back without a journey category, and have no way to tell their
        // instruction had gone nowhere. A golden test against a freshly discovered lab caught it.
        var journey = plan.Categories.Single(c => c.Category == AgentPlanCategory.CriticalJourney);
        journey.Risk.Should().Be(RiskLevel.Critical);
        journey.Why.Should().Contain("payment");
        journey.Why.Should().Contain("better than ignoring what somebody told us matters");
    }

    [Fact]
    public void Covering_a_named_area_without_a_recorded_journey_says_it_is_the_weaker_thing()
    {
        var plan = AgentPlanModel.Build(Inputs(journeys: 0, critical: new[] { "payment" }));

        plan.NotCovered.Should().Contain(n =>
            n.Contains("nothing here follows a path a real user was seen to take"));
    }

    [Fact]
    public void No_journeys_and_nobody_naming_any_is_stated_as_a_gap()
    {
        var plan = AgentPlanModel.Build(Inputs(journeys: 0, critical: Array.Empty<string>()));

        plan.Categories.Should().NotContain(c => c.Category == AgentPlanCategory.CriticalJourney);
        // The plan covers pages and endpoints. Saying so is what stops it reading as coverage
        // of what people use the application for.
        plan.NotCovered.Should().Contain(n => n.Contains("Business journeys"));
    }

    [Fact]
    public void With_nobody_saying_what_matters_the_plan_admits_it_is_guessing()
    {
        var plan = AgentPlanModel.Build(Inputs(critical: Array.Empty<string>()));

        plan.Categories.Single(c => c.Category == AgentPlanCategory.CriticalJourney)
            .Why.Should().Contain("a guess rather than a priority");
    }

    [Fact]
    public void Excluded_areas_are_named_in_what_the_plan_does_not_cover()
    {
        var plan = AgentPlanModel.Build(Inputs(excluded: new[] { "/admin/delete" }));

        plan.NotCovered.Should().Contain(n => n.Contains("/admin/delete"));
        plan.NotCovered.Should().Contain(n => n.Contains("Nothing in this plan touches them"));
    }

    // ---- Security --------------------------------------------------------------

    [Fact]
    public void An_application_with_no_security_scope_gets_no_security_category()
    {
        var plan = AgentPlanModel.Build(Inputs(securityAuthorized: false));

        // The security engine would refuse it anyway, and a plan listing work that cannot
        // happen overstates its own coverage.
        plan.Categories.Should().NotContain(c => c.Category == AgentPlanCategory.Security);
    }

    [Fact]
    public void The_absence_of_security_testing_is_stated_rather_than_left_to_be_noticed()
    {
        var plan = AgentPlanModel.Build(Inputs(securityAuthorized: false));

        // A plan with no security row reads as an application with no security concerns.
        plan.NotCovered.Should().Contain(n =>
            n.Contains("no enabled security scope")
            && n.Contains("absence of authorization, not an absence of risk"));
    }

    [Fact]
    public void Open_security_findings_add_a_regression_category_at_critical_risk()
    {
        var plan = AgentPlanModel.Build(Inputs(openFindings: 3));

        var regression = plan.Categories
            .First(c => c.Category == AgentPlanCategory.Regression);

        regression.TestCount.Should().Be(3);
        regression.Risk.Should().Be(RiskLevel.Critical);
        regression.Why.Should().Contain("comes back is a regression");
    }

    // ---- Estimates ---------------------------------------------------------------

    [Fact]
    public void An_estimate_says_whether_it_came_from_history_or_from_a_default()
    {
        var noHistory = AgentPlanModel.Build(Inputs());
        var withHistory = AgentPlanModel.Build(Inputs(
            observed: new Dictionary<TestDimension, int> { [TestDimension.Ui] = 12 }));

        noHistory.Categories.Should().OnlyContain(c => !c.EstimateFromHistory);
        withHistory.Categories.Where(c => c.Category == AgentPlanCategory.Smoke)
            .Should().OnlyContain(c => c.EstimateFromHistory);
        // The summary carries the distinction too, because that is where most people stop.
        noHistory.Summary.Should().Contain("from defaults");
        withHistory.Summary.Should().Contain("taken on this application before");
    }

    [Fact]
    public void Estimates_without_history_are_pessimistic_rather_than_optimistic()
    {
        var optimisticHistory = AgentPlanModel.Build(Inputs(
            observed: new Dictionary<TestDimension, int> { [TestDimension.Ui] = 5 }));
        var noHistory = AgentPlanModel.Build(Inputs());

        // An estimate that comes in under is a pleasant surprise. One that comes in over is
        // why somebody stops reading the number.
        noHistory.TotalSeconds.Should().BeGreaterThan(optimisticHistory.TotalSeconds);
    }

    [Fact]
    public void The_summary_always_describes_the_time_as_an_estimate()
    {
        AgentPlanModel.Build(Inputs()).Summary.Should().Contain("an estimate");
    }

    // ---- What a plan never claims -------------------------------------------------

    [Fact]
    public void Every_plan_says_that_what_discovery_missed_is_not_covered()
    {
        var plan = AgentPlanModel.Build(Inputs());

        plan.NotCovered.Should().Contain(n =>
            n.Contains("larger than its crawl"));
    }

    [Fact]
    public void An_application_discovery_found_nothing_in_produces_an_empty_plan_not_a_clean_one()
    {
        var plan = AgentPlanModel.Build(Inputs(
            pages: 0, endpoints: 0, journeys: 0, roles: 0, forms: 0, uploads: 0,
            securityAuthorized: false));

        plan.TotalTests.Should().Be(0);
        // Nothing to test is never the same as nothing to worry about, and the uncovered list
        // is what keeps an empty plan from reading as a clean bill of health.
        plan.NotCovered.Should().NotBeEmpty();
    }

    [Fact]
    public void Multiple_roles_are_flagged_as_only_partly_covered()
    {
        var plan = AgentPlanModel.Build(Inputs(roles: 5));

        plan.NotCovered.Should().Contain(n => n.Contains("cross-role authorization"));
    }

    [Fact]
    public void Recent_failures_become_a_regression_category()
    {
        var plan = AgentPlanModel.Build(Inputs(recentFailures: 7));

        plan.Categories.Should().Contain(c =>
            c.Category == AgentPlanCategory.Regression && c.TestCount == 7);
    }
}
