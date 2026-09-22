using Aira.Application.Abstractions;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Projects;

public sealed record CreateEnvironmentRequest(
    Guid ProjectId, string Name, string Key, EnvironmentKind Kind, string BaseUrl,
    string? ApiBaseUrl, string? AllowedDomains, int? RateLimitPerMinute,
    bool? AllowDestructiveTests);

public sealed record UpdateEnvironmentRequest(
    string? Name, EnvironmentKind? Kind, string? BaseUrl, string? ApiBaseUrl,
    string? AllowedDomains, int? RateLimitPerMinute, bool? AllowDestructiveTests, bool? IsEnabled);

/// <summary>Deliberately separate from an ordinary update: authorizing production testing is
/// a decision, and it is recorded as one — who, when, and on what grounds.</summary>
public sealed record AuthorizeProductionRequest(bool Authorized, string Note);

public sealed record EnvironmentSummary(
    Guid Id, Guid ProjectId, string Name, string Key, EnvironmentKind Kind, string BaseUrl,
    string? ApiBaseUrl, bool IsProduction, bool ProductionTestingAuthorized,
    string? ProductionAuthorizationNote, DateTimeOffset? ProductionAuthorizedAt,
    string? AllowedDomains, int RateLimitPerMinute, bool AllowDestructiveTests, bool IsEnabled,
    DateTimeOffset CreatedAt);

public interface IEnvironmentService
{
    Task<IReadOnlyList<EnvironmentSummary>> ListAsync(Guid? projectId, CancellationToken ct = default);
    Task<Result<EnvironmentSummary>> GetAsync(Guid id, CancellationToken ct = default);
    /// <summary>Resolves by the key a pipeline passes to `--environment`.</summary>
    Task<Result<EnvironmentSummary>> ResolveAsync(Guid projectId, string key, CancellationToken ct = default);
    Task<Result<EnvironmentSummary>> CreateAsync(CreateEnvironmentRequest request, CancellationToken ct = default);
    Task<Result<EnvironmentSummary>> UpdateAsync(Guid id, UpdateEnvironmentRequest request, CancellationToken ct = default);
    Task<Result<EnvironmentSummary>> AuthorizeProductionAsync(Guid id, AuthorizeProductionRequest request, CancellationToken ct = default);
    Task<Result> DeleteAsync(Guid id, CancellationToken ct = default);

    /// <summary>Whether AIRA may run against this environment at all, and why not when it
    /// may not. Called before a run is queued rather than after, because the point is that
    /// the run does not happen.</summary>
    Task<Result<EnvironmentSummary>> EnsureTestableAsync(Guid id, CancellationToken ct = default);
}

/// <summary>Environments: where an application is deployed, and whether AIRA is allowed to
/// touch it.
///
/// Production is refused by default and needs two separate things to be true — the
/// environment is marked production, and someone has authorized testing on it with a note
/// saying why. One switch would be easy to flip by accident; the cost of that mistake is
/// paid by real customers.</summary>
public sealed class EnvironmentService : IEnvironmentService
{
    private readonly IAiraDbContext _db;
    private readonly ICurrentUser _user;
    private readonly IAuditLogger _audit;
    private readonly IClock _clock;
    private readonly ILogger<EnvironmentService> _logger;

    public EnvironmentService(
        IAiraDbContext db, ICurrentUser user, IAuditLogger audit, IClock clock,
        ILogger<EnvironmentService> logger)
    {
        _db = db;
        _user = user;
        _audit = audit;
        _clock = clock;
        _logger = logger;
    }

    public async Task<IReadOnlyList<EnvironmentSummary>> ListAsync(Guid? projectId, CancellationToken ct = default)
    {
        var query = _db.Environments.AsQueryable();
        if (projectId is not null) query = query.Where(e => e.ProjectId == projectId);
        return await query.OrderBy(e => e.Kind).ThenBy(e => e.Name).Select(Project()).ToListAsync(ct);
    }

    public async Task<Result<EnvironmentSummary>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var found = await _db.Environments.Where(e => e.Id == id).Select(Project()).FirstOrDefaultAsync(ct);
        return found is null ? Result<EnvironmentSummary>.Failure(Error.NotFound("The environment")) : Result<EnvironmentSummary>.Success(found);
    }

    public async Task<Result<EnvironmentSummary>> ResolveAsync(Guid projectId, string key, CancellationToken ct = default)
    {
        var trimmed = (key ?? string.Empty).Trim();
        if (trimmed.Length == 0) return Result<EnvironmentSummary>.Failure(Error.Validation("An environment key is required."));

        var found = await _db.Environments
            .Where(e => e.ProjectId == projectId && e.Key.ToLower() == trimmed.ToLower())
            .Select(Project()).FirstOrDefaultAsync(ct);

        if (found is not null) return Result<EnvironmentSummary>.Success(found);

        // Names the alternatives: a pipeline that passed the wrong key should not have to
        // guess what the right ones are.
        var known = await _db.Environments.Where(e => e.ProjectId == projectId)
            .Select(e => e.Key).ToListAsync(ct);
        return Result<EnvironmentSummary>.Failure(Error.NotFound(
            known.Count == 0
                ? $"No environment '{trimmed}' — this project has none configured"
                : $"No environment '{trimmed}' in this project (it has: {string.Join(", ", known)})"));
    }

    public async Task<Result<EnvironmentSummary>> CreateAsync(CreateEnvironmentRequest request, CancellationToken ct = default)
    {
        var name = (request.Name ?? string.Empty).Trim();
        var key = (request.Key ?? string.Empty).Trim().ToLowerInvariant();
        if (name.Length == 0) return Result<EnvironmentSummary>.Failure(Error.Validation("A name is required."));
        if (key.Length is 0 or > 40) return Result<EnvironmentSummary>.Failure(Error.Validation("A key of 1 to 40 characters is required."));
        if (!Uri.TryCreate(request.BaseUrl, UriKind.Absolute, out _))
            return Result<EnvironmentSummary>.Failure(Error.Validation("The base URL must be absolute."));

        if (!await _db.Projects.AnyAsync(p => p.Id == request.ProjectId, ct))
            return Result<EnvironmentSummary>.Failure(Error.NotFound("The project"));

        if (await _db.Environments.AnyAsync(e => e.ProjectId == request.ProjectId && e.Key.ToLower() == key, ct))
            return Result<EnvironmentSummary>.Failure(Error.Conflict("environment_key_taken", $"This project already has an environment keyed '{key}'."));

        var isProduction = request.Kind == EnvironmentKind.Production;

        var environment = new Domain.Projects.Environment
        {
            // OrganizationId is stamped by the DbContext from the tenant context on save.
            ProjectId = request.ProjectId,
            Name = name,
            Key = key,
            Kind = request.Kind,
            BaseUrl = request.BaseUrl.TrimEnd('/'),
            ApiBaseUrl = request.ApiBaseUrl?.TrimEnd('/'),
            IsProduction = isProduction,
            // Never on creation, whatever the caller asked for. Authorizing production is a
            // second, explicit act by someone who holds the permission.
            ProductionTestingAuthorized = false,
            AllowedDomains = request.AllowedDomains,
            RateLimitPerMinute = Math.Max(0, request.RateLimitPerMinute ?? 0),
            // A destructive action against production cannot be enabled here either.
            AllowDestructiveTests = !isProduction && (request.AllowDestructiveTests ?? false),
            IsEnabled = true,
            CreatedAt = _clock.UtcNow
        };

        _db.Environments.Add(environment);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ProjectUpdated, nameof(Domain.Projects.Environment), environment.Id,
            $"Environment '{name}' ({key}, {request.Kind}) created for {request.BaseUrl}."
            + (isProduction ? " Production: testing is refused until it is authorized." : string.Empty),
            projectId: request.ProjectId, ct: ct);

        return await GetAsync(environment.Id, ct);
    }

    public async Task<Result<EnvironmentSummary>> UpdateAsync(Guid id, UpdateEnvironmentRequest request, CancellationToken ct = default)
    {
        var environment = await _db.Environments.FirstOrDefaultAsync(e => e.Id == id, ct);
        if (environment is null) return Result<EnvironmentSummary>.Failure(Error.NotFound("The environment"));

        if (request.BaseUrl is not null)
        {
            if (!Uri.TryCreate(request.BaseUrl, UriKind.Absolute, out _))
                return Result<EnvironmentSummary>.Failure(Error.Validation("The base URL must be absolute."));
            environment.BaseUrl = request.BaseUrl.TrimEnd('/');
        }

        if (request.Name is not null) environment.Name = request.Name.Trim();
        if (request.ApiBaseUrl is not null) environment.ApiBaseUrl = request.ApiBaseUrl.TrimEnd('/');
        if (request.AllowedDomains is not null) environment.AllowedDomains = request.AllowedDomains;
        if (request.RateLimitPerMinute is not null) environment.RateLimitPerMinute = Math.Max(0, request.RateLimitPerMinute.Value);
        if (request.IsEnabled is not null) environment.IsEnabled = request.IsEnabled.Value;

        if (request.Kind is not null)
        {
            environment.Kind = request.Kind.Value;
            var becomesProduction = request.Kind.Value == EnvironmentKind.Production;
            // Changing an environment into production withdraws any authorization and any
            // destructive permission it held. Re-authorizing is a separate, recorded act.
            if (becomesProduction && !environment.IsProduction)
            {
                environment.ProductionTestingAuthorized = false;
                environment.ProductionAuthorizationNote = null;
                environment.ProductionAuthorizedByUserId = null;
                environment.ProductionAuthorizedAt = null;
                environment.AllowDestructiveTests = false;
            }
            environment.IsProduction = becomesProduction;
        }

        if (request.AllowDestructiveTests is not null)
        {
            if (request.AllowDestructiveTests.Value && environment.IsProduction)
                return Result<EnvironmentSummary>.Failure(Error.SecurityPolicy("Destructive tests cannot be enabled on a production environment."));
            environment.AllowDestructiveTests = request.AllowDestructiveTests.Value;
        }

        environment.UpdatedAt = _clock.UtcNow;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ProjectUpdated, nameof(Domain.Projects.Environment), environment.Id,
            $"Environment '{environment.Name}' updated.", projectId: environment.ProjectId, ct: ct);

        return await GetAsync(id, ct);
    }

    public async Task<Result<EnvironmentSummary>> AuthorizeProductionAsync(
        Guid id, AuthorizeProductionRequest request, CancellationToken ct = default)
    {
        var environment = await _db.Environments.FirstOrDefaultAsync(e => e.Id == id, ct);
        if (environment is null) return Result<EnvironmentSummary>.Failure(Error.NotFound("The environment"));

        if (!environment.IsProduction)
            return Result<EnvironmentSummary>.Failure(Error.Validation("This environment is not marked production, so there is nothing to authorize."));

        var note = (request.Note ?? string.Empty).Trim();
        // A reason is mandatory when granting. An authorization nobody can account for later
        // is indistinguishable from an accident.
        if (request.Authorized && note.Length < 10)
            return Result<EnvironmentSummary>.Failure(Error.Validation("Authorizing production testing requires a note of at least 10 characters saying why."));

        environment.ProductionTestingAuthorized = request.Authorized;
        environment.ProductionAuthorizationNote = request.Authorized ? note : null;
        environment.ProductionAuthorizedByUserId = request.Authorized ? _user.UserId : null;
        environment.ProductionAuthorizedAt = request.Authorized ? _clock.UtcNow : null;
        environment.UpdatedAt = _clock.UtcNow;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ProjectUpdated, nameof(Domain.Projects.Environment), environment.Id,
            request.Authorized
                ? $"Production testing AUTHORIZED on '{environment.Name}': {note}"
                : $"Production testing authorization WITHDRAWN on '{environment.Name}'.",
            projectId: environment.ProjectId, ct: ct);

        _logger.LogWarning("Production testing {State} on environment {EnvironmentId} by user {UserId}",
            request.Authorized ? "authorized" : "withdrawn", environment.Id, _user.UserId);

        return await GetAsync(id, ct);
    }

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var environment = await _db.Environments.FirstOrDefaultAsync(e => e.Id == id, ct);
        if (environment is null) return Result.Failure(Error.NotFound("The environment"));

        _db.Environments.Remove(environment);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ProjectUpdated, nameof(Domain.Projects.Environment), id,
            $"Environment '{environment.Name}' deleted.", projectId: environment.ProjectId, ct: ct);
        return Result.Success();
    }

    public async Task<Result<EnvironmentSummary>> EnsureTestableAsync(Guid id, CancellationToken ct = default)
    {
        var result = await GetAsync(id, ct);
        if (!result.IsSuccess) return result;
        var environment = result.Value!;

        if (!environment.IsEnabled)
            return Result<EnvironmentSummary>.Failure(Error.SecurityPolicy($"Environment '{environment.Key}' is disabled."));

        if (environment.IsProduction && !environment.ProductionTestingAuthorized)
        {
            return Result<EnvironmentSummary>.Failure(Error.SecurityPolicy(
                $"Environment '{environment.Key}' is production and testing it has not been authorized. "
                + "Authorize it explicitly with POST /api/v1/environments/{id}/authorize-production, "
                + "with a note saying why."));
        }

        return Result<EnvironmentSummary>.Success(environment);
    }

    private static System.Linq.Expressions.Expression<Func<Domain.Projects.Environment, EnvironmentSummary>> Project() =>
        e => new EnvironmentSummary(
            e.Id, e.ProjectId, e.Name, e.Key, e.Kind, e.BaseUrl, e.ApiBaseUrl,
            e.IsProduction, e.ProductionTestingAuthorized, e.ProductionAuthorizationNote,
            e.ProductionAuthorizedAt, e.AllowedDomains, e.RateLimitPerMinute,
            e.AllowDestructiveTests, e.IsEnabled, e.CreatedAt);
}
