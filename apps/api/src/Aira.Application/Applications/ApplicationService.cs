using System.Text.Json;
using Aira.Application.Abstractions;
using Aira.Application.Contracts;
using Aira.Application.Security;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ApplicationEntity = Aira.Domain.Applications.Application;

namespace Aira.Application.Applications;

public sealed record ApplicationCredentials(string? Username, string? Password, string? BearerToken, string? StorageStateJson);

public sealed record CreateApplicationRequest(
    Guid ProjectId, string Name, string BaseUrl, string? Description,
    string? AllowedDomains, string? ExcludedPaths,
    int? MaxCrawlDepth, int? MaxPages, int? MaxActions, int? ExplorationTimeoutSeconds,
    AuthenticationStrategy AuthStrategy, string? LoginUrl, string? LoginFlowJson,
    ApplicationCredentials? Credentials);

public sealed record UpdateApplicationRequest(
    string? Name, string? BaseUrl, string? Description, string? AllowedDomains, string? ExcludedPaths,
    int? MaxCrawlDepth, int? MaxPages, int? MaxActions, int? ExplorationTimeoutSeconds,
    AuthenticationStrategy? AuthStrategy, string? LoginUrl, string? LoginFlowJson,
    ApplicationCredentials? Credentials);

public sealed record ApplicationSummary(
    Guid Id, Guid ProjectId, string Name, string BaseUrl, string Description,
    AuthenticationStrategy AuthStrategy, bool HasCredentials,
    int PageCount, int ElementCount, int ApiEndpointCount, int JourneyCount,
    DateTimeOffset? LastDiscoveredAt, DiscoveryStatus? LastDiscoveryStatus, DateTimeOffset CreatedAt);

public sealed record ApplicationDetail(
    Guid Id, Guid ProjectId, string Name, string BaseUrl, string Description,
    string AllowedDomains, string ExcludedPaths, int MaxCrawlDepth, int MaxPages, int MaxActions,
    int ExplorationTimeoutSeconds, bool RespectRobotsTxt,
    AuthenticationStrategy AuthStrategy, string? LoginUrl, string? LoginFlowJson,
    bool HasCredentials, DateTimeOffset CreatedAt, DateTimeOffset? UpdatedAt);

public interface IApplicationService
{
    Task<IReadOnlyList<ApplicationSummary>> ListAsync(Guid? projectId, CancellationToken ct = default);
    Task<Result<ApplicationDetail>> GetAsync(Guid id, CancellationToken ct = default);
    Task<Result<ApplicationDetail>> CreateAsync(CreateApplicationRequest request, CancellationToken ct = default);
    Task<Result<ApplicationDetail>> UpdateAsync(Guid id, UpdateApplicationRequest request, CancellationToken ct = default);
    Task<Result> DeleteAsync(Guid id, CancellationToken ct = default);
    /// <summary>Decrypts an application's credentials for dispatch to a worker. Never exposed over HTTP.</summary>
    Task<ApplicationCredentials> ResolveCredentialsAsync(ApplicationEntity application, CancellationToken ct = default);
}

public sealed class ApplicationService : IApplicationService
{
    private readonly IAiraDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly ISecretProtector _protector;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly ITargetPolicy _targetPolicy;
    private readonly ILogger<ApplicationService> _logger;

    public ApplicationService(IAiraDbContext db, ICurrentUser currentUser, ISecretProtector protector,
        IClock clock, IAuditLogger audit, ITargetPolicy targetPolicy, ILogger<ApplicationService> logger)
    {
        _db = db;
        _currentUser = currentUser;
        _protector = protector;
        _clock = clock;
        _audit = audit;
        _targetPolicy = targetPolicy;
        _logger = logger;
    }

    public async Task<IReadOnlyList<ApplicationSummary>> ListAsync(Guid? projectId, CancellationToken ct = default)
    {
        var query = _db.Applications.AsQueryable();
        if (projectId is not null) query = query.Where(a => a.ProjectId == projectId);

        return await query
            .OrderBy(a => a.Name)
            .Select(a => new ApplicationSummary(
                a.Id, a.ProjectId, a.Name, a.BaseUrl, a.Description, a.AuthStrategy,
                a.EncryptedCredentials != null,
                _db.ApplicationPages.Count(p => p.ApplicationId == a.Id),
                _db.ApplicationElements.Count(e => _db.ApplicationPages
                    .Where(p => p.ApplicationId == a.Id).Select(p => p.Id).Contains(e.ApplicationPageId)),
                _db.ApiEndpoints.Count(e => e.ApplicationId == a.Id),
                _db.Journeys.Count(j => j.ApplicationId == a.Id),
                _db.DiscoveryRuns.Where(r => r.ApplicationId == a.Id)
                    .OrderByDescending(r => r.CreatedAt).Select(r => (DateTimeOffset?)r.CreatedAt).FirstOrDefault(),
                _db.DiscoveryRuns.Where(r => r.ApplicationId == a.Id)
                    .OrderByDescending(r => r.CreatedAt).Select(r => (DiscoveryStatus?)r.Status).FirstOrDefault(),
                a.CreatedAt))
            .ToListAsync(ct);
    }

    public async Task<Result<ApplicationDetail>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == id, ct);
        return application is null ? Error.NotFound("The application") : Result<ApplicationDetail>.Success(Map(application));
    }

    public async Task<Result<ApplicationDetail>> CreateAsync(CreateApplicationRequest request, CancellationToken ct = default)
    {
        var organizationId = _currentUser.OrganizationId;
        if (organizationId is null) return Error.Unauthorized();

        if (!await _db.Projects.AnyAsync(p => p.Id == request.ProjectId, ct))
            return Error.NotFound("The project");

        var validation = ValidateUrls(request.BaseUrl, request.LoginUrl, request.AllowedDomains);
        if (validation is not null) return Result<ApplicationDetail>.Failure(validation);

        var budget = ValidateBudget(request.MaxCrawlDepth, request.MaxPages, request.MaxActions, request.ExplorationTimeoutSeconds);
        if (budget is not null) return Result<ApplicationDetail>.Failure(budget);

        if (string.IsNullOrWhiteSpace(request.Name))
            return Error.Validation("An application name is required.");

        var application = new ApplicationEntity
        {
            OrganizationId = organizationId.Value,
            ProjectId = request.ProjectId,
            Name = request.Name.Trim(),
            BaseUrl = request.BaseUrl.Trim(),
            Description = request.Description?.Trim() ?? string.Empty,
            // The base URL's own host is always permitted; anything else has to be asked for.
            AllowedDomains = NormalizeAllowlist(request.AllowedDomains, request.BaseUrl),
            ExcludedPaths = request.ExcludedPaths?.Trim() ?? "/logout,/signout,/delete",
            MaxCrawlDepth = request.MaxCrawlDepth ?? 3,
            MaxPages = request.MaxPages ?? 50,
            MaxActions = request.MaxActions ?? 400,
            ExplorationTimeoutSeconds = request.ExplorationTimeoutSeconds ?? 600,
            AuthStrategy = request.AuthStrategy,
            LoginUrl = request.LoginUrl?.Trim(),
            LoginFlowJson = request.LoginFlowJson,
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };

        if (request.Credentials is not null)
            application.EncryptedCredentials = Protect(request.Credentials);

        _db.Applications.Add(application);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ApplicationCreated, nameof(ApplicationEntity), application.Id,
            $"Application '{application.Name}' added for {application.BaseUrl}.",
            projectId: application.ProjectId, ct: ct);

        if (request.Credentials is not null)
        {
            await _audit.LogAsync(AuditAction.SecretConfigured, nameof(ApplicationEntity), application.Id,
                $"Credentials configured for application '{application.Name}'.",
                projectId: application.ProjectId, ct: ct);
        }

        return Result<ApplicationDetail>.Success(Map(application));
    }

    public async Task<Result<ApplicationDetail>> UpdateAsync(Guid id, UpdateApplicationRequest request, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (application is null) return Error.NotFound("The application");

        var baseUrl = request.BaseUrl?.Trim() ?? application.BaseUrl;
        var validation = ValidateUrls(baseUrl, request.LoginUrl ?? application.LoginUrl, request.AllowedDomains ?? application.AllowedDomains);
        if (validation is not null) return Result<ApplicationDetail>.Failure(validation);

        var budget = ValidateBudget(request.MaxCrawlDepth, request.MaxPages, request.MaxActions, request.ExplorationTimeoutSeconds);
        if (budget is not null) return Result<ApplicationDetail>.Failure(budget);

        if (request.Name is not null) application.Name = request.Name.Trim();
        if (request.BaseUrl is not null) application.BaseUrl = baseUrl;
        if (request.Description is not null) application.Description = request.Description.Trim();
        if (request.AllowedDomains is not null) application.AllowedDomains = NormalizeAllowlist(request.AllowedDomains, application.BaseUrl);
        if (request.ExcludedPaths is not null) application.ExcludedPaths = request.ExcludedPaths.Trim();
        if (request.MaxCrawlDepth is not null) application.MaxCrawlDepth = request.MaxCrawlDepth.Value;
        if (request.MaxPages is not null) application.MaxPages = request.MaxPages.Value;
        if (request.MaxActions is not null) application.MaxActions = request.MaxActions.Value;
        if (request.ExplorationTimeoutSeconds is not null) application.ExplorationTimeoutSeconds = request.ExplorationTimeoutSeconds.Value;
        if (request.AuthStrategy is not null) application.AuthStrategy = request.AuthStrategy.Value;
        if (request.LoginUrl is not null) application.LoginUrl = request.LoginUrl.Trim();
        if (request.LoginFlowJson is not null) application.LoginFlowJson = request.LoginFlowJson;

        if (request.Credentials is not null)
        {
            application.EncryptedCredentials = Protect(request.Credentials);
            await _audit.LogAsync(AuditAction.SecretConfigured, nameof(ApplicationEntity), application.Id,
                $"Credentials updated for application '{application.Name}'.",
                projectId: application.ProjectId, ct: ct);
        }

        application.UpdatedByUserId = _currentUser.UserId;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ApplicationUpdated, nameof(ApplicationEntity), application.Id,
            $"Application '{application.Name}' updated.", projectId: application.ProjectId, ct: ct);

        return Result<ApplicationDetail>.Success(Map(application));
    }

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (application is null) return Result.Failure(Error.NotFound("The application"));

        application.DeletedAt = _clock.UtcNow;
        application.UpdatedByUserId = _currentUser.UserId;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ApplicationUpdated, nameof(ApplicationEntity), application.Id,
            $"Application '{application.Name}' deleted.", projectId: application.ProjectId, ct: ct);
        return Result.Success();
    }

    public Task<ApplicationCredentials> ResolveCredentialsAsync(ApplicationEntity application, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(application.EncryptedCredentials))
            return Task.FromResult(new ApplicationCredentials(null, null, null, null));

        if (!_protector.TryUnprotect(application.EncryptedCredentials, out var json))
        {
            // A credential that will not decrypt is an operational problem, not a silent
            // no-op: the run would otherwise fail later with a confusing login error.
            _logger.LogError("Stored credentials for application {ApplicationId} could not be decrypted.", application.Id);
            throw new InvalidOperationException(
                $"The stored credentials for application '{application.Name}' could not be decrypted. They must be re-entered.");
        }

        var credentials = JsonSerializer.Deserialize<ApplicationCredentials>(json, JsonDefaults.Options)
            ?? new ApplicationCredentials(null, null, null, null);
        return Task.FromResult(credentials);
    }

    private string Protect(ApplicationCredentials credentials)
        => _protector.Protect(JsonSerializer.Serialize(credentials, JsonDefaults.Options));

    private Error? ValidateUrls(string baseUrl, string? loginUrl, string? allowedDomains)
    {
        var allowlist = ParseAllowlist(allowedDomains, baseUrl);

        if (!_targetPolicy.IsAllowed(baseUrl, allowlist, out var reason))
            return Error.Validation($"The base URL is not permitted: {reason}");

        if (!string.IsNullOrWhiteSpace(loginUrl) && !_targetPolicy.IsAllowed(loginUrl!, allowlist, out var loginReason))
            return Error.Validation($"The login URL is not permitted: {loginReason}");

        return null;
    }

    private static Error? ValidateBudget(int? depth, int? pages, int? actions, int? timeout)
    {
        if (depth is < 1 or > 10) return Error.Validation("The crawl depth must be between 1 and 10.");
        if (pages is < 1 or > 1000) return Error.Validation("The page budget must be between 1 and 1000.");
        if (actions is < 1 or > 10_000) return Error.Validation("The action budget must be between 1 and 10000.");
        if (timeout is < 30 or > 7200) return Error.Validation("The exploration timeout must be between 30 and 7200 seconds.");
        return null;
    }

    /// <summary>The base URL's host is always included, so a caller cannot lock the
    /// platform out of the application it was just asked to test.</summary>
    private static string NormalizeAllowlist(string? allowedDomains, string baseUrl)
        => string.Join(',', ParseAllowlist(allowedDomains, baseUrl));

    public static IReadOnlyList<string> ParseAllowlist(string? allowedDomains, string baseUrl)
    {
        var hosts = new List<string>();
        if (Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri)) hosts.Add(uri.Host);

        if (!string.IsNullOrWhiteSpace(allowedDomains))
        {
            hosts.AddRange(allowedDomains
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(h => h.ToLowerInvariant()));
        }

        return hosts.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static ApplicationDetail Map(ApplicationEntity a) => new(
        a.Id, a.ProjectId, a.Name, a.BaseUrl, a.Description, a.AllowedDomains, a.ExcludedPaths,
        a.MaxCrawlDepth, a.MaxPages, a.MaxActions, a.ExplorationTimeoutSeconds, a.RespectRobotsTxt,
        a.AuthStrategy, a.LoginUrl, a.LoginFlowJson, a.EncryptedCredentials != null, a.CreatedAt, a.UpdatedAt);
}

/// <summary>Applies the deployment's global target policy on top of an application's own
/// allowlist. Defined as a port so the policy (which depends on configuration) stays out
/// of the use case.</summary>
public interface ITargetPolicy
{
    bool IsAllowed(string url, IReadOnlyCollection<string> applicationAllowlist, out string reason);
    bool AllowPrivateNetworks { get; }
}
