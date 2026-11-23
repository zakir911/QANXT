using System.Text.Json;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using QaNxt.Application.Security;
using QaNxt.Domain.Applications;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Evidence;
using QaNxt.Domain.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Application.Discovery;

/// <summary>Turns a worker's discovery report into the application knowledge graph.
///
/// Ingestion is idempotent and incremental: pages are identified by their normalized URL,
/// so re-running discovery updates what is already known rather than creating a parallel
/// copy. That is what makes the graph a living model of the application instead of a pile
/// of crawl snapshots.</summary>
public interface IDiscoveryIngestService
{
    Task<Result<DiscoveryProgressAck>> RecordProgressAsync(Guid discoveryRunId, DiscoveryProgressPayload progress, CancellationToken ct = default);
    Task<Result> CompleteAsync(Guid discoveryRunId, DiscoveryCompletionPayload completion, CancellationToken ct = default);
    Task<Result> MarkRunningAsync(Guid discoveryRunId, string workerId, CancellationToken ct = default);

    /// <summary>Ends a run the worker could not finish, with the reason it could not.</summary>
    /// <param name="permanent">True when retrying cannot help — a missing browser binary, a
    /// malformed job — so the run is ended now rather than left to the sweep.</param>
    Task<Result> FailAsync(Guid discoveryRunId, string reason, bool permanent, string? workerId = null,
        CancellationToken ct = default);
}

public sealed class DiscoveryIngestService : IDiscoveryIngestService
{
    private const int MaxProgressLogLength = 60_000;

    private readonly IQaNxtDbContext _db;
    private readonly IClock _clock;
    private readonly ITenantContext _tenant;
    private readonly SecretMasker _masker;
    private readonly IExecutionEventPublisher _events;
    private readonly ILogger<DiscoveryIngestService> _logger;

    public DiscoveryIngestService(IQaNxtDbContext db, IClock clock, ITenantContext tenant,
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

    /// <summary>
    /// Ends a run that failed, and says why on the run itself.
    ///
    /// Without this a worker that could not even open a browser left the run on
    /// <c>Running</c> for ever: the failure was known to the worker, written to its log, and
    /// never written anywhere a user could see it. "Running" with nothing behind it is worse
    /// than "Failed" with a reason, because the first invites someone to keep waiting.
    /// </summary>
    public async Task<Result> FailAsync(Guid discoveryRunId, string reason, bool permanent,
        string? workerId = null, CancellationToken ct = default)
    {
        var run = await _db.DiscoveryRuns.FirstOrDefaultAsync(r => r.Id == discoveryRunId, ct);
        if (run is null) return Result.Failure(Error.NotFound("The discovery run"));

        // A run that already reported is not overwritten. A failure callback can arrive after
        // a successful completion when a late retry loses the race, and the completed graph is
        // the better record of what happened.
        if (run.Status is DiscoveryStatus.Completed or DiscoveryStatus.PartiallyCompleted
                       or DiscoveryStatus.Cancelled)
        {
            _logger.LogInformation(
                "Ignoring a failure report for discovery run {RunId}, which already finished as {Status}",
                run.Id, run.Status);
            return Result.Success();
        }

        var masked = _masker.MaskText(reason);

        run.Status = DiscoveryStatus.Failed;
        run.CompletedAt = _clock.UtcNow;
        run.StartedAt ??= _clock.UtcNow;
        if (workerId is not null) run.WorkerId = workerId;
        run.ErrorMessage = permanent
            ? masked + " Retrying will not help, so the run was ended rather than queued again."
            : masked;
        run.ProgressLog = Append(run.ProgressLog,
            $"[{_clock.UtcNow:HH:mm:ss}] The run failed: {masked}");

        await _db.SaveChangesAsync(ct);

        _logger.LogWarning(
            "Discovery run {RunId} failed on worker {WorkerId} ({Kind}): {Reason}",
            run.Id, run.WorkerId, permanent ? "permanent" : "retryable", masked);

        await _events.PublishAsync(run.OrganizationId, new ExecutionEvent(
            ExecutionEventTypes.DiscoveryCompleted, run.Id, null,
            new { status = run.Status.ToString(), errorMessage = run.ErrorMessage, permanent },
            _clock.UtcNow), ct);

        return Result.Success();
    }

    public async Task<Result<DiscoveryProgressAck>> RecordProgressAsync(Guid discoveryRunId, DiscoveryProgressPayload progress, CancellationToken ct = default)
    {
        var run = await _db.DiscoveryRuns.FirstOrDefaultAsync(r => r.Id == discoveryRunId, ct);
        // A run the control plane has never heard of is one the crawler should not be
        // running: say stop rather than leaving it to carry on unsupervised.
        if (run is null) return Result<DiscoveryProgressAck>.Failure(Error.NotFound("The discovery run"));

        // A progress update never lowers the figures, and never reopens a finished run.
        //
        // The worker reports progress without waiting for the answer — the callback returns
        // the promise and the crawler drops it — so dozens of these are in flight at once
        // and they arrive in whatever order the network delivers them. An early update
        // saying two pages could therefore land after a later one saying a hundred and fifty,
        // and after the completion that ended the run. Measured on two consecutive runs of a
        // 137-screen application: both reported 2 pages discovered while the stored model
        // held 150 and the declared-screen count was right. The run summary is the first
        // place anyone looks, and it said the crawl had found almost nothing.
        //
        // Guarded here rather than by making the worker wait, because ordering a
        // best-effort progress feed over the network is not something the worker can
        // promise, and the control plane is where the figure is kept.
        if (run.CompletedAt is not null
            || run.Status is DiscoveryStatus.Completed or DiscoveryStatus.PartiallyCompleted
                          or DiscoveryStatus.Failed or DiscoveryStatus.Cancelled)
        {
            _logger.LogDebug(
                "Ignoring a progress update for discovery run {RunId}, which already finished as {Status}",
                run.Id, run.Status);
            // The figures are not touched, and the crawl is told to stop. A run that has
            // been cancelled, or that something else already finished, has no business
            // still opening pages of somebody's application.
            return Result<DiscoveryProgressAck>.Success(new DiscoveryProgressAck(
                true, $"the run is no longer in flight: it finished as {run.Status}"));
        }

        run.PagesDiscovered = Math.Max(run.PagesDiscovered, progress.PagesVisited);
        run.ElementsDiscovered = Math.Max(run.ElementsDiscovered, progress.ElementsFound);
        var line = $"[{_clock.UtcNow:HH:mm:ss}] {_masker.MaskText(progress.Message)}";
        run.ProgressLog = Append(run.ProgressLog, line);
        await _db.SaveChangesAsync(ct);

        await _events.PublishAsync(run.OrganizationId, new ExecutionEvent(
            ExecutionEventTypes.DiscoveryProgress, run.Id, null,
            new { progress.PagesVisited, progress.PagesQueued, progress.ElementsFound, progress.CurrentUrl, message = line },
            _clock.UtcNow), ct);

        return Result<DiscoveryProgressAck>.Success(new DiscoveryProgressAck(false, null));
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
            await RecordStateChangingLinksAsync(run, application, completion, pageIdsByNormalizedUrl, token);

            run.Status = ParseStatus(completion.Status);
            run.StartedAt ??= completion.StartedAt;
            run.CompletedAt = completion.CompletedAt;
            run.WorkerId = completion.WorkerId;
            // Counted from what this run actually mapped, not from the payload that
            // completed it.
            //
            // The worker streams pages in batches, so the completion carries the final batch
            // and nothing else. Taking its length overwrote the accumulated figure with the
            // size of the last batch: a run that mapped 150 pages across a 137-screen
            // application reported 2, twice in a row, while the stored model and the
            // declared-screen count were both right. Anyone reading the run summary — the
            // place you look first — saw a crawl that had found almost nothing.
            //
            // Scoped by DiscoveryRunId, which UpsertPagesAsync stamps on every page it
            // touches on both the insert and the update path, so a page this run re-saw
            // counts for this run and not for the one that first found it.
            run.PagesDiscovered = await _db.ApplicationPages
                .CountAsync(p => p.ApplicationId == application.Id && p.DiscoveryRunId == run.Id, token);
            run.ElementsDiscovered = await _db.ApplicationElements
                .CountAsync(e => e.Page!.ApplicationId == application.Id
                              && e.Page.DiscoveryRunId == run.Id, token);
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

    /// <summary>
    /// Records each link the crawl refused to follow as a gap for a human to close.
    ///
    /// A GET that approves a permit is a cross-site request forgery waiting for somebody to
    /// send the URL, and it is one of the commonest real findings on an application built
    /// before anti-forgery tokens were normal. Discovery cannot establish that it changes
    /// state without following it, which is the one thing it must not do — a crawl of a
    /// permit register approved all three permits in it before that rule existed.
    ///
    /// So this is a gap and not a finding: the product says what it saw, says why it did not
    /// test it, and says what would let it. Claiming the defect without having observed it
    /// would be the thing the house rules forbid; saying nothing would hide it.
    /// </summary>
    private async Task RecordStateChangingLinksAsync(
        DiscoveryRun run, Domain.Applications.Application application,
        DiscoveryCompletionPayload completion,
        IReadOnlyDictionary<string, Guid> pageIdsByNormalizedUrl, CancellationToken ct)
    {
        if (completion.StateChangingLinks.Count == 0) return;

        // The page the link was seen on, so a check that needs to observe whether the link
        // changed anything has something to observe against. Without it such a check can only
        // read the link's own response, which tells it what the application chose to say
        // rather than what it did.
        var pageIdByUrl = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);
        foreach (var page in completion.Pages)
        {
            if (page.Url is not { Length: > 0 }) continue;
            if (!pageIdsByNormalizedUrl.TryGetValue(page.NormalizedUrl, out var id)) continue;
            pageIdByUrl[page.Url] = id;
        }

        // The address, recorded as the endpoint it is.
        //
        // Separate from the gap below, and this is the point: the gap is the record of a
        // refusal, and the endpoint is the record of a fact. Keyed off the gap, the security
        // surface learned these addresses only when the crawl had declined to follow them —
        // so turning state-changing interaction on, which is the one setting that lets a
        // scan probe them, removed them from the surface. The two settings cancelled each
        // other out and the measurement said 3 of 4 either way.
        //
        // GET, because that is what a link is, and an authenticated endpoint carrying an
        // identifier is what makes the authorization checks apply to it.
        // Addresses added by this loop, because the existence check below runs against the
        // database and nothing in this loop is saved until it ends. Three links to the same
        // address produced three identical endpoint rows: the query could not see the two
        // rows already waiting in the change tracker. Meridian Freight carried
        // /shipments/shp-0008/cancel three times because of it.
        var added = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var link in completion.StateChangingLinks)
        {
            if (!Uri.TryCreate(link.Url, UriKind.Absolute, out var absolute)) continue;
            if (absolute.Scheme != Uri.UriSchemeHttp && absolute.Scheme != Uri.UriSchemeHttps) continue;

            var template = absolute.GetLeftPart(UriPartial.Path);
            if (!added.Add(template)) continue;
            if (await _db.ApiEndpoints.AnyAsync(e => e.ApplicationId == application.Id
                     && e.Method == "GET" && e.UrlTemplate == template, ct))
            {
                continue;
            }

            _db.ApiEndpoints.Add(new Domain.Applications.ApiEndpoint
            {
                OrganizationId = run.OrganizationId,
                ApplicationId = application.Id,
                Method = "GET",
                UrlTemplate = template,
                SampleUrl = absolute.ToString(),
                RequiresAuthentication = true,
                TriggeredByPageId = link.FoundOnUrl is { Length: > 0 } found
                                    && pageIdByUrl.TryGetValue(found, out var witnessId)
                    ? witnessId
                    : null,
                LastSeenAt = run.CompletedAt ?? DateTimeOffset.UtcNow
            });
        }

        var existing = await _db.CoverageGaps
            .Where(g => g.ApplicationId == application.Id
                     && g.Source == CoverageGapSources.Discovery
                     && g.Missing.StartsWith(StateChangeGapPrefix))
            .ToListAsync(ct);

        // And the gap only while the crawl is actually declining to follow them. Written
        // where the links were followed, it would say a thing was not tested that was.
        if (application.AllowStateChangingClicks) return;

        foreach (var link in completion.StateChangingLinks)
        {
            var path = PathOf(link.Url);
            var missing = $"{StateChangeGapPrefix}{path}";
            if (existing.Any(g => g.Missing == missing)) continue;

            var named = string.IsNullOrWhiteSpace(link.AccessibleName)
                ? "An unnamed link"
                : $"The link \"{_masker.MaskText(link.AccessibleName!)}\"";

            _db.CoverageGaps.Add(new CoverageGap
            {
                OrganizationId = run.OrganizationId,
                ProjectId = application.ProjectId,
                ApplicationId = application.Id,
                Category = TestCategory.Security,
                Source = CoverageGapSources.Discovery,
                Missing = missing,
                Reason = $"{named} at {path}, on {PathOf(link.FoundOnUrl)}, says it changes something, "
                    + "and a GET that changes something can be triggered by anyone who gets a user to open "
                    + "the URL. Discovery did not follow it: mapping an application must not alter it. "
                    + "Whether it really changes state, and whether it checks an anti-forgery token, was "
                    + "therefore not established.",
                RecommendedAction = "Authorize destructive testing for this application so the scan may "
                    + "follow it, or open it once by hand and check that the operation requires a POST and "
                    + "an anti-forgery token.",
                Status = CoverageGapStatus.HumanRequired
            });
        }
    }

    /// <summary>One spelling, shared with the security surface, which reads these gaps back
    /// to put the addresses on the surface. Two copies of this string would make that find
    /// nothing and say nothing.</summary>
    private const string StateChangeGapPrefix = Security.SecuritySurfaceService.StateChangeGapPrefix;

    private static string PathOf(string url)
        => Uri.TryCreate(url, UriKind.Absolute, out var parsed) ? parsed.PathAndQuery : url;

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
            await UpsertFormsAsync(run, applicationId, existing[payload.NormalizedUrl], payload.Forms, now, ct);
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
            element.IsReadOnly = payload.IsReadOnly;
            element.IsRequired = payload.IsRequired;
            element.OptionsJson = payload.Options is { Length: > 0 }
                ? JsonSerializer.Serialize(payload.Options, JsonDefaults.Options)
                : null;
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

    /// <summary>Records the forms found on one page.
    ///
    /// A form keeps its row across crawls, keyed by page and form key, so the tests made from
    /// it stay attached to it. Its shape is hashed, and a change of hash is recorded as the
    /// moment the form changed: that is what lets a regression run pick the tests a change
    /// actually reached. A form the page no longer has is marked absent, not deleted.</summary>
    private async Task UpsertFormsAsync(
        DiscoveryRun run, Guid applicationId, ApplicationPage page, List<Forms.DiscoveredFormModel> forms,
        DateTimeOffset now, CancellationToken ct)
    {
        var existing = await _db.ApplicationForms.Where(f => f.ApplicationPageId == page.Id).ToListAsync(ct);
        var byKey = existing.ToDictionary(f => f.FormKey, StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var model in forms)
        {
            var key = Truncate(string.IsNullOrWhiteSpace(model.Key) ? "form" : model.Key, 200);
            if (!seen.Add(key)) continue;

            if (!byKey.TryGetValue(key, out var form))
            {
                form = new ApplicationForm
                {
                    OrganizationId = run.OrganizationId,
                    ApplicationId = applicationId,
                    ApplicationPageId = page.Id,
                    FormKey = key,
                    CreatedAt = now
                };
                _db.ApplicationForms.Add(form);
                byKey[key] = form;
            }

            var hash = Forms.FormShape.Hash(model);
            if (!string.IsNullOrEmpty(form.ModelHash) && form.ModelHash != hash) form.ChangedAt = now;
            form.ModelHash = hash;
            form.DiscoveryRunId = run.Id;
            form.Name = Truncate(model.Name, 300);
            form.Route = page.Route;
            form.PageUrl = page.Url;
            form.Action = Truncate(model.Action, 2048);
            form.Method = Truncate(model.Method, 10);
            form.HasFormElement = model.HasFormElement;
            form.NoValidate = model.NoValidate;
            form.HasCsrfToken = model.HasCsrfToken;
            form.IsMultiStep = model.IsMultiStep;
            form.GroupCount = model.GroupCount;
            form.FieldCount = model.Fields.Count;
            form.RequiredFieldCount = model.Fields.Count(f => f.Required);
            form.DependencyCount = model.Dependencies.Count;
            form.ModelJson = model.ToJson();
            form.IsPresent = true;
            form.LastSeenAt = now;
        }

        foreach (var (key, form) in byKey)
        {
            if (!seen.Contains(key) && form.IsPresent)
            {
                form.IsPresent = false;
                form.ChangedAt = now;
            }
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

        // The control discovery pressed to make each transition, found by its accessible name
        // on the page it was pressed on. Kept so tests can reach a page the way a user does.
        var fromIds = completion.Transitions.Select(t => pageIds.TryGetValue(t.FromNormalizedUrl, out var id) ? id : Guid.Empty)
            .Where(id => id != Guid.Empty).Distinct().ToList();
        var controls = await _db.ApplicationElements
            .Where(e => fromIds.Contains(e.ApplicationPageId) && e.AccessibleName != null
                        && (e.Kind == ElementKind.Link || e.Kind == ElementKind.Button || e.Kind == ElementKind.Menu
                            || e.Kind == ElementKind.Tab || e.Kind == ElementKind.Navigation))
            .Select(e => new { e.Id, e.ApplicationPageId, e.AccessibleName, e.Kind })
            .ToListAsync(ct);
        Guid? ControlFor(Guid pageId, string? name)
        {
            if (string.IsNullOrWhiteSpace(name)) return null;
            var matches = controls.Where(c => c.ApplicationPageId == pageId
                && string.Equals(c.AccessibleName!.Trim(), name.Trim(), StringComparison.OrdinalIgnoreCase)).ToList();
            // Two controls with the same name cannot be told apart by it; better no path than a wrong one.
            return matches.Count == 1 ? matches[0].Id : null;
        }

        foreach (var payload in completion.Transitions)
        {
            if (!pageIds.TryGetValue(payload.FromNormalizedUrl, out var fromId)) continue;
            if (!pageIds.TryGetValue(payload.ToNormalizedUrl, out var toId)) continue;
            if (fromId == toId) continue;

            var action = Enum.TryParse<BrowserActionType>(payload.Action, ignoreCase: true, out var parsed)
                ? parsed : BrowserActionType.Click;

            var trigger = ControlFor(fromId, payload.TriggerAccessibleName);
            var match = existing.FirstOrDefault(t => t.FromPageId == fromId && t.ToPageId == toId && t.Action == action);
            if (match is not null)
            {
                match.TimesObserved++;
                if (trigger is not null) match.TriggerElementId = trigger;
                continue;
            }

            var transition = new PageTransition
            {
                OrganizationId = run.OrganizationId,
                ApplicationId = applicationId,
                FromPageId = fromId,
                ToPageId = toId,
                Action = action,
                TriggerElementId = trigger,
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
