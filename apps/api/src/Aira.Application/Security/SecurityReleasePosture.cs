using Aira.Application.Abstractions;
using Aira.Domain.Security;
using Microsoft.EntityFrameworkCore;

namespace Aira.Application.Security;

/// <summary>What a release decision needs to know about security, including that it does not know.</summary>
public enum SecurityPostureVerdict
{
    /// <summary>No scan covers this build. Not the same as clean, and never rendered as such.</summary>
    NotScanned = 0,
    /// <summary>Scanned, and something about it needs a person before shipping.</summary>
    NeedsReview = 1,
    /// <summary>Scanned, and something open should stop the release.</summary>
    Blocked = 2,
    /// <summary>Scanned, within its coverage, with nothing open above the thresholds.</summary>
    Clear = 3
}

public sealed record ReleaseSecurityPosture(
    SecurityPostureVerdict Verdict,
    bool Scanned,
    int ScansCoveringThisBuild,
    DateTimeOffset? LastScanAt,
    SecurityProfile? Profile,
    int OpenCritical,
    int OpenHigh,
    int OpenMedium,
    int OpenLow,
    int Regressions,
    int NewSincePreviousBuild,
    /// <summary>Findings marked false positive or accepted with no reason or no named person.
    /// Counted as open, because an unexplained suppression is somebody switching a check off.</summary>
    int UnjustifiedSuppressions,
    int ChecksConfigured,
    int ChecksExecuted,
    IReadOnlyList<string> UntestedAreas,
    string Summary);

public interface ISecurityReleaseService
{
    /// <summary>The security posture of everything tested under a build reference.</summary>
    /// <param name="buildRef">The build, when the caller knows it. A scan that recorded this
    /// same reference counts whatever its timestamps say; the window is only the fallback for
    /// scans that never recorded one.</param>
    Task<ReleaseSecurityPosture> ForBuildAsync(
        Guid projectId, DateTimeOffset? from, DateTimeOffset? to,
        string? buildRef = null, CancellationToken ct = default);
}

/// <summary>
/// Security, in the terms a release decision is made in.
/// </summary>
/// <remarks>
/// <para>
/// The only interesting case is the first one. A release report that simply omits security
/// when no scan ran reads as though security was fine — the section is missing, so nothing is
/// wrong — and that is the most consequential silence a release report can contain. So the
/// posture is always present, and a build nobody scanned comes back <see
/// cref="SecurityPostureVerdict.NotScanned"/> with a summary that says so in its first words.
/// </para>
/// <para>
/// The window is the build's own run window rather than "the latest scan", because a release
/// tested across four runs over three days should not be assessed on a scan that ran a week
/// before any of them.
/// </para>
/// </remarks>
public sealed class SecurityReleaseService : ISecurityReleaseService
{
    private readonly IAiraDbContext _db;
    public SecurityReleaseService(IAiraDbContext db) => _db = db;

    public async Task<ReleaseSecurityPosture> ForBuildAsync(
        Guid projectId, DateTimeOffset? from, DateTimeOffset? to,
        string? buildRef = null, CancellationToken ct = default)
    {
        // Two ways a scan can belong to a build, and the first one is not a heuristic.
        //
        // If the scan recorded this build reference, it covers this build. Full stop. That is
        // somebody stating the relationship rather than the platform deducing it, and it is
        // the only version that has no boundary case.
        //
        // Otherwise, fall back to the window. A scan covers the build if it OVERLAPS the
        // window the build was tested in, not if it is contained by it.
        //
        // Containment was wrong in the case that matters most. A build tested by one run has
        // a window of [that run's end, that run's end] — a single instant no scan can fall
        // into — so every single-run build read NOT SECURITY TESTED however thoroughly it had
        // been scanned. That is the common case in a pipeline, and a false "nothing is known"
        // on a security section is the most consequential wrong answer this report can give.
        // It also excluded the normal ordering, where a scan starts before the tests do.
        var reference = string.IsNullOrWhiteSpace(buildRef) ? null : buildRef.Trim();

        var query = _db.SecurityScans.AsNoTracking().Where(s => s.ProjectId == projectId);
        var start = from;
        var end = to;

        query = query.Where(s =>
            // Stated: this scan says it covered this build.
            (reference != null && s.ApplicationBuildRef == reference)
            // Or inferred: it never said, and it overlapped the window. A scan that named a
            // *different* build is excluded either way — it said which build it covered, and
            // it was not this one.
            || (s.ApplicationBuildRef == null
                && (end == null || s.StartedAt <= end)
                && (start == null || s.CompletedAt == null || s.CompletedAt >= start)));

        var scans = await query.OrderBy(s => s.StartedAt).ToListAsync(ct);

        if (scans.Count == 0)
        {
            return new ReleaseSecurityPosture(
                SecurityPostureVerdict.NotScanned, Scanned: false, 0, null, null,
                0, 0, 0, 0, 0, 0, 0, 0, 0, Array.Empty<string>(),
                "NOT SECURITY TESTED. No security scan covers this build, so nothing is known about its "
                + "security posture from AIRA. This is not the same as having been tested and found "
                + "clean, and a release decision should not read it as such.");
        }

        var latest = scans[^1];
        var scanIds = scans.Select(s => s.Id).ToList();

        // Through the sightings: "the findings of these scans" cannot be read off the findings'
        // own scan id, which names each flaw's latest sighting only. A release assessed on that
        // would lose every finding a later scan had seen again, and lose it silently.
        var findingIds = await _db.SecurityScanFindings.AsNoTracking()
            .Where(link => scanIds.Contains(link.SecurityScanId))
            .Select(link => link.SecurityFindingId)
            .Distinct()
            .ToListAsync(ct);

        var findings = await _db.SecurityFindings.AsNoTracking()
            .Where(f => findingIds.Contains(f.Id))
            .ToListAsync(ct);

        var unjustified = findings
            .Where(f => f.Status is SecurityFindingStatus.FalsePositive or SecurityFindingStatus.Accepted)
            .Count(f => string.IsNullOrWhiteSpace(f.DispositionNote) || f.DispositionByUserId is null);

        // An unexplained suppression counts as open, exactly as the gate treats it.
        var open = findings.Where(f =>
            f.Status is SecurityFindingStatus.Potential or SecurityFindingStatus.Confirmed
                or SecurityFindingStatus.NeedsReview or SecurityFindingStatus.Regressed
            || (f.Status is SecurityFindingStatus.FalsePositive or SecurityFindingStatus.Accepted
                && (string.IsNullOrWhiteSpace(f.DispositionNote) || f.DispositionByUserId is null)))
            .ToList();

        var regressions = open.Count(f => f.Status == SecurityFindingStatus.Regressed);
        var newHere = open.Count(f => from is null || f.FirstSeenAt >= from);

        var snapshot = ReadSnapshot(latest.ScopeSnapshotJson);
        var configured = snapshot.Configured.Length;
        var executed = snapshot.Executed.Length;

        var critical = open.Count(f => f.Severity == SecuritySeverity.Critical);
        var high = open.Count(f => f.Severity == SecuritySeverity.High);
        var medium = open.Count(f => f.Severity == SecuritySeverity.Medium);
        var low = open.Count(f => f.Severity == SecuritySeverity.Low);

        var partial = configured == 0 || executed < configured * 0.8;

        var verdict =
            critical > 0 || regressions > 0 || unjustified > 0 ? SecurityPostureVerdict.Blocked
            : high > 0 || partial ? SecurityPostureVerdict.NeedsReview
            : SecurityPostureVerdict.Clear;

        return new ReleaseSecurityPosture(
            verdict, Scanned: true, scans.Count, latest.StartedAt, latest.Profile,
            critical, high, medium, low, regressions, newHere, unjustified,
            configured, executed, snapshot.Untested,
            Summarise(verdict, scans.Count, critical, high, medium, low, regressions, newHere,
                      unjustified, configured, executed, snapshot.Untested));
    }

    private static string Summarise(
        SecurityPostureVerdict verdict, int scans,
        int critical, int high, int medium, int low,
        int regressions, int newHere, int unjustified,
        int configured, int executed, IReadOnlyList<string> untested)
    {
        var coverage = configured == 0
            ? "no checks were recorded as configured"
            : $"{executed} of {configured} configured check(s) ran";

        var untestedNote = untested.Count == 0
            ? string.Empty
            : $" Untested: {string.Join("; ", untested)}.";

        if (verdict == SecurityPostureVerdict.Clear)
        {
            // The sentence the brief specifies, in the place a release decision is made.
            return $"Within the configured scope and test coverage, no security findings were detected "
                 + $"by the executed AIRA security tests across {scans} scan(s) ({coverage}). This is "
                 + $"not a statement that the release is secure or that no vulnerabilities exist."
                 + untestedNote;
        }

        var reasons = new List<string>();
        if (critical > 0) reasons.Add($"{critical} open Critical");
        if (regressions > 0) reasons.Add($"{regressions} regression(s) — something fixed has come back");
        if (unjustified > 0) reasons.Add($"{unjustified} suppression(s) with no written reason, counted as open");
        if (high > 0) reasons.Add($"{high} open High");
        if (configured > 0 && executed < configured * 0.8)
            reasons.Add($"partial coverage ({coverage})");
        if (configured == 0) reasons.Add("no checks recorded as configured, so coverage is unknown");

        var counts = new[] { critical, high, medium, low };
        var total = counts.Sum();

        return $"{(verdict == SecurityPostureVerdict.Blocked ? "BLOCKED" : "NEEDS REVIEW")}. "
             + $"{string.Join(", ", reasons)}. {total} finding(s) open across {scans} scan(s), "
             + $"{newHere} first seen in this build. Findings describe what these tests reached; "
             + $"areas they did not reach are untested, not clean.{untestedNote}";
    }

    private static (string[] Configured, string[] Executed, string[] Untested) ReadSnapshot(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
            return (Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>());
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(json);
            string[] Read(string name) =>
                document.RootElement.TryGetProperty(name, out var element)
                && element.ValueKind == System.Text.Json.JsonValueKind.Array
                    ? element.EnumerateArray().Select(e => e.GetString() ?? string.Empty).ToArray()
                    : Array.Empty<string>();
            return (Read("checksConfigured"), Read("checksExecuted"), Read("untestedAreas"));
        }
        catch (System.Text.Json.JsonException)
        {
            // Unreadable coverage means unknown coverage, which is a reason to review rather
            // than a reason to pass.
            return (Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>());
        }
    }
}
