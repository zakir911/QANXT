using QaNxt.Application.Abstractions;
using QaNxt.Application.Ai;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Application.Dashboard;

public sealed record AskInsightRequest(Guid? ProjectId, string Question, int? WindowDays);

public sealed record InsightAnswer(
    string Answer, IReadOnlyList<InsightFinding> Findings, bool InsufficientEvidence,
    LlmProviderKind Provider, string Model, bool IsLocalProvider, Guid AiRequestId,
    string EvidenceWindow);

public interface IQualityInsightService
{
    Task<Result<InsightAnswer>> AskAsync(AskInsightRequest request, CancellationToken ct = default);
}

/// <summary>Answers quality questions from the execution record.
///
/// The model never sees the database; it sees a bundle of counted facts assembled here.
/// That is what keeps an answer checkable: every finding cites the identifiers it was
/// derived from, and when the window holds nothing worth concluding from, the answer says
/// so rather than producing a confident-sounding summary of nothing.</summary>
public sealed class QualityInsightService : IQualityInsightService
{
    private readonly IQaNxtDbContext _db;
    private readonly IAiOrchestrator _ai;
    private readonly IDashboardService _dashboard;
    private readonly IClock _clock;

    public QualityInsightService(IQaNxtDbContext db, IAiOrchestrator ai, IDashboardService dashboard, IClock clock)
    {
        _db = db;
        _ai = ai;
        _dashboard = dashboard;
        _clock = clock;
    }

    public async Task<Result<InsightAnswer>> AskAsync(AskInsightRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Question))
            return Error.Validation("A question is required.");
        if (request.Question.Length > 1000)
            return Error.Validation("The question must be 1000 characters or fewer.");

        var window = Math.Clamp(request.WindowDays ?? 30, 1, 365);
        var since = _clock.UtcNow.AddDays(-window);
        var view = await _dashboard.GetAsync(request.ProjectId, window, ct);

        var project = request.ProjectId is null
            ? null
            : await _db.Projects.FirstOrDefaultAsync(p => p.Id == request.ProjectId, ct);

        var context = new
        {
            question = request.Question,
            windowDays = window,
            totals = new
            {
                executions = view.Summary.ExecutionsInWindow,
                passed = view.Summary.Passed,
                failed = view.Summary.Failed,
                healed = view.Summary.Healed,
                flaky = view.Summary.Flaky,
                blocked = view.Summary.Blocked,
                passRate = view.Summary.PassRatePercent
            },
            topFailingTests = view.TopFailingTests.Select(t => new
            {
                id = t.TestCaseId, name = $"{t.Reference} {t.Name}", failureCount = t.FailureCount,
                category = t.Category?.ToString(), lastMessage = Truncate(t.LastMessage, 300),
                lastExecutionId = (string?)null
            }),
            unstableTests = view.TopUnstableTests.Select(t => new
            {
                id = t.TestCaseId, name = $"{t.Reference} {t.Name}", flakinessScore = t.FlakinessScore,
                executionCount = t.ExecutionCount,
                resultChanges = (int)Math.Round(t.FlakinessScore * Math.Max(0, t.ExecutionCount - 1) / 100.0)
            }),
            failureCategories = view.FailureCategories.Select(c => new { category = ToCamel(c.Category.ToString()), count = c.Count }),
            newFailures = await NewFailuresAsync(request.ProjectId, since, ct),
            healedTests = await HealedAsync(request.ProjectId, since, ct),
            healingStatistics = view.Healing
        };

        var result = await _ai.ExecuteAsync<GeneratedQualityInsight>(new AiCallOptions
        {
            Kind = AiRequestKind.QualityInsight,
            SchemaName = AiSchemaCatalog.QualityInsight,
            ProjectId = request.ProjectId,
            PreferredProvider = project?.AiProvider ?? LlmProviderKind.Local,
            Model = project?.AiModel,
            MaxTokens = 2000,
            // A moving window means today's answer is not tomorrow's; caching it would
            // serve stale conclusions about live quality.
            AllowCache = false,
            SystemPrompt = SystemPrompt,
            UserPrompt = $"Answer this question about test quality:\n\n{request.Question}",
            Context = context
        }, ct);

        if (!result.IsSuccess || result.Value is null)
            return Error.Dependency("insight_failed", result.Error ?? "The question could not be answered.");

        return Result<InsightAnswer>.Success(new InsightAnswer(
            result.Value.Answer, result.Value.Findings, result.Value.InsufficientEvidence,
            result.Provider, result.Model, result.IsLocalProvider, result.AiRequestId,
            $"the last {window} day(s)"));
    }

    private const string SystemPrompt = """
        You are a QA lead answering a question about a test suite's quality.

        You are given counted facts from the execution record: totals, the tests that fail
        most, the tests that behave inconsistently, failure categories, new failures and
        healing events.

        Rules:
        - Answer only from the supplied facts. Never estimate, extrapolate or invent a number.
        - Attach evidence references to each finding, using the identifiers supplied.
        - If the facts do not support an answer, set insufficientEvidence and say what would
          be needed. An honest "not enough data" is more useful than a confident guess.
        - Be specific: name the tests, quote the counts.
        """;

    private async Task<object> NewFailuresAsync(Guid? projectId, DateTimeOffset since, CancellationToken ct)
    {
        var query = _db.Failures.Where(f => f.IsNewFailure && f.LastSeenAt >= since);
        if (projectId is not null) query = query.Where(f => f.ProjectId == projectId);

        return await query
            .OrderByDescending(f => f.LastSeenAt)
            .Take(10)
            .Select(f => new
            {
                id = f.TestCaseId,
                name = _db.TestCases.Where(tc => tc.Id == f.TestCaseId).Select(tc => tc.Reference + " " + tc.Name).FirstOrDefault(),
                lastMessage = f.RawMessage.Length > 300 ? f.RawMessage.Substring(0, 300) : f.RawMessage,
                lastExecutionId = f.TestExecutionId,
                category = f.Category.ToString()
            })
            .ToListAsync(ct);
    }

    private async Task<object> HealedAsync(Guid? projectId, DateTimeOffset since, CancellationToken ct)
    {
        var query = _db.HealingEvents.Where(h => h.OccurredAt >= since);
        if (projectId is not null) query = query.Where(h => h.ProjectId == projectId);

        return await query
            .OrderByDescending(h => h.OccurredAt)
            .Take(10)
            .Select(h => new
            {
                id = h.Id,
                testCaseName = _db.TestCases.Where(tc => tc.Id == h.TestCaseId).Select(tc => tc.Name).FirstOrDefault(),
                originalLocator = h.OriginalLocatorJson,
                healedLocator = h.HealedLocatorJson,
                confidence = h.Confidence,
                outcome = h.Outcome.ToString()
            })
            .ToListAsync(ct);
    }

    private static string? Truncate(string? value, int max)
        => value is null ? null : value.Length <= max ? value : value[..max];

    private static string ToCamel(string value) => char.ToLowerInvariant(value[0]) + value[1..];
}
