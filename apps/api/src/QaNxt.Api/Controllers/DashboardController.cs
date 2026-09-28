using QaNxt.Api.Authorization;
using QaNxt.Application.Ai;
using QaNxt.Application.Dashboard;
using QaNxt.Application.Security;
using QaNxt.Domain.Enums;
using Microsoft.AspNetCore.Mvc;

namespace QaNxt.Api.Controllers;

/// <summary>Quality metrics and trends, computed from stored executions.</summary>
[RequirePermission(Permissions.DashboardRead)]
public sealed class DashboardController : ApiControllerBase
{
    private readonly IDashboardService _dashboard;
    public DashboardController(IDashboardService dashboard) => _dashboard = dashboard;

    /// <summary>The full dashboard view for a project, or for the whole organization.</summary>
    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] Guid? projectId, [FromQuery] int windowDays = 30, CancellationToken ct = default)
        => Ok(await _dashboard.GetAsync(projectId, windowDays, ct));
}

/// <summary>AI-assisted quality intelligence and provider status.</summary>
[Route("api/v1/ai")]
[RequirePermission(Permissions.AiUse)]
public sealed class AiController : ApiControllerBase
{
    private readonly IQualityInsightService _insights;
    private readonly IAiOrchestrator _orchestrator;
    private readonly IAiRequestQueryService _requests;

    public AiController(IQualityInsightService insights, IAiOrchestrator orchestrator,
        IAiRequestQueryService requests)
    {
        _insights = insights;
        _orchestrator = orchestrator;
        _requests = requests;
    }

    /// <summary>Which providers are configured, so the console can say honestly which
    /// engine answered a question rather than implying a model was consulted.</summary>
    [HttpGet("providers")]
    [RequirePermission(Permissions.ProjectRead)]
    public IActionResult GetProviders() => Ok(_orchestrator.DescribeProviders());

    public sealed record AskBody(Guid? ProjectId, string Question, int? WindowDays);

    /// <summary>Answers a question about quality, citing the records it was derived from.</summary>
    [HttpPost("insights")]
    public async Task<IActionResult> Ask([FromBody] AskBody body, CancellationToken ct)
        => FromResult(await _insights.AskAsync(new AskInsightRequest(body.ProjectId, body.Question, body.WindowDays), ct));

    /// <summary>What was asked of a model, what came back, what it cost and what went wrong.
    ///
    /// Every model call has been recorded since the first AI feature shipped, and until this
    /// endpoint nothing read it but the orchestrator's own cache and the budget check — so
    /// the accounting existed and could not be consulted.</summary>
    [HttpGet("requests")]
    public async Task<IActionResult> Requests(
        [FromQuery] Guid? projectId,
        [FromQuery] AiRequestKind? kind,
        [FromQuery] AiRequestStatus? status,
        [FromQuery] LlmProviderKind? provider,
        [FromQuery] string? correlationId,
        [FromQuery] bool? failedOnly,
        [FromQuery] DateTimeOffset? from,
        [FromQuery] DateTimeOffset? to,
        [FromQuery] int limit = 50,
        [FromQuery] int offset = 0,
        CancellationToken ct = default)
        => Ok(await _requests.QueryAsync(
            new AiRequestQuery(projectId, kind, status, provider, correlationId,
                failedOnly, from, to, limit, offset), ct));
}
