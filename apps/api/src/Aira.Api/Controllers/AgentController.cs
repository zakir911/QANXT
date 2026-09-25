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
    private readonly IAgentPlanService _plans;
    private readonly IApplicationContextService _context;
    private readonly IAgentObservabilityService _observability;

    public AgentController(
        IAgentService agent, IAgentPlanService plans, IApplicationContextService context,
        IAgentObservabilityService observability)
    {
        _agent = agent;
        _plans = plans;
        _context = context;
        _observability = observability;
    }

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

    // ---- The plan ----------------------------------------------------------

    /// <summary>What a pass proposes to test, with the reasoning behind each category.</summary>
    [HttpGet("runs/{id:guid}/plan")]
    public async Task<IActionResult> GetPlan(Guid id, CancellationToken ct)
        => FromResult(await _plans.GetAsync(id, ct));

    /// <summary>
    /// Approve, change or reject a plan.
    /// </summary>
    /// <remarks>
    /// Needs <c>execution:run</c> rather than <c>agent:run</c>: this is the moment the work
    /// described actually starts against a live environment, and starting a run is the
    /// permission that governs that everywhere else in the product.
    /// </remarks>
    [HttpPost("runs/{id:guid}/plan/decision")]
    [RequirePermission(Permissions.ExecutionRun)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> DecidePlan(
        Guid id, [FromBody] PlanDecisionRequest request, CancellationToken ct)
        => FromResult(await _plans.DecideAsync(id, request, ct));

    // ---- Business context --------------------------------------------------

    /// <summary>What a person has said about this application's priorities and exclusions.</summary>
    [HttpGet("applications/{applicationId:guid}/context")]
    public async Task<IActionResult> GetContext(Guid applicationId, CancellationToken ct)
        => FromResult(await _context.GetAsync(applicationId, ct));

    [HttpPut("applications/{applicationId:guid}/context")]
    [RequirePermission(Permissions.ApplicationWrite)]
    public async Task<IActionResult> SetContext(
        Guid applicationId, [FromBody] ApplicationContextRequest request, CancellationToken ct)
        => FromResult(await _context.SetAsync(applicationId, request, ct));

    // ---- Reading back what it did ------------------------------------------

    /// <summary>Every decision the pass made, in order, with the evidence behind each.</summary>
    [HttpGet("runs/{id:guid}/decisions")]
    public async Task<IActionResult> Decisions(Guid id, CancellationToken ct)
        => FromResult(await _observability.DecisionsAsync(id, ct));

    /// <summary>Questions the pass stopped to ask, answered or not.</summary>
    [HttpGet("runs/{id:guid}/approvals")]
    public async Task<IActionResult> Approvals(Guid id, CancellationToken ct)
        => FromResult(await _observability.ApprovalsAsync(id, ct));

    /// <summary>
    /// Answer one of those questions.
    /// </summary>
    /// <remarks>
    /// Needs <c>execution:run</c> for the same reason approving a plan does: granting one is
    /// what lets the pass perform the action it stopped for.
    /// </remarks>
    [HttpPost("approvals/{approvalId:guid}/decision")]
    [RequirePermission(Permissions.ExecutionRun)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> DecideApproval(
        Guid approvalId, [FromBody] AgentApprovalDecisionRequest request, CancellationToken ct)
        => FromResult(await _observability.DecideApprovalAsync(approvalId, request, ct));

    /// <summary>The pass as a sequence of moments, assembled from what was recorded.</summary>
    [HttpGet("runs/{id:guid}/timeline")]
    public async Task<IActionResult> Timeline(Guid id, CancellationToken ct)
        => FromResult(await _observability.TimelineAsync(id, ct));
}
