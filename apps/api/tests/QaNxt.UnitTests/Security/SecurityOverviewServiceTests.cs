using QaNxt.Application.Abstractions;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Projects;
using QaNxt.Domain.Security;
using QaNxt.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace QaNxt.UnitTests.Security;

/// <summary>The security line on the dashboard everybody opens.
///
/// The number these tests care most about is how many applications nobody has scanned. Every
/// security dashboard shows open findings; almost none shows that, and a project with three
/// findings and two applications never scanned is in a very different state from one with
/// three findings and everything covered. Both render identically without it.</summary>
public class SecurityOverviewServiceTests
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

    private sealed class Harness
    {
        public required SecurityOverviewService Service { get; init; }
        public required QaNxtDbContext Db { get; init; }
        public required TestTenantContext Tenant { get; init; }
        public required Guid ProjectId { get; init; }

        public async Task<Guid> ApplicationAsync(bool authorized, bool scanned, params SecurityFinding[] findings)
        {
            var application = new Domain.Applications.Application
            {
                OrganizationId = OrgId, ProjectId = ProjectId,
                Name = $"App {Guid.NewGuid():N}"[..12], BaseUrl = "http://127.0.0.1:4401"
            };
            await SeedAsync(application);

            if (authorized)
            {
                await SeedAsync(new SecurityScope
                {
                    OrganizationId = OrgId, ApplicationId = application.Id, Enabled = true,
                    AllowedDomains = "127.0.0.1",
                    AuthorizationNote = "Authorized by Ada for the QA environment."
                });
            }

            if (scanned)
            {
                var scan = new SecurityScan
                {
                    OrganizationId = OrgId, ProjectId = ProjectId, ApplicationId = application.Id,
                    Reference = $"SCAN-{Guid.NewGuid():N}"[..16], Status = "completed",
                    StartedAt = Noon, CompletedAt = Noon
                };
                await SeedAsync(scan);
                foreach (var finding in findings)
                {
                    finding.OrganizationId = OrgId;
                    finding.ProjectId = ProjectId;
                    finding.ApplicationId = application.Id;
                    finding.SecurityScanId = scan.Id;
                    await SeedAsync(finding);
                }
            }

            return application.Id;
        }

        public async Task SeedAsync(object entity)
        {
            using (Tenant.EnterSystemContext("seed"))
            {
                Db.Add(entity);
                await Db.SaveChangesAsync();
            }
        }
    }

    private static Harness Create()
    {
        var tenant = new TestTenantContext();
        var options = new DbContextOptionsBuilder<QaNxtDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new QaNxtDbContext(options, tenant, new FixedClock());

        var project = new Project { OrganizationId = OrgId, Name = "Retail Banking", Key = "BANK" };
        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        return new Harness
        {
            Service = new SecurityOverviewService(db), Db = db, Tenant = tenant, ProjectId = project.Id
        };
    }

    private static SecurityFinding Finding(
        SecuritySeverity severity = SecuritySeverity.High,
        SecurityFindingStatus status = SecurityFindingStatus.Confirmed,
        string? note = null, Guid? decidedBy = null)
        => new()
        {
            Fingerprint = Guid.NewGuid().ToString("N")[..16], Reference = "SF-1",
            Title = "t", Category = "BOLA", TestId = "authz.bola",
            Severity = severity, Status = status,
            DispositionNote = note, DispositionByUserId = decidedBy,
            FirstSeenAt = Noon, LastSeenAt = Noon
        };

    // -----------------------------------------------------------------------

    [Fact]
    public async Task A_project_with_no_scan_anywhere_says_nothing_is_known()
    {
        var harness = Create();
        await harness.ApplicationAsync(authorized: true, scanned: false);

        var overview = await harness.Service.ForProjectAsync(harness.ProjectId);

        overview.AnyScanRecorded.Should().BeFalse();
        overview.Summary.Should().Contain("Nothing is known about their security posture");
        overview.Summary.Should().Contain("not the same as their being clean");
    }

    [Fact]
    public async Task An_application_nobody_authorized_is_counted_and_named()
    {
        var harness = Create();
        await harness.ApplicationAsync(authorized: false, scanned: false);
        await harness.ApplicationAsync(authorized: true, scanned: true);

        var overview = await harness.Service.ForProjectAsync(harness.ProjectId);

        overview.ApplicationsNotAuthorized.Should().Be(1);
        overview.Summary.Should().Contain("nobody has authorized for security testing");
    }

    [Fact]
    public async Task An_authorized_application_nobody_scanned_is_untested_not_clean()
    {
        // The number this whole type exists for.
        var harness = Create();
        await harness.ApplicationAsync(authorized: true, scanned: false);
        await harness.ApplicationAsync(authorized: true, scanned: true);

        var overview = await harness.Service.ForProjectAsync(harness.ProjectId);

        overview.ApplicationsNeverScanned.Should().Be(1);
        overview.Summary.Should().Contain("never scanned");
        overview.Summary.Should().Contain("untested, not clean");
    }

    [Fact]
    public async Task A_fully_covered_project_with_nothing_open_never_claims_it_is_secure()
    {
        var harness = Create();
        await harness.ApplicationAsync(authorized: true, scanned: true);

        var overview = await harness.Service.ForProjectAsync(harness.ProjectId);

        overview.OpenTotal.Should().Be(0);
        overview.Summary.Should().Contain(
            "Within the scope and coverage of the scans recorded here, no security findings are open");
        overview.Summary.Should().NotContain("is secure");
        overview.Summary.Should().Contain("Every authorized application has been scanned at least once");
    }

    [Fact]
    public async Task Open_findings_are_counted_by_severity()
    {
        var harness = Create();
        await harness.ApplicationAsync(authorized: true, scanned: true,
            Finding(SecuritySeverity.Critical), Finding(SecuritySeverity.High),
            Finding(SecuritySeverity.Medium));

        var overview = await harness.Service.ForProjectAsync(harness.ProjectId);

        overview.OpenCritical.Should().Be(1);
        overview.OpenHigh.Should().Be(1);
        overview.OpenTotal.Should().Be(3);
    }

    [Fact]
    public async Task A_suppression_with_no_reason_counts_as_open_here_too()
    {
        // The gate, the release posture and the dashboard must agree on what "open" means. A
        // finding that is open at the gate and closed on the dashboard makes both untrustworthy.
        var harness = Create();
        await harness.ApplicationAsync(authorized: true, scanned: true,
            Finding(SecuritySeverity.High, SecurityFindingStatus.FalsePositive,
                    note: null, decidedBy: Guid.NewGuid()));

        var overview = await harness.Service.ForProjectAsync(harness.ProjectId);

        overview.UnjustifiedSuppressions.Should().Be(1);
        overview.OpenTotal.Should().Be(1);
        overview.Summary.Should().Contain("no written reason, counted as open");
    }

    [Fact]
    public async Task A_properly_justified_suppression_is_not_open()
    {
        var harness = Create();
        await harness.ApplicationAsync(authorized: true, scanned: true,
            Finding(SecuritySeverity.Critical, SecurityFindingStatus.Accepted,
                    note: "Reviewed with the owning team; the data behind it is synthetic.",
                    decidedBy: Guid.NewGuid()));

        var overview = await harness.Service.ForProjectAsync(harness.ProjectId);

        overview.OpenTotal.Should().Be(0);
        overview.UnjustifiedSuppressions.Should().Be(0);
    }

    [Fact]
    public async Task A_regression_is_counted_separately_and_named()
    {
        var harness = Create();
        await harness.ApplicationAsync(authorized: true, scanned: true,
            Finding(SecuritySeverity.Low, SecurityFindingStatus.Regressed));

        var overview = await harness.Service.ForProjectAsync(harness.ProjectId);

        overview.Regressions.Should().Be(1);
        overview.Summary.Should().Contain("regression(s)");
    }

    [Fact]
    public async Task A_project_with_no_applications_says_there_is_nothing_to_test()
    {
        var harness = Create();

        var overview = await harness.Service.ForProjectAsync(harness.ProjectId);

        overview.Applications.Should().Be(0);
        overview.Summary.Should().Contain("nothing to security test");
    }

    [Fact]
    public async Task The_last_scan_time_is_reported()
    {
        var harness = Create();
        await harness.ApplicationAsync(authorized: true, scanned: true);

        var overview = await harness.Service.ForProjectAsync(harness.ProjectId);

        overview.LastScanAt.Should().Be(Noon);
    }
}
