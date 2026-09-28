using QaNxt.Application.Abstractions;
using QaNxt.Application.Quality;
using QaNxt.Domain.Common;
using QaNxt.Domain.Security;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Application.Security;

public sealed record SecurityImpactRequest(
    Guid ProjectId,
    Guid ApplicationId,
    /// <summary>Repository-relative paths, as <c>git diff --name-only</c> reports them.</summary>
    IReadOnlyList<string> ChangedPaths,
    string? CommitSha = null,
    string? Branch = null);

public sealed record SecurityImpactResult(
    Guid ApplicationId,
    ChangeImpactResult Impact,
    SecurityAttackSurface Surface,
    SecuritySelectionResult Selection,
    /// <summary>Repeated here so a caller acting on this does not have to fetch the surface
    /// separately to find out what the result does not cover.</summary>
    IReadOnlyList<string> Caveats);

public interface ISecurityImpactService
{
    Task<Result<SecurityImpactResult>> AnalyseAsync(
        SecurityImpactRequest request, CancellationToken ct = default);
}

/// <summary>
/// Which security checks a change calls for.
/// </summary>
/// <remarks>
/// Three things come together here, and each is tested on its own: the existing change-impact
/// analysis says which routes and API paths a diff reaches, the attack surface says which
/// checks each discovered thing implies, and the selector intersects them — while keeping any
/// check that covers a currently open finding, whatever the change touched.
///
/// The caveats travel with the result. A caller deciding to run six checks instead of
/// thirty-two needs the sentence about discovery in the same payload, not a link to it.
/// </remarks>
public sealed class SecurityImpactService : ISecurityImpactService
{
    private readonly IQaNxtDbContext _db;
    private readonly IRegressionSelectionService _regression;
    private readonly ISecuritySurfaceService _surface;

    public SecurityImpactService(
        IQaNxtDbContext db, IRegressionSelectionService regression, ISecuritySurfaceService surface)
    {
        _db = db;
        _regression = regression;
        _surface = surface;
    }

    public async Task<Result<SecurityImpactResult>> AnalyseAsync(
        SecurityImpactRequest request, CancellationToken ct = default)
    {
        var surface = await _surface.ForApplicationAsync(request.ApplicationId, ct);
        if (!surface.IsSuccess) return Result<SecurityImpactResult>.Failure(surface.Error!);

        var impact = await _regression.AnalyseImpactAsync(
            new ChangeImpactRequest(request.ProjectId, request.ApplicationId, request.ChangedPaths,
                                    request.CommitSha, request.Branch), ct);
        if (!impact.IsSuccess) return Result<SecurityImpactResult>.Failure(impact.Error!);

        var open = await _db.SecurityFindings.AsNoTracking()
            .Where(f => f.ApplicationId == request.ApplicationId)
            .Select(f => new { f.Category, f.TestId, f.Status })
            .ToListAsync(ct);

        var selection = SecurityImpactSelector.Select(
            surface.Value!,
            impact.Value!.AffectedRoutes,
            impact.Value.AffectedApiPaths,
            impact.Value.AffectsEverything,
            open.Select(f => new SecurityImpactSelector.OpenFinding(f.Category, f.TestId, f.Status)).ToList());

        return Result<SecurityImpactResult>.Success(new SecurityImpactResult(
            request.ApplicationId, impact.Value, surface.Value!, selection, surface.Value!.Caveats));
    }
}
