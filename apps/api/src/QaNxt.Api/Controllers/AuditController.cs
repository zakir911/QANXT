using QaNxt.Api.Authorization;
using QaNxt.Application.Audit;
using QaNxt.Application.Security;
using QaNxt.Domain.Enums;
using Microsoft.AspNetCore.Mvc;

namespace QaNxt.Api.Controllers;

/// <summary>Reading the audit trail.
///
/// Every route here requires <c>audit:read</c>, which project administrators and above hold
/// and nobody below does. The trail names people and what they did, so it is not ordinary
/// read access: a viewer can see every test result in the organization and none of this.
///
/// Read-only, and deliberately so. There is no POST, PATCH or DELETE, and the application's
/// database role is granted INSERT and SELECT on the table — so even a defect here cannot
/// rewrite the record.</summary>
[Route("api/v1/audit")]
[RequirePermission(Permissions.AuditRead)]
public sealed class AuditController : ApiControllerBase
{
    private readonly IAuditQueryService _audit;
    public AuditController(IAuditQueryService audit) => _audit = audit;

    /// <summary>Audit records for the caller's organization, newest first.</summary>
    /// <remarks>
    /// Tenant scoping is the context's global query filter, not a parameter: there is no way
    /// to ask this endpoint for another organization's records, because organization is not
    /// something the caller can say.
    /// </remarks>
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] AuditAction? action,
        [FromQuery] string? entityType,
        [FromQuery] Guid? entityId,
        [FromQuery] string? correlationId,
        [FromQuery] string? userEmail,
        [FromQuery] Guid? projectId,
        [FromQuery] bool? succeeded,
        [FromQuery] DateTimeOffset? from,
        [FromQuery] DateTimeOffset? to,
        [FromQuery] int limit = 50,
        [FromQuery] int offset = 0,
        CancellationToken ct = default)
        => Ok(await _audit.QueryAsync(
            new AuditQuery(action, entityType, entityId, correlationId, userEmail,
                projectId, succeeded, from, to, limit, offset), ct));

    /// <summary>Everything one request did, by correlation id.</summary>
    /// <remarks>
    /// The same thing the list endpoint does with <c>?correlationId=</c>, given its own route
    /// because it is the query somebody runs while looking at a log line or a failed run, and
    /// a path is easier to hand to a colleague than a query string.
    /// </remarks>
    [HttpGet("correlation/{correlationId}")]
    public async Task<IActionResult> ByCorrelation(string correlationId,
        [FromQuery] int limit = 200, CancellationToken ct = default)
        => Ok(await _audit.QueryAsync(
            new AuditQuery(CorrelationId: correlationId, Limit: limit), ct));

    /// <summary>The audit actions this build can record, so a caller filtering by one need
    /// not guess at the spelling or discover a name only by never matching it.</summary>
    [HttpGet("actions")]
    public IActionResult Actions()
        => Ok(Enum.GetValues<AuditAction>()
            .Select(value => new { name = value.ToString(), value = (int)value })
            .OrderBy(entry => entry.value));
}
