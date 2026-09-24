using Aira.Application.Abstractions;
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
/// Giving up on a scan no worker is going to report.
/// </summary>
/// <remarks>
/// The whole point of these is the line between two things that look alike and are not: a scan
/// the platform stopped waiting for, and a scan that ran and found nothing. Every test here is
/// about keeping the first from being read as the second, which is the only way this feature
/// could do harm.
/// </remarks>
public class SecurityScanReaperTests
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

    /// <summary>Records what was audited, because an abandoned scan that leaves no trail is a
    /// gap in what somebody believes was tested and nothing else would show it.</summary>
    private sealed class RecordingAudit : IAuditLogger
    {
        public List<(AuditAction Action, Guid? EntityId, string Summary)> Entries { get; } = new();

        public Task LogAsync(AuditAction action, string entityType, Guid? entityId, string summary,
            object? changes = null, bool succeeded = true, Guid? organizationId = null,
            Guid? projectId = null, Guid? userId = null, string? userEmail = null,
            CancellationToken ct = default)
        {
            Entries.Add((action, entityId, summary));
            return Task.CompletedTask;
        }
    }

    private static (SecurityScanReaper Reaper, AiraDbContext Db, RecordingAudit Audit,
                    Guid ProjectId, TestTenantContext Tenant) Create()
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
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        var audit = new RecordingAudit();
        var reaper = new SecurityScanReaper(db, new FixedClock(), audit,
            NullLogger<SecurityScanReaper>.Instance);
        return (reaper, db, audit, project.Id, tenant);
    }

    private static SecurityScan Scan(Guid projectId, string status, DateTimeOffset startedAt)
        => new()
        {
            OrganizationId = OrgId, ProjectId = projectId, ApplicationId = Guid.NewGuid(),
            Reference = $"SCAN-{Guid.NewGuid():N}"[..16], Profile = SecurityProfile.Standard,
            Status = status, StartedAt = startedAt,
            CompletedAt = status == SecurityScanStatus.Completed ? startedAt : null
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
    public async Task A_scan_nobody_reported_is_abandoned_and_says_why()
    {
        var (reaper, db, _, projectId, tenant) = Create();
        var scan = Scan(projectId, SecurityScanStatus.Queued, Noon.AddHours(-2));
        await SeedAsync(db, tenant, scan);

        var swept = await reaper.SweepAsync(TimeSpan.FromMinutes(60));

        swept.Abandoned.Should().Be(1);
        var stored = await db.SecurityScans.FirstAsync(s => s.Id == scan.Id);
        stored.Status.Should().Be(SecurityScanStatus.Abandoned);
        stored.CompletedAt.Should().Be(Noon);

        // The reason has to name the worker, not the application. Somebody reading this should
        // go and look at their infrastructure rather than hunting for a defect they do not have.
        stored.ErrorMessage.Should().NotBeNullOrWhiteSpace();
        stored.ErrorMessage.Should().Contain("No worker reported");
        stored.ErrorMessage.Should().Contain("not a result");
        stored.ErrorMessage.Should().Contain("not a finding about the application under test");
    }

    [Fact]
    public async Task A_scan_still_inside_its_grace_is_left_alone()
    {
        var (reaper, db, _, projectId, tenant) = Create();
        var scan = Scan(projectId, SecurityScanStatus.Queued, Noon.AddMinutes(-10));
        await SeedAsync(db, tenant, scan);

        var swept = await reaper.SweepAsync(TimeSpan.FromMinutes(60));

        // A slow scan is not a dead one. Cutting a working scan off would throw away real
        // findings and report the loss as though nothing had been there.
        swept.Abandoned.Should().Be(0);
        (await db.SecurityScans.FirstAsync(s => s.Id == scan.Id))
            .Status.Should().Be(SecurityScanStatus.Queued);
    }

    [Fact]
    public async Task A_scan_that_reported_is_never_touched()
    {
        var (reaper, db, _, projectId, tenant) = Create();
        var scan = Scan(projectId, SecurityScanStatus.Completed, Noon.AddDays(-30));
        await SeedAsync(db, tenant, scan);

        await reaper.SweepAsync(TimeSpan.FromMinutes(60));

        var stored = await db.SecurityScans.FirstAsync(s => s.Id == scan.Id);
        stored.Status.Should().Be(SecurityScanStatus.Completed);
        stored.ErrorMessage.Should().BeNull();
    }

    [Fact]
    public async Task An_already_abandoned_scan_is_not_swept_twice()
    {
        var (reaper, db, audit, projectId, tenant) = Create();
        await SeedAsync(db, tenant, Scan(projectId, SecurityScanStatus.Queued, Noon.AddHours(-2)));

        var first = await reaper.SweepAsync(TimeSpan.FromMinutes(60));
        var second = await reaper.SweepAsync(TimeSpan.FromMinutes(60));

        first.Abandoned.Should().Be(1);
        // Otherwise every sweep re-audits the same scan for ever, and the trail that is supposed
        // to make a gap visible becomes the noise that hides it.
        second.Abandoned.Should().Be(0);
        audit.Entries.Should().ContainSingle();
    }

    [Fact]
    public async Task Abandoning_a_scan_is_audited_against_it()
    {
        var (reaper, db, audit, projectId, tenant) = Create();
        var scan = Scan(projectId, SecurityScanStatus.Queued, Noon.AddHours(-2));
        await SeedAsync(db, tenant, scan);

        await reaper.SweepAsync(TimeSpan.FromMinutes(60));

        var entry = audit.Entries.Should().ContainSingle().Subject;
        entry.Action.Should().Be(AuditAction.SecurityScanAbandoned);
        entry.EntityId.Should().Be(scan.Id);
        entry.Summary.Should().Contain(scan.Reference);
    }

    [Fact]
    public async Task Several_stranded_scans_are_all_ended_and_all_named()
    {
        var (reaper, db, _, projectId, tenant) = Create();
        var scans = Enumerable.Range(0, 3)
            .Select(_ => Scan(projectId, SecurityScanStatus.Queued, Noon.AddHours(-2)))
            .ToArray();
        await SeedAsync(db, tenant, scans);

        var swept = await reaper.SweepAsync(TimeSpan.FromMinutes(60));

        swept.Abandoned.Should().Be(3);
        swept.References.Should().BeEquivalentTo(scans.Select(s => s.Reference));
    }
}
