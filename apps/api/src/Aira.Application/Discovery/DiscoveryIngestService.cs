using System.Text.Json;
using Aira.Application.Abstractions;
using Aira.Application.Contracts;
using Aira.Application.Security;
using Aira.Domain.Applications;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Aira.Domain.Evidence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Discovery;

/// <summary>Turns a worker's discovery report into the application knowledge graph.
///
/// Ingestion is idempotent and incremental: pages are identified by their normalized URL,
/// so re-running discovery updates what is already known rather than creating a parallel
/// copy. That is what makes the graph a living model of the application instead of a pile
/// of crawl snapshots.</summary>
public interface IDiscoveryIngestService
{
    Task<Result> RecordProgressAsync(Guid discoveryRunId, DiscoveryProgressPayload progress, CancellationToken ct = default);
    Task<Result> CompleteAsync(Guid discoveryRunId, DiscoveryCompletionPayload completion, CancellationToken ct = default);
    Task<Result> MarkRunningAsync(Guid discoveryRunId, string workerId, CancellationToken ct = default);
}

public sealed class DiscoveryIngestService : IDiscoveryIngestService
{
    private const int MaxProgressLogLength = 60_000;

    private readonly IAiraDbContext _db;
    private readonly IClock _clock;
    private readonly ITenantContext _tenant;
    private readonly SecretMasker _masker;
    private readonly IExecutionEventPublisher _events;
    private readonly ILogger<DiscoveryIngestService> _logger;

    public DiscoveryIngestService(IAiraDbContext db, IClock clock, ITenantContext tenant,
        SecretMasker masker, IExecutionEventPublisher events, ILogger<DiscoveryIngestService> logger)
    {
        _db = db;
        _clock = clock;
        _tenant = tenant;
        _masker = masker;
        _events = events;
        _logger = logger;
    }

    public async Task<Result> MarkRunningAsync(Guid discoveryRunId, string workerId, CancellationToken ct = default)
    {
        var run = await _db.DiscoveryRuns.FirstOrDefaultAsync(r => r.Id == discoveryRunId, ct);
        if (run is null) return Result.Failure(Error.NotFound("The discovery run"));

        run.Status = DiscoveryStatus.Running;
        run.StartedAt ??= _clock.UtcNow;
        run.WorkerId = workerId;
        await _db.SaveChangesAsync(ct);
        return Result.Success();
    }

    public async Task<Result> RecordProgressAsync(Guid discoveryRunId, DiscoveryProgressPayload progress, CancellationToken ct = default)
    {
        var run = await _db.DiscoveryRuns.FirstOrDefaultAsync(r => r.Id == discoveryRunId, ct);
        if (run is null) return Result.Failure(Error.NotFound("The discovery run"));

        run.PagesDiscovered = progress.PagesVisited;
        run.ElementsDiscovered = progress.ElementsFound;
        var line = $"[{_clock.UtcNow:HH:mm:ss}] {_masker.MaskText(progress.Message)}";
        run.ProgressLog = Append(run.ProgressLog, line);
        await _db.SaveChangesAsync(ct);

        await _events.PublishAsync(run.OrganizationId, new ExecutionEvent(
            ExecutionEventTypes.DiscoveryProgress, run.Id, null,
            new { progress.PagesVisited, progress.PagesQueued, progress.ElementsFound, progress.CurrentUrl, message = line },
            _clock.UtcNow), ct);

        return Result.Success();
    }

    public async Task<Result> CompleteAsync(Guid discoveryRunId, DiscoveryCompletionPayload completion, CancellationToken ct = default)
    {
        var run = await _db.DiscoveryRuns.FirstOrDefaultAsync(r => r.Id == discoveryRunId, ct);
        if (run is null) return Result.Failure(Error.NotFound("The discovery run"));

        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == run.ApplicationId, ct);
        if (application is null) return Result.Failure(Error.NotFound("The application"));

        await _db.InTransactionAsync(async token =>
        {
            var pageIdsByNormalizedUrl = await UpsertPagesAsync(run, application.Id, completion, token);
            await UpsertTransitionsAsync(run, application.Id, completion, pageIdsByNormalizedUrl, token);
            await UpsertApiEndpointsAsync(run, application.Id, completion, pageIdsByNormalizedUrl, token);
            await RecordConsoleErrorsAsync(run, completion, token);

            run.Status = ParseStatus(completion.Status);
            run.StartedAt ??= completion.StartedAt;
            run.CompletedAt = completion.CompletedAt;
            run.WorkerId = completion.WorkerId;
            run.PagesDiscovered = completion.Pages.Count;
            run.ElementsDiscovered = completion.Pages.Sum(p => p.Elements.Count);
            run.ApiEndpointsDiscovered = completion.ApiEndpoints.Count;
            run.ConsoleErrorCount = completion.ConsoleErrors.Count;
            run.PagesBlockedByPolicy = completion.PagesBlockedByPolicy;
            run.ErrorMessage = completion.ErrorMessage is null ? null : _masker.MaskText(completion.ErrorMessage);
            run.ProgressLog = Append(run.ProgressLog, _masker.MaskText(completion.ProgressLog));

            await _db.SaveChangesAsync(token);
            return true;
        }, ct);

        _logger.LogInformation(
            "Discovery run {RunId} completed as {Status}: {Pages} pages, {Elements} elements, {Endpoints} API endpoints",
            run.Id, run.Status, run.PagesDiscovered, run.ElementsDiscovered, run.ApiEndpointsDiscovered);

        await _events.PublishAsync(run.OrganizationId, new ExecutionEvent(
            ExecutionEventTypes.DiscoveryCompleted, run.Id, null,
            new { status = run.Status.ToString(), run.PagesDiscovered, run.ElementsDiscovered, run.ApiEndpointsDiscovered },
            _clock.UtcNow), ct);

        return Result.Success();
    }

    private async Task<Dictionary<string, Guid>> UpsertPagesAsync(
        DiscoveryRun run, Guid applicationId, DiscoveryCompletionPayload completion, CancellationToken ct)
    {
        var normalizedUrls = completion.Pages.Select(p => p.NormalizedUrl).ToList();
        var existing = await _db.ApplicationPages
            .Where(p => p.ApplicationId == applicationId && normalizedUrls.Contains(p.NormalizedUrl))
            .Include(p => p.Elements)
            .ToDictionaryAsync(p => p.NormalizedUrl, ct);

        var result = new Dictionary<string, Guid>(StringComparer.Ordinal);
        var now = _clock.UtcNow;

        foreach (var payload in completion.Pages)
        {
            if (!existing.TryGetValue(payload.NormalizedUrl, out var page))
            {
                page = new ApplicationPage
                {
                    OrganizationId = run.OrganizationId,
                    ApplicationId = applicationId,
                    NormalizedUrl = payload.NormalizedUrl,
                    CreatedAt = now
                };
                _db.ApplicationPages.Add(page);
                existing[payload.NormalizedUrl] = page;
            }

            page.DiscoveryRunId = run.Id;
            page.Url = Truncate(payload.Url, 2048);
            page.Route = Truncate(payload.Route, 512);
            page.Title = Truncate(payload.Title, 500);
            page.Kind = payload.Kind;
            page.Depth = payload.Depth;
            page.RequiresAuthentication = payload.RequiresAuthentication;
            page.HttpStatus = payload.HttpStatus;
            page.LoadTimeMs = payload.LoadTimeMs;
            page.ElementCount = payload.Elements.Count;
            page.ConsoleErrorCount = payload.ConsoleErrorCount;
            page.VisibleTextExcerpt = Truncate(_masker.MaskText(payload.VisibleTextExcerpt), 8000);
            page.ScreenshotArtifactKey = payload.ScreenshotKey;
            page.DomArtifactKey = payload.DomKey;
            page.AccessibilityArtifactKey = payload.AccessibilityKey;
            page.LastSeenAt = now;

            result[payload.NormalizedUrl] = page.Id;
        }

        await _db.SaveChangesAsync(ct);

        // Parent links resolve only once every page in the batch has an id.
        foreach (var payload in completion.Pages)
        {
            if (payload.ParentNormalizedUrl is null) continue;
            if (!result.TryGetValue(payload.ParentNormalizedUrl, out var parentId)) continue;
            var page = existing[payload.NormalizedUrl];
            if (page.Id != parentId) page.ParentPageId = parentId;
        }

        foreach (var payload in completion.Pages)
        {
            await UpsertElementsAsync(run, existing[payload.NormalizedUrl], payload.Elements, now, ct);
        }

        await _db.SaveChangesAsync(ct);
        return result;
    }

    private async Task UpsertElementsAsync(
        DiscoveryRun run, ApplicationPage page, List<DiscoveredElementPayload> elements,
        DateTimeOffset now, CancellationToken ct)
    {
        var existing = page.Elements.Count > 0
            ? page.Elements.ToList()
            : await _db.ApplicationElements.Where(e => e.ApplicationPageId == page.Id).ToListAsync(ct);

        // An element's identity is its strongest stable signal. Without this, every crawl
        // would duplicate the whole page and healing would score against stale copies.
        var byKey = existing.ToDictionary(ElementKey, StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var payload in elements)
        {
            var key = PayloadKey(payload);
            seen.Add(key);

            if (!byKey.TryGetValue(key, out var element))
            {
                element = new ApplicationElement
                {
                    OrganizationId = run.OrganizationId,
                    ApplicationPageId = page.Id,
                    CreatedAt = now
                };
                _db.ApplicationElements.Add(element);
                byKey[key] = element;
            }

            element.Kind = payload.Kind;
            element.TagName = Truncate(payload.TagName, 50);
            element.AriaRole = Truncate(payload.AriaRole, 60);
            element.AccessibleName = Truncate(payload.AccessibleName, 500);
            element.Text = Truncate(payload.Text, 1000);
            element.Label = Truncate(payload.Label, 500);
            element.Placeholder = Truncate(payload.Placeholder, 500);
            element.TestId = Truncate(payload.TestId, 200);
            element.ElementId = Truncate(payload.ElementId, 200);
            element.Name = Truncate(payload.Name, 200);
            element.Type = Truncate(payload.Type, 60);
            element.Title = Truncate(payload.Title, 300);
            element.Value = Truncate(payload.Value, 500);
            element.CssSelector = Truncate(payload.CssSelector, 1000);
            element.XPath = Truncate(payload.Xpath, 1000);
            element.DomPath = Truncate(payload.DomPath, 1000);
            element.ParentSignature = Truncate(payload.ParentSignature, 500);
            element.NeighbourText = Truncate(payload.NeighbourText, 1000);
            element.BoundingX = payload.Bounding.X;
            element.BoundingY = payload.Bounding.Y;
            element.BoundingWidth = payload.Bounding.Width;
            element.BoundingHeight = payload.Bounding.Height;
            element.IsVisible = payload.IsVisible;
            element.IsEnabled = payload.IsEnabled;
            element.IsRequired = payload.IsRequired;
            element.AttributesJson = JsonSerializer.Serialize(payload.Attributes, JsonDefaults.Options);
            element.PreferredLocatorJson = payload.PreferredLocator.ToJson();
            element.StabilityScore = payload.StabilityScore;
            element.LastSeenAt = now;
        }

        // Elements that have disappeared are kept, not deleted: their history is what lets
        // healing recognise a control that moved rather than treating it as brand new.
        foreach (var (key, element) in byKey)
        {
            if (!seen.Contains(key)) element.IsVisible = false;
        }
    }

    private static string ElementKey(ApplicationElement element)
        => Key(element.TestId, element.AriaRole, element.AccessibleName, element.Name, element.DomPath, element.TagName);

    private static string PayloadKey(DiscoveredElementPayload payload)
        => Key(payload.TestId, payload.AriaRole, payload.AccessibleName, payload.Name, payload.DomPath, payload.TagName);

    private static string Key(string? testId, string? role, string? name, string? elementName, string? domPath, string tagName)
    {
        if (!string.IsNullOrEmpty(testId)) return $"testid:{testId}";
        if (!string.IsNullOrEmpty(role) && !string.IsNullOrEmpty(name)) return $"role:{role}|{name}";
        if (!string.IsNullOrEmpty(elementName)) return $"name:{tagName}|{elementName}";
        return $"path:{domPath}|{tagName}";
    }

    private async Task UpsertTransitionsAsync(
        DiscoveryRun run, Guid applicationId, DiscoveryCompletionPayload completion,
        Dictionary<string, Guid> pageIds, CancellationToken ct)
    {
        var existing = await _db.PageTransitions
            .Where(t => t.ApplicationId == applicationId)
            .ToListAsync(ct);

        foreach (var payload in completion.Transitions)
        {
            if (!pageIds.TryGetValue(payload.FromNormalizedUrl, out var fromId)) continue;
            if (!pageIds.TryGetValue(payload.ToNormalizedUrl, out var toId)) continue;
            if (fromId == toId) continue;

            var action = Enum.TryParse<BrowserActionType>(payload.Action, ignoreCase: true, out var parsed)
                ? parsed : BrowserActionType.Click;

            var match = existing.FirstOrDefault(t => t.FromPageId == fromId && t.ToPageId == toId && t.Action == action);
            if (match is not null)
            {
                match.TimesObserved++;
                continue;
            }

            var transition = new PageTransition
            {
                OrganizationId = run.OrganizationId,
                ApplicationId = applicationId,
                FromPageId = fromId,
                ToPageId = toId,
                Action = action,
                TimesObserved = 1,
                CreatedAt = _clock.UtcNow
            };
            _db.PageTransitions.Add(transition);
            existing.Add(transition);
        }

        await _db.SaveChangesAsync(ct);
    }

    private async Task UpsertApiEndpointsAsync(
        DiscoveryRun run, Guid applicationId, DiscoveryCompletionPayload completion,
        Dictionary<string, Guid> pageIds, CancellationToken ct)
    {
        var existing = await _db.ApiEndpoints
            .Where(e => e.ApplicationId == applicationId)
            .ToDictionaryAsync(e => $"{e.Method} {e.UrlTemplate}", StringComparer.OrdinalIgnoreCase, ct);
        var now = _clock.UtcNow;

        foreach (var payload in completion.ApiEndpoints)
        {
            var key = $"{payload.Method} {payload.UrlTemplate}";
            if (!existing.TryGetValue(key, out var endpoint))
            {
                endpoint = new ApiEndpoint
                {
                    OrganizationId = run.OrganizationId,
                    ApplicationId = applicationId,
                    Method = Truncate(payload.Method, 10)!,
                    UrlTemplate = Truncate(payload.UrlTemplate, 2048)!,
                    TimesObserved = 0,
                    CreatedAt = now
                };
                _db.ApiEndpoints.Add(endpoint);
                existing[key] = endpoint;
            }

            endpoint.SampleUrl = Truncate(payload.SampleUrl, 2048)!;
            endpoint.TimesObserved += Math.Max(1, payload.TimesObserved);
            endpoint.LastStatusCode = payload.StatusCode;
            endpoint.AverageDurationMs = endpoint.AverageDurationMs == 0
                ? payload.DurationMs
                : (endpoint.AverageDurationMs + payload.DurationMs) / 2;
            endpoint.RequestSampleJson = payload.RequestSample is null ? null : _masker.MaskJson(payload.RequestSample);
            endpoint.ResponseSampleJson = payload.ResponseSample is null ? null : _masker.MaskJson(payload.ResponseSample);
            endpoint.RequestContentType = Truncate(payload.RequestContentType, 120);
            endpoint.ResponseContentType = Truncate(payload.ResponseContentType, 120);
            endpoint.RequiresAuthentication = payload.RequiresAuthentication;
            endpoint.LastSeenAt = now;

            if (payload.TriggeredByNormalizedUrl is not null
                && pageIds.TryGetValue(payload.TriggeredByNormalizedUrl, out var pageId))
            {
                endpoint.TriggeredByPageId = pageId;
            }
        }

        await _db.SaveChangesAsync(ct);
    }

    private async Task RecordConsoleErrorsAsync(DiscoveryRun run, DiscoveryCompletionPayload completion, CancellationToken ct)
    {
        foreach (var error in completion.ConsoleErrors.Take(500))
        {
            _db.ConsoleEvents.Add(new ConsoleEvent
            {
                OrganizationId = run.OrganizationId,
                DiscoveryRunId = run.Id,
                Level = Truncate(error.Level, 20)!,
                Message = Truncate(_masker.MaskText(error.Message), 8000)!,
                Url = Truncate(error.Url, 2048),
                OccurredAt = error.OccurredAt,
                CreatedAt = _clock.UtcNow
            });
        }
        await _db.SaveChangesAsync(ct);
    }

    private static DiscoveryStatus ParseStatus(string status) => status.ToLowerInvariant() switch
    {
        "completed" => DiscoveryStatus.Completed,
        "failed" => DiscoveryStatus.Failed,
        "cancelled" => DiscoveryStatus.Cancelled,
        "partiallycompleted" => DiscoveryStatus.PartiallyCompleted,
        _ => DiscoveryStatus.Completed
    };

    private static string Append(string? existing, string addition)
    {
        var combined = string.IsNullOrEmpty(existing) ? addition : $"{existing}\n{addition}";
        // Keep the tail: the end of a crawl log is where the interesting part is.
        return combined.Length <= MaxProgressLogLength ? combined : combined[^MaxProgressLogLength..];
    }

    private static string? Truncate(string? value, int max)
        => value is null ? null : value.Length <= max ? value : value[..max];
}
