using QaNxt.Application.Abstractions;
using QaNxt.Application.Notifications;
using QaNxt.Application.Security;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Projects;
using QaNxt.Domain.Security;
using QaNxt.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace QaNxt.UnitTests.Security;

/// <summary>
/// One scan reporting the same flaw twice must not lose the whole scan.
///
/// Found by running a security scan against a thirteen-domain application. The scan ran,
/// found things, and the worker's completion callback answered 500:
///
///   duplicate key value violates unique constraint
///   "ix_security_findings_application_id_fingerprint"
///
/// Every finding in the scan was discarded, the scan stayed `queued` for ever, and the
/// worker retried into the same failure. A scan that found real flaws reported none.
///
/// The cause: the ingest loads existing findings from the database once, keyed by
/// fingerprint, then for each reported finding either updates the match or inserts a new
/// row. Newly inserted rows were never added to that lookup, so a second finding in the
/// SAME scan carrying the same fingerprint missed the update branch and inserted a second
/// row. Two findings share a fingerprint whenever they share category, endpoint, parameter
/// and observed role — which is ordinary: a scan can report the same missing header on the
/// same endpoint from two checks.
///
/// The in-memory provider does not enforce unique indexes, so this asserts the intent
/// directly — one row per fingerprint — which is the thing the index exists to guarantee
/// and which fails against the bug by producing two.
/// </summary>
public class DuplicateFindingFingerprintTests
{
    private static readonly Guid OrgId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid AppId = Guid.Parse("22222222-2222-2222-2222-222222222222");

    private const string Authorization =
        "Synthetic lab application on loopback, authorized for security testing. "
        + "Nothing here is a real system and no real data is involved.";

    [Fact]
    public async Task Two_findings_with_the_same_fingerprint_in_one_scan_become_one_row()
    {
        var (service, db, projectId) = Create();

        var result = await service.RecordScanAsync(ReportWithDuplicate(projectId));

        result.IsSuccess.Should().BeTrue(
            "a scan reporting the same flaw twice is ordinary and must not fail: "
            + result.Error?.Message);

        var findings = await db.SecurityFindings
            .Where(f => f.ApplicationId == AppId)
            .ToListAsync();

        findings.Should().HaveCount(1,
            "both reported findings carry the same category, endpoint, parameter and role, "
            + "so they are the same flaw and belong in one row");

        findings.Select(f => f.Fingerprint).Should().OnlyHaveUniqueItems(
            "the unique index on (application, fingerprint) is what this protects");
    }

    [Fact]
    public async Task A_second_distinct_finding_still_gets_its_own_row()
    {
        var (service, db, projectId) = Create();

        var result = await service.RecordScanAsync(ReportWithTwoDistinct(projectId));

        result.IsSuccess.Should().BeTrue(result.Error?.Message);
        var findings = await db.SecurityFindings.Where(f => f.ApplicationId == AppId).ToListAsync();
        findings.Should().HaveCount(2,
            "collapsing duplicates must not collapse two genuinely different flaws");
    }

    // ---- harness ----------------------------------------------------------

    private static (SecurityScanService Service, QaNxtDbContext Db, Guid ProjectId) Create()
    {
        var tenant = new TestTenantContext();
        var options = new DbContextOptionsBuilder<QaNxtDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(
                Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new QaNxtDbContext(options, tenant, new FixedClock());

        var project = new Project { OrganizationId = OrgId, Name = "Meridian Freight", Key = "FRGT" };
        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
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
        return (service, db, project.Id);
    }

    /// <summary>A header finding on an endpoint, reported twice by two checks. Same
    /// category, endpoint, parameter and role, so the same fingerprint.</summary>
    private static RecordSecurityScanRequest ReportWithDuplicate(Guid projectId) => new(
        ApplicationId: AppId, ProjectId: projectId, EnvironmentId: null,
        Profile: SecurityProfile.Standard,
        RequestsIssued: 20, TestsExecuted: 4, TestsSkipped: 0, DurationMs: 5_000,
        Findings: new[] { Header("passive.headers"), Header("passive.csp") },
        BlockedRequests: Array.Empty<RecordBlockedRequest>(),
        ChecksConfigured: new[] { "passive.headers", "passive.csp" },
        ChecksExecuted: new[] { "passive.headers", "passive.csp" },
        UntestedAreas: Array.Empty<string>());

    private static RecordSecurityScanRequest ReportWithTwoDistinct(Guid projectId) => new(
        ApplicationId: AppId, ProjectId: projectId, EnvironmentId: null,
        Profile: SecurityProfile.Standard,
        RequestsIssued: 20, TestsExecuted: 4, TestsSkipped: 0, DurationMs: 5_000,
        Findings: new[] { Header("passive.headers"), Header("passive.headers", endpoint: "/other") },
        BlockedRequests: Array.Empty<RecordBlockedRequest>(),
        ChecksConfigured: new[] { "passive.headers" },
        ChecksExecuted: new[] { "passive.headers" },
        UntestedAreas: Array.Empty<string>());

    private static RecordFindingRequest Header(string testId, string endpoint = "/shipments") => new(
        Category: "MissingSecurityHeader",
        Title: "content-security-policy is not set",
        TestId: testId, Endpoint: endpoint, HttpMethod: "GET",
        Parameter: "content-security-policy", ObservedAsRole: null,
        Severity: SecuritySeverity.Medium, Confidence: SecurityConfidence.Low,
        SeverityFactorsJson: null, Cwe: "CWE-1021", CweConfidence: "potential",
        OwaspApiCategory: null, OwaspWebCategory: "A05:2021", OwaspEdition: "2021",
        Description: "The response carries no content-security-policy header.",
        Impact: "A browser applies its own defaults.",
        Remediation: "Set the header on HTML responses.",
        ReproductionSteps: "GET the endpoint and read the response headers.",
        EvidencePath: null, ExchangeCount: 1);

    // ---- doubles ----------------------------------------------------------
    //
    // Copied rather than shared: the sibling suite keeps its own as private nested types,
    // and lifting them into a shared fixture is a wider change than this fix warrants.

    private static readonly DateTimeOffset Noon = new(2026, 3, 2, 12, 0, 0, TimeSpan.Zero);

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
        public Task<QaNxt.Domain.Common.Result<NotificationResult>> TestAsync(
            Guid integrationId, CancellationToken ct = default)
            => throw new NotSupportedException();
    }
}
