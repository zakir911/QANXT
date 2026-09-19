using Aira.Application.Abstractions;
using Aira.Application.Contracts;
using Aira.Domain.Common;
using Aira.Domain.Diagnosis;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Diagnosis;

public sealed record HealingProposalSummary(
    Guid Id, Guid ProjectId, Guid TestCaseId, string TestCaseName, Guid TestStepId,
    string StepDescription, string OriginalLocator, string HealedLocator, string Reason,
    int Confidence, HealingOutcome Outcome, bool OutcomeVerified, HealingPolicy PolicyAtTime,
    bool ProducedByAi, DateTimeOffset OccurredAt, Guid? ReviewedByUserId, DateTimeOffset? ReviewedAt,
    string? ReviewComment, string? ScoreBreakdownJson, string? ApplicationBuildRef);

public interface IHealingService
{
    Task<IReadOnlyList<HealingProposalSummary>> ListAsync(Guid? projectId, HealingOutcome? outcome, int limit, CancellationToken ct = default);
    Task<Result<HealingProposalSummary>> GetAsync(Guid id, CancellationToken ct = default);
    Task<Result<HealingProposalSummary>> ApproveAsync(Guid id, string? comment, CancellationToken ct = default);
    Task<Result<HealingProposalSummary>> RejectAsync(Guid id, string? comment, CancellationToken ct = default);
    Task<Result<HealingProposalSummary>> RevertAsync(Guid id, string? comment, CancellationToken ct = default);
}

/// <summary>The approval workflow for locator healing.
///
/// Healing a run is the worker's business; changing a stored test is not. Approval is the
/// only path by which a proposal becomes part of the test definition, it is always
/// attributable to a person, and it is always reversible — the original locator is kept on
/// the event, so reverting is exact rather than reconstructed.</summary>
public sealed class HealingService : IHealingService
{
    private readonly IAiraDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly ILogger<HealingService> _logger;

    public HealingService(IAiraDbContext db, ICurrentUser currentUser, IClock clock,
        IAuditLogger audit, ILogger<HealingService> logger)
    {
        _db = db;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
        _logger = logger;
    }

    public async Task<IReadOnlyList<HealingProposalSummary>> ListAsync(
        Guid? projectId, HealingOutcome? outcome, int limit, CancellationToken ct = default)
    {
        var query = _db.HealingEvents.AsQueryable();
        if (projectId is not null) query = query.Where(h => h.ProjectId == projectId);
        if (outcome is not null) query = query.Where(h => h.Outcome == outcome);

        var events = await query
            .OrderByDescending(h => h.OccurredAt)
            .Take(Math.Clamp(limit, 1, 200))
            .ToListAsync(ct);

        return await MapManyAsync(events, ct);
    }

    public async Task<Result<HealingProposalSummary>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var healingEvent = await _db.HealingEvents.FirstOrDefaultAsync(h => h.Id == id, ct);
        if (healingEvent is null) return Error.NotFound("The healing proposal");

        var mapped = await MapManyAsync(new[] { healingEvent }, ct);
        return Result<HealingProposalSummary>.Success(mapped[0]);
    }

    public async Task<Result<HealingProposalSummary>> ApproveAsync(Guid id, string? comment, CancellationToken ct = default)
    {
        var healingEvent = await _db.HealingEvents.FirstOrDefaultAsync(h => h.Id == id, ct);
        if (healingEvent is null) return Error.NotFound("The healing proposal");

        if (healingEvent.Outcome is HealingOutcome.Approved or HealingOutcome.Rejected or HealingOutcome.Reverted)
            return Error.Conflict("already_reviewed", $"This proposal has already been {healingEvent.Outcome.ToString().ToLowerInvariant()}.");

        var step = await _db.TestSteps.FirstOrDefaultAsync(s => s.Id == healingEvent.TestStepId, ct);
        if (step is null) return Error.NotFound("The test step this proposal refers to");

        var healed = LocatorDescriptor.FromJson(healingEvent.HealedLocatorJson);
        if (healed is null) return Error.Validation("The proposed locator could not be read.");

        // The test definition changes only here, and only on a person's instruction.
        step.TargetJson = healed.ToJson();
        step.HealCount++;

        var testCase = await _db.TestCases.FirstOrDefaultAsync(tc => tc.Id == healingEvent.TestCaseId, ct);
        if (testCase is not null)
        {
            // A new version, so historical executions still describe the test they ran.
            testCase.Version++;
            testCase.UpdatedByUserId = _currentUser.UserId;
        }

        healingEvent.Outcome = HealingOutcome.Approved;
        healingEvent.ReviewedByUserId = _currentUser.UserId;
        healingEvent.ReviewedAt = _clock.UtcNow;
        healingEvent.ReviewComment = Truncate(comment, 2000);
        healingEvent.AppliedAt = _clock.UtcNow;

        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.HealingApproved, nameof(HealingEvent), healingEvent.Id,
            $"Healing approved for step '{step.Description}': {LocatorDescriptor.FromJson(healingEvent.OriginalLocatorJson)?.Describe()} -> {healed.Describe()} ({healingEvent.Confidence}% confidence).",
            new { original = healingEvent.OriginalLocatorJson, healed = healingEvent.HealedLocatorJson },
            projectId: healingEvent.ProjectId, ct: ct);

        _logger.LogInformation("Healing proposal {Id} approved by {UserId}", healingEvent.Id, _currentUser.UserId);

        var mapped = await MapManyAsync(new[] { healingEvent }, ct);
        return Result<HealingProposalSummary>.Success(mapped[0]);
    }

    public async Task<Result<HealingProposalSummary>> RejectAsync(Guid id, string? comment, CancellationToken ct = default)
    {
        var healingEvent = await _db.HealingEvents.FirstOrDefaultAsync(h => h.Id == id, ct);
        if (healingEvent is null) return Error.NotFound("The healing proposal");

        if (healingEvent.Outcome is HealingOutcome.Approved or HealingOutcome.Rejected)
            return Error.Conflict("already_reviewed", $"This proposal has already been {healingEvent.Outcome.ToString().ToLowerInvariant()}.");

        healingEvent.Outcome = HealingOutcome.Rejected;
        healingEvent.ReviewedByUserId = _currentUser.UserId;
        healingEvent.ReviewedAt = _clock.UtcNow;
        healingEvent.ReviewComment = Truncate(comment, 2000);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.HealingRejected, nameof(HealingEvent), healingEvent.Id,
            $"Healing rejected: {comment ?? "no comment given"}.", projectId: healingEvent.ProjectId, ct: ct);

        var mapped = await MapManyAsync(new[] { healingEvent }, ct);
        return Result<HealingProposalSummary>.Success(mapped[0]);
    }

    public async Task<Result<HealingProposalSummary>> RevertAsync(Guid id, string? comment, CancellationToken ct = default)
    {
        var healingEvent = await _db.HealingEvents.FirstOrDefaultAsync(h => h.Id == id, ct);
        if (healingEvent is null) return Error.NotFound("The healing proposal");

        if (healingEvent.Outcome != HealingOutcome.Approved)
            return Error.Conflict("not_applied", "Only an approved proposal can be reverted.");

        var step = await _db.TestSteps.FirstOrDefaultAsync(s => s.Id == healingEvent.TestStepId, ct);
        if (step is null) return Error.NotFound("The test step this proposal refers to");

        var original = LocatorDescriptor.FromJson(healingEvent.OriginalLocatorJson);
        if (original is null) return Error.Validation("The original locator could not be read, so this cannot be reverted automatically.");

        // Exact restoration: the original was kept precisely so this is not guesswork.
        step.TargetJson = original.ToJson();

        var testCase = await _db.TestCases.FirstOrDefaultAsync(tc => tc.Id == healingEvent.TestCaseId, ct);
        if (testCase is not null)
        {
            testCase.Version++;
            testCase.UpdatedByUserId = _currentUser.UserId;
        }

        healingEvent.Outcome = HealingOutcome.Reverted;
        healingEvent.ReviewedByUserId = _currentUser.UserId;
        healingEvent.ReviewedAt = _clock.UtcNow;
        healingEvent.ReviewComment = Truncate(comment, 2000);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.HealingApplied, nameof(HealingEvent), healingEvent.Id,
            $"Healing reverted for step '{step.Description}': restored {original.Describe()}.",
            projectId: healingEvent.ProjectId, ct: ct);

        var mapped = await MapManyAsync(new[] { healingEvent }, ct);
        return Result<HealingProposalSummary>.Success(mapped[0]);
    }

    private async Task<IReadOnlyList<HealingProposalSummary>> MapManyAsync(
        IReadOnlyCollection<HealingEvent> events, CancellationToken ct)
    {
        var caseIds = events.Select(e => e.TestCaseId).Distinct().ToList();
        var stepIds = events.Select(e => e.TestStepId).Distinct().ToList();

        var cases = await _db.TestCases.Where(tc => caseIds.Contains(tc.Id))
            .Select(tc => new { tc.Id, tc.Name }).ToDictionaryAsync(tc => tc.Id, tc => tc.Name, ct);
        var steps = await _db.TestSteps.Where(s => stepIds.Contains(s.Id))
            .Select(s => new { s.Id, s.Description }).ToDictionaryAsync(s => s.Id, s => s.Description, ct);

        return events.Select(e => new HealingProposalSummary(
            e.Id, e.ProjectId, e.TestCaseId, cases.GetValueOrDefault(e.TestCaseId, "(deleted test)"),
            e.TestStepId, steps.GetValueOrDefault(e.TestStepId, "(deleted step)"),
            LocatorDescriptor.FromJson(e.OriginalLocatorJson)?.Describe() ?? e.OriginalLocatorJson,
            LocatorDescriptor.FromJson(e.HealedLocatorJson)?.Describe() ?? e.HealedLocatorJson,
            e.Reason, e.Confidence, e.Outcome, e.OutcomeVerified, e.PolicyAtTime, e.ProducedByAi,
            e.OccurredAt, e.ReviewedByUserId, e.ReviewedAt, e.ReviewComment, e.ScoreBreakdownJson,
            e.ApplicationBuildRef)).ToList();
    }

    private static string? Truncate(string? value, int max)
        => string.IsNullOrEmpty(value) ? null : value.Length <= max ? value : value[..max];
}
