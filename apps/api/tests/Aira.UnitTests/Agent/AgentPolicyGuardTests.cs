using Aira.Application.Agent;
using Aira.Application.Security;
using Aira.Domain.Enums;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Agent;

/// <summary>
/// The gate every autonomous action passes through.
/// </summary>
/// <remarks>
/// <para>
/// These are the tests that decide whether the agent is bounded. Everything else in this
/// phase records what the agent did; this decides what it may do, and it is the only place
/// that decides it.
/// </para>
/// <para>
/// Each rung is tested for its refusal <em>and</em> for where it sits in the ladder, because
/// order is behaviour here: a refusal that cannot say which rung stopped it sends somebody
/// to widen the wrong thing.
/// </para>
/// </remarks>
public class AgentPolicyGuardTests
{
    private static AgentRunState State(
        int actions = 0, int minutes = 0, int tests = 0, int journeys = 0,
        bool cancelled = false, string[]? permissions = null, string[]? approvals = null)
        => new(actions, minutes, tests, journeys, cancelled,
            new HashSet<string>(permissions ?? Everything),
            new HashSet<string>(approvals ?? Array.Empty<string>()));

    /// <summary>Every permission any tool asks for, so a test about one rung is not
    /// accidentally answered by an earlier one.</summary>
    private static readonly string[] Everything =
    {
        Permissions.TestWrite, Permissions.TestGenerate, Permissions.ExecutionRun,
        Permissions.DiscoveryRun, Permissions.SecurityScan, Permissions.SecurityRead
    };

    /// <summary>A policy that permits as much as possible, so a refusal in a test is
    /// attributable to the thing the test is about.</summary>
    private static AgentPolicy Permissive => AgentPolicy.Default with
    {
        AllowDestructiveActions = true,
        AllowProduction = true,
        RequireApprovalForHighRisk = false
    };

    private static AgentActionRequest Request(
        string tool, EnvironmentKind? env = EnvironmentKind.Staging,
        AgentActionRisk? risk = null, int newTests = 0, int newJourneys = 0)
        => new(tool, env, risk, newTests, newJourneys);

    // ---- The registry itself -------------------------------------------------

    [Fact]
    public void An_unknown_tool_is_refused_rather_than_passed_through()
    {
        var decision = AgentPolicyGuard.Evaluate(
            Permissive, Request("browser.evaluate"), State());

        // The failure mode this prevents: a phase calls something the registry never declared,
        // no policy applies because there is nothing to check against, and the action happens.
        decision.Allowed.Should().BeFalse();
        decision.Denial.Should().Be(AgentDenial.UnknownTool);
        decision.Passed.Should().BeEmpty("nothing can be checked about a tool that does not exist");
    }

    [Fact]
    public void Every_declared_tool_resolves_and_carries_a_purpose()
    {
        AgentToolRegistry.All.Should().NotBeEmpty();
        foreach (var tool in AgentToolRegistry.All)
        {
            AgentToolRegistry.Resolve(tool.Name).Should().BeSameAs(tool);
            tool.Purpose.Should().NotBeNullOrWhiteSpace();
            tool.AllowedEnvironments.Should().NotBeEmpty(
                $"'{tool.Name}' permits no environment at all, which makes it unusable rather than safe");
        }
    }

    [Fact]
    public void Nothing_that_changes_anything_may_name_production()
    {
        // The rule that matters most in the registry, asserted rather than trusted to review.
        // An agent action that can alter a production system is the one thing no amount of
        // permission should buy through this path.
        var offenders = AgentToolRegistry.All
            .Where(t => t.Risk >= AgentActionRisk.StateChanging
                        && t.PermitsEnvironment(EnvironmentKind.Production))
            .Select(t => t.Name);

        offenders.Should().BeEmpty();
    }

    [Fact]
    public void Every_state_changing_tool_requires_a_permission_and_an_audit_entry()
    {
        foreach (var tool in AgentToolRegistry.All.Where(t => t.Risk >= AgentActionRisk.StateChanging))
        {
            tool.RequiredPermission.Should().NotBeNullOrWhiteSpace(
                $"'{tool.Name}' changes something and would otherwise need only agent:run");
            tool.AuditRequired.Should().BeTrue(
                $"'{tool.Name}' changes something and an unrecorded change is not auditable");
        }
    }

    // ---- The ladder, rung by rung -------------------------------------------

    [Fact]
    public void A_cancelled_run_stops_before_its_budgets_are_consulted()
    {
        var decision = AgentPolicyGuard.Evaluate(
            Permissive, Request("browser.inspect"), State(cancelled: true));

        decision.Denial.Should().Be(AgentDenial.RunCancelled);
        decision.Passed.Should().Equal("tool");
    }

    [Fact]
    public void Spending_the_action_budget_stops_the_run_and_says_it_is_a_bound()
    {
        var policy = Permissive with { MaxActions = 10 };

        var decision = AgentPolicyGuard.Evaluate(policy, Request("browser.inspect"), State(actions: 10));

        decision.Allowed.Should().BeFalse();
        decision.Denial.Should().Be(AgentDenial.ActionBudgetSpent);
        // Wording is load-bearing. "The agent stopped" must never read as "the agent finished".
        decision.Reason.Should().Contain("not a conclusion about the application");
    }

    [Fact]
    public void Spending_the_runtime_budget_stops_the_run()
    {
        var policy = Permissive with { MaxRuntimeMinutes = 30 };

        var decision = AgentPolicyGuard.Evaluate(policy, Request("browser.inspect"), State(minutes: 30));

        decision.Denial.Should().Be(AgentDenial.RuntimeSpent);
        decision.Reason.Should().Contain("not a conclusion about the application");
    }

    [Fact]
    public void A_permission_the_initiator_does_not_hold_refuses_the_tool()
    {
        var decision = AgentPolicyGuard.Evaluate(
            Permissive, Request("test.execute"), State(permissions: Array.Empty<string>()));

        decision.Denial.Should().Be(AgentDenial.PermissionMissing);
        decision.Reason.Should().Contain(Permissions.ExecutionRun);
        // The principle, stated where somebody changing this will read it.
        decision.Reason.Should().Contain("never holds more than they do");
        decision.Passed.Should().Equal("tool", "cancellation", "budget");
    }

    [Fact]
    public void Production_is_refused_before_the_tool_s_own_environment_list_is_read()
    {
        var policy = Permissive with { AllowProduction = false };

        var decision = AgentPolicyGuard.Evaluate(
            policy, Request("browser.inspect", EnvironmentKind.Production), State());

        // browser.inspect *is* permitted in production by the registry. The run's policy is
        // what refuses it, and that ordering matters: the run-level answer is the one an
        // operator can grant, so it should be the one they are told about.
        decision.Denial.Should().Be(AgentDenial.ProductionNotPermitted);
    }

    [Fact]
    public void A_tool_that_forbids_an_environment_is_refused_even_with_production_allowed()
    {
        var decision = AgentPolicyGuard.Evaluate(
            Permissive, Request("test.execute", EnvironmentKind.Production), State());

        // The run allows production. The tool does not permit it. The tool wins, which is the
        // whole reason the registry carries an environment list at all.
        decision.Allowed.Should().BeFalse();
        decision.Denial.Should().Be(AgentDenial.EnvironmentNotPermitted);
    }

    [Fact]
    public void An_undescribed_environment_permits_observation_and_refuses_writing()
    {
        // Found by running a real pass against the lab, where the application had no
        // environment record. Everything was refused with "this run is not authorized for
        // production" — misleading, because the run never asked for production, and useless
        // to an operator trying to work out what to change.
        var observe = AgentPolicyGuard.Evaluate(
            Permissive, Request("browser.inspect", env: null), State());
        observe.Allowed.Should().BeTrue(observe.Reason);

        var generate = AgentPolicyGuard.Evaluate(
            Permissive, Request("test.generate", env: null), State());
        generate.Allowed.Should().BeTrue(generate.Reason);

        var write = AgentPolicyGuard.Evaluate(
            Permissive, Request("test.execute", env: null), State());
        write.Allowed.Should().BeFalse();
        write.Denial.Should().Be(AgentDenial.EnvironmentUnknown);
    }

    [Fact]
    public void The_refusal_for_an_unknown_environment_says_what_to_change()
    {
        var decision = AgentPolicyGuard.Evaluate(
            Permissive, Request("test.execute", env: null), State());

        // A refusal an operator cannot act on is a refusal they route around.
        decision.Reason.Should().Contain("Register an environment for it");
        decision.Reason.Should().Contain("name one on its security scope");
        decision.Reason.Should().NotContain("not authorized for production");
    }

    [Fact]
    public void An_unknown_environment_is_not_quietly_read_as_production()
    {
        var decision = AgentPolicyGuard.Evaluate(
            Permissive with { AllowProduction = false },
            Request("test.execute", env: null), State());

        // The distinction the original defect turned on: "we do not know" and "it is
        // production" lead to the same refusal and to completely different fixes.
        decision.Denial.Should().NotBe(AgentDenial.ProductionNotPermitted);
    }

    [Fact]
    public void A_declared_risk_still_raises_the_floor_when_the_environment_is_unknown()
    {
        var decision = AgentPolicyGuard.Evaluate(
            Permissive, Request("browser.click", env: null, risk: AgentActionRisk.StateChanging),
            State());

        // Otherwise a caller that knows its click submits a payment gets waved through
        // against a system nobody has identified.
        decision.Denial.Should().Be(AgentDenial.EnvironmentUnknown);
    }

    [Fact]
    public void A_caller_may_raise_the_risk_of_an_action_and_never_lower_it()
    {
        var policy = Permissive with { AllowDestructiveActions = false };

        var raised = AgentPolicyGuard.Evaluate(
            Permissive with { AllowDestructiveActions = false },
            Request("browser.click", risk: AgentActionRisk.Destructive), State());

        raised.Denial.Should().Be(AgentDenial.DestructiveNotPermitted,
            "a caller that knows this click deletes something must be able to say so");

        var lowered = AgentPolicyGuard.Evaluate(
            policy, Request("test.execute", risk: AgentActionRisk.Observation), State());

        // And the other direction, which is the one that would matter to an attacker or a
        // careless phase: declaring a run as an observation does not make it one.
        lowered.EffectiveRisk.Should().Be(AgentActionRisk.StateChanging);
    }

    [Fact]
    public void Security_tools_are_refused_when_the_run_has_security_testing_switched_off()
    {
        var policy = Permissive with { AllowSecurityTesting = false };

        var scan = AgentPolicyGuard.Evaluate(policy, Request("security.scan"), State());
        scan.Denial.Should().Be(AgentDenial.SecurityTestingNotPermitted);

        // Reading what an application has authorized is not security testing, and refusing it
        // would leave the agent unable to find out that it must not scan.
        var read = AgentPolicyGuard.Evaluate(policy, Request("security.validateScope"), State());
        read.Allowed.Should().BeTrue(read.Reason);
    }

    [Fact]
    public void The_new_test_budget_counts_what_exists_plus_what_is_proposed()
    {
        var policy = Permissive with { MaxNewTests = 100 };

        var withinBudget = AgentPolicyGuard.Evaluate(
            policy, Request("test.generate", newTests: 10), State(tests: 90));
        withinBudget.Allowed.Should().BeTrue(withinBudget.Reason);

        var overBudget = AgentPolicyGuard.Evaluate(
            policy, Request("test.generate", newTests: 11), State(tests: 90));
        overBudget.Denial.Should().Be(AgentDenial.TestBudgetSpent);
    }

    [Fact]
    public void The_new_journey_budget_behaves_the_same_way()
    {
        var policy = Permissive with { MaxNewJourneys = 25 };

        AgentPolicyGuard.Evaluate(policy, Request("test.generate", newJourneys: 1), State(journeys: 25))
            .Denial.Should().Be(AgentDenial.JourneyBudgetSpent);
    }

    // ---- Approval ------------------------------------------------------------

    [Fact]
    public void A_state_changing_action_needs_a_person_when_the_policy_says_so()
    {
        var policy = AgentPolicy.Default with { AllowDestructiveActions = true };

        var decision = AgentPolicyGuard.Evaluate(policy, Request("test.execute"), State());

        decision.Allowed.Should().BeFalse();
        decision.RequiresApproval.Should().BeTrue();
        // The distinction the dashboard reads: this is not a refusal, it is a question.
        decision.Reason.Should().Contain("does not perform it");
        decision.Passed.Should().Contain("creation-budget",
            "approval is the last rung, so reaching it means everything else was satisfied");
    }

    [Fact]
    public void An_approval_a_person_granted_lets_that_tool_through()
    {
        var policy = AgentPolicy.Default;

        var decision = AgentPolicyGuard.Evaluate(
            policy, Request("test.execute"), State(approvals: new[] { "test.execute" }));

        decision.Allowed.Should().BeTrue(decision.Reason);
    }

    [Fact]
    public void An_approval_covers_one_tool_and_not_the_others()
    {
        var policy = AgentPolicy.Default;

        var decision = AgentPolicyGuard.Evaluate(
            policy, Request("security.scan"), State(approvals: new[] { "test.execute" }));

        // Otherwise approving one run of the tests silently authorizes scanning, which is a
        // different decision made by a different person for different reasons.
        decision.RequiresApproval.Should().BeTrue();
    }

    [Fact]
    public void Observations_never_need_an_approval()
    {
        var decision = AgentPolicyGuard.Evaluate(
            AgentPolicy.Default, Request("browser.inspect"), State());

        // A policy that asked a person about every read would be switched off within a day,
        // and then nothing would be approved at all.
        decision.Allowed.Should().BeTrue(decision.Reason);
    }

    // ---- Clamping ------------------------------------------------------------

    [Fact]
    public void Numbers_above_the_ceiling_are_clamped_rather_than_rejected()
    {
        var requested = AgentPolicy.Default with
        {
            MaxActions = 1_000_000, MaxRuntimeMinutes = 9_999,
            MaxNewTests = 10_000, MaxParallelWorkers = 500
        };

        var clamped = AgentPolicy.Clamp(requested, mayUseProduction: false, mayBeDestructive: false);

        clamped.MaxActions.Should().Be(AgentPolicy.Ceiling.MaxActions);
        clamped.MaxRuntimeMinutes.Should().Be(AgentPolicy.Ceiling.MaxRuntimeMinutes);
        clamped.MaxNewTests.Should().Be(AgentPolicy.Ceiling.MaxNewTests);
        clamped.MaxParallelWorkers.Should().Be(AgentPolicy.Ceiling.MaxParallelWorkers);
    }

    [Fact]
    public void Production_and_destructive_are_cleared_rather_than_clamped()
    {
        var requested = AgentPolicy.Default with
        {
            AllowProduction = true, AllowDestructiveActions = true
        };

        var clamped = AgentPolicy.Clamp(requested, mayUseProduction: false, mayBeDestructive: false);

        // These two are decisions rather than quantities. Asking for them in the request body
        // is not the same as being permitted them, and a maximum is meaningless for a boolean.
        clamped.AllowProduction.Should().BeFalse();
        clamped.AllowDestructiveActions.Should().BeFalse();

        var permitted = AgentPolicy.Clamp(requested, mayUseProduction: true, mayBeDestructive: true);
        permitted.AllowProduction.Should().BeTrue();
        permitted.AllowDestructiveActions.Should().BeTrue();
    }

    [Fact]
    public void Approval_for_high_risk_cannot_be_switched_off_by_asking()
    {
        var requested = AgentPolicy.Default with { RequireApprovalForHighRisk = false };

        var clamped = AgentPolicy.Clamp(requested, mayUseProduction: true, mayBeDestructive: true);

        // An agent that decides for itself that nothing needs approving is the failure this
        // whole phase exists to prevent, so this one flag does not take instruction.
        clamped.RequireApprovalForHighRisk.Should().BeTrue();
    }

    [Fact]
    public void The_default_policy_refuses_everything_dangerous()
    {
        AgentPolicy.Default.AllowProduction.Should().BeFalse();
        AgentPolicy.Default.AllowDestructiveActions.Should().BeFalse();
        AgentPolicy.Default.RequireApprovalForHighRisk.Should().BeTrue();
    }
}
