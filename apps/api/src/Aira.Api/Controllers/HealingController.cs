using Aira.Api.Authorization;
using Aira.Application.Diagnosis;
using Aira.Application.Security;
using Aira.Domain.Enums;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

/// <summary>Reviewing and deciding on locator healing proposals.</summary>
[RequirePermission(Permissions.HealingRead)]
public sealed class HealingController : ApiControllerBase
{
    private readonly IHealingService _healing;
    public HealingController(IHealingService healing) => _healing = healing;

    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] Guid? projectId, [FromQuery] HealingOutcome? outcome,
        [FromQuery] int limit = 50, CancellationToken ct = default)
        => Ok(await _healing.ListAsync(projectId, outcome, limit, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => FromResult(await _healing.GetAsync(id, ct));

    public sealed record ReviewBody(string? Comment);

    /// <summary>Applies the proposed locator to the stored test. This is the only path by
    /// which healing changes a test definition, and it is attributable and reversible.</summary>
    [HttpPost("{id:guid}/approve")]
    [RequirePermission(Permissions.HealingApprove)]
    public async Task<IActionResult> Approve(Guid id, [FromBody] ReviewBody? body, CancellationToken ct)
        => FromResult(await _healing.ApproveAsync(id, body?.Comment, ct));

    [HttpPost("{id:guid}/reject")]
    [RequirePermission(Permissions.HealingApprove)]
    public async Task<IActionResult> Reject(Guid id, [FromBody] ReviewBody? body, CancellationToken ct)
        => FromResult(await _healing.RejectAsync(id, body?.Comment, ct));

    /// <summary>Restores the original locator exactly as it was before approval.</summary>
    [HttpPost("{id:guid}/revert")]
    [RequirePermission(Permissions.HealingApprove)]
    public async Task<IActionResult> Revert(Guid id, [FromBody] ReviewBody? body, CancellationToken ct)
        => FromResult(await _healing.RevertAsync(id, body?.Comment, ct));
}
