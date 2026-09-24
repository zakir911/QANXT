using Aira.Application.Abstractions;
using Aira.Domain.Common;
using Microsoft.EntityFrameworkCore;

namespace Aira.Application.Security;

public interface ISecuritySurfaceService
{
    Task<Result<SecurityAttackSurface>> ForApplicationAsync(
        Guid applicationId, CancellationToken ct = default);
}

/// <summary>Reads the knowledge graph and hands it to the attack surface derivation.
///
/// Everything interesting is in <see cref="SecurityAttackSurfaceBuilder"/>, which is pure and
/// unit tested. This is the part that talks to the database, and it is deliberately thin so
/// the rules stay arguable in a test rather than inferred from a query.</summary>
public sealed class SecuritySurfaceService : ISecuritySurfaceService
{
    private readonly IAiraDbContext _db;
    public SecuritySurfaceService(IAiraDbContext db) => _db = db;

    public async Task<Result<SecurityAttackSurface>> ForApplicationAsync(
        Guid applicationId, CancellationToken ct = default)
    {
        var application = await _db.Applications.AsNoTracking()
            .FirstOrDefaultAsync(a => a.Id == applicationId, ct);
        if (application is null)
            return Result<SecurityAttackSurface>.Failure(Error.NotFound("The application"));

        var pages = await _db.ApplicationPages.AsNoTracking()
            .Where(p => p.ApplicationId == applicationId)
            .Select(p => new
            {
                p.Id, p.Route, p.NormalizedUrl, p.Kind, p.RequiresAuthentication, p.LastSeenAt
            })
            .ToListAsync(ct);

        var pageIds = pages.Select(p => p.Id).ToList();
        var elements = await _db.ApplicationElements.AsNoTracking()
            .Where(e => pageIds.Contains(e.ApplicationPageId))
            .Select(e => new { e.ApplicationPageId, e.Kind, e.Name, e.Type, e.Label })
            .ToListAsync(ct);

        var elementsByPage = elements
            .GroupBy(e => e.ApplicationPageId)
            .ToDictionary(
                group => group.Key,
                group => (IReadOnlyList<SecurityAttackSurfaceBuilder.ElementInput>)group
                    .Select(e => new SecurityAttackSurfaceBuilder.ElementInput(e.Kind, e.Name, e.Type, e.Label))
                    .ToList());

        var endpoints = await _db.ApiEndpoints.AsNoTracking()
            .Where(e => e.ApplicationId == applicationId)
            .Select(e => new SecurityAttackSurfaceBuilder.EndpointInput(
                e.Id, e.Method, e.UrlTemplate, e.SampleUrl, e.RequiresAuthentication,
                e.RequestContentType, e.RequestSampleJson, e.LastSeenAt))
            .ToListAsync(ct);

        var pageInputs = pages.Select(p => new SecurityAttackSurfaceBuilder.PageInput(
            p.Id, p.Route, p.NormalizedUrl, p.Kind, p.RequiresAuthentication, p.LastSeenAt,
            elementsByPage.TryGetValue(p.Id, out var found)
                ? found
                : Array.Empty<SecurityAttackSurfaceBuilder.ElementInput>())).ToList();

        return Result<SecurityAttackSurface>.Success(
            SecurityAttackSurfaceBuilder.Build(applicationId, pageInputs, endpoints));
    }
}
