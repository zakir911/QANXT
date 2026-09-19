using Aira.Application.Abstractions;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Aira.Application.Dashboard;

public sealed record DashboardSummary(
    int TotalTests, int EnabledTests, int ExecutionsInWindow,
    int Passed, int Failed, int Skipped, int Blocked, int Healed, int Flaky,
    decimal PassRatePercent, decimal FailureRatePercent, int AverageDurationMs,
    int NewFailures, int OpenDefects, int PendingHealingProposals,
    int RegressionRiskScore, string RegressionRiskRationale);

public sealed record TrendPoint(DateOnly Date, int Passed, int Failed, int Healed, int Flaky, decimal PassRatePercent);

public sealed record FailingTest(Guid TestCaseId, string Reference, string Name, int FailureCount,
    int ExecutionCount, string? LastMessage, FailureCategory? Category, DateTimeOffset? LastFailedAt);

public sealed record UnstableTest(Guid TestCaseId, string Reference, string Name, int FlakinessScore,
    int ExecutionCount, int PassCount, int FailCount);

public sealed record CategoryCount(FailureCategory Category, int Count);

public sealed record HealingStatistics(int Total, int Applied, int Proposed, int Approved, int Rejected,
    int AverageConfidence, int VerifiedCount);

public sealed record DashboardView(
    DashboardSummary Summary,
    IReadOnlyList<TrendPoint> Trend,
    IReadOnlyList<FailingTest> TopFailingTests,
    IReadOnlyList<UnstableTest> TopUnstableTests,
    IReadOnlyList<CategoryCount> FailureCategories,
    HealingStatistics Healing,
    IReadOnlyList<DurationPoint> SlowestTests);

public sealed record DurationPoint(Guid TestCaseId, string Reference, string Name, int AverageDurationMs);

public interface IDashboardService
{
    Task<DashboardView> GetAsync(Guid? projectId, int windowDays, CancellationToken ct = default);
}

/// <summary>Aggregates the numbers the dashboard shows.
///
/// Every figure here is computed from stored executions — nothing is estimated, sampled or
/// placeholder. Where a number cannot be computed honestly (no executions in the window),
/// it is reported as zero with the window stated, rather than filled in.</summary>
public sealed class DashboardService : IDashboardService
{
    private readonly IAiraDbContext _db;
    private readonly IClock _clock;

    public DashboardService(IAiraDbContext db, IClock clock)
    {
        _db = db;
        _clock = clock;
    }

    public async Task<DashboardView> GetAsync(Guid? projectId, int windowDays, CancellationToken ct = default)
    {
        var window = Math.Clamp(windowDays, 1, 365);
        var since = _clock.UtcNow.AddDays(-window);

        var executions = _db.TestExecutions.Where(e => e.CompletedAt >= since);
        var testCases = _db.TestCases.AsQueryable();
        var failures = _db.Failures.Where(f => f.LastSeenAt >= since);
        var healing = _db.HealingEvents.Where(h => h.OccurredAt >= since);
        var defects = _db.Defects.AsQueryable();

        if (projectId is not null)
        {
            executions = executions.Where(e => e.TestCase!.ProjectId == projectId);
            testCases = testCases.Where(tc => tc.ProjectId == projectId);
            failures = failures.Where(f => f.ProjectId == projectId);
            healing = healing.Where(h => h.ProjectId == projectId);
            defects = defects.Where(d => d.ProjectId == projectId);
        }

        var statuses = await executions
            .Select(e => new { e.Status, e.DurationMs, e.CompletedAt, e.TestCaseId })
            .ToListAsync(ct);

        var passed = statuses.Count(s => s.Status is ExecutionStatus.Passed or ExecutionStatus.Flaky);
        var failed = statuses.Count(s => s.Status is ExecutionStatus.Failed or ExecutionStatus.Error);
        var healed = statuses.Count(s => s.Status == ExecutionStatus.Healed);
        var flaky = statuses.Count(s => s.Status == ExecutionStatus.Flaky);
        var skipped = statuses.Count(s => s.Status == ExecutionStatus.Skipped);
        var blocked = statuses.Count(s => s.Status == ExecutionStatus.Blocked);

        // Blocked and skipped executions never reached a verdict, so including them in the
        // pass rate would make an unreachable environment look like a quality problem.
        var verdicts = passed + failed + healed;
        var passRate = verdicts == 0 ? 0m : Math.Round((passed + healed) * 100m / verdicts, 1);
        var failureRate = verdicts == 0 ? 0m : Math.Round(failed * 100m / verdicts, 1);

        var totalTests = await testCases.CountAsync(ct);
        var enabledTests = await testCases.CountAsync(tc => tc.IsEnabled, ct);
        var newFailures = await failures.CountAsync(f => f.IsNewFailure, ct);
        var openDefects = await defects.CountAsync(d =>
            d.Status == DefectStatus.Open || d.Status == DefectStatus.Triaged || d.Status == DefectStatus.InProgress, ct);
        var pendingHealing = await healing.CountAsync(h => h.Outcome == HealingOutcome.Proposed, ct);

        var (riskScore, rationale) = ComputeRegressionRisk(passRate, failed, newFailures, flaky, verdicts);

        return new DashboardView(
            new DashboardSummary(
                totalTests, enabledTests, statuses.Count, passed, failed, skipped, blocked, healed, flaky,
                passRate, failureRate,
                statuses.Count == 0 ? 0 : (int)statuses.Average(s => s.DurationMs),
                newFailures, openDefects, pendingHealing, riskScore, rationale),
            await BuildTrendAsync(statuses, window),
            await TopFailingAsync(projectId, since, ct),
            await TopUnstableAsync(testCases, ct),
            await FailureCategoriesAsync(failures, ct),
            await HealingStatisticsAsync(healing, ct),
            await SlowestAsync(testCases, ct));
    }

    /// <summary>A composite of the signals that actually predict a bad release: how much is
    /// failing, how much of it is new, and how much of the suite cannot be trusted.</summary>
    private static (int Score, string Rationale) ComputeRegressionRisk(
        decimal passRate, int failed, int newFailures, int flaky, int verdicts)
    {
        if (verdicts == 0)
            return (0, "No executions completed in this window, so there is nothing to assess.");

        var reasons = new List<string>();
        var score = 0;

        var failureWeight = (int)Math.Min(40, (100 - passRate) * 0.8m);
        if (failureWeight > 0)
        {
            score += failureWeight;
            reasons.Add($"the pass rate is {passRate}%");
        }

        if (newFailures > 0)
        {
            // New failures matter more than familiar ones: they correlate with the change
            // that was just made.
            var weight = Math.Min(35, newFailures * 7);
            score += weight;
            reasons.Add($"{newFailures} failure(s) are new");
        }

        if (flaky > 0)
        {
            var weight = Math.Min(15, flaky * 3);
            score += weight;
            reasons.Add($"{flaky} execution(s) were unstable");
        }

        if (verdicts < 5)
        {
            score += 10;
            reasons.Add($"only {verdicts} execution(s) ran, so coverage of this window is thin");
        }

        score = Math.Clamp(score, 0, 100);
        var rationale = reasons.Count == 0
            ? $"All {verdicts} execution(s) passed and nothing is unstable."
            : $"Scored {score}/100 because {string.Join(", and ", reasons)}.";

        return (score, rationale);
    }

    private Task<IReadOnlyList<TrendPoint>> BuildTrendAsync(
        IReadOnlyList<dynamic> statuses, int window)
    {
        var byDay = statuses
            .Where(s => s.CompletedAt != null)
            .GroupBy(s => DateOnly.FromDateTime(((DateTimeOffset)s.CompletedAt!).UtcDateTime))
            .OrderBy(g => g.Key)
            .Select(g =>
            {
                var dayPassed = g.Count(x => x.Status == ExecutionStatus.Passed || x.Status == ExecutionStatus.Flaky);
                var dayFailed = g.Count(x => x.Status == ExecutionStatus.Failed || x.Status == ExecutionStatus.Error);
                var dayHealed = g.Count(x => x.Status == ExecutionStatus.Healed);
                var dayFlaky = g.Count(x => x.Status == ExecutionStatus.Flaky);
                var dayVerdicts = dayPassed + dayFailed + dayHealed;
                return new TrendPoint(g.Key, dayPassed, dayFailed, dayHealed, dayFlaky,
                    dayVerdicts == 0 ? 0m : Math.Round((dayPassed + dayHealed) * 100m / dayVerdicts, 1));
            })
            .ToList();

        return Task.FromResult<IReadOnlyList<TrendPoint>>(byDay);
    }

    private async Task<IReadOnlyList<FailingTest>> TopFailingAsync(Guid? projectId, DateTimeOffset since, CancellationToken ct)
    {
        var query = _db.Failures.Where(f => f.LastSeenAt >= since);
        if (projectId is not null) query = query.Where(f => f.ProjectId == projectId);

        // Aggregate in the database, keeping the shape to primitives EF can translate.
        var aggregated = await query
            .GroupBy(f => f.TestCaseId)
            .Select(g => new
            {
                TestCaseId = g.Key,
                FailureCount = g.Sum(f => f.OccurrenceCount),
                LastFailedAt = g.Max(f => f.LastSeenAt)
            })
            .OrderByDescending(x => x.FailureCount)
            .Take(10)
            .ToListAsync(ct);

        if (aggregated.Count == 0) return System.Array.Empty<FailingTest>();

        var testCaseIds = aggregated.Select(a => a.TestCaseId).ToList();

        // The most recent failure per test supplies the message and category shown.
        var latest = await query
            .Where(f => testCaseIds.Contains(f.TestCaseId))
            .OrderByDescending(f => f.LastSeenAt)
            .Select(f => new { f.TestCaseId, f.RawMessage, f.Category, f.LastSeenAt })
            .ToListAsync(ct);

        var cases = await _db.TestCases
            .Where(tc => testCaseIds.Contains(tc.Id))
            .Select(tc => new { tc.Id, tc.Reference, tc.Name, tc.ExecutionCount })
            .ToListAsync(ct);

        return aggregated
            .Select(a =>
            {
                var testCase = cases.FirstOrDefault(c => c.Id == a.TestCaseId);
                var mostRecent = latest.FirstOrDefault(l => l.TestCaseId == a.TestCaseId);
                return new FailingTest(
                    a.TestCaseId,
                    testCase?.Reference ?? "(deleted)",
                    testCase?.Name ?? "(deleted test)",
                    a.FailureCount,
                    testCase?.ExecutionCount ?? 0,
                    mostRecent?.RawMessage,
                    mostRecent?.Category,
                    a.LastFailedAt);
            })
            .Where(f => f.Reference != "(deleted)")
            .ToList();
    }

    private async Task<IReadOnlyList<UnstableTest>> TopUnstableAsync(IQueryable<Domain.Testing.TestCase> testCases, CancellationToken ct)
        => await testCases
            .Where(tc => tc.FlakinessScore > 0)
            .OrderByDescending(tc => tc.FlakinessScore)
            .Take(10)
            .Select(tc => new UnstableTest(tc.Id, tc.Reference, tc.Name, tc.FlakinessScore,
                tc.ExecutionCount, tc.PassCount, tc.FailCount))
            .ToListAsync(ct);

    private async Task<IReadOnlyList<CategoryCount>> FailureCategoriesAsync(IQueryable<Domain.Diagnosis.Failure> failures, CancellationToken ct)
    {
        // Grouped in the database, then shaped into the record in memory: EF cannot
        // translate a projection into a type with a constructor at the tail of a GroupBy.
        var grouped = await failures
            .GroupBy(f => f.Category)
            .Select(g => new { Category = g.Key, Count = g.Count() })
            .ToListAsync(ct);

        return grouped
            .OrderByDescending(g => g.Count)
            .Select(g => new CategoryCount(g.Category, g.Count))
            .ToList();
    }

    private async Task<HealingStatistics> HealingStatisticsAsync(IQueryable<Domain.Diagnosis.HealingEvent> healing, CancellationToken ct)
    {
        var events = await healing.Select(h => new { h.Outcome, h.Confidence, h.OutcomeVerified }).ToListAsync(ct);

        return new HealingStatistics(
            events.Count,
            events.Count(e => e.Outcome == HealingOutcome.Applied),
            events.Count(e => e.Outcome == HealingOutcome.Proposed),
            events.Count(e => e.Outcome == HealingOutcome.Approved),
            events.Count(e => e.Outcome == HealingOutcome.Rejected),
            events.Count == 0 ? 0 : (int)events.Average(e => e.Confidence),
            events.Count(e => e.OutcomeVerified));
    }

    private async Task<IReadOnlyList<DurationPoint>> SlowestAsync(IQueryable<Domain.Testing.TestCase> testCases, CancellationToken ct)
        => await testCases
            .Where(tc => tc.AverageDurationMs > 0)
            .OrderByDescending(tc => tc.AverageDurationMs)
            .Take(10)
            .Select(tc => new DurationPoint(tc.Id, tc.Reference, tc.Name, tc.AverageDurationMs))
            .ToListAsync(ct);
}
