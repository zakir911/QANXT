using Aira.Api.Authorization;
using Aira.Application.Discovery;
using Aira.Application.Security;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

/// <summary>Starting and observing application discovery.</summary>
[RequirePermission(Permissions.ApplicationRead)]
public sealed class DiscoveryController : ApiControllerBase
{
    private readonly IDiscoveryService _discovery;
    public DiscoveryController(IDiscoveryService discovery) => _discovery = discovery;

    /// <summary>Queues a bounded crawl of an application. The budget is frozen onto the
    /// run, so later configuration changes cannot make a past run unexplainable.</summary>
    [HttpPost("runs")]
    [RequirePermission(Permissions.DiscoveryRun)]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> Start([FromBody] StartDiscoveryRequest request, CancellationToken ct)
    {
        var result = await _discovery.StartAsync(request, ct);
        return FromResult(result, summary => AcceptedAtAction(nameof(GetRun), new { id = summary.Id }, summary));
    }

    [HttpGet("runs")]
    public async Task<IActionResult> ListRuns([FromQuery] Guid? applicationId, [FromQuery] int limit = 25, CancellationToken ct = default)
        => Ok(await _discovery.ListAsync(applicationId, limit, ct));

    [HttpGet("runs/{id:guid}")]
    public async Task<IActionResult> GetRun(Guid id, CancellationToken ct)
        => FromResult(await _discovery.GetAsync(id, ct));
}
