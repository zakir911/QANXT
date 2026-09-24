using Aira.Api.Authorization;
using Aira.Application.Security;
using Aira.Domain.Security;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

/// <summary>
/// Security scopes, scans and findings.
/// </summary>
/// <remarks>
/// Every route here needs a security permission, and none of them is in the Viewer set. A
/// security finding is a working description of how to break the application; read-only
/// access to test results is not a reason to hold one.
///
/// Note which permission guards which act. Reading a finding, running a scan, authorizing an
/// application for testing and setting a finding aside are four different decisions with four
/// different people accountable for them, and collapsing them into one "security" permission
/// would mean whoever could read a report could also authorize a scan.
/// </remarks>
[Route("api/v1/security")]
[RequirePermission(Permissions.SecurityRead)]
public sealed class SecurityController : ApiControllerBase
{
    private readonly ISecurityScanService _security;
    private readonly ISecurityTrendService _trend;
    private readonly ISecuritySurfaceService _surface;
    private readonly ISecurityImpactService _impact;

    public SecurityController(
        ISecurityScanService security, ISecurityTrendService trend,
        ISecuritySurfaceService surface, ISecurityImpactService impact)
    {
        _security = security;
        _trend = trend;
        _surface = surface;
        _impact = impact;
    }

    /// <summary>Every security check AIRA knows how to run.</summary>
    /// <remarks>
    /// Served rather than documented because four things have to agree on these strings: the
    /// attack surface that says which apply, the selector that says which to run, the scan
    /// record that says which executed, and the gate that reads coverage from that record. A
    /// check named one way in the selector and another in the scan record produces a gate
    /// reporting full coverage from a scan that ran nothing — a false green arriving through
    /// a typo. The golden suite compares this list against the engine's own.
    /// </remarks>
    [HttpGet("checks")]
    public IActionResult Checks()
        => Ok(new
        {
            checks = SecurityChecks.All,
            requiresBrowser = SecurityChecks.RequiresBrowser
        });

    // ---- Scope -------------------------------------------------------------

    /// <summary>What an application has authorized, if anything.</summary>
    /// <remarks>
    /// 404 when no scope exists, rather than an empty permissive one. "Nobody has authorized
    /// this" and "there is a scope that allows nothing" are different facts, and returning a
    /// default-shaped object invites a caller to treat the first as configuration to tweak.
    /// </remarks>
    [HttpGet("applications/{applicationId:guid}/scope")]
    public async Task<IActionResult> GetScope(Guid applicationId, CancellationToken ct)
        => FromResult(await _security.GetScopeAsync(applicationId, ct));

    /// <summary>Authorize an application for security testing, or withdraw it.</summary>
    [HttpPut("applications/{applicationId:guid}/scope")]
    [RequirePermission(Permissions.SecurityAuthorize)]
    public async Task<IActionResult> AuthorizeScope(
        Guid applicationId, [FromBody] AuthorizeSecurityScopeRequest request, CancellationToken ct)
        => FromResult(await _security.AuthorizeScopeAsync(applicationId, request, ct));

    // ---- Scans -------------------------------------------------------------

    /// <summary>Record what a scan did and what it found.</summary>
    /// <remarks>
    /// Refused when the application has no enabled scope carrying a written authorization,
    /// and refused when any finding arrives with no request/response exchange behind it.
    /// Both refusals are deliberate: if a scan somehow ran against an unauthorized
    /// application, that is a defect worth surfacing rather than a record worth keeping.
    /// </remarks>
    [HttpPost("scans")]
    [RequirePermission(Permissions.SecurityScan)]
    public async Task<IActionResult> RecordScan(
        [FromBody] RecordSecurityScanRequest request, CancellationToken ct)
        => FromResult(await _security.RecordScanAsync(request, ct),
            scan => CreatedAtAction(nameof(GetScan), new { id = scan.Id }, scan));

    [HttpGet("scans")]
    public async Task<IActionResult> ListScans(
        [FromQuery] Guid? applicationId, [FromQuery] int take = 20, CancellationToken ct = default)
        => Ok(await _security.ListScansAsync(applicationId, take, ct));

    /// <summary>One scan, its findings, and the gate decision they produce.</summary>
    [HttpGet("scans/{id:guid}")]
    public async Task<IActionResult> GetScan(Guid id, CancellationToken ct)
        => FromResult(await _security.GetScanAsync(id, ct));

    /// <summary>How an application's security posture has moved across its recorded scans.</summary>
    /// <remarks>
    /// Every point carries the coverage it was measured at, and a point measured at materially
    /// less coverage than the one before it is flagged. A chart that plots severity counts
    /// without the coverage draws a reassuring downward line every time somebody narrows a
    /// scope, which is the most dangerous chart a security tool can produce.
    /// </remarks>
    [HttpGet("applications/{applicationId:guid}/trend")]
    public async Task<IActionResult> Trend(
        Guid applicationId, [FromQuery] int take = 30, CancellationToken ct = default)
        => FromResult(await _trend.ForApplicationAsync(applicationId, take, ct));

    /// <summary>What discovery found that is worth security testing.</summary>
    /// <remarks>
    /// Derived from the knowledge graph: which endpoints take an object identifier, which
    /// change state, which take a file, which carry a parameter that names a destination. Each
    /// item says why it is there and which checks it implies.
    ///
    /// The caveat list is never empty, and its first entry is always that this describes what
    /// discovery walked rather than the application. A reader who takes the item list as
    /// complete will treat everywhere else as safe, and nothing here has looked at anywhere else.
    /// </remarks>
    [HttpGet("applications/{applicationId:guid}/surface")]
    public async Task<IActionResult> Surface(Guid applicationId, CancellationToken ct)
        => FromResult(await _surface.ForApplicationAsync(applicationId, ct));

    /// <summary>Which security checks a change calls for.</summary>
    /// <remarks>
    /// Intersects the change-impact analysis with the discovered attack surface, and keeps any
    /// check covering a currently open finding whatever the change touched — a check that found
    /// something and then stopped running is how a regression hides.
    ///
    /// The full implied set comes back as <c>checksImplied</c> alongside the selection. A scan
    /// that runs six of thirty-two reports six of thirty-two to the gate and comes back REVIEW.
    /// Narrowing changes what runs; it does not change what a clean result may claim.
    /// </remarks>
    [HttpPost("impact")]
    [RequirePermission(Permissions.SecurityScan)]
    public async Task<IActionResult> Impact(
        [FromBody] SecurityImpactRequest request, CancellationToken ct)
        => FromResult(await _impact.AnalyseAsync(request, ct));

    // ---- Findings ----------------------------------------------------------

    [HttpGet("findings")]
    public async Task<IActionResult> ListFindings(
        [FromQuery] Guid? applicationId, [FromQuery] SecurityFindingStatus? status,
        CancellationToken ct = default)
        => Ok(await _security.ListFindingsAsync(applicationId, status, ct));

    /// <summary>Change a finding's status.</summary>
    /// <remarks>
    /// Marking a finding a false positive, accepted or resolved requires a named caller and a
    /// written justification of at least twenty characters. The refusal is the feature: a
    /// suppression with nothing behind it is somebody switching the check off.
    /// </remarks>
    [HttpPost("findings/{id:guid}/triage")]
    [RequirePermission(Permissions.SecurityTriage)]
    public async Task<IActionResult> Triage(
        Guid id, [FromBody] TriageFindingRequest request, CancellationToken ct)
        => FromResult(await _security.TriageAsync(id, request, ct));
}
