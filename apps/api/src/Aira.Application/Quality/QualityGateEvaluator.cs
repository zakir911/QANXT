using Aira.Application.Abstractions;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Quality;

public sealed record QualityGateResult(
    bool Passed,
    IReadOnlyList<QualityGateRuleResult> Rules,
    string Summary);

public sealed record QualityGateRuleResult(
    Guid RuleId, string Name, QualityGateMetric Metric, QualityGateOperator Operator,
    decimal Threshold, decimal ActualValue, bool Passed, bool IsBlocking, string Explanation);

public interface IQualityGateEvaluator
{
    Task<QualityGateResult> EvaluateAsync(Guid testRunId, CancellationToken ct = default);
}

/// <summary>Decides whether a completed run should block a pipeline.
///
/// The rules are data, not code: a project defines what "good enough" means for it, and
/// this evaluates those rules against what the run actually produced. Every rule reports
/// the number it saw alongside the threshold it was compared against, because a gate that
/// fails without explaining itself just gets disabled.</summary>
public sealed class QualityGateEvaluator : IQualityGateEvaluator
{
    private readonly IAiraDbContext _db;
    private readonly ILogger<QualityGateEvaluator> _logger;

    public QualityGateEvaluator(IAiraDbContext db, ILogger<QualityGateEvaluator> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<QualityGateResult> EvaluateAsync(Guid testRunId, CancellationToken ct = default)
    {
        var run = await _db.TestRuns.FirstOrDefaultAsync(r => r.Id == testRunId, ct);
        if (run is null) return new QualityGateResult(true, Array.Empty<QualityGateRuleResult>(), "The run was not found.");

        var rules = await _db.QualityGateRules
            .Where(r => r.ProjectId == run.ProjectId && r.IsEnabled)
            .ToListAsync(ct);

        if (rules.Count == 0)
        {
            return new QualityGateResult(true, Array.Empty<QualityGateRuleResult>(),
                "No quality gates are configured for this project, so the run does not block.");
        }

        var metrics = await GatherMetricsAsync(run, ct);
        var results = new List<QualityGateRuleResult>();

        foreach (var rule in rules)
        {
            var actual = metrics.GetValueOrDefault(rule.Metric, 0m);
            var passed = Compare(actual, rule.Operator, rule.Threshold);

            results.Add(new QualityGateRuleResult(
                rule.Id, rule.Name, rule.Metric, rule.Operator, rule.Threshold, actual, passed, rule.IsBlocking,
                passed
                    ? $"{Describe(rule.Metric)} was {Format(actual)}, which satisfies {Describe(rule.Operator)} {Format(rule.Threshold)}."
                    : $"{Describe(rule.Metric)} was {Format(actual)}, which fails {Describe(rule.Operator)} {Format(rule.Threshold)}."));
        }

        // Only a blocking rule can fail the gate. A non-blocking rule is a warning the team
        // wants recorded without stopping a release.
        var blockingFailures = results.Where(r => !r.Passed && r.IsBlocking).ToList();
        var passedOverall = blockingFailures.Count == 0;

        var summary = passedOverall
            ? results.Any(r => !r.Passed)
                ? $"The quality gate passed. {results.Count(r => !r.Passed)} non-blocking rule(s) reported a warning."
                : $"The quality gate passed: all {results.Count} rule(s) were satisfied."
            : $"The quality gate failed on {blockingFailures.Count} blocking rule(s): {string.Join("; ", blockingFailures.Select(r => r.Name))}.";

        if (!passedOverall)
            _logger.LogWarning("Run {RunId} failed its quality gate: {Summary}", run.Id, summary);

        return new QualityGateResult(passedOverall, results, summary);
    }

    private async Task<Dictionary<QualityGateMetric, decimal>> GatherMetricsAsync(Domain.Testing.TestRun run, CancellationToken ct)
    {
        // PassedCount already includes flaky executions, which did pass; healed ones are
        // counted too, since the journey completed.
        var finished = run.PassedCount + run.FailedCount + run.HealedCount;
        var passRate = finished == 0 ? 0m : (run.PassedCount + run.HealedCount) * 100m / finished;

        var criticalFailed = await _db.TestExecutions
            .Where(e => e.TestRunId == run.Id &&
                        (e.Status == ExecutionStatus.Failed || e.Status == ExecutionStatus.Error) &&
                        e.TestCase!.Priority == TestPriority.Critical)
            .CountAsync(ct);

        var newFailures = await _db.Failures
            .Where(f => f.TestExecutionId != null &&
                        _db.TestExecutions.Where(e => e.TestRunId == run.Id).Select(e => e.Id).Contains(f.TestExecutionId) &&
                        f.IsNewFailure)
            .CountAsync(ct);

        var highConfidenceDefects = await _db.FailureAnalyses
            .Where(a => a.IsLikelyApplicationDefect && a.Confidence >= 80 &&
                        _db.TestExecutions.Where(e => e.TestRunId == run.Id).Select(e => e.Id)
                            .Contains(a.Failure!.TestExecutionId))
            .CountAsync(ct);

        var criticalJourneyFailed = await _db.TestExecutions
            .Where(e => e.TestRunId == run.Id &&
                        (e.Status == ExecutionStatus.Failed || e.Status == ExecutionStatus.Error) &&
                        e.TestCase!.Risk == RiskLevel.Critical)
            .CountAsync(ct);

        var averageDuration = await _db.TestExecutions
            .Where(e => e.TestRunId == run.Id && e.DurationMs > 0)
            .Select(e => (decimal?)e.DurationMs)
            .AverageAsync(ct) ?? 0m;

        return new Dictionary<QualityGateMetric, decimal>
        {
            [QualityGateMetric.PassRatePercent] = Math.Round(passRate, 2),
            [QualityGateMetric.FailedCount] = run.FailedCount,
            [QualityGateMetric.CriticalFailedCount] = criticalFailed,
            [QualityGateMetric.FlakyCount] = run.FlakyCount,
            [QualityGateMetric.NewFailureCount] = newFailures,
            [QualityGateMetric.HighConfidenceDefectCount] = highConfidenceDefects,
            [QualityGateMetric.CriticalJourneyFailedCount] = criticalJourneyFailed,
            [QualityGateMetric.HealedCount] = run.HealedCount,
            [QualityGateMetric.AverageDurationMs] = Math.Round(averageDuration, 0)
        };
    }

    private static bool Compare(decimal actual, QualityGateOperator op, decimal threshold) => op switch
    {
        QualityGateOperator.LessThan => actual < threshold,
        QualityGateOperator.LessThanOrEqual => actual <= threshold,
        QualityGateOperator.GreaterThan => actual > threshold,
        QualityGateOperator.GreaterThanOrEqual => actual >= threshold,
        QualityGateOperator.Equal => actual == threshold,
        QualityGateOperator.NotEqual => actual != threshold,
        _ => true
    };

    private static string Describe(QualityGateMetric metric) => metric switch
    {
        QualityGateMetric.PassRatePercent => "The pass rate",
        QualityGateMetric.FailedCount => "The number of failed tests",
        QualityGateMetric.CriticalFailedCount => "The number of failed critical tests",
        QualityGateMetric.FlakyCount => "The number of flaky tests",
        QualityGateMetric.NewFailureCount => "The number of new failures",
        QualityGateMetric.HighConfidenceDefectCount => "The number of high-confidence defects",
        QualityGateMetric.CriticalJourneyFailedCount => "The number of failed critical journeys",
        QualityGateMetric.HealedCount => "The number of healed tests",
        QualityGateMetric.AverageDurationMs => "The average execution duration (ms)",
        _ => metric.ToString()
    };

    private static string Describe(QualityGateOperator op) => op switch
    {
        QualityGateOperator.LessThan => "being below",
        QualityGateOperator.LessThanOrEqual => "being at most",
        QualityGateOperator.GreaterThan => "being above",
        QualityGateOperator.GreaterThanOrEqual => "being at least",
        QualityGateOperator.Equal => "equalling",
        QualityGateOperator.NotEqual => "differing from",
        _ => op.ToString()
    };

    private static string Format(decimal value) => value == Math.Floor(value) ? ((long)value).ToString() : value.ToString("0.##");
}
