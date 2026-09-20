using Aira.Api.Authorization;
using Aira.Application.Agent;
using Aira.Application.Security;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

/// <summary>The autonomous agent.
///
/// Starting a pass needs its own permission, separate from running tests, because an agent
/// explores an application on its own and spends a model budget doing it. Reading what a
/// pass concluded needs only the ordinary read permission: its findings are proposals, and
/// proposals are for people to look at.</summary>
[Route("api/v1/agent")]
[RequirePermission(Permissions.TestRead)]
public sealed class AgentController : ApiControllerBase
{
    private readonly IAgentService _agent;
    public AgentController(IAgentService agent) => _agent = agent;

    /// <summary>Queues a bounded pass. Returns immediately; the pass runs in the background.</summary>
    [HttpPost("runs")]
    [RequirePermission(Permissions.AgentRun)]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> Start([FromBody] StartAgentRunRequest request, CancellationToken ct)
    {
        var result = await _agent.StartAsync(request, ct);
        return FromResult(result, summary => AcceptedAtAction(nameof(Get), new { id = summary.Id }, summary));
    }

    [HttpGet("runs")]
    public async Task<IActionResult> List(
        [FromQuery] Guid? applicationId, [FromQuery] int limit = 25, CancellationToken ct = default)
        => Ok(await _agent.ListAsync(applicationId, limit, ct));

    /// <summary>One pass with every step it took and every proposal it made.</summary>
    [HttpGet("runs/{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
        => FromResult(await _agent.GetAsync(id, ct));

    [HttpPost("runs/{id:guid}/cancel")]
    [RequirePermission(Permissions.AgentRun)]
    public async Task<IActionResult> Cancel(Guid id, CancellationToken ct)
        => FromResult(await _agent.CancelAsync(id, ct));
}
