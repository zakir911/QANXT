using QaNxt.Application.Abstractions;
using QaNxt.Domain.Security;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Application.Security;

/// <summary>Where a project's security stands right now, for the dashboard everybody opens.</summary>
/// <remarks>
/// The number that earns its place here is <see cref="ApplicationsNeverScanned"/>. Every
/// security dashboard shows open findings; almost none shows how many applications nobody has
/// pointed a scanner at, and a project with four applications, three findings and two never
/// scanned is in a very different state from one with four applications, three findings and
/// everything covered. Both render identically without it.
/// </remarks>
public sealed record SecurityOverview(
    bool AnyScanRecorded,
    DateTimeOffset? LastScanAt,
    int Applications,
    /// <summary>Applications with no enabled scope: nobody has authorized testing them.</summary>
    int ApplicationsNotAuthorized,
    /// <summary>Authorized and never scanned. Untested, not clean.</summary>
    int ApplicationsNeverScanned,
    int OpenCritical,
    int OpenHigh,
    int OpenTotal,
    int Regressions,
    /// <summary>Suppressed with no written reason or no named person. Counted as open.</summary>
    int UnjustifiedSuppressions,
    string Summary);

public interface ISecurityOverviewService
{
    Task<SecurityOverview> ForProjectAsync(Guid? projectId, CancellationToken ct = default);
}

/// <summary>
/// The security line on the main dashboard.
/// </summary>
/// <remarks>
/// Always present, like the release posture and for the same reason: a dashboard that shows a
/// security section only when a scan exists reads as though security is fine whenever it is
/// missing. Absence of a section and absence of a problem look identical, and only one of them
/// is usually true.
/// </remarks>
public sealed class SecurityOverviewService : ISecurityOverviewService
{
    private readonly IQaNxtDbContext _db;
    public SecurityOverviewService(IQaNxtDbContext db) => _db = db;

    public async Task<SecurityOverview> ForProjectAsync(Guid? projectId, CancellationToken ct = default)
    {
        var applications = _db.Applications.AsNoTracking().AsQueryable();
        if (projectId is { } id) applications = applications.Where(a => a.ProjectId == id);
        var applicationIds = await applications.Select(a => a.Id).ToListAsync(ct);

        var authorized = await _db.SecurityScopes.AsNoTracking()
            .Where(s => applicationIds.Contains(s.ApplicationId) && s.Enabled
                     && s.AuthorizationNote != null && s.AuthorizationNote != "")
            .Select(s => s.ApplicationId)
            .ToListAsync(ct);

        var scanned = await _db.SecurityScans.AsNoTracking()
            .Where(s => applicationIds.Contains(s.ApplicationId))
            .Select(s => s.ApplicationId)
            .Distinct()
            .ToListAsync(ct);

        var lastScanAt = await _db.SecurityScans.AsNoTracking()
            .Where(s => applicationIds.Contains(s.ApplicationId))
            .OrderByDescending(s => s.StartedAt)
            .Select(s => (DateTimeOffset?)s.StartedAt)
            .FirstOrDefaultAsync(ct);

        var findings = await _db.SecurityFindings.AsNoTracking()
            .Where(f => applicationIds.Contains(f.ApplicationId))
            .Select(f => new { f.Severity, f.Status, f.DispositionNote, f.DispositionByUserId })
            .ToListAsync(ct);

        var unjustified = findings
            .Where(f => f.Status is SecurityFindingStatus.FalsePositive or SecurityFindingStatus.Accepted)
            .Count(f => string.IsNullOrWhiteSpace(f.DispositionNote) || f.DispositionByUserId is null);

        // Same definition of "open" the gate and the release posture use, including counting
        // an unexplained suppression as open. Three places agreeing is the point: a finding
        // that is open on the dashboard and closed at the gate would make both untrustworthy.
        var open = findings.Where(f =>
            f.Status is SecurityFindingStatus.Potential or SecurityFindingStatus.Confirmed
                or SecurityFindingStatus.NeedsReview or SecurityFindingStatus.Regressed
            || (f.Status is SecurityFindingStatus.FalsePositive or SecurityFindingStatus.Accepted
                && (string.IsNullOrWhiteSpace(f.DispositionNote) || f.DispositionByUserId is null)))
            .ToList();

        var notAuthorized = applicationIds.Count - authorized.Count;
        var neverScanned = authorized.Count(a => !scanned.Contains(a));

        return new SecurityOverview(
            AnyScanRecorded: scanned.Count > 0,
            LastScanAt: lastScanAt,
            Applications: applicationIds.Count,
            ApplicationsNotAuthorized: notAuthorized,
            ApplicationsNeverScanned: neverScanned,
            OpenCritical: open.Count(f => f.Severity == SecuritySeverity.Critical),
            OpenHigh: open.Count(f => f.Severity == SecuritySeverity.High),
            OpenTotal: open.Count,
            Regressions: open.Count(f => f.Status == SecurityFindingStatus.Regressed),
            UnjustifiedSuppressions: unjustified,
            Summary: Summarise(applicationIds.Count, notAuthorized, neverScanned, open.Count,
                               open.Count(f => f.Severity == SecuritySeverity.Critical),
                               open.Count(f => f.Status == SecurityFindingStatus.Regressed),
                               unjustified, scanned.Count > 0));
    }

    private static string Summarise(
        int applications, int notAuthorized, int neverScanned, int open, int critical,
        int regressions, int unjustified, bool anyScan)
    {
        if (applications == 0)
        {
            return "No applications are registered in this project, so there is nothing to security test.";
        }
        if (!anyScan)
        {
            return $"No security scan has been recorded for any of the {applications} application(s) "
                 + "here. Nothing is known about their security posture from QA NXT, which is not the "
                 + "same as their being clean.";
        }

        var gaps = new List<string>();
        if (notAuthorized > 0)
            gaps.Add($"{notAuthorized} application(s) nobody has authorized for security testing");
        if (neverScanned > 0)
            gaps.Add($"{neverScanned} authorized application(s) never scanned");

        var problems = new List<string>();
        if (critical > 0) problems.Add($"{critical} open Critical");
        if (regressions > 0) problems.Add($"{regressions} regression(s)");
        if (unjustified > 0)
            problems.Add($"{unjustified} suppression(s) with no written reason, counted as open");

        var head = open == 0
            ? "Within the scope and coverage of the scans recorded here, no security findings are open."
            : $"{open} open finding(s)" + (problems.Count > 0 ? $": {string.Join(", ", problems)}." : ".");

        var tail = gaps.Count > 0
            ? $" {string.Join(" and ", gaps)} — untested, not clean."
            : " Every authorized application has been scanned at least once.";

        return head + tail;
    }
}
