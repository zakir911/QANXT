using Aira.Application.Abstractions;
using Aira.Application.Notifications;
using Aira.Application.Security;
using Aira.Domain.Enums;
using Aira.Domain.Projects;
using Aira.Domain.Security;
using Aira.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Aira.UnitTests.Security;

/// <summary>
/// What a scan the platform gave up on is allowed to mean.
/// </summary>
/// <remarks>
/// <para>
/// The sweep that abandons a scan is covered elsewhere. These are the two consequences of it
/// that could do damage, and neither is visible from the sweep's own code.
/// </para>
/// <para>
/// The first is that an abandoned scan must never read as a clean one. It has a completed
/// timestamp, no findings and a full scope snapshot, which is exactly the shape of a scan that
/// ran and found nothing — and the difference between those two sentences is the whole point of
/// the gate.
/// </para>
/// <para>
/// The second is that abandoning must not be final. A worker that was slow rather than dead
/// still has real findings to deliver, and discarding them to defend a guess would lose the
/// one thing the scan was for.
/// </para>
/// </remarks>
public class AbandonedSecurityScanTests
{
    private static readonly Guid OrgId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid AppId = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly DateTimeOffset Noon = new(2026, 9, 24, 12, 0, 0, TimeSpan.Zero);

    private const string Authorization =
        "Authorized by Ada for the QA environment on 2026-09-01, reviewed with the platform team.";

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

    private sealed class NoUser : ICurrentUser
    {
        public Guid? UserId => null;
        public Guid? OrganizationId => OrgId;
        public string? Email => null;
        public bool IsAuthenticated => false;
        public IReadOnlySet<string> Permissions => new HashSet<string>();
        public bool HasPermission(string permission) => false;
        public string? CorrelationId => null;
    }

    private sealed class SilentAudit : IAuditLogger
    {
        public Task LogAsync(AuditAction action, string entityType, Guid? entityId, string summary,
            object? changes = null, bool succeeded = true, Guid? organizationId = null,
            Guid? projectId = null, Guid? userId = null, string? userEmail = null,
            CancellationToken ct = default) => Task.CompletedTask;
    }

    private sealed class SilentNotifications : INotificationService
    {
        public Task NotifyAsync(NotificationMessage message, CancellationToken ct = default)
            => Task.CompletedTask;
        public Task<Aira.Domain.Common.Result<NotificationResult>> TestAsync(
            Guid integrationId, CancellationToken ct = default)
            => throw new NotSupportedException();
    }

    private static readonly string Snapshot = System.Text.Json.JsonSerializer.Serialize(new
    {
        checksConfigured = new[] { "passive.headers", "passive.cookies", "passive.cors" },
        checksExecuted = Array.Empty<string>(),
        untestedAreas = Array.Empty<string>()
    });

    private static (SecurityScanService Service, AiraDbContext Db, Guid ProjectId, TestTenantContext Tenant)
        Create()
    {
        var tenant = new TestTenantContext();
        var options = new DbContextOptionsBuilder<AiraDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(
                Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new AiraDbContext(options, tenant, new FixedClock());

        var project = new Project { OrganizationId = OrgId, Name = "Retail Banking", Key = "BANK" };
        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
            // Recording anything needs an enabled scope carrying a written authorization, at
            // both ends. That refusal is tested elsewhere; here it just has to be satisfied.
            db.SecurityScopes.Add(new SecurityScope
            {
                OrganizationId = OrgId, ApplicationId = AppId, Enabled = true,
                AuthorizationNote = Authorization, AllowedDomains = "127.0.0.1"
            });
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        var service = new SecurityScanService(db, new NoUser(), new SilentAudit(),
            new SilentNotifications(), NullLogger<SecurityScanService>.Instance);
        return (service, db, project.Id, tenant);
    }

    private static SecurityScan Abandoned(Guid projectId) => new()
    {
        OrganizationId = OrgId, ProjectId = projectId, ApplicationId = AppId,
        Reference = "SCAN-ABANDONED-1", Profile = SecurityProfile.Standard,
        Status = SecurityScanStatus.Abandoned,
        AuthorizationNote = Authorization,
        ScopeSnapshotJson = Snapshot,
        StartedAt = Noon.AddHours(-2), CompletedAt = Noon, DurationMs = 7_200_000,
        ErrorMessage = "No worker reported on this scan for over 60 minutes."
    };

    private static RecordSecurityScanRequest Report(Guid projectId) => new(
        ApplicationId: AppId, ProjectId: projectId, EnvironmentId: null,
        Profile: SecurityProfile.Standard,
        RequestsIssued: 15, TestsExecuted: 3, TestsSkipped: 0, DurationMs: 4_000,
        Findings: new[]
        {
            new RecordFindingRequest(
                Category: "MissingSecurityHeader", Title: "content-security-policy is not set",
                TestId: "passive.headers", Endpoint: "/weak", HttpMethod: "GET",
                Parameter: "content-security-policy", ObservedAsRole: null,
                Severity: SecuritySeverity.Medium, Confidence: SecurityConfidence.Low,
                SeverityFactorsJson: null, Cwe: "CWE-1021", CweConfidence: "potential",
                OwaspApiCategory: null, OwaspWebCategory: "A05:2021", OwaspEdition: "2021",
                Description: "The response carries no content-security-policy header.",
                Impact: "A browser applies its own defaults.",
                Remediation: "Set the header on HTML responses.",
                ReproductionSteps: "GET /weak and read the response headers.",
                EvidencePath: null, ExchangeCount: 1)
        },
        BlockedRequests: Array.Empty<RecordBlockedRequest>(),
        ChecksConfigured: new[] { "passive.headers", "passive.cookies", "passive.cors" },
        ChecksExecuted: new[] { "passive.headers", "passive.cookies", "passive.cors" },
        UntestedAreas: Array.Empty<string>());

    private static async Task SeedAsync(AiraDbContext db, TestTenantContext tenant, SecurityScan scan)
    {
        using (tenant.EnterSystemContext("seed"))
        {
            db.SecurityScans.Add(scan);
            await db.SaveChangesAsync();
        }
    }

    // -----------------------------------------------------------------------

    [Fact]
    public async Task An_abandoned_scan_reads_as_NOT_SCANNED_rather_than_clean()
    {
        var (service, db, projectId, tenant) = Create();
        var scan = Abandoned(projectId);
        await SeedAsync(db, tenant, scan);

        var result = await service.GetScanAsync(scan.Id);

        result.IsSuccess.Should().BeTrue();
        var summary = result.Value!;

        // It has a completed timestamp, no findings and a full scope snapshot — the exact shape
        // of a scan that ran and found nothing. Only the status separates them, and everything
        // downstream has to read that rather than the shape.
        summary.Status.Should().Be(SecurityScanStatus.Abandoned);
        summary.Findings.Should().BeEmpty();
        summary.Gate.Summary.Should().StartWith("NOT SCANNED");
        summary.Gate.Outcome.Should().NotBe(SecurityGateOutcome.Pass);
        summary.ErrorMessage.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task A_late_report_supersedes_the_abandonment()
    {
        var (service, db, projectId, tenant) = Create();
        var scan = Abandoned(projectId);
        await SeedAsync(db, tenant, scan);

        var result = await service.CompleteScanAsync(scan.Id, Report(projectId));

        // A worker that was slow rather than dead still has real findings to deliver, and
        // defending the guess by discarding them would lose the one thing the scan was for.
        result.IsSuccess.Should().BeTrue();
        result.Value!.Status.Should().Be(SecurityScanStatus.Completed);
        result.Value.Findings.Should().ContainSingle();
        result.Value.RequestsIssued.Should().Be(15);

        var stored = await db.SecurityScans.FirstAsync(s => s.Id == scan.Id);
        // The stale "nobody reported this" note would now be the opposite of what happened.
        stored.ErrorMessage.Should().BeNull();
    }

    [Fact]
    public async Task A_report_delivered_twice_is_ingested_once()
    {
        var (service, db, projectId, tenant) = Create();
        var scan = Abandoned(projectId);
        await SeedAsync(db, tenant, scan);

        await service.CompleteScanAsync(scan.Id, Report(projectId));
        var second = await service.CompleteScanAsync(scan.Id, Report(projectId));

        // The worker retries a delivery whose response it never saw. A retry that doubled the
        // findings would make a scan look worse the flakier the network was.
        second.IsSuccess.Should().BeTrue();
        second.Value!.Findings.Should().ContainSingle();
        (await db.SecurityScanFindings.CountAsync(l => l.SecurityScanId == scan.Id))
            .Should().Be(1);
    }
}
