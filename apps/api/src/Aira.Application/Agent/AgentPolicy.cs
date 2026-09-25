using Aira.Domain.Enums;

namespace Aira.Application.Agent;

/// <summary>
/// What an agent run is allowed to do, in total.
/// </summary>
/// <remarks>
/// Frozen onto a run when it starts, like the existing bounds, so that changing the defaults
/// cannot widen a pass already in flight and a historical run stays explainable.
/// </remarks>
public sealed record AgentPolicy(
    int MaxActions,
    int MaxRuntimeMinutes,
    int MaxNewTests,
    int MaxNewJourneys,
    bool AllowProduction,
    bool AllowDestructiveActions,
    bool AllowSecurityTesting,
    bool RequireApprovalForHighRisk,
    int MaxParallelWorkers)
{
    /// <summary>
    /// The defaults, which refuse everything dangerous.
    /// </summary>
    /// <remarks>
    /// Production off, destructive off, approval required. A policy nobody configured is the
    /// policy most runs will use, so the unconfigured one has to be the safe one.
    /// </remarks>
    public static AgentPolicy Default { get; } = new(
        MaxActions: 500,
        MaxRuntimeMinutes: 30,
        MaxNewTests: 100,
        MaxNewJourneys: 25,
        AllowProduction: false,
        AllowDestructiveActions: false,
        AllowSecurityTesting: true,
        RequireApprovalForHighRisk: true,
        MaxParallelWorkers: 5);

    /// <summary>Ceilings an operator cannot exceed. A bound that can be argued with is not one.</summary>
    public static AgentPolicy Ceiling { get; } = new(
        MaxActions: 5_000,
        MaxRuntimeMinutes: 120,
        MaxNewTests: 500,
        MaxNewJourneys: 100,
        AllowProduction: true,
        AllowDestructiveActions: true,
        AllowSecurityTesting: true,
        RequireApprovalForHighRisk: true,
        MaxParallelWorkers: 20);

    /// <summary>
    /// Clamps a requested policy to the ceilings, and refuses to let the two flags that matter
    /// be turned on by asking.
    /// </summary>
    /// <remarks>
    /// Production and destructive are not clamped — they are cleared unless the caller was
    /// separately established as permitted. A ceiling is a maximum; these two are decisions,
    /// and a decision does not have a maximum.
    /// </remarks>
    public static AgentPolicy Clamp(AgentPolicy requested, bool mayUseProduction, bool mayBeDestructive)
        => new(
            Math.Clamp(requested.MaxActions, 1, Ceiling.MaxActions),
            Math.Clamp(requested.MaxRuntimeMinutes, 1, Ceiling.MaxRuntimeMinutes),
            Math.Clamp(requested.MaxNewTests, 0, Ceiling.MaxNewTests),
            Math.Clamp(requested.MaxNewJourneys, 0, Ceiling.MaxNewJourneys),
            requested.AllowProduction && mayUseProduction,
            requested.AllowDestructiveActions && mayBeDestructive,
            requested.AllowSecurityTesting,
            // Cannot be switched off. An agent that decides for itself that nothing needs
            // approving is the failure mode this whole phase exists to avoid.
            RequireApprovalForHighRisk: true,
            Math.Clamp(requested.MaxParallelWorkers, 1, Ceiling.MaxParallelWorkers));
}

/// <summary>Where a policy check stopped, and why.</summary>
public enum AgentDenial
{
    None = 0,
    UnknownTool = 1,
    ActionBudgetSpent = 2,
    RuntimeSpent = 3,
    PermissionMissing = 4,
    EnvironmentNotPermitted = 5,
    ProductionNotPermitted = 6,
    /// <summary>Nothing says what kind of environment this is, so nothing that changes state
    /// may be sent to it.</summary>
    EnvironmentUnknown = 13,
    DestructiveNotPermitted = 7,
    SecurityTestingNotPermitted = 8,
    TestBudgetSpent = 9,
    JourneyBudgetSpent = 10,
    ApprovalRequired = 11,
    RunCancelled = 12
}

/// <summary>What the agent is asking to do.</summary>
public sealed record AgentActionRequest(
    string ToolName,
    /// <summary>
    /// Where this would run, or null when nothing says.
    /// </summary>
    /// <remarks>
    /// Null is its own answer rather than a default. Treating an undescribed environment as
    /// production refuses everything with "this run is not authorized for production", which
    /// is misleading — the run was never asking for production — and leaves an operator with
    /// no idea what to change. Treating it as non-production would let an unattended pass
    /// write to something nobody has identified. So it is neither: observation and
    /// interaction are permitted, anything that changes state is refused, and the refusal
    /// says what to do about it.
    /// </remarks>
    EnvironmentKind? Environment,
    /// <summary>The risk the caller declares. It can raise the tool's floor, never lower it.</summary>
    AgentActionRisk? DeclaredRisk = null,
    /// <summary>How many tests this action would create, for the budget rung.</summary>
    int NewTests = 0,
    int NewJourneys = 0);

/// <summary>Where a run currently stands against its policy.</summary>
public sealed record AgentRunState(
    int ActionsTaken,
    int MinutesElapsed,
    int TestsCreated,
    int JourneysCreated,
    bool Cancelled,
    /// <summary>Permissions the run's initiator holds, frozen when the run started.</summary>
    IReadOnlySet<string> Permissions,
    /// <summary>Approvals a person has granted for this run, by tool name.</summary>
    IReadOnlySet<string> Approvals);

/// <summary>One policy decision, with how far it got.</summary>
public sealed record AgentPolicyDecision(
    bool Allowed,
    AgentDenial Denial,
    string Reason,
    /// <summary>The rungs that passed before this answer. A refusal that cannot say where it
    /// happened is not much better than a refusal that does not happen.</summary>
    IReadOnlyList<string> Passed,
    /// <summary>The risk the action was finally judged at, after the tool's floor was applied.</summary>
    AgentActionRisk EffectiveRisk)
{
    public bool RequiresApproval => Denial == AgentDenial.ApprovalRequired;
}

/// <summary>
/// The single gate every agent action passes through.
/// </summary>
/// <remarks>
/// <para>
/// A pure function, deliberately, and for the same reason <c>SecurityScopeGuard.Evaluate</c>
/// is one: a control that needs a database, a clock and a web request to exercise is a control
/// nobody writes enough tests for. Everything it needs arrives as arguments.
/// </para>
/// <para>
/// The ladder is ordered and each rung is only reached if the one before it passed, so a
/// refusal says <em>where</em> it was refused. The order is not arbitrary. The tool is
/// resolved first because an unknown tool has no risk, no permission and no environment to
/// check. Budgets come next because they are the cheapest true answer. Permission precedes
/// environment because "you may not do this at all" is a better message than "not here".
/// Risk is raised before it is judged, so a caller cannot describe a deletion as a read.
/// Approval is last because it is the only rung whose answer is "ask a person" rather than
/// "no" — and it is reached only by an action that would otherwise have been allowed.
/// </para>
/// </remarks>
public static class AgentPolicyGuard
{
    public static AgentPolicyDecision Evaluate(
        AgentPolicy policy, AgentActionRequest request, AgentRunState state)
    {
        var passed = new List<string>();

        var tool = AgentToolRegistry.Resolve(request.ToolName);
        if (tool is null)
            return Deny(AgentDenial.UnknownTool,
                $"'{request.ToolName}' is not a tool the agent has. An action the registry does "
                + "not name cannot be checked against a policy, so it is refused rather than "
                + "allowed through.", passed, AgentActionRisk.Observation);
        passed.Add("tool");

        if (state.Cancelled)
            return Deny(AgentDenial.RunCancelled, "The run was cancelled.", passed, tool.Risk);
        passed.Add("cancellation");

        if (state.ActionsTaken >= policy.MaxActions)
            return Deny(AgentDenial.ActionBudgetSpent,
                $"The run has taken {state.ActionsTaken} action(s) of {policy.MaxActions}. "
                + "Stopping here is a bound being reached, not a conclusion about the application.",
                passed, tool.Risk);

        if (state.MinutesElapsed >= policy.MaxRuntimeMinutes)
            return Deny(AgentDenial.RuntimeSpent,
                $"The run has been going {state.MinutesElapsed} minute(s) of "
                + $"{policy.MaxRuntimeMinutes}. Stopping here is a bound being reached, not a "
                + "conclusion about the application.", passed, tool.Risk);
        passed.Add("budget");

        if (tool.RequiredPermission is { } permission && !state.Permissions.Contains(permission))
            return Deny(AgentDenial.PermissionMissing,
                $"'{tool.Name}' needs '{permission}', which the run's initiator does not hold. "
                + "The agent acts on somebody's behalf and never holds more than they do.",
                passed, tool.Risk);
        passed.Add("permission");

        // The declared risk raises the tool's floor and can never lower it. Computed before
        // the environment rungs because what an unknown environment permits depends on it.
        var risk = request.DeclaredRisk is { } declared && declared > tool.Risk ? declared : tool.Risk;

        if (request.Environment is { } environment)
        {
            if (environment == EnvironmentKind.Production && !policy.AllowProduction)
                return Deny(AgentDenial.ProductionNotPermitted,
                    "This run is not authorized for production, and production is off by default.",
                    passed, risk);

            if (!tool.PermitsEnvironment(environment))
                return Deny(AgentDenial.EnvironmentNotPermitted,
                    $"'{tool.Name}' may not be used against a {environment} environment, "
                    + "whatever the run's policy allows.", passed, risk);
        }
        else if (risk >= AgentActionRisk.StateChanging)
        {
            // Accurate and actionable. The old behaviour read an undescribed environment as
            // production and refused everything with "not authorized for production", which
            // was misleading — the run never asked for production — and told an operator
            // nothing about what to change.
            return Deny(AgentDenial.EnvironmentUnknown,
                $"'{tool.Name}' would change something and nothing says what kind of "
                + "environment this application lives in. Register an environment for it, or "
                + "name one on its security scope, and this will run. Until then only "
                + "observation is permitted: an unattended pass must not write to a system "
                + "nobody has identified.", passed, risk);
        }
        passed.Add("environment");

        if (risk == AgentActionRisk.Destructive && !policy.AllowDestructiveActions)
            return Deny(AgentDenial.DestructiveNotPermitted,
                "The action is destructive and this run does not permit destructive actions.",
                passed, risk);
        passed.Add("risk");

        if (tool.Name.StartsWith("security.", StringComparison.Ordinal)
            && !policy.AllowSecurityTesting
            && tool.Risk > AgentActionRisk.Observation)
            return Deny(AgentDenial.SecurityTestingNotPermitted,
                "Security testing is switched off for this run.", passed, risk);
        passed.Add("security");

        if (request.NewTests > 0 && state.TestsCreated + request.NewTests > policy.MaxNewTests)
            return Deny(AgentDenial.TestBudgetSpent,
                $"This would take the run past {policy.MaxNewTests} new test(s). Tests nobody "
                + "asked for are a cost, and an agent that writes them without limit is one.",
                passed, risk);

        if (request.NewJourneys > 0 && state.JourneysCreated + request.NewJourneys > policy.MaxNewJourneys)
            return Deny(AgentDenial.JourneyBudgetSpent,
                $"This would take the run past {policy.MaxNewJourneys} new journey(s).",
                passed, risk);
        passed.Add("creation-budget");

        // Last rung, and the only one whose answer is "ask somebody" rather than "no".
        if (policy.RequireApprovalForHighRisk
            && risk >= AgentActionRisk.StateChanging
            && !state.Approvals.Contains(tool.Name))
            return Deny(AgentDenial.ApprovalRequired,
                $"'{tool.Name}' is {risk} and this run requires a person to approve actions at "
                + "that level. The agent proposes it; it does not perform it.", passed, risk);
        passed.Add("approval");

        return new AgentPolicyDecision(true, AgentDenial.None,
            $"'{tool.Name}' is permitted at {risk}.", passed, risk);
    }

    private static AgentPolicyDecision Deny(
        AgentDenial denial, string reason, List<string> passed, AgentActionRisk risk)
        => new(false, denial, reason, passed, risk);
}
