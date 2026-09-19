using Aira.Api.Authorization;
using Aira.Application.Abstractions;
using Aira.Application.Security;
using Aira.Domain.Enums;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Aira.Api.Controllers;

/// <summary>Queries over the application knowledge graph: the pages, elements, API calls
/// and transitions discovery has learned. This is the model the AI plans against and the
/// console renders, so it is exposed as a first-class read surface.</summary>
[Route("api/v1/applications/{applicationId:guid}")]
[RequirePermission(Permissions.ApplicationRead)]
public sealed class KnowledgeGraphController : ApiControllerBase
{
    private readonly IAiraDbContext _db;
    public KnowledgeGraphController(IAiraDbContext db) => _db = db;

    /// <summary>The page graph, with edge counts, ready to render as a map.</summary>
    [HttpGet("graph")]
    public async Task<IActionResult> GetGraph(Guid applicationId, CancellationToken ct)
    {
        if (!await _db.Applications.AnyAsync(a => a.Id == applicationId, ct))
            return Problem(Aira.Domain.Common.Error.NotFound("The application"));

        var pages = await _db.ApplicationPages
            .Where(p => p.ApplicationId == applicationId)
            .OrderBy(p => p.Depth).ThenBy(p => p.Route)
            .Select(p => new
            {
                id = p.Id,
                p.Route,
                p.Title,
                p.NormalizedUrl,
                kind = p.Kind,
                p.Depth,
                p.RequiresAuthentication,
                p.ElementCount,
                p.HttpStatus,
                p.LoadTimeMs,
                p.ConsoleErrorCount,
                parentPageId = p.ParentPageId,
                hasScreenshot = p.ScreenshotArtifactKey != null,
                p.LastSeenAt
            })
            .ToListAsync(ct);

        var transitions = await _db.PageTransitions
            .Where(t => t.ApplicationId == applicationId)
            .Select(t => new { from = t.FromPageId, to = t.ToPageId, action = t.Action, t.TimesObserved })
            .ToListAsync(ct);

        var endpoints = await _db.ApiEndpoints
            .Where(e => e.ApplicationId == applicationId)
            .OrderByDescending(e => e.TimesObserved)
            .Select(e => new
            {
                id = e.Id, e.Method, e.UrlTemplate, e.TimesObserved, e.LastStatusCode,
                e.AverageDurationMs, e.RequiresAuthentication, triggeredByPageId = e.TriggeredByPageId
            })
            .ToListAsync(ct);

        return Ok(new { pages, transitions, apiEndpoints = endpoints });
    }

    /// <summary>Pages, with optional filtering by kind. Elements are not included here —
    /// a large application has tens of thousands of them.</summary>
    [HttpGet("pages")]
    public async Task<IActionResult> GetPages(Guid applicationId, [FromQuery] PageKind? kind, CancellationToken ct)
    {
        var query = _db.ApplicationPages.Where(p => p.ApplicationId == applicationId);
        if (kind is not null) query = query.Where(p => p.Kind == kind);

        return Ok(await query
            .OrderBy(p => p.Depth).ThenBy(p => p.Route)
            .Select(p => new
            {
                id = p.Id, p.Url, p.Route, p.Title, kind = p.Kind, p.Depth,
                p.RequiresAuthentication, p.ElementCount, p.HttpStatus, p.LoadTimeMs,
                p.ConsoleErrorCount, p.VisibleTextExcerpt, p.LastSeenAt,
                hasScreenshot = p.ScreenshotArtifactKey != null
            })
            .ToListAsync(ct));
    }

    /// <summary>Every element captured on one page, with the signals the locator engine scores against.</summary>
    [HttpGet("pages/{pageId:guid}/elements")]
    public async Task<IActionResult> GetElements(Guid applicationId, Guid pageId, CancellationToken ct)
    {
        var page = await _db.ApplicationPages
            .FirstOrDefaultAsync(p => p.Id == pageId && p.ApplicationId == applicationId, ct);
        if (page is null) return Problem(Aira.Domain.Common.Error.NotFound("The page"));

        var elements = await _db.ApplicationElements
            .Where(e => e.ApplicationPageId == pageId)
            .OrderByDescending(e => e.StabilityScore)
            .Select(e => new
            {
                id = e.Id, kind = e.Kind, e.TagName, e.AriaRole, e.AccessibleName, e.Text,
                e.Label, e.Placeholder, e.TestId, e.ElementId, e.Name, e.Type,
                e.IsVisible, e.IsEnabled, e.IsRequired, e.StabilityScore,
                preferredLocator = e.PreferredLocatorJson,
                bounding = new { x = e.BoundingX, y = e.BoundingY, width = e.BoundingWidth, height = e.BoundingHeight },
                e.LastSeenAt
            })
            .ToListAsync(ct);

        return Ok(new { page = new { page.Id, page.Route, page.Title, page.Url }, elements });
    }

    /// <summary>The API surface observed while driving the UI — the seed for API testing.</summary>
    [HttpGet("api-endpoints")]
    public async Task<IActionResult> GetApiEndpoints(Guid applicationId, CancellationToken ct)
        => Ok(await _db.ApiEndpoints
            .Where(e => e.ApplicationId == applicationId)
            .OrderByDescending(e => e.TimesObserved)
            .Select(e => new
            {
                id = e.Id, e.Method, e.UrlTemplate, e.SampleUrl, e.TimesObserved, e.LastStatusCode,
                e.AverageDurationMs, e.RequiresAuthentication, e.RequestContentType, e.ResponseContentType,
                e.RequestSampleJson, e.ResponseSampleJson, e.LastSeenAt
            })
            .ToListAsync(ct));
}
