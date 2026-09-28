using QaNxt.Application.Abstractions;
using QaNxt.Application.Applications;
using QaNxt.Application.Security;
using QaNxt.Domain.Applications;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Application.Discovery;

public sealed record StartDiscoveryRequest(Guid ApplicationId, BrowserType? Browser, int? MaxDepth, int? MaxPages, int? TimeoutSeconds);

public sealed record DiscoveryRunSummary(
    Guid Id, Guid ApplicationId, string ApplicationName, DiscoveryStatus Status,
    DateTimeOffset CreatedAt, DateTimeOffset? StartedAt, DateTimeOffset? CompletedAt,
    int PagesDiscovered, int ElementsDiscovered, int ApiEndpointsDiscovered,
    int ConsoleErrorCount, int PagesBlockedByPolicy, string? ErrorMessage, string? WorkerId);

public sealed record DiscoveryRunDetail(DiscoveryRunSummary Summary, string? ProgressLog, int MaxDepth, int MaxPages, int TimeoutSeconds);

public interface IDiscoveryService
{
    Task<Result<DiscoveryRunSummary>> StartAsync(StartDiscoveryRequest request, CancellationToken ct = default);
    Task<IReadOnlyList<DiscoveryRunSummary>> ListAsync(Guid? applicationId, int limit, CancellationToken ct = default);
    Task<Result<DiscoveryRunDetail>> GetAsync(Guid id, CancellationToken ct = default);
}

/// <summary>Starts discovery runs. The control plane decides *whether* and *within what
/// bounds* exploration may happen; the worker decides nothing — it receives a frozen
/// budget and an allowlist it cannot widen.</summary>
public sealed class DiscoveryService : IDiscoveryService
{
    private readonly IQaNxtDbContext _db;
    private readonly IJobQueue _queue;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly ITokenService _tokens;
    private readonly IApplicationService _applications;
    private readonly ITargetPolicy _targetPolicy;
    private readonly ICorrelationContext _correlation;
    private readonly IAuditLogger _audit;
    private readonly IPlatformUrls _urls;
    private readonly ILogger<DiscoveryService> _logger;

    public DiscoveryService(IQaNxtDbContext db, IJobQueue queue, ICurrentUser currentUser, IClock clock,
        ITokenService tokens, IApplicationService applications, ITargetPolicy targetPolicy,
        ICorrelationContext correlation, IAuditLogger audit, IPlatformUrls urls, ILogger<DiscoveryService> logger)
    {
        _db = db;
        _queue = queue;
        _currentUser = currentUser;
        _clock = clock;
        _tokens = tokens;
        _applications = applications;
        _targetPolicy = targetPolicy;
        _correlation = correlation;
        _audit = audit;
        _urls = urls;
        _logger = logger;
    }

    public async Task<Result<DiscoveryRunSummary>> StartAsync(StartDiscoveryRequest request, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == request.ApplicationId, ct);
        if (application is null) return Error.NotFound("The application");

        // A second concurrent crawl of the same application would double the load on the
        // target and race on the page nodes both runs are writing.
        var inFlight = await _db.DiscoveryRuns
            .Where(r => r.ApplicationId == application.Id &&
                        (r.Status == DiscoveryStatus.Queued || r.Status == DiscoveryStatus.Running))
            .ToListAsync(ct);

        var stale = inFlight.Where(IsAbandoned).ToList();
        foreach (var abandoned in stale)
        {
            // A worker that died mid-crawl must not block the application forever. Past its
            // own budget plus a generous margin, a run is abandoned rather than in progress.
            abandoned.Status = DiscoveryStatus.Failed;
            abandoned.CompletedAt = _clock.UtcNow;
            abandoned.ErrorMessage = "The run was abandoned: no worker reported progress within its exploration budget.";
            _logger.LogWarning("Marking abandoned discovery run {RunId} as failed", abandoned.Id);
        }
        if (stale.Count > 0) await _db.SaveChangesAsync(ct);

        if (inFlight.Count > stale.Count)
            return Error.Conflict("discovery_in_progress", "Discovery is already running for this application.");

        var allowlist = ApplicationService.ParseAllowlist(application.AllowedDomains, application.BaseUrl);
        if (!_targetPolicy.IsAllowed(application.BaseUrl, allowlist, out var reason))
            return Error.Validation($"Discovery cannot start: {reason}");

        var run = new DiscoveryRun
        {
            OrganizationId = application.OrganizationId,
            ProjectId = application.ProjectId,
            ApplicationId = application.Id,
            Status = DiscoveryStatus.Queued,
            // The budget is frozen onto the run so a later configuration change cannot
            // make a historical run unexplainable.
            MaxDepth = Math.Clamp(request.MaxDepth ?? application.MaxCrawlDepth, 1, 10),
            MaxPages = Math.Clamp(request.MaxPages ?? application.MaxPages, 1, 1000),
            TimeoutSeconds = Math.Clamp(request.TimeoutSeconds ?? application.ExplorationTimeoutSeconds, 30, 7200),
            Browser = request.Browser ?? BrowserType.Chromium,
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };

        _db.DiscoveryRuns.Add(run);
        await _db.SaveChangesAsync(ct);

        var credentials = await _applications.ResolveCredentialsAsync(application, ct);
        var payload = BuildPayload(run, application, credentials, allowlist);

        try
        {
            var jobId = await _queue.EnqueueAsync(QueueNames.Discovery, "discovery", payload, ct);
            _logger.LogInformation("Queued discovery run {RunId} as job {JobId}", run.Id, jobId);
        }
        catch (Exception ex)
        {
            // The run must not sit in Queued forever if the queue is unreachable; that
            // looks to a user like a worker that never picked it up.
            run.Status = DiscoveryStatus.Failed;
            run.ErrorMessage = "The discovery job could not be queued. Check that the job queue is reachable.";
            run.CompletedAt = _clock.UtcNow;
            await _db.SaveChangesAsync(ct);
            _logger.LogError(ex, "Failed to queue discovery run {RunId}", run.Id);
            return Error.Dependency("queue_unavailable", run.ErrorMessage);
        }

        await _audit.LogAsync(AuditAction.DiscoveryStarted, nameof(DiscoveryRun), run.Id,
            $"Discovery started for '{application.Name}' ({application.BaseUrl}).",
            projectId: application.ProjectId, ct: ct);

        return Result<DiscoveryRunSummary>.Success(await MapAsync(run, application.Name));
    }

    public async Task<IReadOnlyList<DiscoveryRunSummary>> ListAsync(Guid? applicationId, int limit, CancellationToken ct = default)
    {
        var query = _db.DiscoveryRuns.AsQueryable();
        if (applicationId is not null) query = query.Where(r => r.ApplicationId == applicationId);

        return await query
            .OrderByDescending(r => r.CreatedAt)
            .Take(Math.Clamp(limit, 1, 200))
            .Select(r => new DiscoveryRunSummary(
                r.Id, r.ApplicationId, r.Application!.Name, r.Status, r.CreatedAt, r.StartedAt, r.CompletedAt,
                r.PagesDiscovered, r.ElementsDiscovered, r.ApiEndpointsDiscovered,
                r.ConsoleErrorCount, r.PagesBlockedByPolicy, r.ErrorMessage, r.WorkerId))
            .ToListAsync(ct);
    }

    public async Task<Result<DiscoveryRunDetail>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var run = await _db.DiscoveryRuns.Include(r => r.Application).FirstOrDefaultAsync(r => r.Id == id, ct);
        if (run is null) return Error.NotFound("The discovery run");

        return Result<DiscoveryRunDetail>.Success(new DiscoveryRunDetail(
            await MapAsync(run, run.Application?.Name ?? string.Empty),
            run.ProgressLog, run.MaxDepth, run.MaxPages, run.TimeoutSeconds));
    }

    /// <summary>A run is treated as abandoned once it has had no update for longer than its
    /// own timeout plus a margin that comfortably covers a worker restart.</summary>
    private bool IsAbandoned(DiscoveryRun run)
    {
        var lastActivity = run.UpdatedAt ?? run.StartedAt ?? run.CreatedAt;
        var grace = TimeSpan.FromSeconds(run.TimeoutSeconds) + TimeSpan.FromMinutes(5);
        return _clock.UtcNow - lastActivity > grace;
    }

    private DiscoveryJobPayload BuildPayload(
        DiscoveryRun run, Domain.Applications.Application application,
        ApplicationCredentials credentials, IReadOnlyList<string> allowlist)
    {
        return new DiscoveryJobPayload
        {
            JobId = run.Id.ToString(),
            DiscoveryRunId = run.Id,
            OrganizationId = run.OrganizationId,
            ProjectId = run.ProjectId,
            ApplicationId = application.Id,
            BaseUrl = application.BaseUrl,
            Browser = run.Browser.ToString().ToLowerInvariant(),
            Headless = true,
            Auth = new AuthConfigPayload
            {
                Strategy = application.AuthStrategy,
                LoginUrl = application.LoginUrl,
                Username = credentials.Username,
                Password = credentials.Password,
                BearerToken = credentials.BearerToken,
                StorageStateJson = credentials.StorageStateJson,
                SuccessUrlContains = ExtractLoginFlowValue(application.LoginFlowJson, "successUrlContains")
            },
            Budget = new CrawlBudgetPayload
            {
                AllowedHosts = allowlist.ToArray(),
                ExcludedPathPrefixes = application.ExcludedPaths
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                MaxDepth = run.MaxDepth,
                MaxPages = run.MaxPages,
                MaxActions = application.MaxActions,
                TimeoutSeconds = run.TimeoutSeconds,
                AllowPrivateNetworks = _targetPolicy.AllowPrivateNetworks,
                RespectRobotsTxt = application.RespectRobotsTxt
            },
            // Scoped to this run, and expiring with its budget plus a margin: a leaked
            // worker token is worth almost nothing.
            CallbackToken = _tokens.IssueWorkerToken(run.OrganizationId, run.Id, "discovery",
                TimeSpan.FromSeconds(run.TimeoutSeconds + 900)),
            CallbackBaseUrl = _urls.ApiBaseUrl,
            CorrelationId = _correlation.CorrelationId
        };
    }

    /// <summary>Reads one optional hint out of the stored login-flow description.</summary>
    private static string? ExtractLoginFlowValue(string? loginFlowJson, string property)
    {
        if (string.IsNullOrWhiteSpace(loginFlowJson)) return null;
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(loginFlowJson!);
            return document.RootElement.TryGetProperty(property, out var value) ? value.GetString() : null;
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }

    private Task<DiscoveryRunSummary> MapAsync(DiscoveryRun run, string applicationName)
        => Task.FromResult(new DiscoveryRunSummary(
            run.Id, run.ApplicationId, applicationName, run.Status, run.CreatedAt, run.StartedAt, run.CompletedAt,
            run.PagesDiscovered, run.ElementsDiscovered, run.ApiEndpointsDiscovered,
            run.ConsoleErrorCount, run.PagesBlockedByPolicy, run.ErrorMessage, run.WorkerId));
}

/// <summary>Where the platform can be reached. Supplied by configuration so that workers
/// are told a URL that works from where they run, not from where the API thinks it is.</summary>
public interface IPlatformUrls
{
    string ApiBaseUrl { get; }
    string ConsoleBaseUrl { get; }
}
