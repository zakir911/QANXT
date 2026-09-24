using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Aira.Application.Abstractions;
using Aira.Domain.Ai;
using Aira.Domain.Agent;
using Aira.Domain.Applications;
using Aira.Domain.Audit;
using Aira.Domain.Security;
using Aira.Domain.Common;
using Aira.Domain.Diagnosis;
using Aira.Domain.Evidence;
using Aira.Domain.Identity;
using Aira.Domain.Projects;
using Aira.Domain.Testing;

namespace Aira.Infrastructure.Persistence;

public class AiraDbContext : DbContext, IAiraDbContext
{
    private readonly ITenantContext _tenant;
    private readonly IClock _clock;

    public AiraDbContext(DbContextOptions<AiraDbContext> options, ITenantContext tenant, IClock clock)
        : base(options)
    {
        _tenant = tenant;
        _clock = clock;
    }

    public DbSet<Organization> Organizations => Set<Organization>();
    public DbSet<User> Users => Set<User>();
    public DbSet<Role> Roles => Set<Role>();
    public DbSet<Permission> Permissions => Set<Permission>();
    public DbSet<RolePermission> RolePermissions => Set<RolePermission>();
    public DbSet<UserRole> UserRoles => Set<UserRole>();
    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();

    public DbSet<Project> Projects => Set<Project>();
    public DbSet<Domain.Projects.Environment> Environments => Set<Domain.Projects.Environment>();
    public DbSet<QualityGateRule> QualityGateRules => Set<QualityGateRule>();
    public DbSet<Integration> Integrations => Set<Integration>();
    public DbSet<Schedule> Schedules => Set<Schedule>();
    public DbSet<NotificationDelivery> NotificationDeliveries => Set<NotificationDelivery>();
    public DbSet<VisualBaseline> VisualBaselines => Set<VisualBaseline>();

    public DbSet<Domain.Applications.Application> Applications => Set<Domain.Applications.Application>();
    public DbSet<DiscoveryRun> DiscoveryRuns => Set<DiscoveryRun>();

    public DbSet<AgentRun> AgentRuns => Set<AgentRun>();
    public DbSet<AgentStep> AgentSteps => Set<AgentStep>();
    public DbSet<AgentFinding> AgentFindings => Set<AgentFinding>();
    public DbSet<ApplicationPage> ApplicationPages => Set<ApplicationPage>();
    public DbSet<PageTransition> PageTransitions => Set<PageTransition>();
    public DbSet<ApplicationElement> ApplicationElements => Set<ApplicationElement>();
    public DbSet<ApiEndpoint> ApiEndpoints => Set<ApiEndpoint>();
    public DbSet<ApiContract> ApiContracts => Set<ApiContract>();
    public DbSet<ChangeImpactRule> ChangeImpactRules => Set<ChangeImpactRule>();
    public DbSet<ApiContractChange> ApiContractChanges => Set<ApiContractChange>();
    public DbSet<Journey> Journeys => Set<Journey>();
    public DbSet<JourneyStep> JourneySteps => Set<JourneyStep>();

    public DbSet<TestSuite> TestSuites => Set<TestSuite>();
    public DbSet<TestCase> TestCases => Set<TestCase>();
    public DbSet<TestStep> TestSteps => Set<TestStep>();
    public DbSet<Assertion> Assertions => Set<Assertion>();
    public DbSet<TestDataSet> TestDataSets => Set<TestDataSet>();
    public DbSet<TestDataField> TestDataFields => Set<TestDataField>();
    public DbSet<TestRun> TestRuns => Set<TestRun>();
    public DbSet<TestExecution> TestExecutions => Set<TestExecution>();
    public DbSet<TestAction> TestActions => Set<TestAction>();

    public DbSet<Artifact> Artifacts => Set<Artifact>();
    public DbSet<NetworkEvent> NetworkEvents => Set<NetworkEvent>();
    public DbSet<ConsoleEvent> ConsoleEvents => Set<ConsoleEvent>();

    public DbSet<Failure> Failures => Set<Failure>();
    public DbSet<FailureAnalysis> FailureAnalyses => Set<FailureAnalysis>();
    public DbSet<LocatorCandidate> LocatorCandidates => Set<LocatorCandidate>();
    public DbSet<HealingEvent> HealingEvents => Set<HealingEvent>();
    public DbSet<Defect> Defects => Set<Defect>();

    public DbSet<AiRequest> AiRequests => Set<AiRequest>();
    public DbSet<AiResponse> AiResponses => Set<AiResponse>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();

    public DbSet<SecurityScope> SecurityScopes => Set<SecurityScope>();
    public DbSet<SecurityScan> SecurityScans => Set<SecurityScan>();
    public DbSet<SecurityFinding> SecurityFindings => Set<SecurityFinding>();
    public DbSet<SecurityBlockedRequest> SecurityBlockedRequests => Set<SecurityBlockedRequest>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        builder.ApplyConfigurationsFromAssembly(typeof(AiraDbContext).Assembly);

        // Global filters are applied once per entity type. EF Core re-evaluates the captured
        // context properties for the instance executing the query, which is what makes a
        // request-scoped tenant work with a cached model.
        foreach (var entityType in builder.Model.GetEntityTypes())
        {
            var clrType = entityType.ClrType;
            var tenantOwned = typeof(ITenantOwned).IsAssignableFrom(clrType);
            var softDeletable = typeof(ISoftDeletable).IsAssignableFrom(clrType);

            var methodName = (tenantOwned, softDeletable) switch
            {
                (true, true) => nameof(ApplyTenantAndSoftDeleteFilter),
                (true, false) => nameof(ApplyTenantFilter),
                (false, true) => nameof(ApplySoftDeleteFilter),
                _ => null
            };
            if (methodName is null) continue;

            typeof(AiraDbContext)
                .GetMethod(methodName, System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!
                .MakeGenericMethod(clrType)
                .Invoke(this, new object[] { builder });
        }

        builder.ApplySnakeCaseNames();
    }

    private void ApplyTenantFilter<T>(ModelBuilder builder) where T : class, ITenantOwned
        => builder.Entity<T>().HasQueryFilter(e =>
            IsSystemContext || CurrentTenantId == null || e.OrganizationId == CurrentTenantId);

    private void ApplySoftDeleteFilter<T>(ModelBuilder builder) where T : class, ISoftDeletable
        => builder.Entity<T>().HasQueryFilter(e => e.DeletedAt == null);

    private void ApplyTenantAndSoftDeleteFilter<T>(ModelBuilder builder) where T : class, ITenantOwned, ISoftDeletable
        => builder.Entity<T>().HasQueryFilter(e =>
            (IsSystemContext || CurrentTenantId == null || e.OrganizationId == CurrentTenantId)
            && e.DeletedAt == null);

    /// <summary>Exposed for the query-filter expression; not part of the public contract.</summary>
    public Guid? CurrentTenantId => _tenant.OrganizationId;
    public bool IsSystemContext => _tenant.IsSystemContext;

    public override Task<int> SaveChangesAsync(CancellationToken ct = default)
    {
        ApplyTimestampsAndTenant();
        return base.SaveChangesAsync(ct);
    }

    Task<int> IAiraDbContext.SaveChangesAsync(CancellationToken ct) => SaveChangesAsync(ct);

    public async Task<T> InTransactionAsync<T>(Func<CancellationToken, Task<T>> operation, CancellationToken ct = default)
    {
        // The in-memory provider used by unit tests has no transaction support; running the
        // operation directly there keeps those tests meaningful without faking persistence.
        if (Database.ProviderName?.Contains("InMemory", StringComparison.Ordinal) == true)
            return await operation(ct).ConfigureAwait(false);

        // Connection resiliency retries a failed command, which would replay only part of a
        // manual transaction. EF therefore requires the whole transaction to run inside the
        // execution strategy so a retry restarts it from the beginning.
        var strategy = Database.CreateExecutionStrategy();
        return await strategy.ExecuteAsync(async () =>
        {
            await using var transaction = await Database.BeginTransactionAsync(ct).ConfigureAwait(false);
            try
            {
                var result = await operation(ct).ConfigureAwait(false);
                await transaction.CommitAsync(ct).ConfigureAwait(false);
                return result;
            }
            catch
            {
                await transaction.RollbackAsync(ct).ConfigureAwait(false);
                throw;
            }
        }).ConfigureAwait(false);
    }

    /// <summary>Stamps timestamps and the owning tenant, and refuses writes that would
    /// place a row in a different tenant than the current context — the write-side twin
    /// of the query filter.</summary>
    private void ApplyTimestampsAndTenant()
    {
        var now = _clock.UtcNow;
        foreach (var entry in ChangeTracker.Entries())
        {
            if (entry.Entity is BaseEntity entity)
            {
                if (entry.State == EntityState.Added && entity.CreatedAt == default) entity.CreatedAt = now;
                if (entry.State == EntityState.Modified) entity.UpdatedAt = now;
            }

            if (entry.Entity is ITenantOwned owned && entry.State is EntityState.Added or EntityState.Modified)
                EnforceTenant(entry, owned);
        }
    }

    private void EnforceTenant(EntityEntry entry, ITenantOwned owned)
    {
        if (_tenant.IsSystemContext) return;
        var tenantId = _tenant.OrganizationId;
        if (tenantId is null) return;

        if (entry.State == EntityState.Added && owned.OrganizationId == Guid.Empty)
        {
            owned.OrganizationId = tenantId.Value;
            return;
        }

        if (owned.OrganizationId != tenantId.Value)
        {
            throw new InvalidOperationException(
                $"Cross-tenant write blocked: {entry.Entity.GetType().Name} belongs to organization " +
                $"{owned.OrganizationId} but the current context is {tenantId.Value}.");
        }
    }
}
