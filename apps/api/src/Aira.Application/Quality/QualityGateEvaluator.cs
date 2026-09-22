using Aira.Application.Abstractions;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Quality;

public sealed record QualityGateResult(
    bool Passed,
    IReadOnlyList<QualityGateRuleResult> Rules,
    string Summary,
    QualityGateOutcome Outcome = QualityGateOutcome.Pass,
    /// <summary>Why the outcome is REVIEW rather than PASS, when it is. Empty otherwise.</summary>
    IReadOnlyList<string>? ReviewReasons = null,
    /// <summary>What the gate measured, so a report can show the numbers the rules were
    /// compared against even where no rule covered them.</summary>
    IReadOnlyDictionary<string, decimal>? Metrics = null)
{
    /// <summary>`Passed` stays true for REVIEW: a run that needs a person to look has not
    /// failed, and a pipeline that wants to stop on REVIEW keys off the outcome instead.
    /// Kept as a property so existing callers and stored reports do not change meaning.</summary>
    public bool Blocked => Outcome == QualityGateOutcome.Fail;
}

public sealed record QualityGateRuleResult(
    Guid RuleId, string Name, QualityGateMetric Metric, QualityGateOperator Operator,
    decimal Threshold, decimal ActualValue, bool Passed, bool IsBlocking, string Explanation,
    QualityGateAction Action = QualityGateAction.Fail,
    /// <summary>False when this run could not measure the rule's metric at all. Such a
    /// rule is never reported as satisfied: a threshold compared against a value nobody
    /// measured reads as a guarantee and is not one.</summary>
    bool Measured = true);

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

        // The environment key of the run, so a rule scoped to one environment applies only
        // there. A rule with no environment applies everywhere, which is what most are.
        var environmentKey = run.EnvironmentId is null
            ? null
            : await _db.Environments
                .Where(e => e.Id == run.EnvironmentId)
                .Select(e => e.Key)
                .FirstOrDefaultAsync(ct);

        var allRules = await _db.QualityGateRules
            .Where(r => r.ProjectId == run.ProjectId && r.IsEnabled)
            .ToListAsync(ct);

        var rules = allRules
            .Where(r => r.Environment is null
                        || string.Equals(r.Environment, environmentKey, StringComparison.OrdinalIgnoreCase))
            .ToList();

        var skippedForEnvironment = allRules.Count - rules.Count;
        if (skippedForEnvironment > 0)
        {
            // Logged rather than silent: "the gate passed" and "the gate passed because
            // four of its rules were for another environment" are different statements.
            _logger.LogInformation(
                "Run {RunId}: {Skipped} quality gate rule(s) do not apply to environment '{Environment}'.",
                run.Id, skippedForEnvironment, environmentKey ?? "(none)");
        }

        var metrics = await GatherMetricsAsync(run, ct);
        var named = metrics.ToDictionary(pair => pair.Key.ToString(), pair => pair.Value);

        // The project's own policy on healed tests applies whether or not a rule mentions
        // healing, because it is a statement about what a pass means here rather than a
        // threshold. Evaluated before the rules so its reason appears alongside theirs.
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == run.ProjectId, ct);
        var healingVerdict = HealingVerdict(project, run, metrics);

        if (rules.Count == 0)
        {
            var outcomeWithoutRules = healingVerdict.Outcome;
            return new QualityGateResult(
                outcomeWithoutRules != QualityGateOutcome.Fail,
                Array.Empty<QualityGateRuleResult>(),
                outcomeWithoutRules == QualityGateOutcome.Pass
                    ? "No quality gates are configured for this project, so the run does not block."
                    : $"No quality gates are configured for this project. {healingVerdict.Reason}",
                outcomeWithoutRules,
                healingVerdict.Reason is null ? Array.Empty<string>() : new[] { healingVerdict.Reason },
                named);
        }

        var results = new List<QualityGateRuleResult>();

        foreach (var rule in rules)
        {
            // Absent, not zero. A metric this run had no way to measure must not be
            // silently compared as 0 — that is how a rule intended to stop a release
            // becomes a rule that always passes.
            var measured = metrics.TryGetValue(rule.Metric, out var actual);

            if (!measured)
            {
                results.Add(new QualityGateRuleResult(
                    rule.Id, rule.Name, rule.Metric, rule.Operator, rule.Threshold, 0m,
                    Passed: false, rule.IsBlocking,
                    $"{Describe(rule.Metric)} was not measured for this run, so this rule could not be "
                    + "evaluated. It is reported for review rather than treated as satisfied.",
                    QualityGateAction.Review, Measured: false));
                continue;
            }

            var passed = Compare(actual, rule.Operator, rule.Threshold);
            // A rule with no Action set at all came from before actions existed; a blocking
            // rule meant fail and a non-blocking one meant warn.
            var action = rule.Action;

            var explanation = passed
                ? $"{Describe(rule.Metric)} was {Format(actual)}, which satisfies {Describe(rule.Operator)} {Format(rule.Threshold)}."
                : string.IsNullOrWhiteSpace(rule.Message)
                    ? $"{Describe(rule.Metric)} was {Format(actual)}, which fails {Describe(rule.Operator)} {Format(rule.Threshold)}."
                    : $"{rule.Message} ({Describe(rule.Metric)} was {Format(actual)} against {Describe(rule.Operator)} {Format(rule.Threshold)}.)";

            results.Add(new QualityGateRuleResult(
                rule.Id, rule.Name, rule.Metric, rule.Operator, rule.Threshold, actual, passed,
                rule.IsBlocking, explanation, action));
        }

        var failing = results.Where(r => !r.Passed && r.Action == QualityGateAction.Fail && r.IsBlocking).ToList();
        var reviewing = results.Where(r => !r.Passed && r.Action == QualityGateAction.Review).ToList();
        var warning = results.Where(r => !r.Passed && (r.Action == QualityGateAction.Warn || !r.IsBlocking)).ToList();

        var reviewReasons = new List<string>();
        reviewReasons.AddRange(reviewing.Select(r => r.Explanation));
        if (healingVerdict.Reason is not null) reviewReasons.Add(healingVerdict.Reason);

        // Fail beats review beats pass. A run with both a failing rule and a review reason
        // is a failure; there is nothing to deliberate about while something is broken.
        var outcome = failing.Count > 0 || healingVerdict.Outcome == QualityGateOutcome.Fail
            ? QualityGateOutcome.Fail
            : reviewing.Count > 0 || healingVerdict.Outcome == QualityGateOutcome.Review
                ? QualityGateOutcome.Review
                : QualityGateOutcome.Pass;

        var summary = outcome switch
        {
            QualityGateOutcome.Fail when failing.Count > 0 =>
                $"The quality gate failed on {failing.Count} rule(s): {string.Join("; ", failing.Select(r => r.Name))}.",
            QualityGateOutcome.Fail =>
                $"The quality gate failed. {healingVerdict.Reason}",
            QualityGateOutcome.Review =>
                $"The quality gate needs review: {string.Join(" ", reviewReasons)}",
            _ => warning.Count > 0
                ? $"The quality gate passed. {warning.Count} rule(s) reported a warning."
                : $"The quality gate passed: all {results.Count} rule(s) were satisfied."
        };

        if (outcome != QualityGateOutcome.Pass)
            _logger.LogWarning("Run {RunId} quality gate outcome {Outcome}: {Summary}", run.Id, outcome, summary);

        return new QualityGateResult(
            outcome != QualityGateOutcome.Fail, results, summary, outcome, reviewReasons, named);
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

        var executionIds = _db.TestExecutions.Where(e => e.TestRunId == run.Id).Select(e => e.Id);
        var failedStatuses = new[] { ExecutionStatus.Failed, ExecutionStatus.Error, ExecutionStatus.TimedOut };

        var highFailed = await _db.TestExecutions
            .Where(e => e.TestRunId == run.Id && failedStatuses.Contains(e.Status)
                        && e.TestCase!.Priority == TestPriority.High)
            .CountAsync(ct);

        var mediumFailed = await _db.TestExecutions
            .Where(e => e.TestRunId == run.Id && failedStatuses.Contains(e.Status)
                        && e.TestCase!.Priority == TestPriority.Medium)
            .CountAsync(ct);

        var blocked = await _db.TestExecutions
            .Where(e => e.TestRunId == run.Id && e.Status == ExecutionStatus.Blocked)
            .CountAsync(ct);

        // A regression is a test that used to pass and now does not — distinct from one that
        // has never passed, which is unfinished work rather than a regression.
        var regressionFailed = await _db.Failures
            .Where(f => f.TestExecutionId != null && executionIds.Contains(f.TestExecutionId) && f.IsRegression)
            .CountAsync(ct);

        // Measurable now that a test case records what it drives. Counted separately from
        // FailedCount because "the UI is fine but two endpoints are broken" and "two UI
        // journeys are broken" are different releases.
        var apiFailed = await _db.TestExecutions
            .Where(e => e.TestRunId == run.Id && failedStatuses.Contains(e.Status)
                        && e.TestCase!.Kind == TestCaseKind.Api)
            .CountAsync(ct);

        var flakyRate = finished == 0 ? 0m : run.FlakyCount * 100m / finished;

        var metrics = new Dictionary<QualityGateMetric, decimal>
        {
            [QualityGateMetric.HighFailedCount] = highFailed,
            [QualityGateMetric.MediumFailedCount] = mediumFailed,
            [QualityGateMetric.BlockedCount] = blocked,
            [QualityGateMetric.RegressionFailedCount] = regressionFailed,
            [QualityGateMetric.ApiFailedCount] = apiFailed,
            [QualityGateMetric.FlakyRatePercent] = Math.Round(flakyRate, 2),
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

        // Added only when a contract check actually ran against this run's evidence.
        // "No breaking changes" and "nobody looked" are different statements, and a rule
        // that cannot tell them apart is a rule that always passes (BUG-0021).
        if (run.ContractCheckedAt is not null)
        {
            metrics[QualityGateMetric.ContractBreakingChangeCount] = run.ContractBreakingChangeCount;
        }

        return metrics;
    }

    /// <summary>What the project's self-healing policy says about this run.
    ///
    /// Separate from the rules because it is not a threshold: it is the project's answer to
    /// "does a test that only passed after a locator was rewritten count as a pass here?".
    /// Whatever the answer, a healed run never passes silently — the reason is carried into
    /// the result so a report and a pull-request comment can both name it.</summary>
    private static (QualityGateOutcome Outcome, string? Reason) HealingVerdict(
        Domain.Projects.Project? project, Domain.Testing.TestRun run,
        Dictionary<QualityGateMetric, decimal> metrics)
    {
        var healed = (int)metrics.GetValueOrDefault(QualityGateMetric.HealedCount, run.HealedCount);
        if (healed == 0) return (QualityGateOutcome.Pass, null);

        var plural = healed == 1 ? "test" : "tests";
        var noun = $"{healed} {plural} passed only after a locator was repaired";

        return (project?.SelfHealingGatePolicy ?? SelfHealingGatePolicy.PassWithWarning) switch
        {
            SelfHealingGatePolicy.Pass => (QualityGateOutcome.Pass, null),
            SelfHealingGatePolicy.PassWithWarning => (QualityGateOutcome.Pass,
                $"{noun}; the repairs are recorded and await review."),
            SelfHealingGatePolicy.RequireReview => (QualityGateOutcome.Review,
                $"{noun}, and this project requires a person to review a repair before it counts."),
            SelfHealingGatePolicy.Fail => (QualityGateOutcome.Fail,
                $"{noun}, and this project treats any repair as a failure."),
            _ => (QualityGateOutcome.Pass, null)
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
        QualityGateMetric.HighFailedCount => "The number of failed high-priority tests",
        QualityGateMetric.MediumFailedCount => "The number of failed medium-priority tests",
        QualityGateMetric.FlakyRatePercent => "The flaky rate",
        QualityGateMetric.ApiFailedCount => "The number of failed API tests",
        QualityGateMetric.ContractBreakingChangeCount => "The number of breaking API contract changes",
        QualityGateMetric.SecurityFailedCount => "The number of failed security checks",
        QualityGateMetric.RegressionFailedCount => "The number of regressions",
        QualityGateMetric.BlockedCount => "The number of blocked tests",
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
