using System.Security.Claims;
using Aira.Api.Authorization;
using Aira.Application.Abstractions;
using Aira.Application.Discovery;
using Aira.Application.Testing;
using Aira.Domain.Common;
using Aira.Infrastructure.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Aira.Api.Controllers;

/// <summary>The only surface a browser worker may touch.
///
/// A worker authenticates with a token scoped to one job. Every endpoint here checks that
/// the job in the route is the job in the token, so a worker cannot read another run's
/// plan or write another run's results — which matters, because workers run the least
/// trusted code in the system: they point a browser at whatever a customer asked for.</summary>
[ApiController]
[Route("api/v1/worker")]
[RequireWorkerToken]
public sealed class WorkerController : ApiControllerBase
{
    private readonly IDiscoveryIngestService _discoveryIngest;
    private readonly IExecutionIngestService _executionIngest;
    private readonly IArtifactStore _artifacts;
    private readonly ITenantContext _tenant;
    private readonly ILogger<WorkerController> _logger;

    public WorkerController(IDiscoveryIngestService discoveryIngest, IExecutionIngestService executionIngest,
        IArtifactStore artifacts, ITenantContext tenant, ILogger<WorkerController> logger)
    {
        _discoveryIngest = discoveryIngest;
        _executionIngest = executionIngest;
        _artifacts = artifacts;
        _tenant = tenant;
        _logger = logger;
    }

    /// <summary>Confirms a worker has picked the job up. Also the worker's liveness signal.</summary>
    [HttpPost("discovery/{runId:guid}/started")]
    public async Task<IActionResult> DiscoveryStarted(Guid runId, [FromBody] WorkerStartedBody body, CancellationToken ct)
    {
        if (!Authorize(runId, "discovery", out var failure)) return failure!;
        return FromResult(await _discoveryIngest.MarkRunningAsync(runId, body.WorkerId, ct), () => NoContent());
    }

    /// <summary>Streams crawl progress so the console can show a live picture.</summary>
    [HttpPost("discovery/{runId:guid}/progress")]
    public async Task<IActionResult> DiscoveryProgress(Guid runId, [FromBody] DiscoveryProgressPayload body, CancellationToken ct)
    {
        if (!Authorize(runId, "discovery", out var failure)) return failure!;
        return FromResult(await _discoveryIngest.RecordProgressAsync(runId, body, ct), () => NoContent());
    }

    /// <summary>Delivers the finished crawl. Ingestion is idempotent, so a retried delivery
    /// updates the graph rather than duplicating it.</summary>
    [HttpPost("discovery/{runId:guid}/complete")]
    [RequestSizeLimit(64 * 1024 * 1024)]
    public async Task<IActionResult> DiscoveryComplete(Guid runId, [FromBody] DiscoveryCompletionPayload body, CancellationToken ct)
    {
        if (!Authorize(runId, "discovery", out var failure)) return failure!;
        _logger.LogInformation("Received discovery completion for run {RunId}: {Pages} pages", runId, body.Pages.Count);
        return FromResult(await _discoveryIngest.CompleteAsync(runId, body, ct), () => NoContent());
    }

    // ---- Execution -----------------------------------------------------------

    /// <summary>Confirms a worker has started an execution.</summary>
    [HttpPost("executions/{executionId:guid}/started")]
    public async Task<IActionResult> ExecutionStarted(Guid executionId, [FromBody] WorkerStartedBody body, CancellationToken ct)
    {
        if (!Authorize(executionId, "execution", out var failure)) return failure!;
        return FromResult(await _executionIngest.MarkRunningAsync(executionId, body.WorkerId, ct), () => NoContent());
    }

    /// <summary>Streams one completed action, which drives the live execution view.</summary>
    [HttpPost("executions/{executionId:guid}/actions")]
    public async Task<IActionResult> ExecutionAction(Guid executionId, [FromBody] ActionResultPayload body, CancellationToken ct)
    {
        if (!Authorize(executionId, "execution", out var failure)) return failure!;
        return FromResult(await _executionIngest.RecordActionAsync(executionId, body, ct), () => NoContent());
    }

    /// <summary>Delivers the finished execution: verdict, evidence, and any healing events.</summary>
    [HttpPost("executions/{executionId:guid}/complete")]
    [RequestSizeLimit(64 * 1024 * 1024)]
    public async Task<IActionResult> ExecutionComplete(Guid executionId, [FromBody] ExecutionCompletionPayload body, CancellationToken ct)
    {
        if (!Authorize(executionId, "execution", out var failure)) return failure!;
        _logger.LogInformation("Received execution completion for {ExecutionId}: {Status}", executionId, body.Status);
        return FromResult(await _executionIngest.CompleteAsync(executionId, body, ct), () => NoContent());
    }

    // ---- Artifacts -----------------------------------------------------------

    /// <summary>Uploads one evidence file. The worker streams bytes; the store assigns the
    /// key, so a worker cannot choose where its content lands.</summary>
    [HttpPost("artifacts")]
    [RequestSizeLimit(512 * 1024 * 1024)]
    public async Task<IActionResult> UploadArtifact(
        [FromQuery] string name, [FromQuery] string contentType, CancellationToken ct)
    {
        var organizationId = OrganizationFromToken();
        if (organizationId is null) return Problem(Error.Unauthorized("The worker token carries no organization."));

        if (string.IsNullOrWhiteSpace(name)) return Problem(Error.Validation("An artifact name is required."));

        using (_tenant.EnterSystemContext("worker artifact upload"))
        {
            var stored = await _artifacts.PutAsync(organizationId.Value, name,
                string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType,
                Request.Body, ct);

            return Ok(new { stored.StorageKey, stored.SizeBytes, stored.Sha256, stored.ContentType });
        }
    }

    public sealed record WorkerStartedBody(string WorkerId);

    /// <summary>A worker token names exactly one job and one scope. Anything else is refused.</summary>
    private bool Authorize(Guid jobId, string scope, out IActionResult? failure)
    {
        failure = null;

        var tokenJob = User.FindFirst(JwtTokenService.WorkerJobClaim)?.Value;
        var tokenScope = User.FindFirst(JwtTokenService.WorkerScopeClaim)?.Value;

        if (!Guid.TryParse(tokenJob, out var parsed) || parsed != jobId)
        {
            _logger.LogWarning("A worker token for job {TokenJob} attempted to act on job {JobId}", tokenJob, jobId);
            failure = Problem(Error.Forbidden("This worker token is not valid for that job."));
            return false;
        }

        if (!string.Equals(tokenScope, scope, StringComparison.Ordinal))
        {
            _logger.LogWarning("A worker token scoped to {TokenScope} attempted a {Scope} operation", tokenScope, scope);
            failure = Problem(Error.Forbidden($"This worker token is not scoped for {scope} operations."));
            return false;
        }

        var organizationId = OrganizationFromToken();
        if (organizationId is null)
        {
            failure = Problem(Error.Unauthorized("The worker token carries no organization."));
            return false;
        }

        // Workers act on behalf of the tenant that owns the job, never as a user.
        _tenant.SetOrganization(organizationId.Value);
        return true;
    }

    private Guid? OrganizationFromToken()
        => Guid.TryParse(User.FindFirstValue(JwtTokenService.OrganizationClaim), out var id) ? id : null;
}
