using QaNxt.Application.Abstractions;
using QaNxt.Application.Security;
using QaNxt.Domain.Agent;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Application.Agent;

public sealed record PlanItemView(
    Guid Id, AgentPlanCategory Category, int TestCount, int ToGenerate, string Why,
    RiskLevel Risk, string Coverage, int EstimatedSeconds, bool EstimateFromHistory,
    string PotentialImpact, bool Included);

public sealed record PlanView(
    Guid Id, Guid AgentRunId, Guid ApplicationId, AgentPlanStatus Status, string Objective,
    int PagesDiscovered, int EndpointsDiscovered, int JourneysKnown, int RolesKnown,
    string Summary, IReadOnlyList<string> NotCovered, IReadOnlyList<PlanItemView> Items,
    int TotalTests, int EstimatedSeconds,
    string? DecidedByEmail, DateTimeOffset? DecidedAt, string? DecisionNote);

/// <summary>A person's answer. Categories left out of <paramref name="IncludedCategories"/>
/// are switched off rather than deleted, so the plan still records what was proposed.</summary>
public sealed record PlanDecisionRequest(
    bool Approve,
    IReadOnlyList<AgentPlanCategory>? IncludedCategories,
    string? Note);

public interface IAgentPlanService
{
    Task<Result<PlanView>> GetAsync(Guid agentRunId, CancellationToken ct = default);
    Task<Result<PlanView>> DecideAsync(
        Guid agentRunId, PlanDecisionRequest request, CancellationToken ct = default);
}

/// <summary>
/// The plan a person approves, changes or refuses.
/// </summary>
/// <remarks>
/// <para>
/// A decision here authorizes work against a live environment, so it needs
/// <c>execution:run</c> — reading test results is not a reason to be able to start hundreds
/// of them. And a decision is recorded with a name against it, because a plan somebody halved
/// is a decision about coverage and decisions about coverage need an author.
/// </para>
/// <para>
/// Switching a category off leaves it in the plan marked excluded rather than deleting it.
/// The difference matters afterwards: "we chose not to run the security category" and "there
/// was no security category" are read the same way by a reader looking at a short plan, and
/// only one of them is a decision anybody made.
/// </para>
/// </remarks>
public sealed class AgentPlanService : IAgentPlanService
{
    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _user;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly IAgentJournal _journal;

    public AgentPlanService(IQaNxtDbContext db, ICurrentUser user, IClock clock,
        IAuditLogger audit, IAgentJournal journal)
    {
        _db = db;
        _user = user;
        _clock = clock;
        _audit = audit;
        _journal = journal;
    }

    public async Task<Result<PlanView>> GetAsync(Guid agentRunId, CancellationToken ct = default)
    {
        var plan = await Load(agentRunId, ct);
        return plan is null
            ? Result<PlanView>.Failure(Error.NotFound("A plan for this run"))
            : Result<PlanView>.Success(Project(plan));
    }

    public async Task<Result<PlanView>> DecideAsync(
        Guid agentRunId, PlanDecisionRequest request, CancellationToken ct = default)
    {
        if (!_user.HasPermission(Permissions.ExecutionRun))
            return Result<PlanView>.Failure(Error.Forbidden(
                "Approving a test plan needs 'execution:run'. Approving one starts the work it "
                + "describes against a live environment; reading results is not a reason to hold that."));

        var plan = await Load(agentRunId, ct);
        if (plan is null) return Result<PlanView>.Failure(Error.NotFound("A plan for this run"));

        if (plan.Status != AgentPlanStatus.Proposed)
            return Result<PlanView>.Failure(Error.Conflict("plan_already_decided",
                $"This plan was already {plan.Status.ToString().ToLowerInvariant()}"
                + (plan.DecidedByEmail is null ? "" : $" by {plan.DecidedByEmail}")
                + ". A plan is decided once; start another pass to test something else."));

        if (!request.Approve && string.IsNullOrWhiteSpace(request.Note))
            return Result<PlanView>.Failure(Error.Validation(
                "Rejecting a plan needs a reason. A refusal with no reason leaves the next "
                + "person to propose the same plan again."));

        if (request.IncludedCategories is { } included)
        {
            var wanted = included.ToHashSet();
            foreach (var item in plan.Items)
                // Switched off, never removed. "We chose not to run this" and "this was never
                // proposed" look identical on a short plan, and only one is a decision.
                item.Included = wanted.Contains(item.Category);
        }

        if (request.Approve && plan.Items.All(i => !i.Included))
            return Result<PlanView>.Failure(Error.Validation(
                "Approving a plan with every category switched off would start a pass that "
                + "tests nothing and reports as though it had run. Reject it instead."));

        plan.Status = request.Approve ? AgentPlanStatus.Approved : AgentPlanStatus.Rejected;
        plan.DecidedByUserId = _user.UserId;
        plan.DecidedByEmail = _user.Email;
        plan.DecidedAt = _clock.UtcNow;
        plan.DecisionNote = request.Note;

        var run = await _db.AgentRuns.FirstOrDefaultAsync(r => r.Id == agentRunId, ct);
        if (run is not null && !request.Approve)
        {
            run.Status = AgentRunStatus.Stopped;
            run.Phase = AgentPhase.Done;
            run.CompletedAt = _clock.UtcNow;
            run.StopReason = $"The plan was rejected by {_user.Email}: {request.Note}";
        }
        else if (run is { Status: AgentRunStatus.AwaitingApproval })
        {
            // Queued again rather than resumed in place. The runner claims queued passes and
            // is the only thing that runs the loop, so re-queueing is how an approved plan
            // starts working without a second code path that could drift from the first.
            run.Status = AgentRunStatus.Queued;
            run.Phase = AgentPhase.Pending;
            run.StopReason = null;
            // Generation onward. Crawling again would change the map underneath the plan this
            // person just approved, and proposing a second plan would ask them again.
            run.ResumeFromPhase = AgentPhase.Generating;
        }

        await _db.SaveChangesAsync(ct);

        var excluded = plan.Items.Where(i => !i.Included).Select(i => i.Category.ToString()).ToList();
        await _journal.RecordAsync(agentRunId, new AgentDecisionRecord(
            AgentPhase.Planning,
            request.Approve
                ? $"The plan was approved by {_user.Email}."
                : $"The plan was rejected by {_user.Email}.",
            request.Note ?? "No note was given.",
            new[]
            {
                new AgentEvidence("decidedBy", _user.Email ?? "unknown"),
                new AgentEvidence("categoriesIncluded",
                    string.Join(", ", plan.Items.Where(i => i.Included).Select(i => i.Category))),
                new AgentEvidence("categoriesExcluded",
                    excluded.Count == 0 ? "none" : string.Join(", ", excluded)),
                new AgentEvidence("testsPlanned",
                    plan.Items.Where(i => i.Included).Sum(i => i.TestCount).ToString())
            },
            Tool: null,
            Result: plan.Status.ToString(),
            // In its own column. The email in the evidence comes back partly masked, which is
            // right for something that gets exported and is not a record of who decided.
            ActorUserId: _user.UserId), ct);

        await _audit.LogAsync(
            request.Approve ? AuditAction.AgentPlanApproved : AuditAction.AgentPlanRejected,
            nameof(AgentTestPlan), plan.Id,
            $"Agent test plan {plan.Status.ToString().ToLowerInvariant()}: "
            + $"{plan.Items.Count(i => i.Included)} of {plan.Items.Count} category(ies), "
            + $"{plan.Items.Where(i => i.Included).Sum(i => i.TestCount)} test(s).",
            organizationId: plan.OrganizationId, ct: ct);

        return Result<PlanView>.Success(Project(plan));
    }

    private Task<AgentTestPlan?> Load(Guid agentRunId, CancellationToken ct)
        => _db.AgentTestPlans
            .Include(p => p.Items)
            .OrderByDescending(p => p.CreatedAt)
            .FirstOrDefaultAsync(p => p.AgentRunId == agentRunId, ct);

    private static PlanView Project(AgentTestPlan plan) => new(
        plan.Id, plan.AgentRunId, plan.ApplicationId, plan.Status, plan.Objective,
        plan.PagesDiscovered, plan.EndpointsDiscovered, plan.JourneysKnown, plan.RolesKnown,
        plan.Summary,
        string.IsNullOrWhiteSpace(plan.NotCovered)
            ? Array.Empty<string>()
            : plan.NotCovered.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
        plan.Items
            .OrderBy(i => i.Category)
            .Select(i => new PlanItemView(
                i.Id, i.Category, i.TestCount, i.ToGenerate, i.Why, i.Risk, i.Coverage,
                i.EstimatedSeconds, i.EstimateFromHistory, i.PotentialImpact, i.Included))
            .ToList(),
        plan.Items.Where(i => i.Included).Sum(i => i.TestCount),
        plan.Items.Where(i => i.Included).Sum(i => i.EstimatedSeconds),
        plan.DecidedByEmail, plan.DecidedAt, plan.DecisionNote);
}
