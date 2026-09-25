using Aira.Application.Abstractions;
using Aira.Application.Security;
using Aira.Domain.Common;
using Aira.Domain.Projects;
using Aira.Domain.Security;
using Aira.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Aira.UnitTests.Security;

/// <summary>Security, in the terms a release decision is made in.
///
/// The first test is the one that matters most. A release report that omits security when no
/// scan ran reads as though security was fine — the section is missing, so nothing is wrong —
/// and a team shipping on that has been misled by a silence rather than a sentence.</summary>
public class SecurityReleaseServiceTests
{
    private static readonly Guid OrgId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly DateTimeOffset Noon = new(2026, 9, 24, 12, 0, 0, TimeSpan.Zero);

    private sealed class TestTenantContext : ITenantContext
    {
        private int _depth;
        public Guid? OrganizationId { get; private set; }
        public bool IsSystemContext => _depth > 0;
        public void SetOrganization(Guid organizationId) => OrganizationId = organizationId;
        public IDisposable EnterSystemContext(string reason) { _depth++; return new Scope(() => _depth--); }
        private sealed class Scope(Action onDispose) : IDisposable { public void Dispose() => onDispose(); }
    }

    private sealed class FixedClock : IClock { public DateTimeOffset UtcNow => Noon; }

    private static readonly string Snapshot = System.Text.Json.JsonSerializer.Serialize(new
    {
        checksConfigured = new[] { "authz.bola", "authz.vertical", "authz.missing", "api.rate-limit", "passive.headers" },
        checksExecuted = new[] { "authz.bola", "authz.vertical", "authz.missing", "api.rate-limit", "passive.headers" },
        untestedAreas = new[] { "DOM-based XSS (needs a browser-driven scan)" }
    });

    private static readonly string PartialSnapshot = System.Text.Json.JsonSerializer.Serialize(new
    {
        checksConfigured = new[] { "authz.bola", "authz.vertical", "authz.missing", "api.rate-limit", "passive.headers" },
        checksExecuted = new[] { "authz.bola" },
        untestedAreas = Array.Empty<string>()
    });

    private static (SecurityReleaseService Service, AiraDbContext Db, Guid ProjectId, TestTenantContext Tenant)
        Create()
    {
        var tenant = new TestTenantContext();
        var options = new DbContextOptionsBuilder<AiraDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new AiraDbContext(options, tenant, new FixedClock());

        var project = new Project { OrganizationId = OrgId, Name = "Retail Banking", Key = "BANK" };
        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        return (new SecurityReleaseService(db), db, project.Id, tenant);
    }

    private static SecurityScan Scan(Guid projectId, string? snapshot = null, DateTimeOffset? at = null)
        => new()
        {
            OrganizationId = OrgId, ProjectId = projectId, ApplicationId = Guid.NewGuid(),
            Reference = $"SCAN-{Guid.NewGuid():N}"[..16], Profile = SecurityProfile.Standard,
            Status = "completed", StartedAt = at ?? Noon, CompletedAt = at ?? Noon,
            ScopeSnapshotJson = snapshot ?? Snapshot
        };

    private static SecurityFinding Finding(
        Guid projectId, Guid scanId,
        SecuritySeverity severity = SecuritySeverity.High,
        SecurityFindingStatus status = SecurityFindingStatus.Confirmed,
        string? note = null, Guid? decidedBy = null)
        => new()
        {
            OrganizationId = OrgId, ProjectId = projectId, ApplicationId = Guid.NewGuid(),
            SecurityScanId = scanId, Fingerprint = Guid.NewGuid().ToString("N")[..16],
            Reference = "SF-1", Title = "t", Category = "BOLA", TestId = "authz.bola",
            Severity = severity, Status = status,
            DispositionNote = note, DispositionByUserId = decidedBy,
            FirstSeenAt = Noon, LastSeenAt = Noon
        };

    /// <summary>
    /// Seeds entities, and the sighting rows that go with any finding attached to a scan.
    /// </summary>
    /// <remarks>
    /// A scan's findings are read through <see cref="SecurityScanFinding"/> rather than off the
    /// finding's own scan id, because that id names each flaw's latest sighting and cannot also
    /// be the record of what one scan reported. The ingest path always writes both, so a fixture
    /// that wrote only the finding would be seeding a state the application never produces —
    /// and every test built on it would be measuring nothing.
    /// </remarks>
    private static async Task SeedAsync(AiraDbContext db, TestTenantContext tenant, params object[] entities)
    {
        using (tenant.EnterSystemContext("seed"))
        {
            foreach (var entity in entities) db.Add(entity);

            foreach (var finding in entities.OfType<SecurityFinding>()
                         .Where(f => f.SecurityScanId is not null))
            {
                db.Add(new SecurityScanFinding
                {
                    OrganizationId = finding.OrganizationId,
                    SecurityScanId = finding.SecurityScanId!.Value,
                    SecurityFindingId = finding.Id,
                    Severity = finding.Severity,
                    Confidence = finding.Confidence,
                    WasNew = finding.FirstSeenAt == finding.LastSeenAt,
                    WasRegression = finding.RegressedAt is not null,
                    ReportedAt = finding.LastSeenAt
                });
            }

            await db.SaveChangesAsync();
        }
    }

    /// <summary>A scan with its own start and end, so the window can be tested at all.</summary>
    private static SecurityScan ScanBetween(Guid projectId, DateTimeOffset started, DateTimeOffset? completed)
        => new()
        {
            OrganizationId = OrgId, ProjectId = projectId, ApplicationId = Guid.NewGuid(),
            Reference = $"SCAN-{Guid.NewGuid():N}"[..16], Profile = SecurityProfile.Standard,
            Status = completed is null ? "running" : "completed",
            StartedAt = started, CompletedAt = completed,
            ScopeSnapshotJson = Snapshot
        };

    // ---- The build reference, which is not a heuristic -----------------------

    [Fact]
    public async Task A_scan_that_recorded_this_build_covers_it_whatever_the_clock_says()
    {
        // The root cause the Verdaccio pilot exposed. An autonomous pass finishes its scan
        // moments before it starts the verification run, so no window drawn from that run can
        // contain the scan — and the release report said nothing was known about a build that
        // had just been scanned as part of the same pass. A scan that states which build it
        // covered removes the guess entirely.
        var (service, db, projectId, tenant) = Create();
        var scan = ScanBetween(projectId, Noon.AddMinutes(-10), Noon.AddMinutes(-9));
        scan.ApplicationBuildRef = "build-42";
        await SeedAsync(db, tenant, scan);

        var posture = await service.ForBuildAsync(projectId, Noon, Noon.AddMinutes(5), "build-42");

        posture.Scanned.Should().BeTrue(
            "the scan said which build it covered, and it was this one");
        posture.ScansCoveringThisBuild.Should().Be(1);
    }

    [Fact]
    public async Task A_scan_that_recorded_a_different_build_never_covers_this_one()
    {
        // The other direction, and the one that keeps the first honest. A scan that named a
        // build is excluded from every other build even when its timestamps overlap — it
        // already said what it covered, and a window must not talk it into covering more.
        var (service, db, projectId, tenant) = Create();
        var scan = ScanBetween(projectId, Noon.AddMinutes(1), Noon.AddMinutes(4));
        scan.ApplicationBuildRef = "some-other-build";
        await SeedAsync(db, tenant, scan);

        var posture = await service.ForBuildAsync(projectId, Noon, Noon.AddMinutes(5), "build-42");

        posture.Scanned.Should().BeFalse();
        posture.Verdict.Should().Be(SecurityPostureVerdict.NotScanned);
    }

    [Fact]
    public async Task A_scan_that_named_no_build_still_falls_back_to_the_window()
    {
        // Scans predating the build reference, and scans a person started by hand, name no
        // build. They must keep working, or adding the column would quietly stop counting
        // every scan already in the database.
        var (service, db, projectId, tenant) = Create();
        await SeedAsync(db, tenant, ScanBetween(projectId, Noon.AddMinutes(1), Noon.AddMinutes(4)));

        var posture = await service.ForBuildAsync(projectId, Noon, Noon.AddMinutes(5), "build-42");

        posture.Scanned.Should().BeTrue();
    }

    // ---- The window ---------------------------------------------------------
    //
    // Every other test in this file passes (null, null) and so never exercised the window at
    // all. The pilot against Verdaccio found what that left uncovered: a build tested by one
    // run reported NOT SECURITY TESTED although a scan had just covered it, because the
    // window was [that run's end, that run's end] — an instant nothing can fall into.

    [Fact]
    public async Task A_scan_running_alongside_the_tests_covers_the_build()
    {
        // The ordering an autonomous pass produces, and the one a pipeline produces: the scan
        // is queued first and finishes while the tests are still running.
        var (service, db, projectId, tenant) = Create();
        var runStarted = Noon;
        var runFinished = Noon.AddMinutes(5);
        await SeedAsync(db, tenant, ScanBetween(projectId, Noon.AddMinutes(-1), Noon.AddMinutes(4)));

        var posture = await service.ForBuildAsync(projectId, runStarted, runFinished);

        posture.Scanned.Should().BeTrue(
            "the scan overlapped the window the build was tested in");
        posture.ScansCoveringThisBuild.Should().Be(1);
    }

    [Fact]
    public async Task A_scan_wholly_inside_the_window_covers_the_build()
    {
        // The easy case, kept because widening the rule must not lose it. It does not pin the
        // single-run regression: that came from the window the CALLER passed — anchored on the
        // first run's completion, which for one run is its own end — and no test of this
        // service can reach it. AQI-056 pins that end to end.
        var (service, db, projectId, tenant) = Create();
        await SeedAsync(db, tenant, ScanBetween(projectId, Noon.AddMinutes(1), Noon.AddMinutes(4)));

        var posture = await service.ForBuildAsync(projectId, Noon, Noon.AddMinutes(5));

        posture.Scanned.Should().BeTrue();
        posture.Verdict.Should().NotBe(SecurityPostureVerdict.NotScanned);
    }

    [Fact]
    public async Task A_scan_that_finished_before_the_build_was_tested_does_not_cover_it()
    {
        // The other half. Widening the window must not turn "a scan happened once" into
        // "this build was scanned" — that is the claim the whole section exists to refuse.
        var (service, db, projectId, tenant) = Create();
        await SeedAsync(db, tenant,
            ScanBetween(projectId, Noon.AddDays(-7), Noon.AddDays(-7).AddMinutes(10)));

        var posture = await service.ForBuildAsync(projectId, Noon, Noon.AddMinutes(5));

        posture.Scanned.Should().BeFalse();
        posture.Verdict.Should().Be(SecurityPostureVerdict.NotScanned);
    }

    [Fact]
    public async Task A_scan_that_started_after_the_build_finished_does_not_cover_it()
    {
        var (service, db, projectId, tenant) = Create();
        await SeedAsync(db, tenant,
            ScanBetween(projectId, Noon.AddHours(2), Noon.AddHours(2).AddMinutes(10)));

        var posture = await service.ForBuildAsync(projectId, Noon, Noon.AddMinutes(5));

        posture.Scanned.Should().BeFalse();
    }

    [Fact]
    public async Task A_scan_still_running_when_the_build_was_tested_counts()
    {
        // It was looking at this build. Excluding it would report the build unscanned on the
        // strength of the scan not having finished yet, which is a statement about the clock
        // rather than about the application.
        var (service, db, projectId, tenant) = Create();
        await SeedAsync(db, tenant, ScanBetween(projectId, Noon.AddMinutes(1), null));

        var posture = await service.ForBuildAsync(projectId, Noon, Noon.AddMinutes(5));

        posture.Scanned.Should().BeTrue();
    }

    // -----------------------------------------------------------------------

    [Fact]
    public async Task A_build_nobody_scanned_is_NOT_SECURITY_TESTED_rather_than_clean()
    {
        var (service, _, projectId, _) = Create();

        var posture = await service.ForBuildAsync(projectId, null, null);

        posture.Verdict.Should().Be(SecurityPostureVerdict.NotScanned);
        posture.Scanned.Should().BeFalse();
        posture.Summary.Should().StartWith("NOT SECURITY TESTED");
        posture.Summary.Should().Contain("not the same as having been tested and found clean");
    }

    [Fact]
    public async Task A_clean_scan_never_claims_the_release_is_secure()
    {
        var (service, db, projectId, tenant) = Create();
        await SeedAsync(db, tenant, Scan(projectId));

        var posture = await service.ForBuildAsync(projectId, null, null);

        posture.Verdict.Should().Be(SecurityPostureVerdict.Clear);
        posture.Summary.Should().Contain(
            "Within the configured scope and test coverage, no security findings were detected");
        posture.Summary.Should().Contain("not a statement that the release is secure");
        // The untested area travels with the clean result, or a reader assumes it was covered.
        posture.Summary.Should().Contain("DOM-based XSS");
    }

    [Fact]
    public async Task An_open_critical_blocks_the_release()
    {
        var (service, db, projectId, tenant) = Create();
        var scan = Scan(projectId);
        await SeedAsync(db, tenant, scan, Finding(projectId, scan.Id, SecuritySeverity.Critical));

        var posture = await service.ForBuildAsync(projectId, null, null);

        posture.Verdict.Should().Be(SecurityPostureVerdict.Blocked);
        posture.OpenCritical.Should().Be(1);
        posture.Summary.Should().StartWith("BLOCKED");
    }

    [Fact]
    public async Task An_open_high_needs_review_rather_than_blocking()
    {
        var (service, db, projectId, tenant) = Create();
        var scan = Scan(projectId);
        await SeedAsync(db, tenant, scan, Finding(projectId, scan.Id, SecuritySeverity.High));

        var posture = await service.ForBuildAsync(projectId, null, null);

        posture.Verdict.Should().Be(SecurityPostureVerdict.NeedsReview);
        posture.OpenHigh.Should().Be(1);
    }

    [Fact]
    public async Task A_regression_blocks_at_any_severity()
    {
        var (service, db, projectId, tenant) = Create();
        var scan = Scan(projectId);
        await SeedAsync(db, tenant, scan,
            Finding(projectId, scan.Id, SecuritySeverity.Low, SecurityFindingStatus.Regressed));

        var posture = await service.ForBuildAsync(projectId, null, null);

        posture.Verdict.Should().Be(SecurityPostureVerdict.Blocked);
        posture.Regressions.Should().Be(1);
        posture.Summary.Should().Contain("something fixed has come back");
    }

    [Fact]
    public async Task A_suppression_with_no_reason_is_counted_as_open_and_blocks()
    {
        var (service, db, projectId, tenant) = Create();
        var scan = Scan(projectId);
        await SeedAsync(db, tenant, scan,
            Finding(projectId, scan.Id, SecuritySeverity.Low, SecurityFindingStatus.FalsePositive,
                    note: null, decidedBy: Guid.NewGuid()));

        var posture = await service.ForBuildAsync(projectId, null, null);

        posture.UnjustifiedSuppressions.Should().Be(1);
        posture.Verdict.Should().Be(SecurityPostureVerdict.Blocked);
        posture.Summary.Should().Contain("no written reason, counted as open");
    }

    [Fact]
    public async Task A_properly_justified_suppression_is_honoured()
    {
        var (service, db, projectId, tenant) = Create();
        var scan = Scan(projectId);
        await SeedAsync(db, tenant, scan,
            Finding(projectId, scan.Id, SecuritySeverity.Critical, SecurityFindingStatus.Accepted,
                    note: "Reviewed with the owning team; the data behind it is synthetic.",
                    decidedBy: Guid.NewGuid()));

        var posture = await service.ForBuildAsync(projectId, null, null);

        posture.UnjustifiedSuppressions.Should().Be(0);
        posture.OpenCritical.Should().Be(0);
        posture.Verdict.Should().Be(SecurityPostureVerdict.Clear);
    }

    [Fact]
    public async Task A_partial_scan_needs_review_however_clean_it_was()
    {
        var (service, db, projectId, tenant) = Create();
        await SeedAsync(db, tenant, Scan(projectId, PartialSnapshot));

        var posture = await service.ForBuildAsync(projectId, null, null);

        posture.Verdict.Should().Be(SecurityPostureVerdict.NeedsReview);
        posture.ChecksExecuted.Should().Be(1);
        posture.ChecksConfigured.Should().Be(5);
        posture.Summary.Should().Contain("partial coverage");
    }

    [Fact]
    public async Task A_scan_whose_coverage_cannot_be_read_needs_review_rather_than_passing()
    {
        // Unreadable coverage is unknown coverage, and unknown is a reason to look rather
        // than a reason to ship.
        var (service, db, projectId, tenant) = Create();
        await SeedAsync(db, tenant, Scan(projectId, "{ not json"));

        var posture = await service.ForBuildAsync(projectId, null, null);

        posture.Verdict.Should().Be(SecurityPostureVerdict.NeedsReview);
        posture.Summary.Should().Contain("coverage is unknown");
    }

    [Fact]
    public async Task A_scan_outside_the_build_window_does_not_count_as_covering_it()
    {
        // A release tested across three days should not be assessed on a scan that ran a
        // week before any of its runs.
        var (service, db, projectId, tenant) = Create();
        await SeedAsync(db, tenant, Scan(projectId, at: Noon.AddDays(-7)));

        var posture = await service.ForBuildAsync(projectId, Noon.AddHours(-1), Noon.AddHours(1));

        posture.Verdict.Should().Be(SecurityPostureVerdict.NotScanned);
        posture.ScansCoveringThisBuild.Should().Be(0);
    }

    [Fact]
    public async Task Several_scans_in_the_window_are_all_counted_and_the_latest_supplies_coverage()
    {
        var (service, db, projectId, tenant) = Create();
        await SeedAsync(db, tenant,
            Scan(projectId, PartialSnapshot, Noon.AddHours(-2)),
            Scan(projectId, Snapshot, Noon));

        var posture = await service.ForBuildAsync(projectId, Noon.AddHours(-3), Noon.AddHours(1));

        posture.ScansCoveringThisBuild.Should().Be(2);
        posture.ChecksExecuted.Should().Be(5);
        posture.LastScanAt.Should().Be(Noon);
    }

    [Fact]
    public async Task A_finding_first_seen_in_this_window_is_counted_as_new_to_the_build()
    {
        var (service, db, projectId, tenant) = Create();
        var scan = Scan(projectId);
        await SeedAsync(db, tenant, scan, Finding(projectId, scan.Id, SecuritySeverity.Medium));

        var posture = await service.ForBuildAsync(projectId, Noon.AddHours(-1), Noon.AddHours(1));

        posture.NewSincePreviousBuild.Should().Be(1);
        posture.OpenMedium.Should().Be(1);
    }

    [Fact]
    public async Task A_resolved_finding_is_not_open()
    {
        var (service, db, projectId, tenant) = Create();
        var scan = Scan(projectId);
        await SeedAsync(db, tenant, scan,
            Finding(projectId, scan.Id, SecuritySeverity.Critical, SecurityFindingStatus.Resolved));

        var posture = await service.ForBuildAsync(projectId, null, null);

        posture.OpenCritical.Should().Be(0);
        posture.Verdict.Should().Be(SecurityPostureVerdict.Clear);
    }

    [Fact]
    public async Task Every_verdict_carries_a_summary_that_says_what_was_not_reached()
    {
        var (service, db, projectId, tenant) = Create();
        var scan = Scan(projectId);
        await SeedAsync(db, tenant, scan, Finding(projectId, scan.Id, SecuritySeverity.High));

        var posture = await service.ForBuildAsync(projectId, null, null);

        posture.Summary.Should().Contain("areas they did not reach are untested, not clean");
    }
}
