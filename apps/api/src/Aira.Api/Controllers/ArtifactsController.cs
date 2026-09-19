using Aira.Api.Authorization;
using Aira.Application.Abstractions;
using Aira.Application.Security;
using Aira.Domain.Common;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Aira.Api.Controllers;

/// <summary>Serves evidence files.
///
/// Artifacts are fetched through the API rather than from a public bucket URL, so every
/// download is authorized against the tenant that owns it. A signed URL is used instead
/// when the backing store offers one — it is the same authorization decision, made once.</summary>
[RequirePermission(Permissions.ArtifactRead)]
public sealed class ArtifactsController : ApiControllerBase
{
    private readonly IAiraDbContext _db;
    private readonly IArtifactStore _store;
    private readonly ILogger<ArtifactsController> _logger;

    public ArtifactsController(IAiraDbContext db, IArtifactStore store, ILogger<ArtifactsController> logger)
    {
        _db = db;
        _store = store;
        _logger = logger;
    }

    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] Guid? executionId, [FromQuery] Guid? discoveryRunId, CancellationToken ct)
    {
        var query = _db.Artifacts.AsQueryable();
        if (executionId is not null) query = query.Where(a => a.TestExecutionId == executionId);
        if (discoveryRunId is not null) query = query.Where(a => a.DiscoveryRunId == discoveryRunId);
        if (executionId is null && discoveryRunId is null)
            return Problem(Error.Validation("Supply either an executionId or a discoveryRunId."));

        return Ok(await query
            .OrderBy(a => a.Kind).ThenBy(a => a.Name)
            .Select(a => new
            {
                a.Id, kind = a.Kind, a.Name, a.ContentType, a.SizeBytes, a.IsMasked,
                a.CreatedAt, a.TestActionId
            })
            .ToListAsync(ct));
    }

    /// <summary>Streams one artifact. The tenant filter on the metadata row is what makes
    /// this safe: an artifact belonging to another organization is simply not found.</summary>
    [HttpGet("{id:guid}/content")]
    public async Task<IActionResult> GetContent(Guid id, CancellationToken ct)
    {
        var artifact = await _db.Artifacts.FirstOrDefaultAsync(a => a.Id == id, ct);
        if (artifact is null) return Problem(Error.NotFound("The artifact"));

        var signed = await _store.TryGetSignedUrlAsync(artifact.StorageKey, TimeSpan.FromMinutes(10), ct);
        if (signed is not null) return Redirect(signed);

        var stream = await _store.GetAsync(artifact.StorageKey, ct);
        if (stream is null)
        {
            _logger.LogWarning("Artifact {ArtifactId} is recorded but missing from the store ({Key})", id, artifact.StorageKey);
            return Problem(Error.NotFound("The artifact's content"));
        }

        // Inline for images so the console can render evidence without a download step.
        var disposition = artifact.ContentType.StartsWith("image/", StringComparison.Ordinal) ? "inline" : "attachment";
        Response.Headers.ContentDisposition = $"{disposition}; filename=\"{Sanitize(artifact.Name)}\"";
        return File(stream, artifact.ContentType);
    }

    private static string Sanitize(string name)
        => new(name.Where(c => char.IsLetterOrDigit(c) || c is '.' or '-' or '_').Take(120).ToArray());
}
