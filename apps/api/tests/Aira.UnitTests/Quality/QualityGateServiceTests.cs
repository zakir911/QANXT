using Aira.Application.Abstractions;
using Aira.Application.Quality;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Aira.Domain.Projects;
using Aira.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Aira.UnitTests.Quality;

/// <summary>A quality gate is the only thing standing between a failing run and a release,
/// so a rule that cannot be satisfied — or one that silently accepts nonsense — is worse
/// than no rule at all. These cover the validation and the audit trail that make a gate
/// trustworthy enough to leave switched on.</summary>
public class QualityGateServiceTests
{
    private static readonly Guid OrgId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid UserId = Guid.Parse("33333333-3333-3333-3333-333333333333");

    private sealed class TestTenantContext : ITenantContext
    {
        private int _depth;
        public Guid? OrganizationId { get; private set; }
        public bool IsSystemContext => _depth > 0;
        public void SetOrganization(Guid organizationId) => OrganizationId = organizationId;
        public IDisposable EnterSystemContext(string reason) { _depth++; return new Scope(() => _depth--); }
        private sealed class Scope(Action onDispose) : IDisposable
        {
            public void Dispose() => onDispose();
        }
    }

    private sealed class FixedClock : IClock
    {
        public DateTimeOffset UtcNow { get; } = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    }

    private sealed class TestCurrentUser : ICurrentUser
    {
        public Guid? UserId => QualityGateServiceTests.UserId;
        public Guid? OrganizationId => OrgId;
        public string? Email => "qa.lead@example.test";
        public bool IsAuthenticated => true;
        public IReadOnlySet<string> Permissions => new HashSet<string>();
        public bool HasPermission(string permission) => true;
        public string? CorrelationId => "test";
    }

    /// <summary>Records what was audited, so the tests can assert on it.</summary>
    private sealed class RecordingAuditLogger : IAuditLogger
    {
        public List<(AuditAction Action, string Summary)> Entries { get; } = new();

        public Task LogAsync(AuditAction action, string entityType, Guid? entityId, string summary,
            object? changes = null, bool succeeded = true, Guid? organizationId = null,
            Guid? projectId = null, Guid? userId = null, string? userEmail = null,
            CancellationToken ct = default)
        {
            Entries.Add((action, summary));
            return Task.CompletedTask;
        }
    }

    private static (QualityGateService Service, AiraDbContext Db, RecordingAuditLogger Audit, Guid ProjectId)
        CreateService()
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

        var audit = new RecordingAuditLogger();
        return (new QualityGateService(db, new TestCurrentUser(), new FixedClock(), audit), db, audit, project.Id);
    }

    private static QualityGateRuleRequest Valid(decimal threshold = 95) => new(
        "Pass rate at least 95%", QualityGateMetric.PassRatePercent,
        QualityGateOperator.GreaterThanOrEqual, threshold, true, true);

    [Fact]
    public async Task Creates_a_rule_and_defaults_it_to_blocking_and_enabled()
    {
        var (service, _, _, projectId) = CreateService();

        var result = await service.CreateAsync(projectId, new QualityGateRuleRequest(
            "No failed criticals", QualityGateMetric.CriticalFailedCount,
            QualityGateOperator.Equal, 0, null, null));

        result.IsSuccess.Should().BeTrue();
        result.Value!.IsBlocking.Should().BeTrue();
        result.Value.IsEnabled.Should().BeTrue();
    }

    [Fact]
    public async Task Refuses_a_percentage_threshold_above_one_hundred()
    {
        // A pass rate of at least 120% can never be met, so the gate would block every
        // release forever and get switched off rather than corrected.
        var (service, _, _, projectId) = CreateService();

        var result = await service.CreateAsync(projectId, Valid(threshold: 120));

        result.IsSuccess.Should().BeFalse();
        result.Error!.Kind.Should().Be(ErrorKind.Validation);
        result.Error.Details.Should().ContainKey("threshold");
    }

    [Fact]
    public async Task Allows_a_large_threshold_for_a_metric_that_is_not_a_percentage()
    {
        var (service, _, _, projectId) = CreateService();

        var result = await service.CreateAsync(projectId, new QualityGateRuleRequest(
            "Runs stay under ten minutes", QualityGateMetric.AverageDurationMs,
            QualityGateOperator.LessThan, 600_000, true, true));

        result.IsSuccess.Should().BeTrue();
    }

    [Fact]
    public async Task Refuses_a_negative_threshold()
    {
        var (service, _, _, projectId) = CreateService();

        var result = await service.CreateAsync(projectId, new QualityGateRuleRequest(
            "Nonsense", QualityGateMetric.FailedCount, QualityGateOperator.LessThan, -1, true, true));

        result.IsSuccess.Should().BeFalse();
        result.Error!.Details.Should().ContainKey("threshold");
    }

    [Fact]
    public async Task Refuses_a_rule_with_no_name()
    {
        var (service, _, _, projectId) = CreateService();

        var result = await service.CreateAsync(projectId, new QualityGateRuleRequest(
            "   ", QualityGateMetric.FailedCount, QualityGateOperator.Equal, 0, true, true));

        result.IsSuccess.Should().BeFalse();
        result.Error!.Details.Should().ContainKey("name");
    }

    [Fact]
    public async Task Refuses_a_metric_the_evaluator_cannot_measure()
    {
        // An out-of-range enum arrives from a hand-written request body, and silently
        // storing it would produce a rule that always reads zero.
        var (service, _, _, projectId) = CreateService();

        var result = await service.CreateAsync(projectId, new QualityGateRuleRequest(
            "Invented", (QualityGateMetric)999, QualityGateOperator.Equal, 0, true, true));

        result.IsSuccess.Should().BeFalse();
        result.Error!.Details.Should().ContainKey("metric");
    }

    [Fact]
    public async Task Refuses_to_create_a_rule_for_a_project_that_does_not_exist()
    {
        var (service, _, _, _) = CreateService();

        var result = await service.CreateAsync(Guid.NewGuid(), Valid());

        result.IsSuccess.Should().BeFalse();
        result.Error!.Kind.Should().Be(ErrorKind.NotFound);
    }

    [Fact]
    public async Task Records_what_a_gate_changed_from_and_to()
    {
        // "Who weakened this gate, and from what" is the question asked after a bad
        // release, so both values have to be in the audit entry.
        var (service, _, audit, projectId) = CreateService();
        var created = await service.CreateAsync(projectId, Valid(threshold: 95));

        await service.UpdateAsync(created.Value!.Id, Valid(threshold: 50));

        var entry = audit.Entries.Last();
        entry.Action.Should().Be(AuditAction.QualityGateChanged);
        entry.Summary.Should().Contain("95").And.Contain("50");
    }

    [Fact]
    public async Task Records_a_deletion_with_the_rule_it_removed()
    {
        var (service, _, audit, projectId) = CreateService();
        var created = await service.CreateAsync(projectId, Valid());

        var result = await service.DeleteAsync(created.Value!.Id);

        result.IsSuccess.Should().BeTrue();
        audit.Entries.Last().Summary.Should().Contain("deleted");
    }

    [Fact]
    public async Task Disabling_a_rule_leaves_it_stored_rather_than_removing_it()
    {
        var (service, db, _, projectId) = CreateService();
        var created = await service.CreateAsync(projectId, Valid());

        await service.UpdateAsync(created.Value!.Id, Valid() with { IsEnabled = false });

        var stored = await db.QualityGateRules.SingleAsync();
        stored.IsEnabled.Should().BeFalse();
        stored.Name.Should().Be("Pass rate at least 95%");
    }

    [Fact]
    public async Task Lists_only_the_rules_of_the_project_asked_for()
    {
        var (service, db, _, projectId) = CreateService();
        await service.CreateAsync(projectId, Valid());

        var other = new Project { OrganizationId = OrgId, Name = "Other", Key = "OTHER" };
        db.Projects.Add(other);
        await db.SaveChangesAsync();
        await service.CreateAsync(other.Id, Valid() with { Name = "Something else" });

        var result = await service.ListAsync(projectId);

        result.IsSuccess.Should().BeTrue();
        result.Value!.Should().ContainSingle().Which.Name.Should().Be("Pass rate at least 95%");
    }
}
