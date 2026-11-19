using System.Security.Cryptography;
using System.Text;
using QaNxt.Api.Configuration;
using QaNxt.Application.Abstractions;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Api.Controllers;

/// <summary>Exchanges the worker fleet's shared secret for a token scoped to one job.
///
/// <para>This exists because a job's callback token used to be minted when the job was
/// queued, and queue time is not bounded by anything. Run accddf2b designed 5,887 tests;
/// the fleet worked through about 40 a minute; two hours in, the token every remaining job
/// was carrying expired, and 1,116 executions that had never been attempted could not
/// report a result, ever. No amount of retrying could help: the credential was stamped
/// before the work was scheduled.</para>
///
/// <para>Queue time scales with the suite and inversely with the fleet, so no constant
/// lifetime is correct — a bigger suite or a smaller fleet reintroduces the same defect.
/// The fix is for the credential to be minted when the work starts, which means the worker
/// has to be able to ask. The shared secret it presents here is the fleet's own
/// credential, already required in its configuration, and already described in this
/// project's settings as the secret "a worker presents to exchange for job-scoped tokens".
/// That exchange was specified and never built; this is it.</para>
///
/// <para>What the exchange will not do is resurrect finished work. A token is issued only
/// while the job can still legitimately report, so a leaked secret cannot be used to
/// rewrite a run that is already closed.</para></summary>
[ApiController]
[Route("api/v1/worker/jobs")]
[AllowAnonymous]
public sealed class WorkerTokenController : ApiControllerBase
{
    /// <summary>Long enough that no single job outlives its credential while running, short
    /// enough that a leaked one is worth little. Unlike the old lifetime this bounds one
    /// job's execution, not a whole suite's time in the queue.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(1);

    private readonly SecurityOptions _security;
    private readonly ITokenService _tokens;
    private readonly IQaNxtDbContext _db;
    private readonly ILogger<WorkerTokenController> _logger;

    public WorkerTokenController(IOptions<SecurityOptions> security, ITokenService tokens,
        IQaNxtDbContext db, ILogger<WorkerTokenController> logger)
    {
        _security = security.Value;
        _tokens = tokens;
        _db = db;
        _logger = logger;
    }

    public sealed record RenewTokenBody(string Scope);

    public sealed record RenewedToken(string Token, DateTimeOffset ExpiresAt);

    /// <summary>Issues a fresh callback token for a job that can still report.</summary>
    [HttpPost("{jobId:guid}/token")]
    public async Task<IActionResult> Renew(Guid jobId, [FromBody] RenewTokenBody body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_security.WorkerToken))
        {
            // Refusing beats inventing a default: an exchange with no secret configured is
            // an open credential mint, and saying so names the setting to fix.
            _logger.LogError("A worker asked to renew a job token but Security:WorkerToken is not configured.");
            return Problem(Error.Unauthorized(
                "Token exchange is not configured on this control plane. Set WORKER_TOKEN."));
        }

        if (!PresentedSecretMatches())
        {
            _logger.LogWarning("A token renewal for job {JobId} presented the wrong worker secret.", jobId);
            return Problem(Error.Unauthorized("The worker secret was not accepted."));
        }

        var scope = (body?.Scope ?? string.Empty).Trim();

        if (scope is not ("execution" or "discovery" or "security"))
            return Problem(Error.Validation($"'{scope}' is not a job scope."));

        var organizationId = scope switch
        {
            "execution" => await ExecutionOwnerAsync(jobId, ct),
            "discovery" => await DiscoveryOwnerAsync(jobId, ct),
            _ => await ScanOwnerAsync(jobId, ct)
        };

        if (organizationId is null)
        {
            // One answer for "no such job" and "that job has finished", deliberately: the
            // secret holder may enumerate its own fleet's jobs, but this endpoint should not
            // be a way to discover which run ids exist.
            _logger.LogInformation(
                "Refused a token renewal for {Scope} job {JobId}: no such job, or it can no longer report.",
                scope, jobId);
            return Problem(Error.NotFound("A job of that id still waiting to report"));
        }

        _logger.LogInformation("Issued a fresh {Scope} token for job {JobId}.", scope, jobId);

        return Ok(new RenewedToken(
            _tokens.IssueWorkerToken(organizationId.Value, jobId, scope, Lifetime),
            DateTimeOffset.UtcNow.Add(Lifetime)));
    }

    /// <summary>Compares the presented secret in constant time, so a wrong guess takes the
    /// same time to refuse however much of it was right.</summary>
    private bool PresentedSecretMatches()
    {
        var presented = Request.Headers["X-Worker-Secret"].ToString();
        if (string.IsNullOrEmpty(presented)) return false;

        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(presented), Encoding.UTF8.GetBytes(_security.WorkerToken));
    }

    /// <summary>The tenant that owns an execution still waiting to report, or null.
    ///
    /// An execution that has already reported is not renewable: a token is for work that is
    /// about to happen, never for rewriting work that is done.</summary>
    private async Task<Guid?> ExecutionOwnerAsync(Guid id, CancellationToken ct)
    {
        var found = await _db.TestExecutions.AsNoTracking()
            .Where(e => e.Id == id)
            .Select(e => new { e.OrganizationId, e.Status })
            .FirstOrDefaultAsync(ct);

        if (found is null) return null;

        return found.Status is ExecutionStatus.Pending or ExecutionStatus.Queued or ExecutionStatus.Running
            ? found.OrganizationId
            : null;
    }

    private async Task<Guid?> DiscoveryOwnerAsync(Guid id, CancellationToken ct)
    {
        var found = await _db.DiscoveryRuns.AsNoTracking()
            .Where(r => r.Id == id)
            .Select(r => new { r.OrganizationId, r.Status })
            .FirstOrDefaultAsync(ct);

        if (found is null) return null;

        return found.Status is DiscoveryStatus.Queued or DiscoveryStatus.Running
            ? found.OrganizationId
            : null;
    }

    private async Task<Guid?> ScanOwnerAsync(Guid id, CancellationToken ct)
    {
        var found = await _db.SecurityScans.AsNoTracking()
            .Where(s => s.Id == id)
            .Select(s => new { s.OrganizationId, s.Status })
            .FirstOrDefaultAsync(ct);

        if (found is null) return null;

        // Anything that is not a settled verdict is still waiting to report.
        return found.Status is SecurityScanStatus.Completed or SecurityScanStatus.Abandoned
            ? null
            : found.OrganizationId;
    }
}
