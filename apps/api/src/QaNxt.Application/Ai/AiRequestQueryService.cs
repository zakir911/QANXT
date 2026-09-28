using QaNxt.Application.Abstractions;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Application.Ai;

public sealed record AiRequestQuery(
    Guid? ProjectId = null,
    AiRequestKind? Kind = null,
    AiRequestStatus? Status = null,
    LlmProviderKind? Provider = null,
    string? CorrelationId = null,
    bool? FailedOnly = null,
    DateTimeOffset? From = null,
    DateTimeOffset? To = null,
    int Limit = 50,
    int Offset = 0);

public sealed record AiRequestSummary(
    Guid Id, Guid? ProjectId, AiRequestKind Kind, LlmProviderKind Provider, string Model,
    AiRequestStatus Status, string? ResponseSchemaName, int PromptTokens, int CompletionTokens,
    int TotalTokens, int LatencyMs, decimal EstimatedCostUsd, bool FromCache,
    string? ErrorMessage, string CorrelationId, DateTimeOffset CreatedAt);

/// <param name="TotalCostUsd">Spend across everything matching the filter, not just this page.</param>
public sealed record AiRequestPage(
    IReadOnlyList<AiRequestSummary> Items, int Total, decimal TotalCostUsd,
    int FailedCount, int Limit, int Offset);

public interface IAiRequestQueryService
{
    Task<AiRequestPage> QueryAsync(AiRequestQuery query, CancellationToken ct = default);
}

/// <summary>
/// Reading the record of what was asked of a model, and what came back.
/// </summary>
/// <remarks>
/// <see cref="Domain.Ai.AiRequest"/> has been written since the first AI feature shipped, and
/// was read only by the orchestrator's own cache lookup and the budget check. Nothing exposed
/// it: not an endpoint, not a command, not a screen. So the accounting existed and the
/// questions it was built to answer — what did this cost, how often does the provider fail,
/// which response was rejected and why — could not be asked. The same shape as BUG-0034, one
/// table over.
///
/// Prompt excerpts and the response body are deliberately not returned here. They are stored
/// masked and truncated, but they are still the contents of somebody's application, and this
/// is a list endpoint. The accounting row answers the questions that motivate the list; the
/// contents belong to a deliberate single-record read.
/// </remarks>
public sealed class AiRequestQueryService : IAiRequestQueryService
{
    public const int MaxLimit = 200;

    private readonly IQaNxtDbContext _db;
    public AiRequestQueryService(IQaNxtDbContext db) => _db = db;

    public async Task<AiRequestPage> QueryAsync(AiRequestQuery query, CancellationToken ct = default)
    {
        var limit = Math.Clamp(query.Limit, 1, MaxLimit);
        var offset = Math.Max(query.Offset, 0);

        // Tenant scoping is the context's global query filter; AiRequest is ITenantOwned.
        var rows = _db.AiRequests.AsNoTracking();

        if (query.ProjectId is not null) rows = rows.Where(r => r.ProjectId == query.ProjectId);
        if (query.Kind is not null) rows = rows.Where(r => r.Kind == query.Kind);
        if (query.Status is not null) rows = rows.Where(r => r.Status == query.Status);
        if (query.Provider is not null) rows = rows.Where(r => r.Provider == query.Provider);
        if (query.From is not null) rows = rows.Where(r => r.CreatedAt >= query.From);
        if (query.To is not null) rows = rows.Where(r => r.CreatedAt <= query.To);

        if (!string.IsNullOrWhiteSpace(query.CorrelationId))
        {
            var correlationId = query.CorrelationId.Trim();
            rows = rows.Where(r => r.CorrelationId == correlationId);
        }

        // Anything that did not end in usable output. Succeeded is the one status that means
        // the platform got what it asked for; everything else is a failure of some kind, and
        // lumping them together is what makes "how often does this go wrong" answerable.
        if (query.FailedOnly == true)
            rows = rows.Where(r => r.Status != AiRequestStatus.Succeeded);

        var total = await rows.CountAsync(ct).ConfigureAwait(false);
        var failed = await rows.CountAsync(r => r.Status != AiRequestStatus.Succeeded, ct).ConfigureAwait(false);
        // Summed over the filter rather than the page: a cost figure that changes when you
        // turn the page is worse than no cost figure.
        var cost = await rows.SumAsync(r => r.EstimatedCostUsd, ct).ConfigureAwait(false);

        var items = await rows
            .OrderByDescending(r => r.CreatedAt).ThenByDescending(r => r.Id)
            .Skip(offset).Take(limit)
            .Select(r => new AiRequestSummary(
                r.Id, r.ProjectId, r.Kind, r.Provider, r.Model, r.Status, r.ResponseSchemaName,
                r.PromptTokens, r.CompletionTokens, r.TotalTokens, r.LatencyMs,
                r.EstimatedCostUsd, r.FromCache, r.ErrorMessage, r.CorrelationId, r.CreatedAt))
            .ToListAsync(ct).ConfigureAwait(false);

        return new AiRequestPage(items, total, cost, failed, limit, offset);
    }
}
