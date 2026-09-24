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

    public SecurityController(ISecurityScanService security, ISecurityTrendService trend)
    {
        _security = security;
        _trend = trend;
    }

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
