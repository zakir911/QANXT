using System.Text.Json;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Security;
using QaNxt.Domain.Agent;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Application.Agent;

public sealed record DecisionView(
    Guid Id, int Sequence, AgentPhase Phase, string? Tool, string Summary, string Reason,
    IReadOnlyList<EvidenceView> Evidence, string? Result, bool Allowed, string? Denial,
    string? Risk, Guid? ActorUserId, bool ModelContributed, decimal AiCostUsd,
    DateTimeOffset OccurredAt);

public sealed record EvidenceView(string Name, string Value);

public sealed record ApprovalView(
    Guid Id, string Tool, string Reason, string Proposal, IReadOnlyList<EvidenceView> Evidence,
    string Risk, string? ExpectedImpact, AgentApprovalStatus Status,
    string? DecidedByEmail, string? Justification, DateTimeOffset? DecidedAt);

/// <summary>One moment on the run's timeline.</summary>
public sealed record TimelineEntry(
    DateTimeOffset At,
    string Kind,
    AgentPhase Phase,
    string Title,
    string? Detail,
    /// <summary>What to open to see the evidence behind this, if anything.</summary>
    string? Link);

public sealed record AgentApprovalDecisionRequest(bool Grant, string Justification);

public interface IAgentObservabilityService
{
    Task<Result<IReadOnlyList<DecisionView>>> DecisionsAsync(Guid runId, CancellationToken ct = default);
    Task<Result<IReadOnlyList<ApprovalView>>> ApprovalsAsync(Guid runId, CancellationToken ct = default);
    Task<Result<ApprovalView>> DecideApprovalAsync(
        Guid approvalId, AgentApprovalDecisionRequest request, CancellationToken ct = default);
    Task<Result<IReadOnlyList<TimelineEntry>>> TimelineAsync(Guid runId, CancellationToken ct = default);
}

/// <summary>
/// Reading back what an unattended pass did, and answering the questions it stopped to ask.
/// </summary>
/// <remarks>
/// The pass ran with nobody watching, so everything it concluded is worth exactly as much as
/// this surface makes it inspectable. The timeline in particular is assembled from the
/// recorded steps, decisions and approvals rather than reconstructed from the run's counters —
/// a timeline derived from totals can be drawn for a run that recorded nothing.
/// </remarks>
public sealed class AgentObservabilityService : IAgentObservabilityService
{
    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _user;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;

    public AgentObservabilityService(
        IQaNxtDbContext db, ICurrentUser user, IClock clock, IAuditLogger audit)
    {
        _db = db;
        _user = user;
        _clock = clock;
        _audit = audit;
    }

    public async Task<Result<IReadOnlyList<DecisionView>>> DecisionsAsync(
        Guid runId, CancellationToken ct = default)
    {
        if (!await RunExistsAsync(runId, ct))
            return Result<IReadOnlyList<DecisionView>>.Failure(Error.NotFound("The agent run"));

        var decisions = await _db.AgentDecisions.AsNoTracking()
            .Where(d => d.AgentRunId == runId)
            .OrderBy(d => d.Sequence)
            .ToListAsync(ct);

        return Result<IReadOnlyList<DecisionView>>.Success(decisions.Select(d => new DecisionView(
            d.Id, d.Sequence, d.Phase, d.Tool, d.Summary, d.Reason, Evidence(d.EvidenceJson),
            d.Result, d.Allowed, d.Denial, d.Risk, d.ActorUserId,
            // Stated rather than left to be inferred from a null id: "the agent decided" and
            // "a model suggested and the agent accepted" are different facts, and the second
            // is the one a reader should treat sceptically.
            d.AiRequestId is not null, d.AiCostUsd, d.OccurredAt)).ToList());
    }

    public async Task<Result<IReadOnlyList<ApprovalView>>> ApprovalsAsync(
        Guid runId, CancellationToken ct = default)
    {
        if (!await RunExistsAsync(runId, ct))
            return Result<IReadOnlyList<ApprovalView>>.Failure(Error.NotFound("The agent run"));

        var approvals = await _db.AgentApprovals.AsNoTracking()
            .Where(a => a.AgentRunId == runId)
            .OrderBy(a => a.CreatedAt)
            .ToListAsync(ct);

        return Result<IReadOnlyList<ApprovalView>>.Success(approvals.Select(Project).ToList());
    }

    public async Task<Result<ApprovalView>> DecideApprovalAsync(
        Guid approvalId, AgentApprovalDecisionRequest request, CancellationToken ct = default)
    {
        // The same permission that starts a run. Answering one of these is what lets the pass
        // do the thing it stopped to ask about.
        if (!_user.HasPermission(Permissions.ExecutionRun))
            return Result<ApprovalView>.Failure(Error.Forbidden(
                "Answering an agent's question needs 'execution:run': granting one is what "
                + "lets the pass perform the action it stopped for."));

        if (string.IsNullOrWhiteSpace(request.Justification) || request.Justification.Trim().Length < 10)
            return Result<ApprovalView>.Failure(Error.Validation(
                "An answer needs a reason of at least ten characters. An approval with nobody's "
                + "reasoning behind it is indistinguishable from the control being switched off."));

        var approval = await _db.AgentApprovals.FirstOrDefaultAsync(a => a.Id == approvalId, ct);
        if (approval is null)
            return Result<ApprovalView>.Failure(Error.NotFound("The approval"));

        if (approval.Status != AgentApprovalStatus.Pending)
            return Result<ApprovalView>.Failure(Error.Conflict("approval_already_decided",
                $"This was already {approval.Status.ToString().ToLowerInvariant()}"
                + (approval.DecidedByEmail is null ? "" : $" by {approval.DecidedByEmail}") + "."));

        approval.Status = request.Grant ? AgentApprovalStatus.Granted : AgentApprovalStatus.Refused;
        approval.DecidedByUserId = _user.UserId;
        approval.DecidedByEmail = _user.Email;
        approval.Justification = request.Justification.Trim();
        approval.DecidedAt = _clock.UtcNow;

        // Saved before anything asks the database how many questions are still open.
        //
        // This is where a real pass got stuck: the count ran against the database while this
        // approval's new status existed only in the change tracker, so the answer was always
        // "one still pending" and the run was never released. It granted, reported granted,
        // and sat at AwaitingApproval for ever — the worst shape of bug, because every visible
        // signal said it had worked.
        await _db.SaveChangesAsync(ct);

        // Answering the last outstanding question releases the pass. Queued again rather than
        // resumed in place: the runner is the only thing that runs the loop, and a second code
        // path for "resume" would drift from the first.
        var run = await _db.AgentRuns.FirstOrDefaultAsync(r => r.Id == approval.AgentRunId, ct);
        var stillPending = await _db.AgentApprovals.CountAsync(
            a => a.AgentRunId == approval.AgentRunId
                 && a.Status == AgentApprovalStatus.Pending, ct);

        if (run is { Status: AgentRunStatus.AwaitingApproval } && stillPending == 0)
        {
            if (request.Grant)
            {
                run.Status = AgentRunStatus.Queued;
                run.Phase = AgentPhase.Pending;
                run.StopReason = null;
                // ResumeFromPhase was set when the pass parked, so it picks up at the phase
                // that asked rather than starting over.
            }
            else
            {
                // Refused, and nothing else is outstanding. The pass has no reason to carry
                // on and every reason to say what it did not do.
                run.Status = AgentRunStatus.Stopped;
                run.Phase = AgentPhase.Done;
                run.CompletedAt = _clock.UtcNow;
                run.StopReason =
                    $"{approval.Tool} was refused by {_user.Email}: {approval.Justification}. "
                    + "The pass stopped without performing it, and nothing it would have "
                    + "established is known.";
            }
        }

        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.AgentApprovalDecided, nameof(AgentApproval), approval.Id,
            $"Agent approval for '{approval.Tool}' was "
            + $"{approval.Status.ToString().ToLowerInvariant()}: {approval.Justification}",
            organizationId: approval.OrganizationId, ct: ct);

        return Result<ApprovalView>.Success(Project(approval));
    }

    public async Task<Result<IReadOnlyList<TimelineEntry>>> TimelineAsync(
        Guid runId, CancellationToken ct = default)
    {
        var run = await _db.AgentRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == runId, ct);
        if (run is null)
            return Result<IReadOnlyList<TimelineEntry>>.Failure(Error.NotFound("The agent run"));

        var entries = new List<TimelineEntry>();

        if (run.StartedAt is { } startedAt)
            entries.Add(new TimelineEntry(startedAt, "run", AgentPhase.Pending,
                $"Pass started: {run.Name}", run.Objective, null));

        // Assembled from what was recorded rather than from the run's counters. A timeline
        // derived from totals can be drawn for a pass that recorded nothing.
        var steps = await _db.AgentSteps.AsNoTracking()
            .Where(s => s.AgentRunId == runId)
            .OrderBy(s => s.Order)
            .ToListAsync(ct);

        entries.AddRange(steps.Select(s => new TimelineEntry(
            s.StartedAt, s.Succeeded ? "phase" : "phase-failed", s.Phase,
            s.Description, s.Rationale, null)));

        var decisions = await _db.AgentDecisions.AsNoTracking()
            .Where(d => d.AgentRunId == runId)
            .OrderBy(d => d.Sequence)
            .ToListAsync(ct);

        entries.AddRange(decisions.Select(d => new TimelineEntry(
            d.OccurredAt, d.Allowed ? "decision" : "refusal", d.Phase,
            d.Summary, d.Reason, $"decision:{d.Id}")));

        var approvals = await _db.AgentApprovals.AsNoTracking()
            .Where(a => a.AgentRunId == runId)
            .ToListAsync(ct);

        foreach (var approval in approvals)
        {
            entries.Add(new TimelineEntry(approval.CreatedAt, "approval-requested",
                AgentPhase.AwaitingApproval,
                $"Asked for approval to use {approval.Tool}", approval.Proposal,
                $"approval:{approval.Id}"));

            if (approval.DecidedAt is { } decidedAt)
                entries.Add(new TimelineEntry(decidedAt,
                    approval.Status == AgentApprovalStatus.Granted ? "approval-granted" : "approval-refused",
                    AgentPhase.AwaitingApproval,
                    $"{approval.Tool} was {approval.Status.ToString().ToLowerInvariant()}"
                    + (approval.DecidedByEmail is null ? "" : $" by {approval.DecidedByEmail}"),
                    approval.Justification, $"approval:{approval.Id}"));
        }

        if (run.CompletedAt is { } completedAt)
            entries.Add(new TimelineEntry(completedAt, "run", AgentPhase.Done,
                $"Pass {run.Status.ToString().ToLowerInvariant()}", run.StopReason, null));

        return Result<IReadOnlyList<TimelineEntry>>.Success(
            entries.OrderBy(e => e.At).ThenBy(e => e.Kind, StringComparer.Ordinal).ToList());
    }

    private Task<bool> RunExistsAsync(Guid runId, CancellationToken ct)
        => _db.AgentRuns.AsNoTracking().AnyAsync(r => r.Id == runId, ct);

    private static ApprovalView Project(AgentApproval a) => new(
        a.Id, a.Tool, a.Reason, a.Proposal, Evidence(a.EvidenceJson), a.Risk,
        a.ExpectedImpact, a.Status, a.DecidedByEmail, a.Justification, a.DecidedAt);

    private static IReadOnlyList<EvidenceView> Evidence(string json)
    {
        try
        {
            var parsed = JsonSerializer.Deserialize<List<EvidenceRow>>(json);
            return parsed?.Select(r => new EvidenceView(r.name ?? "", r.value ?? "")).ToList()
                   ?? new List<EvidenceView>();
        }
        catch (JsonException)
        {
            // Malformed evidence is reported as malformed rather than as none: an empty list
            // reads as "this decision had no evidence", which is the one thing the journal
            // refuses to allow and would be a lie here.
            return new List<EvidenceView>
            {
                new("evidence", "Stored evidence could not be read. This is a platform "
                                + "problem; it does not mean the decision had none.")
            };
        }
    }

    private sealed record EvidenceRow(string? name, string? value);
}
