using QaNxt.Application.Abstractions;
using QaNxt.Domain.Enums;
using QaNxt.Infrastructure.Persistence;
using QaNxt.Infrastructure.Services;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace QaNxt.UnitTests.Persistence;

/// <summary>
/// Which organization an audit record is written against, and what happens when nothing says.
/// </summary>
/// <remarks>
/// <para>
/// The audit trail's one job is that an act that happened is in it. For a long time that failed
/// silently for everything running outside an HTTP request: the organization came from the
/// signed-in user, a background sweep has no user, and the record was logged as a warning and
/// dropped. Scheduled runs, and scans the platform abandoned, left nothing behind.
/// </para>
/// <para>
/// What made it survive review is that it is invisible from either side. The call succeeds. The
/// caller has no way to tell. And a test with a fake logger asserts the call was made, which it
/// was — the loss happens after. So the resolution itself is pinned here, at the only place
/// that knows all three sources.
/// </para>
/// </remarks>
public class AuditLoggerTests
{
    private static readonly Guid CallerOrg = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid UserOrg = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid TenantOrg = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly DateTimeOffset Noon = new(2026, 9, 24, 12, 0, 0, TimeSpan.Zero);

    private sealed class FixedClock : IClock { public DateTimeOffset UtcNow => Noon; }

    private sealed class TestTenantContext : ITenantContext
    {
        private int _depth;
        public Guid? OrganizationId { get; private set; }
        public bool IsSystemContext => _depth > 0;
        public void SetOrganization(Guid organizationId) => OrganizationId = organizationId;
        public IDisposable EnterSystemContext(string reason) { _depth++; return new Scope(() => _depth--); }
        private sealed class Scope(Action onDispose) : IDisposable { public void Dispose() => onDispose(); }
    }

    /// <summary>A signed-in user, or nobody — which is what a background sweep has.</summary>
    private sealed class MaybeUser : ICurrentUser
    {
        public MaybeUser(Guid? organizationId) => OrganizationId = organizationId;
        public Guid? UserId => OrganizationId is null ? null : Guid.Parse("44444444-4444-4444-4444-444444444444");
        public Guid? OrganizationId { get; }
        public string? Email => OrganizationId is null ? null : "someone@example.test";
        public bool IsAuthenticated => OrganizationId is not null;
        public IReadOnlySet<string> Permissions => new HashSet<string>();
        public bool HasPermission(string permission) => false;
        public string? CorrelationId => null;
    }

    private sealed class FixedCorrelation : ICorrelationContext
    {
        public string CorrelationId => "test-correlation";
        public string? RequestId => null;
    }

    private static (AuditLogger Logger, QaNxtDbContext Db, TestTenantContext Tenant)
        Create(Guid? userOrg, Guid? tenantOrg)
    {
        var tenant = new TestTenantContext();
        if (tenantOrg is { } org) tenant.SetOrganization(org);

        var options = new DbContextOptionsBuilder<QaNxtDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(
                Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new QaNxtDbContext(options, tenant, new FixedClock());

        var logger = new AuditLogger(db, new MaybeUser(userOrg), tenant, new FixedCorrelation(),
            new FixedClock(), NullLogger<AuditLogger>.Instance);
        return (logger, db, tenant);
    }

    /// <summary>
    /// Reads the row whatever organization it was written against.
    /// </summary>
    /// <remarks>
    /// Audit rows are tenant-filtered like everything else, so a test asserting which
    /// organization a row carries has to be able to see rows belonging to another one —
    /// otherwise "written against the wrong tenant" and "not written at all" look identical,
    /// which is the very confusion these tests exist to rule out.
    /// </remarks>
    private static async Task<int> CountAsync(QaNxtDbContext db, TestTenantContext tenant)
    {
        using var _ = tenant.EnterSystemContext("reading the trail across tenants");
        return await db.AuditLogs.CountAsync();
    }

    private static async Task<QaNxt.Domain.Audit.AuditLog> SingleAsync(
        QaNxtDbContext db, TestTenantContext tenant)
    {
        using var _ = tenant.EnterSystemContext("reading the trail across tenants");
        return await db.AuditLogs.SingleAsync();
    }

    private static Task LogAsync(AuditLogger logger, Guid? organizationId = null)
        => logger.LogAsync(AuditAction.SecurityScanStarted, "SecurityScan", Guid.NewGuid(),
            "A scan was started.", organizationId: organizationId);

    // -----------------------------------------------------------------------

    [Fact]
    public async Task An_organization_the_caller_names_wins_over_the_users()
    {
        // The caller names the tenant it is working in, and the signed-in user belongs to a
        // different one. The caller's answer is the one used.
        var (logger, db, tenant) = Create(userOrg: UserOrg, tenantOrg: TenantOrg);

        await LogAsync(logger, organizationId: TenantOrg);

        (await SingleAsync(db, tenant)).OrganizationId.Should().Be(TenantOrg);
    }

    [Fact]
    public async Task Naming_an_organization_the_tenant_context_forbids_writes_nothing()
    {
        var (logger, db, tenant) = Create(userOrg: UserOrg, tenantOrg: TenantOrg);

        await LogAsync(logger, organizationId: CallerOrg);

        // The cross-tenant write guard refuses it, and the logger swallows the exception
        // because an audit failure must never fail the act it is recording. So naming an
        // organization the context does not permit loses the record — quietly, as far as the
        // caller is concerned, and at error level in the log.
        //
        // Pinned because it is a trap: the parameter looks like it overrides everything, and
        // it only overrides the *choice*, never the guard.
        (await CountAsync(db, tenant)).Should().Be(0);
    }

    [Fact]
    public async Task The_tenant_context_is_used_when_there_is_no_user_at_all()
    {
        var (logger, db, tenant) = Create(userOrg: null, tenantOrg: TenantOrg);

        await LogAsync(logger);

        // The one that matters. A schedule firing, a sweep abandoning a scan, anything running
        // outside a request: no user, and before this the record was dropped with a warning.
        // The act happened and the only trace of it was a log line saying nothing was recorded.
        var entry = await SingleAsync(db, tenant);
        entry.OrganizationId.Should().Be(TenantOrg);
        entry.UserId.Should().BeNull("nobody performed it — a schedule did, and saying otherwise "
            + "would name a person for an act they did not commit");
    }

    [Fact]
    public async Task With_no_caller_no_user_and_no_tenant_nothing_is_written()
    {
        var (logger, db, tenant) = Create(userOrg: null, tenantOrg: null);

        await LogAsync(logger);

        // Genuinely unanswerable, and a row against the wrong organization would be worse than
        // no row: it would appear in somebody else's trail. This is the case the logger shouts
        // about rather than the ordinary one it used to shout about.
        (await CountAsync(db, tenant)).Should().Be(0);
    }

    [Fact]
    public async Task An_audit_failure_never_propagates_to_the_caller()
    {
        var (logger, db, _) = Create(userOrg: UserOrg, tenantOrg: null);
        await db.DisposeAsync();

        // A failure to audit is logged, never thrown. Turning a successful operation into a
        // failed one because its record could not be written trades a gap in the trail for a
        // gap in the thing being recorded.
        var act = async () => await LogAsync(logger);
        await act.Should().NotThrowAsync();
    }
}
