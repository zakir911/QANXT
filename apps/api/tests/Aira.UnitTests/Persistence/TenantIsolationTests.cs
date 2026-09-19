using Aira.Application.Abstractions;
using Aira.Domain.Projects;
using Aira.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Aira.UnitTests.Persistence;

/// <summary>Tenant isolation is enforced by the DbContext itself, not by callers remembering
/// a filter. These tests exercise that guarantee directly: a query written without any
/// organization predicate must still see only the current tenant's rows, and a write that
/// crosses tenants must be refused.</summary>
public class TenantIsolationTests
{
    private sealed class TestTenantContext : ITenantContext
    {
        private int _systemDepth;
        public Guid? OrganizationId { get; private set; }
        public bool IsSystemContext => _systemDepth > 0;
        public void SetOrganization(Guid organizationId) => OrganizationId = organizationId;
        public IDisposable EnterSystemContext(string reason)
        {
            _systemDepth++;
            return new Scope(() => _systemDepth--);
        }
        private sealed class Scope : IDisposable
        {
            private readonly Action _onDispose;
            public Scope(Action onDispose) => _onDispose = onDispose;
            public void Dispose() => _onDispose();
        }
    }

    private sealed class FixedClock : IClock
    {
        public DateTimeOffset UtcNow { get; } = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    }

    private static AiraDbContext CreateContext(ITenantContext tenant, string databaseName)
    {
        var options = new DbContextOptionsBuilder<AiraDbContext>()
            .UseInMemoryDatabase(databaseName)
            .ConfigureWarnings(w => w.Ignore(Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        return new AiraDbContext(options, tenant, new FixedClock());
    }

    private static readonly Guid OrgA = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid OrgB = Guid.Parse("22222222-2222-2222-2222-222222222222");

    [Fact]
    public async Task A_query_without_any_organization_predicate_sees_only_the_current_tenant()
    {
        var databaseName = Guid.NewGuid().ToString();
        var tenant = new TestTenantContext();

        using (var seeding = CreateContext(tenant, databaseName))
        {
            using (tenant.EnterSystemContext("seed"))
            {
                seeding.Projects.Add(new Project { OrganizationId = OrgA, Name = "Alpha", Key = "ALPHA" });
                seeding.Projects.Add(new Project { OrganizationId = OrgB, Name = "Beta", Key = "BETA" });
                await seeding.SaveChangesAsync();
            }
        }

        tenant.SetOrganization(OrgA);
        using var context = CreateContext(tenant, databaseName);

        var projects = await context.Projects.ToListAsync();

        projects.Should().ContainSingle();
        projects[0].Name.Should().Be("Alpha");
    }

    [Fact]
    public async Task Fetching_another_tenants_row_by_its_primary_key_returns_nothing()
    {
        var databaseName = Guid.NewGuid().ToString();
        var tenant = new TestTenantContext();
        var foreignProjectId = Guid.NewGuid();

        using (var seeding = CreateContext(tenant, databaseName))
        using (tenant.EnterSystemContext("seed"))
        {
            seeding.Projects.Add(new Project { Id = foreignProjectId, OrganizationId = OrgB, Name = "Beta", Key = "BETA" });
            await seeding.SaveChangesAsync();
        }

        tenant.SetOrganization(OrgA);
        using var context = CreateContext(tenant, databaseName);

        var found = await context.Projects.FirstOrDefaultAsync(p => p.Id == foreignProjectId);

        found.Should().BeNull("a direct id lookup must not bypass the tenant filter");
    }

    [Fact]
    public async Task A_write_that_crosses_tenants_is_refused()
    {
        var tenant = new TestTenantContext();
        tenant.SetOrganization(OrgA);
        using var context = CreateContext(tenant, Guid.NewGuid().ToString());

        context.Projects.Add(new Project { OrganizationId = OrgB, Name = "Smuggled", Key = "SMUG" });

        var act = async () => await context.SaveChangesAsync();

        await act.Should().ThrowAsync<InvalidOperationException>()
            .WithMessage("*Cross-tenant write blocked*");
    }

    [Fact]
    public async Task New_entities_are_stamped_with_the_current_tenant_automatically()
    {
        var tenant = new TestTenantContext();
        tenant.SetOrganization(OrgA);
        using var context = CreateContext(tenant, Guid.NewGuid().ToString());

        context.Projects.Add(new Project { Name = "Implicit", Key = "IMP" });
        await context.SaveChangesAsync();

        var project = await context.Projects.SingleAsync();
        project.OrganizationId.Should().Be(OrgA);
        project.CreatedAt.Should().Be(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
    }

    [Fact]
    public async Task A_system_context_can_read_across_tenants_for_background_work()
    {
        var databaseName = Guid.NewGuid().ToString();
        var tenant = new TestTenantContext();

        using (var seeding = CreateContext(tenant, databaseName))
        using (tenant.EnterSystemContext("seed"))
        {
            seeding.Projects.Add(new Project { OrganizationId = OrgA, Name = "Alpha", Key = "ALPHA" });
            seeding.Projects.Add(new Project { OrganizationId = OrgB, Name = "Beta", Key = "BETA" });
            await seeding.SaveChangesAsync();
        }

        tenant.SetOrganization(OrgA);
        using var context = CreateContext(tenant, databaseName);

        using (tenant.EnterSystemContext("scheduled job"))
        {
            (await context.Projects.CountAsync()).Should().Be(2);
        }
    }

    [Fact]
    public async Task Soft_deleted_rows_leave_normal_queries_but_remain_stored()
    {
        var databaseName = Guid.NewGuid().ToString();
        var tenant = new TestTenantContext();
        tenant.SetOrganization(OrgA);

        Guid projectId;
        using (var context = CreateContext(tenant, databaseName))
        {
            var project = new Project { OrganizationId = OrgA, Name = "Retired", Key = "RET" };
            context.Projects.Add(project);
            await context.SaveChangesAsync();
            projectId = project.Id;

            project.DeletedAt = new DateTimeOffset(2026, 2, 1, 0, 0, 0, TimeSpan.Zero);
            await context.SaveChangesAsync();
        }

        using (var context = CreateContext(tenant, databaseName))
        {
            (await context.Projects.AnyAsync(p => p.Id == projectId)).Should().BeFalse();
            (await context.Projects.IgnoreQueryFilters().AnyAsync(p => p.Id == projectId)).Should().BeTrue();
        }
    }
}
