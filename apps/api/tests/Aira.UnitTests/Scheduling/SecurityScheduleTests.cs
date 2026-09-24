using Aira.Application.Abstractions;
using Aira.Application.Projects;
using Aira.Application.Scheduling;
using Aira.Application.Security;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Aira.Domain.Projects;
using Aira.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using ApplicationEntity = Aira.Domain.Applications.Application;

namespace Aira.UnitTests.Scheduling;

/// <summary>
/// What may be scheduled to run against an application unattended.
/// </summary>
/// <remarks>
/// <para>
/// A schedule is a standing instruction. Everything dangerous about security testing is
/// dangerous precisely because nobody is watching when it fires, so the question these pin is
/// not "does it work" but "what can it be pointed at, and by whom".
/// </para>
/// <para>
/// The refusal that matters most is not here, because it cannot be: destructive testing and
/// production scanning are refused at the moment of the scan by the launcher, reading
/// permissions a background sweep does not hold. Those are covered where the launcher is. What
/// is here is the other half — who may set one up at all, and what a schedule that points
/// nowhere does.
/// </para>
/// </remarks>
public class SecurityScheduleTests
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

    private sealed class TestUser : ICurrentUser
    {
        private readonly HashSet<string> _permissions;
        public TestUser(params string[] permissions) => _permissions = new HashSet<string>(permissions);
        public Guid? UserId { get; } = Guid.Parse("33333333-3333-3333-3333-333333333333");
        public Guid? OrganizationId => OrgId;
        public string? Email => "qa.lead@example.test";
        public bool IsAuthenticated => true;
        public IReadOnlySet<string> Permissions => _permissions;
        public bool HasPermission(string permission) => _permissions.Contains(permission);
        public string? CorrelationId => null;
    }

    /// <summary>Nothing here resolves an environment; a security schedule names none.</summary>
    private sealed class NoEnvironments : IEnvironmentService
    {
        public Task<IReadOnlyList<EnvironmentSummary>> ListAsync(Guid? projectId, CancellationToken ct = default)
            => Task.FromResult<IReadOnlyList<EnvironmentSummary>>(Array.Empty<EnvironmentSummary>());
        public Task<Result<EnvironmentSummary>> GetAsync(Guid id, CancellationToken ct = default)
            => Task.FromResult(Result<EnvironmentSummary>.Failure(Error.NotFound("The environment")));
        public Task<Result<EnvironmentSummary>> ResolveAsync(Guid projectId, string key, CancellationToken ct = default)
            => Task.FromResult(Result<EnvironmentSummary>.Failure(Error.NotFound("The environment")));
        public Task<Result<EnvironmentSummary>> CreateAsync(CreateEnvironmentRequest request, CancellationToken ct = default)
            => throw new NotSupportedException();
        public Task<Result<EnvironmentSummary>> UpdateAsync(Guid id, UpdateEnvironmentRequest request, CancellationToken ct = default)
            => throw new NotSupportedException();
        public Task<Result<EnvironmentSummary>> AuthorizeProductionAsync(Guid id, AuthorizeProductionRequest request, CancellationToken ct = default)
            => throw new NotSupportedException();
        public Task<Result> DeleteAsync(Guid id, CancellationToken ct = default)
            => throw new NotSupportedException();
        public Task<Result<EnvironmentSummary>> EnsureTestableAsync(Guid id, CancellationToken ct = default)
            => Task.FromResult(Result<EnvironmentSummary>.Failure(Error.NotFound("The environment")));
    }

    private sealed class SilentAudit : IAuditLogger
    {
        public Task LogAsync(AuditAction action, string entityType, Guid? entityId, string summary,
            object? changes = null, bool succeeded = true, Guid? organizationId = null,
            Guid? projectId = null, Guid? userId = null, string? userEmail = null,
            CancellationToken ct = default) => Task.CompletedTask;
    }

    private static (ScheduleService Service, AiraDbContext Db, Guid ProjectId, Guid ApplicationId)
        Create(params string[] permissions)
    {
        var tenant = new TestTenantContext();
        var options = new DbContextOptionsBuilder<AiraDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(
                Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new AiraDbContext(options, tenant, new FixedClock());

        var project = new Project { OrganizationId = OrgId, Name = "Retail Banking", Key = "BANK" };
        var application = new ApplicationEntity
        {
            OrganizationId = OrgId, Name = "Internet Bank", BaseUrl = "https://bank.example.test"
        };

        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
            db.SaveChanges();
            application.ProjectId = project.Id;
            db.Applications.Add(application);
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        var service = new ScheduleService(db, new TestUser(permissions), new NoEnvironments(),
            new SilentAudit(), new FixedClock(), NullLogger<ScheduleService>.Instance);
        return (service, db, project.Id, application.Id);
    }

    private static CreateScheduleRequest Request(Guid projectId, Guid? applicationId,
        ScheduleKind kind = ScheduleKind.SecurityScan)
        => new(ProjectId: projectId, Name: "Nightly security scan",
               CronExpression: "0 2 * * *", TimeZone: "UTC",
               TestSuiteId: null, IncludeTags: null, EnvironmentId: null, Browser: null,
               Kind: kind, ApplicationId: applicationId);

    // -----------------------------------------------------------------------

    [Fact]
    public async Task Scheduling_a_security_scan_needs_security_scan_as_well_as_project_write()
    {
        var (service, _, projectId, applicationId) = Create(Permissions.ProjectWrite);

        var result = await service.CreateAsync(Request(projectId, applicationId));

        // Otherwise project:write alone is a route to recurring security scans, which is a
        // larger authority than the permission was granted for.
        result.IsSuccess.Should().BeFalse();
        result.Error!.Message.Should().Contain("security:scan");
    }

    [Fact]
    public async Task A_holder_of_both_may_schedule_one()
    {
        var (service, db, projectId, applicationId) =
            Create(Permissions.ProjectWrite, Permissions.SecurityScan);

        var result = await service.CreateAsync(Request(projectId, applicationId));

        result.IsSuccess.Should().BeTrue(result.Error?.Message);
        result.Value!.Kind.Should().Be(ScheduleKind.SecurityScan);
        result.Value.ApplicationId.Should().Be(applicationId);

        var stored = await db.Schedules.FirstAsync();
        stored.Kind.Should().Be(ScheduleKind.SecurityScan);
        stored.ApplicationId.Should().Be(applicationId);
        stored.NextRunAt.Should().NotBeNull();
    }

    [Fact]
    public async Task A_security_schedule_with_no_application_is_refused()
    {
        var (service, _, projectId, _) =
            Create(Permissions.ProjectWrite, Permissions.SecurityScan);

        var result = await service.CreateAsync(Request(projectId, applicationId: null));

        // A schedule that fires for ever and starts nothing reads in a list exactly like one
        // that is working, which is the worst way for a coverage gap to look.
        result.IsSuccess.Should().BeFalse();
        result.Error!.Message.Should().Contain("application");
    }

    [Fact]
    public async Task A_security_schedule_cannot_point_at_another_projects_application()
    {
        var (service, db, projectId, _) =
            Create(Permissions.ProjectWrite, Permissions.SecurityScan);

        var elsewhere = new ApplicationEntity
        {
            OrganizationId = OrgId, ProjectId = Guid.NewGuid(),
            Name = "Someone else's", BaseUrl = "https://elsewhere.example.test"
        };
        db.Applications.Add(elsewhere);
        await db.SaveChangesAsync();

        var result = await service.CreateAsync(Request(projectId, elsewhere.Id));

        result.IsSuccess.Should().BeFalse();
        result.Error!.Message.Should().Contain("not in this project");
    }

    [Fact]
    public async Task A_test_run_schedule_is_unaffected_and_stores_no_application()
    {
        var (service, db, projectId, applicationId) = Create(Permissions.ProjectWrite);

        // No security:scan, and none needed: this is the schedule that always existed.
        var result = await service.CreateAsync(
            Request(projectId, applicationId, ScheduleKind.TestRun));

        result.IsSuccess.Should().BeTrue(result.Error?.Message);
        result.Value!.Kind.Should().Be(ScheduleKind.TestRun);
        // An application id on a test-run schedule would be a field nothing reads and a reader
        // could easily believe means something.
        (await db.Schedules.FirstAsync()).ApplicationId.Should().BeNull();
    }
}
