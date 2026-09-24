using System.Text.Json;
using Aira.Application.Abstractions;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Aira.Domain.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Security;

public sealed record StartSecurityScanRequest(
    Guid ApplicationId,
    SecurityProfile Profile = SecurityProfile.Standard,
    /// <summary>Narrow the run to these checks. Empty runs everything the surface implies;
    /// whatever is passed, the full implied set still travels as the configured set so the
    /// gate reads coverage honestly.</summary>
    IReadOnlyList<string>? ChecksToRun = null,
    /// <summary>Synthetic identities the scan may sign in as. Never real accounts.</summary>
    IReadOnlyList<SecurityScanIdentity>? Identities = null);

public sealed record SecurityScanIdentity(
    string Label, string Username, string Password, string? Role = null, string? ResourceId = null);

public sealed record StartedSecurityScan(
    Guid SecurityScanId, string Reference, string Queue, string JobId,
    int Targets, int ChecksToRun, int ChecksConfigured, string Summary);

public interface ISecurityScanLauncher
{
    Task<Result<StartedSecurityScan>> StartAsync(
        StartSecurityScanRequest request, CancellationToken ct = default);
}

/// <summary>
/// Starting a security scan: the platform deciding, the worker doing.
/// </summary>
/// <remarks>
/// <para>
/// Everything that decides what is permitted happens here, before anything is queued. The
/// worker receives a scope it cannot widen, a target list it did not choose and a check list
/// the control plane selected — and the guard inside the engine refuses anything outside the
/// scope even so. A worker that looked up its own scope could be pointed at a different one by
/// whoever enqueued the job; a worker that receives one can only do what a person authorized.
/// </para>
/// <para>
/// The three refusals here are the same three the recording path makes, and deliberately so:
/// no enabled scope, no written authorization, production without the permission. Refusing at
/// both ends means a scan cannot be started around the check and cannot be recorded around it
/// either.
/// </para>
/// </remarks>
public sealed class SecurityScanLauncher : ISecurityScanLauncher
{
    private readonly IAiraDbContext _db;
    private readonly ISecuritySurfaceService _surface;
    private readonly IJobQueue _queue;
    private readonly ITokenService _tokens;
    private readonly ICurrentUser _user;
    private readonly IAuditLogger _audit;
    private readonly IClock _clock;
    private readonly ILogger<SecurityScanLauncher> _logger;
    private readonly string _callbackBaseUrl;

    public SecurityScanLauncher(
        IAiraDbContext db, ISecuritySurfaceService surface, IJobQueue queue, ITokenService tokens,
        ICurrentUser user, IAuditLogger audit, IClock clock,
        ILogger<SecurityScanLauncher> logger, Aira.Application.Discovery.IPlatformUrls urls)
    {
        _db = db;
        _surface = surface;
        _queue = queue;
        _tokens = tokens;
        _user = user;
        _audit = audit;
        _clock = clock;
        _logger = logger;
        // The same URL discovery and execution are told: the one that works from where the
        // worker runs, not the one the API believes it is reachable at.
        _callbackBaseUrl = urls.ApiBaseUrl;
    }

    public async Task<Result<StartedSecurityScan>> StartAsync(
        StartSecurityScanRequest request, CancellationToken ct = default)
    {
        var application = await _db.Applications.AsNoTracking()
            .FirstOrDefaultAsync(a => a.Id == request.ApplicationId, ct);
        if (application is null)
            return Result<StartedSecurityScan>.Failure(Error.NotFound("The application"));

        var scope = await _db.SecurityScopes.AsNoTracking()
            .FirstOrDefaultAsync(s => s.ApplicationId == request.ApplicationId, ct);

        if (scope is null || !scope.Enabled || string.IsNullOrWhiteSpace(scope.AuthorizationNote))
        {
            return Result<StartedSecurityScan>.Failure(Error.SecurityPolicy(
                "This application has no enabled security scope carrying a written authorization, so "
                + "no scan can be started against it. Somebody with security:authorize has to say, in "
                + "writing, that it may be tested."));
        }

        // Destructive and production are each checked here as well as in the guard. The guard
        // refuses one request at a time; this refuses the scan, which is what somebody asked for.
        if (scope.AllowDestructiveTesting && !_user.HasPermission(Permissions.SecurityScanDestructive))
        {
            return Result<StartedSecurityScan>.Failure(Error.Forbidden(
                "This scope permits destructive testing and you do not hold security:scan:destructive. "
                + "Both are required, and neither grants the other."));
        }

        var environment = scope.EnvironmentId is { } environmentId
            ? await _db.Environments.AsNoTracking().FirstOrDefaultAsync(e => e.Id == environmentId, ct)
            : null;
        var isProduction = environment?.Kind == EnvironmentKind.Production;

        if (isProduction && !_user.HasPermission(Permissions.SecurityProduction))
        {
            return Result<StartedSecurityScan>.Failure(Error.Forbidden(
                "Scanning a production environment requires security:production, which is held at "
                + "organization level. Production security testing is off by default."));
        }

        // The surface decides where to point checks. A scan of an undiscovered application would
        // issue no requests and report as a scan, which is worse than refusing.
        var surface = await _surface.ForApplicationAsync(request.ApplicationId, ct);
        if (!surface.IsSuccess) return Result<StartedSecurityScan>.Failure(surface.Error!);

        var implied = surface.Value!.ChecksImplied;
        if (surface.Value.Items.Count == 0 || implied.Count == 0)
        {
            return Result<StartedSecurityScan>.Failure(Error.Validation(
                "Nothing has been discovered for this application, so there is nowhere to point a "
                + "security check. Run discovery first. A scan with no targets would issue no requests "
                + "and still be recorded as a scan, which reads as a clean result."));
        }

        var requested = request.ChecksToRun is { Count: > 0 }
            ? request.ChecksToRun.Where(c => implied.Contains(c)).ToList()
            : implied.ToList();

        if (requested.Count == 0)
        {
            return Result<StartedSecurityScan>.Failure(Error.Validation(
                "None of the checks requested is implied by what discovery found for this application, "
                + $"so the scan would run nothing. Implied here: {string.Join(", ", implied)}."));
        }

        var now = _clock.UtcNow;
        var scan = new SecurityScan
        {
            ApplicationId = application.Id,
            ProjectId = application.ProjectId,
            EnvironmentId = scope.EnvironmentId,
            Reference = $"SCAN-{now:yyyyMMdd}-{Guid.NewGuid().ToString("N")[..6].ToUpperInvariant()}",
            Profile = request.Profile,
            Status = "queued",
            AuthorizationNote = scope.AuthorizationNote,
            // The snapshot is written now, from the scope as authorized now, so a gate evaluated
            // later reads what this scan was permitted rather than what the scope says then.
            ScopeSnapshotJson = JsonSerializer.Serialize(new
            {
                scope.AllowedDomains, scope.AllowedApiDomains, scope.AllowedPaths, scope.BlockedPaths,
                scope.EnvironmentId, scope.MaxRequestsPerSecond, scope.MaxConcurrentRequests,
                scope.MaxScanDurationMinutes, scope.AllowActiveTesting, scope.AllowDestructiveTesting,
                scope.AllowProduction, scope.AuthorizationNote, scope.AuthorizedByUserId, scope.AuthorizedAt,
                checksConfigured = implied,
                checksExecuted = Array.Empty<string>(),
                untestedAreas = surface.Value.Caveats
            }),
            StartedAt = now,
            CreatedByUserId = _user.UserId
        };
        _db.SecurityScans.Add(scan);
        await _db.SaveChangesAsync(ct);

        var token = _tokens.IssueWorkerToken(
            application.OrganizationId, scan.Id, "security", TimeSpan.FromMinutes(
                Math.Max(scope.MaxScanDurationMinutes * 2, 30)));

        var job = new
        {
            jobId = scan.Id.ToString(),
            securityScanId = scan.Id.ToString(),
            organizationId = application.OrganizationId.ToString(),
            projectId = application.ProjectId.ToString(),
            applicationId = application.Id.ToString(),
            environmentId = scope.EnvironmentId?.ToString(),
            baseUrl = environment?.BaseUrl ?? application.BaseUrl,
            profile = request.Profile.ToString().ToLowerInvariant(),
            scope = new
            {
                enabled = scope.Enabled,
                authorizationNote = scope.AuthorizationNote,
                allowedDomains = Split(scope.AllowedDomains),
                allowedApiDomains = Split(scope.AllowedApiDomains),
                allowedPaths = Split(scope.AllowedPaths),
                blockedPaths = Split(scope.BlockedPaths),
                environmentId = scope.EnvironmentId?.ToString(),
                maxRequestsPerSecond = scope.MaxRequestsPerSecond,
                maxConcurrentRequests = scope.MaxConcurrentRequests,
                maxScanDurationMinutes = scope.MaxScanDurationMinutes,
                allowActiveTesting = scope.AllowActiveTesting,
                allowDestructiveTesting = scope.AllowDestructiveTesting,
                allowProduction = scope.AllowProduction
            },
            targets = surface.Value.Items.Select(item => new
            {
                kind = item.Kind == SecuritySurfaceKind.Page ? "page" : "endpoint",
                identifier = item.Identifier,
                httpMethod = item.HttpMethod,
                requiresAuthentication = item.RequiresAuthentication,
                parameters = item.Parameters,
                checks = item.RelevantChecks
            }),
            checksToRun = requested,
            checksConfigured = implied,
            identities = (request.Identities ?? Array.Empty<SecurityScanIdentity>()).Select(i => new
            {
                label = i.Label, username = i.Username, password = i.Password,
                role = i.Role, resourceId = i.ResourceId
            }),
            callerMayRunDestructiveScans = _user.HasPermission(Permissions.SecurityScanDestructive),
            isProductionEnvironment = isProduction,
            productionTestingAuthorized = isProduction && _user.HasPermission(Permissions.SecurityProduction),
            callbackToken = token,
            callbackBaseUrl = _callbackBaseUrl,
            correlationId = _user.CorrelationId ?? scan.Id.ToString()
        };

        var jobId = await _queue.EnqueueAsync(QueueNames.Security, "security-scan", job, ct);

        await _audit.LogAsync(AuditAction.SecurityScanStarted, nameof(SecurityScan), scan.Id,
            $"Started security scan {scan.Reference} against application {application.Id}",
            new
            {
                scan.Reference, profile = request.Profile.ToString(),
                targets = surface.Value.Items.Count,
                checksToRun = requested.Count, checksConfigured = implied.Count,
                identities = request.Identities?.Count ?? 0
            }, ct: ct);

        _logger.LogInformation(
            "Queued security scan {Reference} with {Targets} target(s) and {Checks} check(s)",
            scan.Reference, surface.Value.Items.Count, requested.Count);

        var narrowed = requested.Count < implied.Count;
        return Result<StartedSecurityScan>.Success(new StartedSecurityScan(
            scan.Id, scan.Reference, QueueNames.Security, jobId,
            surface.Value.Items.Count, requested.Count, implied.Count,
            $"Queued {scan.Reference}: {requested.Count} of {implied.Count} implied check(s) across "
            + $"{surface.Value.Items.Count} discovered target(s)."
            + (narrowed
                ? " This is a narrowed run, so it will report as partial coverage and cannot pass the "
                  + "gate on that basis."
                : " Every check the discovered surface implies is running.")
            + $" {surface.Value.Caveats.Count} caveat(s) apply to that surface, the first being that it "
            + "describes what discovery walked rather than the application."));
    }

    private static string[] Split(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? Array.Empty<string>()
            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}
