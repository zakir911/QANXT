using Aira.Application.Abstractions;
using Aira.Domain.Enums;
using Aira.Domain.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Security;

/// <summary>What one sweep did.</summary>
public sealed record SecurityScanSweep(int Abandoned, IReadOnlyList<string> References)
{
    public static readonly SecurityScanSweep Nothing =
        new(0, Array.Empty<string>());
}

public interface ISecurityScanReaper
{
    /// <summary>Ends scans queued longer ago than <paramref name="grace"/> that no worker reported.</summary>
    Task<SecurityScanSweep> SweepAsync(TimeSpan grace, CancellationToken ct = default);
}

/// <summary>
/// Stops waiting on security scans no worker is going to report.
/// </summary>
/// <remarks>
/// <para>
/// A scan row is written when somebody asks for one, and a worker fills it in when it has
/// finished issuing requests. If that worker dies, loses its network or drops the job, the row
/// stays <c>queued</c> for ever — indistinguishable from a scan queued a moment ago that is
/// about to run.
/// </para>
/// <para>
/// This is a milder failure than a stranded test execution, because a queued scan already reads
/// as NOT SCANNED rather than as clean: the safe direction. What it is not is honest. Somebody
/// looking at the application sees a scan apparently in flight and waits for a result that is
/// never coming, and "waiting" is the one state in which nobody goes and starts another scan.
/// </para>
/// <para>
/// So the sweep ends it and says why, in words, on the row. What it does not do is invent a
/// verdict. An abandoned scan issued no requests anybody can account for, so it stays outside
/// the set the gate reads as having run — exactly where the queued one was. And if the worker
/// was slow rather than dead, its report still lands and supersedes this, because a real result
/// beats a presumption of death.
/// </para>
/// <para>
/// Separate from the hosted service that calls it on a timer, so the decision can be tested
/// without waiting an hour for one.
/// </para>
/// </remarks>
public sealed class SecurityScanReaper : ISecurityScanReaper
{
    private readonly IAiraDbContext _db;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly ILogger<SecurityScanReaper> _logger;

    public SecurityScanReaper(IAiraDbContext db, IClock clock, IAuditLogger audit,
        ILogger<SecurityScanReaper> logger)
    {
        _db = db;
        _clock = clock;
        _audit = audit;
        _logger = logger;
    }

    public async Task<SecurityScanSweep> SweepAsync(TimeSpan grace, CancellationToken ct = default)
    {
        var cutoff = _clock.UtcNow - grace;

        // Only queued scans, and only ones older than the grace. A completed scan is finished
        // and an abandoned one has already been accounted for; touching either would rewrite a
        // record somebody may already have read.
        var stranded = await _db.SecurityScans
            .Where(s => s.Status == SecurityScanStatus.Queued && s.StartedAt < cutoff)
            .ToListAsync(ct);

        if (stranded.Count == 0) return SecurityScanSweep.Nothing;

        foreach (var scan in stranded)
        {
            scan.Status = SecurityScanStatus.Abandoned;
            scan.CompletedAt = _clock.UtcNow;
            scan.DurationMs = (int)(_clock.UtcNow - scan.StartedAt).TotalMilliseconds;
            // Plain, and explicit about which half of the system the reason lies in: whoever
            // reads this should go and look at their workers, not at their application.
            var minutes = (int)Math.Round(grace.TotalMinutes);
            scan.ErrorMessage =
                $"No worker reported on this scan for over {minutes} minute{(minutes == 1 ? "" : "s")}, so the "
                + "platform stopped waiting for it. Nothing was established about this application: "
                + "this is not a result, and it is not a clean one. Queue another scan once a worker "
                + "is available. This is a platform or infrastructure problem, not a finding about "
                + "the application under test.";

            _logger.LogWarning(
                "Security scan {Reference} ({ScanId}) was never reported and has been abandoned",
                scan.Reference, scan.Id);
        }

        await _db.SaveChangesAsync(ct);

        // Audited one at a time. A scan that was authorized and then never ran is a gap in what
        // somebody believes was tested, and the trail is where that stays visible afterwards.
        foreach (var scan in stranded)
        {
            await _audit.LogAsync(AuditAction.SecurityScanAbandoned, nameof(SecurityScan), scan.Id,
                $"Security scan {scan.Reference} was abandoned: no worker reported it.",
                new { scan.Reference, graceMinutes = grace.TotalMinutes, scan.StartedAt },
                // Named explicitly. The logger otherwise falls back to the signed-in user's
                // organization, and a sweep has no user — so the entry was written nowhere and
                // the trail this exists to leave did not exist.
                organizationId: scan.OrganizationId,
                projectId: scan.ProjectId, ct: ct);
        }

        return new SecurityScanSweep(stranded.Count, stranded.Select(s => s.Reference).ToList());
    }
}
