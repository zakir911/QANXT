using Aira.Application.Abstractions;
using Aira.Application.Security;
using Aira.Domain.Agent;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Aira.Application.Agent;

public sealed record ApplicationContextRequest(
    string? CriticalJourneys, string? HighRiskAreas, string? ExcludedAreas, string? Notes);

public sealed record ApplicationContextView(
    Guid ApplicationId,
    IReadOnlyList<string> CriticalJourneys,
    IReadOnlyList<string> HighRiskAreas,
    IReadOnlyList<string> ExcludedAreas,
    string Notes,
    DateTimeOffset? UpdatedAt,
    Guid? UpdatedByUserId)
{
    public static ApplicationContextView Empty(Guid applicationId) => new(
        applicationId, Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>(),
        string.Empty, null, null);

    /// <summary>
    /// Whether a route, endpoint or area is one a person said never to touch.
    /// </summary>
    /// <remarks>
    /// Matched on a prefix after trimming and lower-casing, so writing <c>/admin</c> excludes
    /// <c>/admin/users/42/delete</c>. Prefix rather than exact, because an operator naming an
    /// area means the area, and an exclusion that missed a child route would be the worst kind
    /// of near-miss: it would read as protection and not be.
    /// </remarks>
    public bool Excludes(string? target)
    {
        if (string.IsNullOrWhiteSpace(target) || ExcludedAreas.Count == 0) return false;
        var candidate = target.Trim().ToLowerInvariant();
        return ExcludedAreas.Any(area =>
            candidate.StartsWith(area, StringComparison.Ordinal)
            || candidate.Contains(area, StringComparison.Ordinal));
    }

    /// <summary>Whether a person called this area business-critical.</summary>
    public bool IsCritical(string? target)
    {
        if (string.IsNullOrWhiteSpace(target)) return false;
        var candidate = target.Trim().ToLowerInvariant();
        return CriticalJourneys.Any(j => candidate.Contains(j, StringComparison.Ordinal))
            || HighRiskAreas.Any(a => candidate.Contains(a, StringComparison.Ordinal));
    }
}

public interface IApplicationContextService
{
    Task<Result<ApplicationContextView>> GetAsync(Guid applicationId, CancellationToken ct = default);
    Task<Result<ApplicationContextView>> SetAsync(
        Guid applicationId, ApplicationContextRequest request, CancellationToken ct = default);
}

/// <summary>
/// The operator's standing input into how an application is tested.
/// </summary>
/// <remarks>
/// <para>
/// Reading is open to anyone who can read the application; writing needs
/// <c>application:write</c>, because what is written here changes what an unattended agent
/// prioritises and, through the exclusions, what it refuses to touch at all.
/// </para>
/// <para>
/// Nothing here is interpreted by a model. The lists are split on lines, trimmed, lower-cased
/// and matched literally. An operator's instruction that has to be understood before it can be
/// obeyed is an instruction that can be misunderstood.
/// </para>
/// </remarks>
public sealed class ApplicationContextService : IApplicationContextService
{
    private const int MaxEntries = 100;
    private const int MaxEntryLength = 200;

    private readonly IAiraDbContext _db;
    private readonly ICurrentUser _user;
    private readonly IAuditLogger _audit;
    private readonly SecretMasker _masker;

    public ApplicationContextService(
        IAiraDbContext db, ICurrentUser user, IAuditLogger audit, SecretMasker masker)
    {
        _db = db;
        _user = user;
        _audit = audit;
        _masker = masker;
    }

    public async Task<Result<ApplicationContextView>> GetAsync(
        Guid applicationId, CancellationToken ct = default)
    {
        var application = await _db.Applications
            .FirstOrDefaultAsync(a => a.Id == applicationId, ct);
        if (application is null)
            return Result<ApplicationContextView>.Failure(Error.NotFound("The application"));

        var context = await _db.ApplicationContexts
            .FirstOrDefaultAsync(c => c.ApplicationId == applicationId, ct);

        // An application nobody has described is not an error, and not a reason to make
        // something up. It is an application with no context, and the planner treats the
        // absence as the absence rather than as "nothing is critical".
        return Result<ApplicationContextView>.Success(
            context is null ? ApplicationContextView.Empty(applicationId) : Project(context));
    }

    public async Task<Result<ApplicationContextView>> SetAsync(
        Guid applicationId, ApplicationContextRequest request, CancellationToken ct = default)
    {
        if (!_user.HasPermission(Permissions.ApplicationWrite))
            return Result<ApplicationContextView>.Failure(Error.Forbidden(
                "Setting business context needs 'application:write'. What is written here decides "
                + "what an unattended agent prioritises, and what it will not touch at all."));

        var application = await _db.Applications
            .FirstOrDefaultAsync(a => a.Id == applicationId, ct);
        if (application is null)
            return Result<ApplicationContextView>.Failure(Error.NotFound("The application"));

        var context = await _db.ApplicationContexts
            .FirstOrDefaultAsync(c => c.ApplicationId == applicationId, ct);

        if (context is null)
        {
            context = new ApplicationContext
            {
                OrganizationId = application.OrganizationId,
                ProjectId = application.ProjectId,
                ApplicationId = applicationId,
                CreatedByUserId = _user.UserId
            };
            _db.ApplicationContexts.Add(context);
        }

        context.CriticalJourneys = Normalise(request.CriticalJourneys);
        context.HighRiskAreas = Normalise(request.HighRiskAreas);
        context.ExcludedAreas = Normalise(request.ExcludedAreas);
        // Masked because an operator explaining why an area is sensitive is exactly the person
        // most likely to paste a credential into the explanation.
        context.Notes = _masker.MaskText(request.Notes ?? string.Empty);
        context.UpdatedByUserId = _user.UserId;

        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ApplicationUpdated, nameof(ApplicationContext),
            context.Id,
            $"Business context set for {application.Name}: "
            + $"{Split(context.CriticalJourneys).Count} critical journey(s), "
            + $"{Split(context.ExcludedAreas).Count} exclusion(s).",
            organizationId: application.OrganizationId, projectId: application.ProjectId, ct: ct);

        return Result<ApplicationContextView>.Success(Project(context));
    }

    private static ApplicationContextView Project(ApplicationContext c) => new(
        c.ApplicationId,
        Split(c.CriticalJourneys), Split(c.HighRiskAreas), Split(c.ExcludedAreas),
        c.Notes, c.UpdatedAt ?? c.CreatedAt, c.UpdatedByUserId);

    /// <summary>One entry per line, trimmed, lower-cased, de-duplicated, bounded.</summary>
    private static string Normalise(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;
        var entries = raw
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(line => line.Trim().ToLowerInvariant())
            .Where(line => line.Length > 0)
            .Select(line => line.Length > MaxEntryLength ? line[..MaxEntryLength] : line)
            .Distinct(StringComparer.Ordinal)
            .Take(MaxEntries);
        return string.Join('\n', entries);
    }

    private static IReadOnlyList<string> Split(string stored)
        => string.IsNullOrWhiteSpace(stored)
            ? Array.Empty<string>()
            : stored.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}
