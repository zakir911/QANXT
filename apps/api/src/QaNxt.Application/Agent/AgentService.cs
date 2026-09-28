using QaNxt.Application.Security;
using QaNxt.Application.Abstractions;
using QaNxt.Domain.Agent;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Application.Agent;

/// <summary>Starting, listing and stopping agent passes.
///
/// The bounds are validated and clamped here, once, and then frozen onto the run. Nothing
/// downstream re-reads configuration, so an agent cannot have its limits widened while it
/// is running and a finished run stays explainable after the defaults change.</summary>
public sealed class AgentService : IAgentService
{
    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly ILogger<AgentService> _logger;

    public AgentService(IQaNxtDbContext db, ICurrentUser currentUser, IClock clock,
        IAuditLogger audit, ILogger<AgentService> logger)
    {
        _db = db;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
        _logger = logger;
    }

    public async Task<Result<AgentRunSummary>> StartAsync(StartAgentRunRequest request, CancellationToken ct = default)
    {
        var organizationId = _currentUser.OrganizationId;
        if (organizationId is null) return Error.Unauthorized();

        var application = await _db.Applications
            .FirstOrDefaultAsync(a => a.Id == request.ApplicationId, ct);
        if (application is null) return Error.NotFound("The application");

        // One pass at a time per application. Two agents generating tests for the same
        // areas at once would duplicate work and race each other's suites.
        var active = await _db.AgentRuns.AnyAsync(r =>
            r.ApplicationId == application.Id &&
            (r.Status == AgentRunStatus.Queued || r.Status == AgentRunStatus.Running), ct);
        if (active)
        {
            return Error.Conflict("agent_already_running",
                "An agent pass is already running for this application. Wait for it to finish, or cancel it.");
        }

        // Clamped once, here, so the run carries the answer rather than re-deriving it.
        var policy = AgentPolicy.Clamp(
            request.Policy ?? AgentPolicy.Default,
            mayUseProduction: _currentUser.HasPermission(Permissions.SecurityProduction),
            mayBeDestructive: _currentUser.HasPermission(Permissions.SecurityScanDestructive));

        var run = new AgentRun
        {
            OrganizationId = organizationId.Value,
            ProjectId = application.ProjectId,
            ApplicationId = application.Id,
            Name = string.IsNullOrWhiteSpace(request.Name)
                ? $"Agent pass over {application.Name}"
                : request.Name.Trim(),
            Objective = string.IsNullOrWhiteSpace(request.Objective) ? null : request.Objective.Trim(),
            ApplicationBuildRef = string.IsNullOrWhiteSpace(request.BuildRef)
                ? null : request.BuildRef.Trim(),
            Status = AgentRunStatus.Queued,
            Phase = AgentPhase.Pending,

            ExploreEnabled = request.Explore ?? true,
            ExecuteEnabled = request.Execute ?? true,
            MaxPages = Clamp(request.MaxPages, AgentDefaults.MaxPages, 1, AgentDefaults.MaxPagesCeiling),
            MaxDepth = Clamp(request.MaxDepth, AgentDefaults.MaxDepth, 1, AgentDefaults.MaxDepthCeiling),
            MaxTargets = Clamp(request.MaxTargets, AgentDefaults.MaxTargets, 1, AgentDefaults.MaxTargetsCeiling),
            MaxGeneratedTests = Clamp(request.MaxGeneratedTests, AgentDefaults.MaxGeneratedTests, 1,
                AgentDefaults.MaxGeneratedTestsCeiling),
            TimeBudgetSeconds = Clamp(request.TimeBudgetSeconds, AgentDefaults.TimeBudgetSeconds, 30,
                AgentDefaults.TimeBudgetSecondsCeiling),
            MaxAiCostUsd = Math.Clamp(request.MaxAiCostUsd ?? AgentDefaults.MaxAiCostUsd, 0m,
                AgentDefaults.MaxAiCostUsdCeiling),

            // The policy, frozen with the bounds and clamped the same way. Production and
            // destructive are cleared rather than clamped: they are decisions rather than
            // quantities, and the caller does not get them by asking — they get them by
            // holding the permission that governs each one everywhere else in the product.
            MaxActions = policy.MaxActions,
            MaxNewJourneys = policy.MaxNewJourneys,
            AllowProduction = policy.AllowProduction,
            AllowDestructiveActions = policy.AllowDestructiveActions,
            AllowSecurityTesting = policy.AllowSecurityTesting
                                   && _currentUser.HasPermission(Permissions.SecurityScan),
            RequireApprovalForHighRisk = policy.RequireApprovalForHighRisk,
            MaxParallelWorkers = policy.MaxParallelWorkers,

            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };

        _db.AgentRuns.Add(run);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.AgentRunStarted, nameof(AgentRun), run.Id,
            $"Agent pass '{run.Name}' queued for '{application.Name}' with bounds: "
            + $"{run.MaxPages} page(s), {run.MaxTargets} target(s), {run.MaxGeneratedTests} test(s), "
            + $"{run.TimeBudgetSeconds}s, ${run.MaxAiCostUsd:0.00}"
            + $"{(run.ExploreEnabled ? "" : ", exploration disabled")}"
            + $"{(run.ExecuteEnabled ? "" : ", execution disabled")}.",
            projectId: run.ProjectId, ct: ct);

        _logger.LogInformation("Agent run {RunId} queued for application {ApplicationId}", run.Id, application.Id);

        return Result<AgentRunSummary>.Success(await MapAsync(run, application.Name, ct));
    }

    public async Task<IReadOnlyList<AgentRunSummary>> ListAsync(Guid? applicationId, int limit, CancellationToken ct = default)
    {
        var query = _db.AgentRuns.AsNoTracking();
        if (applicationId is not null) query = query.Where(r => r.ApplicationId == applicationId);

        return await query
            .OrderByDescending(r => r.CreatedAt)
            .Take(Math.Clamp(limit, 1, 100))
            .Select(r => new AgentRunSummary(
                r.Id, r.ProjectId, r.ApplicationId, r.Application!.Name, r.Name, r.Objective,
                r.Status, r.Phase, r.CreatedAt, r.StartedAt, r.CompletedAt,
                r.PagesConsidered, r.AreasAssessed, r.TestsGenerated, r.TestsExecuted,
                r.FailuresInvestigated, r.ProposalsMade, r.AiCostUsd,
                r.StopReason, r.ErrorMessage, r.Summary,
                r.DiscoveryRunId, r.TestSuiteId, r.TestRunId, r.ApplicationBuildRef))
            .ToListAsync(ct);
    }

    public async Task<Result<AgentRunDetail>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var run = await _db.AgentRuns.AsNoTracking()
            .Include(r => r.Application)
            .FirstOrDefaultAsync(r => r.Id == id, ct);
        if (run is null) return Error.NotFound("The agent run");

        var steps = await _db.AgentSteps.AsNoTracking()
            .Where(s => s.AgentRunId == id)
            .OrderBy(s => s.Order)
            .Select(s => new AgentStepView(
                s.Order, s.Phase, s.Succeeded, s.Description, s.Rationale, s.Detail,
                s.StartedAt, s.DurationMs))
            .ToListAsync(ct);

        var findings = await _db.AgentFindings.AsNoTracking()
            .Where(f => f.AgentRunId == id)
            // Severity is an enum where Critical is 0, so ascending puts the worst first.
            .OrderBy(f => f.Severity).ThenByDescending(f => f.Confidence)
            .Select(f => new AgentFindingView(
                f.Id, f.Kind, f.Severity, f.Title, f.Detail, f.Recommendation, f.Confidence,
                f.Route, f.TestCaseId, f.TestExecutionId, f.IsAiGenerated))
            .ToListAsync(ct);

        return Result<AgentRunDetail>.Success(new AgentRunDetail(
            await MapAsync(run, run.Application?.Name ?? string.Empty, ct),
            new AgentBounds(run.ExploreEnabled, run.ExecuteEnabled, run.MaxPages, run.MaxDepth,
                run.MaxTargets, run.MaxGeneratedTests, run.TimeBudgetSeconds, run.MaxAiCostUsd,
                run.MaxActions, run.MaxNewJourneys, run.AllowProduction,
                run.AllowDestructiveActions, run.AllowSecurityTesting,
                run.RequireApprovalForHighRisk, run.MaxParallelWorkers, run.ActionsTaken),
            steps,
            findings));
    }

    public async Task<Result> CancelAsync(Guid id, CancellationToken ct = default)
    {
        var run = await _db.AgentRuns.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (run is null) return Result.Failure(Error.NotFound("The agent run"));

        if (run.Status is AgentRunStatus.Completed or AgentRunStatus.Failed or AgentRunStatus.Cancelled)
            return Result.Failure(Error.Validation($"This agent run has already {run.Status.ToString().ToLowerInvariant()}."));

        run.Status = AgentRunStatus.Cancelled;
        run.CompletedAt = _clock.UtcNow;
        run.StopReason = "Cancelled by a person.";
        run.UpdatedByUserId = _currentUser.UserId;
        run.UpdatedAt = _clock.UtcNow;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.AgentRunCompleted, nameof(AgentRun), run.Id,
            $"Agent pass '{run.Name}' cancelled.", projectId: run.ProjectId, ct: ct);

        return Result.Success();
    }

    private async Task<AgentRunSummary> MapAsync(AgentRun run, string applicationName, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(applicationName))
        {
            applicationName = await _db.Applications
                .Where(a => a.Id == run.ApplicationId)
                .Select(a => a.Name)
                .FirstOrDefaultAsync(ct) ?? string.Empty;
        }

        return new AgentRunSummary(
            run.Id, run.ProjectId, run.ApplicationId, applicationName, run.Name, run.Objective,
            run.Status, run.Phase, run.CreatedAt, run.StartedAt, run.CompletedAt,
            run.PagesConsidered, run.AreasAssessed, run.TestsGenerated, run.TestsExecuted,
            run.FailuresInvestigated, run.ProposalsMade, run.AiCostUsd,
            run.StopReason, run.ErrorMessage, run.Summary,
            run.DiscoveryRunId, run.TestSuiteId, run.TestRunId, run.ApplicationBuildRef);
    }

    private static int Clamp(int? requested, int fallback, int min, int max)
        => Math.Clamp(requested ?? fallback, min, max);
}
