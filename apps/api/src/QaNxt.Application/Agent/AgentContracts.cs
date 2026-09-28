using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Application.Agent;

public sealed record StartAgentRunRequest(
    Guid ApplicationId,
    string? Name,
    /// <summary>What to concentrate on, in the operator's words. Advisory: it steers
    /// prioritisation, it does not widen what the agent is allowed to do.</summary>
    string? Objective,
    /// <summary>Which build of the application this pass is testing, in the operator's own
    /// notation. Carried onto the verification run so the pass's results can be read as a
    /// release assessment. Omitted, the pass is simply not assessed as a release.</summary>
    string? BuildRef,
    bool? Explore,
    bool? Execute,
    int? MaxPages,
    int? MaxDepth,
    int? MaxTargets,
    int? MaxGeneratedTests,
    int? TimeBudgetSeconds,
    decimal? MaxAiCostUsd,
    /// <summary>
    /// What this pass may do at all, as distinct from how much of it.
    /// </summary>
    /// <remarks>
    /// Clamped on the way in, and the two flags that are decisions rather than quantities —
    /// production and destructive — are cleared unless the caller separately holds the
    /// permission that governs each one everywhere else in the product. Asking for them in a
    /// request body is not the same as being permitted them.
    /// </remarks>
    AgentPolicy? Policy = null);

public sealed record AgentRunSummary(
    Guid Id, Guid ProjectId, Guid ApplicationId, string ApplicationName, string Name,
    string? Objective, AgentRunStatus Status, AgentPhase Phase,
    DateTimeOffset CreatedAt, DateTimeOffset? StartedAt, DateTimeOffset? CompletedAt,
    int PagesConsidered, int AreasAssessed, int TestsGenerated, int TestsExecuted,
    int FailuresInvestigated, int ProposalsMade, decimal AiCostUsd,
    string? StopReason, string? ErrorMessage, string? Summary,
    Guid? DiscoveryRunId, Guid? TestSuiteId, Guid? TestRunId,
    /// <summary>The build this pass tested, or null when the operator named none. Null means
    /// the pass is absent from every release assessment — not that it passed one.</summary>
    string? BuildRef);

public sealed record AgentStepView(
    int Order, AgentPhase Phase, bool Succeeded, string Description,
    string? Rationale, string? Detail, DateTimeOffset StartedAt, int DurationMs);

public sealed record AgentFindingView(
    Guid Id, AgentFindingKind Kind, RiskLevel Severity, string Title, string Detail,
    string? Recommendation, int Confidence, string? Route,
    Guid? TestCaseId, Guid? TestExecutionId, bool IsAiGenerated);

public sealed record AgentRunDetail(
    AgentRunSummary Summary,
    AgentBounds Bounds,
    IReadOnlyList<AgentStepView> Steps,
    IReadOnlyList<AgentFindingView> Findings);

/// <summary>The limits the run was started with, reported back so a reader can tell the
/// difference between "the agent found nothing else" and "the agent ran out of budget".</summary>
public sealed record AgentBounds(
    bool Explore, bool Execute, int MaxPages, int MaxDepth, int MaxTargets,
    int MaxGeneratedTests, int TimeBudgetSeconds, decimal MaxAiCostUsd,
    // The policy, reported alongside the quantities. Without these a reader can see how much
    // a pass was allowed to do and not what it was allowed to do at all — so "was this pass
    // permitted to touch production" had no answer outside the database, which is the wrong
    // place for the question somebody asks first.
    int MaxActions, int MaxNewJourneys, bool AllowProduction, bool AllowDestructiveActions,
    bool AllowSecurityTesting, bool RequireApprovalForHighRisk, int MaxParallelWorkers,
    int ActionsTaken);

public interface IAgentService
{
    Task<Result<AgentRunSummary>> StartAsync(StartAgentRunRequest request, CancellationToken ct = default);
    Task<IReadOnlyList<AgentRunSummary>> ListAsync(Guid? applicationId, int limit, CancellationToken ct = default);
    Task<Result<AgentRunDetail>> GetAsync(Guid id, CancellationToken ct = default);
    Task<Result> CancelAsync(Guid id, CancellationToken ct = default);
}

/// <summary>Defaults chosen so that an agent started with no options at all does something
/// useful and stops quickly. An unbounded agent is not a feature.</summary>
public static class AgentDefaults
{
    public const int MaxPages = 25;
    public const int MaxDepth = 3;
    public const int MaxTargets = 5;
    public const int MaxGeneratedTests = 15;
    public const int TimeBudgetSeconds = 900;
    public const decimal MaxAiCostUsd = 1.00m;

    // Ceilings an operator cannot exceed through the API. The point of a bound is that it
    // cannot be argued with.
    public const int MaxPagesCeiling = 200;
    public const int MaxDepthCeiling = 6;
    public const int MaxTargetsCeiling = 25;
    public const int MaxGeneratedTestsCeiling = 100;
    public const int TimeBudgetSecondsCeiling = 3600;
    public const decimal MaxAiCostUsdCeiling = 20.00m;
}
