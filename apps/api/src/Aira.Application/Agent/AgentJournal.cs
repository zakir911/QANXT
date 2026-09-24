using System.Text.Json;
using Aira.Application.Abstractions;
using Aira.Domain.Agent;
using Aira.Application.Security;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Aira.Application.Agent;

/// <summary>One named fact a decision rests on.</summary>
/// <remarks>
/// Deliberately a pair rather than a sentence. "Payment API changed in commit abc123" is an
/// assertion; <c>("changedEndpoint", "POST /api/transfers, commit abc123")</c> is something a
/// reader can go and check, and something a test can assert on.
/// </remarks>
public sealed record AgentEvidence(string Name, string Value);

/// <summary>What the agent is about to record.</summary>
public sealed record AgentDecisionRecord(
    AgentPhase Phase,
    string Summary,
    string Reason,
    IReadOnlyList<AgentEvidence> Evidence,
    string? Tool = null,
    string? Result = null,
    bool Allowed = true,
    AgentDenial Denial = AgentDenial.None,
    AgentActionRisk? Risk = null,
    Guid? AiRequestId = null,
    decimal AiCostUsd = 0m);

public interface IAgentJournal
{
    /// <summary>Records a decision. Refuses one with no evidence behind it.</summary>
    Task<Guid> RecordAsync(Guid agentRunId, AgentDecisionRecord decision, CancellationToken ct = default);

    /// <summary>Records the guard's answer for an action, whichever way it went.</summary>
    Task<Guid> RecordActionAsync(
        Guid agentRunId, AgentPhase phase, AgentActionRequest request,
        AgentPolicyDecision decision, IReadOnlyList<AgentEvidence> evidence,
        string summary, string? result = null, CancellationToken ct = default);

    /// <summary>Asks a person. Returns the approval record; it does not wait for an answer.</summary>
    Task<Guid> RequestApprovalAsync(
        Guid agentRunId, string tool, string reason, string proposal, string risk,
        IReadOnlyList<AgentEvidence> evidence, string? expectedImpact = null,
        CancellationToken ct = default);

    /// <summary>The tools a person has approved for this run.</summary>
    Task<IReadOnlySet<string>> GrantedApprovalsAsync(Guid agentRunId, CancellationToken ct = default);
}

/// <summary>
/// Where the agent writes down what it did and why.
/// </summary>
/// <remarks>
/// <para>
/// One rule is enforced here and nowhere else: <strong>a decision with no evidence is
/// refused</strong>. Not warned about, not stored with an empty array — refused, the same way
/// the security engine refuses a finding with no request and response behind it, and for the
/// same reason. The agent's output is a set of claims nobody watched it form. A claim that
/// cannot be checked is not a weaker claim, it is a different kind of thing.
/// </para>
/// <para>
/// The exception is a refusal. When the policy guard says no, the guard's own reason is the
/// evidence — there is nothing else to look at, and demanding more would push callers into
/// inventing some.
/// </para>
/// </remarks>
public sealed class AgentJournal : IAgentJournal
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    private readonly IAiraDbContext _db;
    private readonly IClock _clock;
    private readonly SecretMasker _masker;

    public AgentJournal(IAiraDbContext db, IClock clock, SecretMasker masker)
    {
        _db = db;
        _clock = clock;
        _masker = masker;
    }

    public async Task<Guid> RecordAsync(
        Guid agentRunId, AgentDecisionRecord decision, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(decision.Summary))
            throw new ArgumentException("A decision needs a summary.", nameof(decision));
        if (string.IsNullOrWhiteSpace(decision.Reason))
            throw new ArgumentException("A decision needs a reason.", nameof(decision));

        // The rule. A permitted action with nothing behind it is the case this exists to stop:
        // it reads as reasoned and is not.
        if (decision.Allowed && decision.Evidence.Count == 0)
            throw new ArgumentException(
                $"The decision '{decision.Summary}' carries no evidence. A decision nobody can "
                + "check is not a decision this platform will record.", nameof(decision));

        var run = await _db.AgentRuns.FirstOrDefaultAsync(r => r.Id == agentRunId, ct)
            ?? throw new InvalidOperationException($"Agent run {agentRunId} does not exist.");

        var sequence = await _db.AgentDecisions
            .Where(d => d.AgentRunId == agentRunId)
            .Select(d => (int?)d.Sequence)
            .MaxAsync(ct) ?? 0;

        var record = new AgentDecision
        {
            OrganizationId = run.OrganizationId,
            AgentRunId = agentRunId,
            Sequence = sequence + 1,
            Phase = decision.Phase,
            Tool = decision.Tool,
            // Masked on the way in rather than on the way out. Evidence is read by reports,
            // the console and the CLI, and masking at each of those is three chances to forget.
            Summary = _masker.MaskText(decision.Summary),
            Reason = _masker.MaskText(decision.Reason),
            EvidenceJson = JsonSerializer.Serialize(
                decision.Evidence.Select(e => new { name = e.Name, value = _masker.MaskText(e.Value) }),
                Json),
            Result = decision.Result is null ? null : _masker.MaskText(decision.Result),
            Allowed = decision.Allowed,
            Denial = decision.Denial == AgentDenial.None ? null : decision.Denial.ToString(),
            Risk = decision.Risk?.ToString(),
            AiRequestId = decision.AiRequestId,
            AiCostUsd = decision.AiCostUsd,
            OccurredAt = _clock.UtcNow
        };

        _db.AgentDecisions.Add(record);
        await _db.SaveChangesAsync(ct);
        return record.Id;
    }

    public Task<Guid> RecordActionAsync(
        Guid agentRunId, AgentPhase phase, AgentActionRequest request,
        AgentPolicyDecision decision, IReadOnlyList<AgentEvidence> evidence,
        string summary, string? result = null, CancellationToken ct = default)
    {
        // A refusal's evidence is the guard's answer: which rungs passed, and where it stopped.
        // Anything else would be padding, and padding in an audit trail is worse than brevity.
        var behind = decision.Allowed
            ? evidence
            : evidence.Concat(new[]
            {
                new AgentEvidence("policyRungsPassed", string.Join(" → ", decision.Passed)),
                new AgentEvidence("deniedAt", decision.Denial.ToString())
            }).ToList();

        return RecordAsync(agentRunId, new AgentDecisionRecord(
            phase, summary, decision.Reason, behind,
            Tool: request.ToolName,
            Result: result ?? (decision.Allowed ? null : "Not performed."),
            Allowed: decision.Allowed,
            Denial: decision.Denial,
            Risk: decision.EffectiveRisk), ct);
    }

    public async Task<Guid> RequestApprovalAsync(
        Guid agentRunId, string tool, string reason, string proposal, string risk,
        IReadOnlyList<AgentEvidence> evidence, string? expectedImpact = null,
        CancellationToken ct = default)
    {
        var run = await _db.AgentRuns.FirstOrDefaultAsync(r => r.Id == agentRunId, ct)
            ?? throw new InvalidOperationException($"Agent run {agentRunId} does not exist.");

        // One pending question per tool per run. Asking the same thing repeatedly is how a
        // queue of approvals becomes something nobody reads.
        var existing = await _db.AgentApprovals.FirstOrDefaultAsync(
            a => a.AgentRunId == agentRunId && a.Tool == tool
                 && a.Status == AgentApprovalStatus.Pending, ct);
        if (existing is not null) return existing.Id;

        var approval = new AgentApproval
        {
            OrganizationId = run.OrganizationId,
            AgentRunId = agentRunId,
            Tool = tool,
            Reason = _masker.MaskText(reason),
            Proposal = _masker.MaskText(proposal),
            Risk = risk,
            EvidenceJson = JsonSerializer.Serialize(
                evidence.Select(e => new { name = e.Name, value = _masker.MaskText(e.Value) }), Json),
            ExpectedImpact = expectedImpact is null ? null : _masker.MaskText(expectedImpact),
            Status = AgentApprovalStatus.Pending
        };

        _db.AgentApprovals.Add(approval);
        await _db.SaveChangesAsync(ct);
        return approval.Id;
    }

    public async Task<IReadOnlySet<string>> GrantedApprovalsAsync(
        Guid agentRunId, CancellationToken ct = default)
    {
        var granted = await _db.AgentApprovals
            .Where(a => a.AgentRunId == agentRunId && a.Status == AgentApprovalStatus.Granted)
            .Select(a => a.Tool)
            .ToListAsync(ct);

        return new HashSet<string>(granted, StringComparer.Ordinal);
    }
}
