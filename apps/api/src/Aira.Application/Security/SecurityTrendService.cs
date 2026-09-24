using System.Text.Json;
using Aira.Application.Abstractions;
using Aira.Domain.Common;
using Aira.Domain.Security;
using Microsoft.EntityFrameworkCore;

namespace Aira.Application.Security;

/// <summary>One scan, reduced to the numbers a trend line is drawn from.</summary>
/// <remarks>
/// Each point carries its own coverage. A severity count is only comparable to the one before
/// it if the two scans looked at comparable amounts of the application, and a chart that plots
/// the counts without the coverage draws a reassuring downward line every time somebody
/// narrows a scope.
/// </remarks>
public sealed record SecurityTrendPoint(
    Guid ScanId, string Reference, DateTimeOffset At, SecurityProfile Profile,
    int Critical, int High, int Medium, int Low, int Informational,
    int NewFindings, int Regressions,
    int ChecksConfigured, int ChecksExecuted,
    int RequestsIssued, int RequestsBlocked,
    /// <summary>False when this scan covered materially less than the one before it, so a
    /// drop in findings cannot be read as an improvement.</summary>
    bool ComparableToPrevious,
    string? NotComparableBecause);

public sealed record SecurityTrend(
    Guid ApplicationId,
    IReadOnlyList<SecurityTrendPoint> Points,
    int OpenNow,
    int OpenCritical,
    int OpenHigh,
    /// <summary>Median days from first sighting to a person marking it resolved. Null when
    /// fewer than three findings have ever been resolved — a median of one number is not a
    /// median, and reporting it as one invites a team to plan against noise.</summary>
    double? MedianDaysToResolution,
    int ResolvedCount,
    string Summary);

public interface ISecurityTrendService
{
    Task<Result<SecurityTrend>> ForApplicationAsync(
        Guid applicationId, int take = 30, CancellationToken ct = default);
}

/// <summary>
/// How an application's security posture has moved, and when it cannot be said to have moved.
/// </summary>
/// <remarks>
/// The hard part of a security trend is not drawing the line. It is refusing to draw one when
/// the points are not comparable — a scan that ran two checks and a scan that ran twenty
/// produce counts that sit on the same axis and mean entirely different things. Every point
/// here carries the coverage it was measured at, and a point measured at materially less
/// coverage than the one before it is flagged so a chart can break the line rather than slope
/// it downwards.
/// </remarks>
public sealed class SecurityTrendService : ISecurityTrendService
{
    private readonly IAiraDbContext _db;
    public SecurityTrendService(IAiraDbContext db) => _db = db;

    public async Task<Result<SecurityTrend>> ForApplicationAsync(
        Guid applicationId, int take = 30, CancellationToken ct = default)
    {
        var application = await _db.Applications.AsNoTracking()
            .FirstOrDefaultAsync(a => a.Id == applicationId, ct);
        if (application is null) return Result<SecurityTrend>.Failure(Error.NotFound("The application"));

        var scans = await _db.SecurityScans.AsNoTracking()
            .Where(s => s.ApplicationId == applicationId)
            .OrderByDescending(s => s.StartedAt)
            .Take(Math.Clamp(take, 1, 200))
            .ToListAsync(ct);
        scans.Reverse();

        var scanIds = scans.Select(s => s.Id).ToList();

        // Attributed through the sightings, so each point plots what that scan reported. A
        // finding's own scan id names its latest sighting only, and a trend built on it would
        // collapse every finding onto the newest point and draw a falling line for an
        // application where nothing had been fixed.
        var sightings = await _db.SecurityScanFindings.AsNoTracking()
            .Where(link => scanIds.Contains(link.SecurityScanId))
            .Join(_db.SecurityFindings.AsNoTracking().Where(f => f.ApplicationId == applicationId),
                  link => link.SecurityFindingId, f => f.Id,
                  (link, f) => new { link.SecurityScanId, link.Severity, link.WasNew, link.WasRegression })
            .ToListAsync(ct);

        // The application's findings as they stand now, which is a different question from what
        // any scan reported and answers the open counts and time-to-resolution below.
        var findings = await _db.SecurityFindings.AsNoTracking()
            .Where(f => f.ApplicationId == applicationId)
            .ToListAsync(ct);

        var points = new List<SecurityTrendPoint>(scans.Count);
        SecurityTrendPoint? previous = null;

        foreach (var scan in scans)
        {
            // Severity as that scan reported it, not as the finding stands today: a flaw
            // reassessed upwards must not retroactively raise a point somebody already read.
            var inScan = sightings.Where(row => row.SecurityScanId == scan.Id).ToList();
            var (configured, executed) = ReadCoverage(scan.ScopeSnapshotJson);

            var comparable = true;
            string? because = null;
            if (previous is not null)
            {
                if (previous.Profile != scan.Profile)
                {
                    comparable = false;
                    because = $"The previous scan ran the {previous.Profile} profile and this one ran "
                            + $"{scan.Profile}. The two look for different things.";
                }
                // A fifth fewer checks is enough to make a count drop for reasons that have
                // nothing to do with the application.
                else if (previous.ChecksExecuted > 0 && executed < previous.ChecksExecuted * 0.8)
                {
                    comparable = false;
                    because = $"This scan executed {executed} check(s) against the previous scan's "
                            + $"{previous.ChecksExecuted}. A drop in findings cannot be read as an "
                            + "improvement.";
                }
                else if (previous.RequestsIssued > 0 && scan.RequestsIssued < previous.RequestsIssued * 0.5)
                {
                    comparable = false;
                    because = $"This scan issued {scan.RequestsIssued} request(s) against the previous "
                            + $"scan's {previous.RequestsIssued}. It reached materially less of the "
                            + "application.";
                }
            }

            var point = new SecurityTrendPoint(
                scan.Id, scan.Reference, scan.StartedAt, scan.Profile,
                Critical: inScan.Count(row => row.Severity == SecuritySeverity.Critical),
                High: inScan.Count(row => row.Severity == SecuritySeverity.High),
                Medium: inScan.Count(row => row.Severity == SecuritySeverity.Medium),
                Low: inScan.Count(row => row.Severity == SecuritySeverity.Low),
                Informational: inScan.Count(row => row.Severity == SecuritySeverity.Informational),
                // New and regressed as of this scan. Read off the finding's current state, a
                // flaw first seen two scans ago would count as new in every point until
                // something else happened to it.
                NewFindings: inScan.Count(row => row.WasNew),
                Regressions: inScan.Count(row => row.WasRegression),
                ChecksConfigured: configured, ChecksExecuted: executed,
                RequestsIssued: scan.RequestsIssued, RequestsBlocked: scan.RequestsBlocked,
                ComparableToPrevious: comparable, NotComparableBecause: because);

            points.Add(point);
            previous = point;
        }

        var open = findings.Where(f => f.Status is SecurityFindingStatus.Potential
            or SecurityFindingStatus.Confirmed or SecurityFindingStatus.NeedsReview
            or SecurityFindingStatus.Regressed).ToList();

        var resolved = findings
            .Where(f => f.ResolvedAt is not null)
            .Select(f => (f.ResolvedAt!.Value - f.FirstSeenAt).TotalDays)
            .OrderBy(days => days)
            .ToList();

        // A median needs enough numbers to be one. Below three, this reports null rather than
        // a figure a team might plan against.
        double? median = resolved.Count >= 3
            ? resolved.Count % 2 == 1
                ? resolved[resolved.Count / 2]
                : (resolved[resolved.Count / 2 - 1] + resolved[resolved.Count / 2]) / 2
            : null;

        return Result<SecurityTrend>.Success(new SecurityTrend(
            applicationId, points,
            OpenNow: open.Count,
            OpenCritical: open.Count(f => f.Severity == SecuritySeverity.Critical),
            OpenHigh: open.Count(f => f.Severity == SecuritySeverity.High),
            MedianDaysToResolution: median,
            ResolvedCount: resolved.Count,
            Summary: Summarise(points, open, median, resolved.Count)));
    }

    private static string Summarise(
        IReadOnlyList<SecurityTrendPoint> points,
        IReadOnlyCollection<SecurityFinding> open,
        double? median,
        int resolvedCount)
    {
        if (points.Count == 0)
        {
            return "No security scan has been recorded for this application. That is not a clean "
                 + "result: nothing has been tested.";
        }

        var incomparable = points.Count(p => !p.ComparableToPrevious);
        var comparability = incomparable == 0
            ? string.Empty
            : $" {incomparable} of {points.Count} scan(s) are not comparable to the one before them, "
            + "so the line between those points does not mean what a falling line usually means.";

        var resolution = median is null
            ? resolvedCount == 0
                ? " No finding has been resolved yet, so there is no time-to-resolution to report."
                : $" {resolvedCount} finding(s) have been resolved — too few for a median that would "
                + "mean anything."
            : $" The median time from first sighting to resolution is {median:F1} day(s), over "
            + $"{resolvedCount} resolved finding(s).";

        if (open.Count == 0)
        {
            return $"Across {points.Count} scan(s), no findings are currently open. This describes what "
                 + $"those scans reached; areas they did not reach are untested, not clean.{comparability}"
                 + resolution;
        }

        return $"{open.Count} open finding(s) across {points.Count} scan(s). This describes what those "
             + $"scans reached; areas they did not reach are untested, not clean.{comparability}{resolution}";
    }

    private static (int Configured, int Executed) ReadCoverage(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return (0, 0);
        try
        {
            using var document = JsonDocument.Parse(json);
            int Count(string name) =>
                document.RootElement.TryGetProperty(name, out var element)
                && element.ValueKind == JsonValueKind.Array
                    ? element.GetArrayLength() : 0;
            return (Count("checksConfigured"), Count("checksExecuted"));
        }
        catch (JsonException)
        {
            return (0, 0);
        }
    }
}
