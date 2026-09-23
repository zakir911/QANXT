using Aira.Api.Authorization;
using Aira.Application.Security;
using Aira.Infrastructure.Ai;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

/// <summary>Arms a simulated model-provider failure, so the platform's behaviour when the
/// AI fails can be observed rather than argued about.
///
/// Returns 404 unless <c>Ai:FaultInjection:Enabled</c> is true, which it is not in any
/// shipped configuration. The switch itself also refuses to arm when the feature is off, so
/// this endpoint being reachable is not the only thing standing between a deployment and an
/// injected fault.
///
/// It needs <c>organization:write</c> — the highest-privilege thing a caller can hold short
/// of platform operation — because arming a fault changes what every AI feature in the
/// process does for everybody in it.</summary>
[Route("api/v1/ai-faults")]
[RequirePermission(Permissions.OrganizationWrite)]
public sealed class AiFaultsController : ApiControllerBase
{
    private readonly IAiFaultSwitch _faults;
    public AiFaultsController(IAiFaultSwitch faults) => _faults = faults;

    public sealed record ArmFaultRequest(AiFaultKind? Fault);

    [HttpGet]
    public IActionResult Get()
    {
        if (!_faults.Enabled) return NotFound();
        return Ok(new
        {
            enabled = true,
            current = _faults.Current?.ToString(),
            available = Enum.GetNames<AiFaultKind>()
        });
    }

    /// <summary>Arms a fault, or clears it with a null one.</summary>
    [HttpPost]
    public IActionResult Arm([FromBody] ArmFaultRequest request)
    {
        if (!_faults.Enabled) return NotFound();
        _faults.Set(request.Fault);
        return Ok(new { current = _faults.Current?.ToString() });
    }

    [HttpDelete]
    public IActionResult Clear()
    {
        if (!_faults.Enabled) return NotFound();
        _faults.Set(null);
        return NoContent();
    }
}
