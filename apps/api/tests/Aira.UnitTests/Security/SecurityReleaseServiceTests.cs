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

    private static async Task SeedAsync(AiraDbContext db, TestTenantContext tenant, params object[] entities)
    {
        using (tenant.EnterSystemContext("seed"))
        {
            foreach (var entity in entities) db.Add(entity);
            await db.SaveChangesAsync();
        }
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
