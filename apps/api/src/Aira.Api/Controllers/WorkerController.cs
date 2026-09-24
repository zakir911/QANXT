using System.Security.Claims;
using Aira.Api.Authorization;
using Aira.Application.Abstractions;
using Aira.Application.Discovery;
using Aira.Application.Security;
using Aira.Application.Testing;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Aira.Domain.Testing;
using Aira.Infrastructure.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

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
    private readonly ISecurityScanService _security;
    private readonly IArtifactStore _artifacts;
    private readonly ITenantContext _tenant;
    private readonly IAiraDbContext _db;
    private readonly IClock _clock;
    private readonly ILogger<WorkerController> _logger;

    public WorkerController(IDiscoveryIngestService discoveryIngest, IExecutionIngestService executionIngest,
        ISecurityScanService security, IArtifactStore artifacts, ITenantContext tenant,
        IAiraDbContext db, IClock clock, ILogger<WorkerController> logger)
    {
        _discoveryIngest = discoveryIngest;
        _executionIngest = executionIngest;
        _security = security;
        _artifacts = artifacts;
        _tenant = tenant;
        _db = db;
        _clock = clock;
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

    // ---- Security ------------------------------------------------------------

    /// <summary>
    /// Delivers a finished security scan: what ran, what was refused, and what was found.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The token is scoped to this scan and to security, so an execution worker cannot post
    /// findings and a security worker cannot post them against another scan. Which application
    /// the findings belong to is read from the stored scan, not from the body.
    /// </para>
    /// <para>
    /// The same two refusals the operator-facing route makes apply here: a scan against an
    /// application with no enabled, authorized scope is rejected, and so is any finding arriving
    /// with no request/response exchange behind it. A worker that somehow scanned an
    /// unauthorized application must not be able to launder that into a record.
    /// </para>
    /// </remarks>
    [HttpPost("security/{scanId:guid}/completed")]
    [RequestSizeLimit(64 * 1024 * 1024)]
    public async Task<IActionResult> SecurityScanCompleted(
        Guid scanId, [FromBody] RecordSecurityScanRequest body, CancellationToken ct)
    {
        if (!Authorize(scanId, "security", out var failure)) return failure!;

        _logger.LogInformation(
            "Received a security scan report for {ScanId}: {Executed} check(s) executed, {Findings} finding(s)",
            scanId, body.TestsExecuted, body.Findings.Count);

        return FromResult(await _security.CompleteScanAsync(scanId, body, ct), scan => Ok(new
        {
            scan.Id, scan.Reference, scan.Status,
            findings = scan.Findings.Count,
            // The outcome, not a boolean: a scan can pass, warn or fail, and a warn folded
            // into "passed" is exactly the reading the gate exists to prevent.
            gate = scan.Gate.Outcome.ToString()
        }));
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

    // ---- Visual baselines ------------------------------------------------------

    /// <summary>
    /// The stored baseline for one visual check, or 404 when there is none.
    /// </summary>
    /// <remarks>
    /// Identity is test case, name, browser and viewport together. Each genuinely changes
    /// how a page looks, so a baseline from a different browser or width would report a
    /// difference on every run — which is how a visual suite gets switched off.
    /// </remarks>
    [HttpGet("executions/{executionId:guid}/visual-baseline")]
    public async Task<IActionResult> GetVisualBaseline(
        Guid executionId, [FromQuery] string name, [FromQuery] BrowserType browser,
        [FromQuery] int width, [FromQuery] int height, CancellationToken ct)
    {
        if (!Authorize(executionId, "execution", out var failure)) return failure!;
        if (string.IsNullOrWhiteSpace(name)) return Problem(Error.Validation("A baseline name is required."));

        using (_tenant.EnterSystemContext("worker reading a visual baseline"))
        {
            var testCaseId = await _db.TestExecutions
                .Where(e => e.Id == executionId).Select(e => e.TestCaseId).FirstOrDefaultAsync(ct);
            if (testCaseId == Guid.Empty) return Problem(Error.NotFound("The execution"));

            var baseline = await _db.VisualBaselines.FirstOrDefaultAsync(
                v => v.TestCaseId == testCaseId && v.Name == name && v.Browser == browser
                  && v.ViewportWidth == width && v.ViewportHeight == height, ct);

            // 404 is the answer a first run gets, and the worker turns it into
            // "no baseline existed, so this capture became one" rather than a failure.
            if (baseline is null) return NotFound();

            var content = await _artifacts.GetAsync(baseline.StorageKey, ct);
            if (content is null)
            {
                // The row says there is a baseline and the store disagrees. Reported as
                // absent rather than as an error, so the run recovers by making a new one
                // — but logged loudly, because it means evidence was lost.
                _logger.LogError("Visual baseline {BaselineId} points at missing content {Key}",
                    baseline.Id, baseline.StorageKey);
                return NotFound();
            }

            return File(content, "image/png");
        }
    }

    /// <summary>Stores a capture as the baseline for one visual check.</summary>
    /// <remarks>
    /// Called by the worker only when there was no baseline, or when a person asked for an
    /// update. It never happens because a run decided its own appearance was acceptable:
    /// a run that updates its own baselines cannot regress, because it agrees with itself
    /// every time.
    /// </remarks>
    [HttpPut("executions/{executionId:guid}/visual-baseline")]
    [RequestSizeLimit(64 * 1024 * 1024)]
    public async Task<IActionResult> PutVisualBaseline(
        Guid executionId, [FromQuery] string name, [FromQuery] BrowserType browser,
        [FromQuery] int width, [FromQuery] int height,
        [FromQuery] int imageWidth, [FromQuery] int imageHeight, CancellationToken ct)
    {
        if (!Authorize(executionId, "execution", out var failure)) return failure!;
        if (string.IsNullOrWhiteSpace(name)) return Problem(Error.Validation("A baseline name is required."));

        var organizationId = OrganizationFromToken();
        if (organizationId is null) return Problem(Error.Unauthorized("The worker token carries no organization."));

        using (_tenant.EnterSystemContext("worker writing a visual baseline"))
        {
            var execution = await _db.TestExecutions
                .Where(e => e.Id == executionId)
                .Select(e => new { e.TestCaseId, e.TestRunId, ProjectId = e.TestCase!.ProjectId })
                .FirstOrDefaultAsync(ct);
            if (execution is null) return Problem(Error.NotFound("The execution"));

            var stored = await _artifacts.PutAsync(organizationId.Value,
                $"baseline-{name}.png", "image/png", Request.Body, ct);

            var baseline = await _db.VisualBaselines.FirstOrDefaultAsync(
                v => v.TestCaseId == execution.TestCaseId && v.Name == name && v.Browser == browser
                  && v.ViewportWidth == width && v.ViewportHeight == height, ct);

            if (baseline is null)
            {
                baseline = new VisualBaseline
                {
                    OrganizationId = organizationId.Value,
                    ProjectId = execution.ProjectId,
                    TestCaseId = execution.TestCaseId,
                    Name = name,
                    Browser = browser,
                    ViewportWidth = width,
                    ViewportHeight = height
                };
                _db.VisualBaselines.Add(baseline);
            }

            baseline.StorageKey = stored.StorageKey;
            baseline.Width = imageWidth;
            baseline.Height = imageHeight;
            baseline.SizeBytes = stored.SizeBytes;
            baseline.SourceTestRunId = execution.TestRunId;
            // ApprovedByUserId stays null: a worker is not a person, and a baseline nobody
            // approved records what the page happened to look like rather than what
            // anybody decided it should look like.
            baseline.UpdatedAt = _clock.UtcNow;

            await _db.SaveChangesAsync(ct);
            return Ok(new { baseline.Id, stored.StorageKey });
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
