using QaNxt.Application.Abstractions;
using QaNxt.Application.Agent;
using QaNxt.Application.Security;
using QaNxt.Domain.Agent;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Projects;
using QaNxt.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace QaNxt.UnitTests.Agent;

/// <summary>
/// Approving, changing and refusing what a pass proposes to test.
/// </summary>
/// <remarks>
/// This is the moment work starts against a live environment, so the tests are about who may
/// do it, what a decision leaves behind, and the two shapes of plan that must not be allowed
/// through: one nobody can refuse intelligently, and one that would run nothing while
/// reporting as though it had run.
/// </remarks>
public class AgentPlanServiceTests
{
    private static readonly Guid OrgId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly DateTimeOffset Noon = new(2026, 9, 25, 12, 0, 0, TimeSpan.Zero);

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

    private sealed class SilentAudit : IAuditLogger
    {
        public Task LogAsync(AuditAction action, string entityType, Guid? entityId, string summary,
            object? changes = null, bool succeeded = true, Guid? organizationId = null,
            Guid? projectId = null, Guid? userId = null, string? userEmail = null,
            CancellationToken ct = default) => Task.CompletedTask;
    }

    private static (AgentPlanService Service, QaNxtDbContext Db, Guid RunId, Guid PlanId)
        Create(params string[] permissions)
    {
        var tenant = new TestTenantContext();
        var options = new DbContextOptionsBuilder<QaNxtDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(
                Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new QaNxtDbContext(options, tenant, new FixedClock());

        var project = new Project { OrganizationId = OrgId, Name = "Retail Banking", Key = "BANK" };
        var run = new AgentRun
        {
            OrganizationId = OrgId, ProjectId = project.Id, ApplicationId = Guid.NewGuid(),
            Name = "Release validation", Status = AgentRunStatus.AwaitingApproval,
            Phase = AgentPhase.AwaitingApproval
        };
        var plan = new AgentTestPlan
        {
            OrganizationId = OrgId, AgentRunId = run.Id, ApplicationId = run.ApplicationId,
            Objective = "Release validation", Status = AgentPlanStatus.Proposed,
            Summary = "213 test(s) across 4 category(ies).",
            NotCovered = "Anything discovery did not reach."
        };
        plan.Items.Add(Item(AgentPlanCategory.Smoke, 18));
        plan.Items.Add(Item(AgentPlanCategory.CriticalJourney, 32));
        plan.Items.Add(Item(AgentPlanCategory.Api, 41));
        plan.Items.Add(Item(AgentPlanCategory.Security, 27));

        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
            db.AgentRuns.Add(run);
            db.AgentTestPlans.Add(plan);
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        var journal = new AgentJournal(db, new FixedClock(), new SecretMasker());
        var service = new AgentPlanService(
            db, new TestUser(permissions), new FixedClock(), new SilentAudit(), journal);
        return (service, db, run.Id, plan.Id);
    }

    private static AgentTestPlanItem Item(AgentPlanCategory category, int count)
        => new()
        {
            OrganizationId = OrgId, Category = category, TestCount = count,
            Why = $"{count} test(s) because the category applies to this application.",
            Coverage = "some", PotentialImpact = "some", EstimatedSeconds = count * 10,
            Included = true
        };

    // -----------------------------------------------------------------------

    [Fact]
    public async Task A_proposed_plan_reads_back_with_its_categories_and_what_it_misses()
    {
        var (service, _, runId, _) = Create(Permissions.ExecutionRun);

        var plan = (await service.GetAsync(runId)).Value!;

        plan.Status.Should().Be(AgentPlanStatus.Proposed);
        plan.Items.Should().HaveCount(4);
        plan.TotalTests.Should().Be(118);
        plan.NotCovered.Should().NotBeEmpty();
    }

    [Fact]
    public async Task Approving_a_plan_needs_permission_to_start_a_run()
    {
        var (service, _, runId, _) = Create(Permissions.TestRead);

        var result = await service.DecideAsync(runId, new PlanDecisionRequest(true, null, null));

        // Reading test results is not a reason to be able to start hundreds of them.
        result.IsSuccess.Should().BeFalse();
        result.Error!.Message.Should().Contain("execution:run");
    }

    [Fact]
    public async Task Approving_a_plan_queues_the_run_again_to_resume_from_generation()
    {
        var (service, db, runId, _) = Create(Permissions.ExecutionRun);

        await service.DecideAsync(runId, new PlanDecisionRequest(true, null, "Looks right."));

        var run = await db.AgentRuns.FirstAsync(r => r.Id == runId);
        run.Status.Should().Be(AgentRunStatus.Queued);
        // Generation onward. Crawling again would change the application map underneath the
        // plan this person just approved, and re-planning would ask them the same question.
        run.ResumeFromPhase.Should().Be(AgentPhase.Generating);
        run.StopReason.Should().BeNull();
    }

    [Fact]
    public async Task Rejecting_a_plan_stops_the_run_and_records_who_and_why()
    {
        var (service, db, runId, _) = Create(Permissions.ExecutionRun);

        await service.DecideAsync(runId, new PlanDecisionRequest(
            false, null, "Not against staging during the migration window."));

        var run = await db.AgentRuns.FirstAsync(r => r.Id == runId);
        run.Status.Should().Be(AgentRunStatus.Stopped);
        run.StopReason.Should().Contain("migration window");
        run.StopReason.Should().Contain("qa.lead@example.test");

        var plan = await db.AgentTestPlans.FirstAsync();
        plan.Status.Should().Be(AgentPlanStatus.Rejected);
        plan.DecidedByEmail.Should().Be("qa.lead@example.test");
        plan.DecidedAt.Should().Be(Noon);
    }

    [Fact]
    public async Task Rejecting_a_plan_without_a_reason_is_refused()
    {
        var (service, _, runId, _) = Create(Permissions.ExecutionRun);

        var result = await service.DecideAsync(runId, new PlanDecisionRequest(false, null, "   "));

        // A refusal with no reason leaves the next person to propose the same plan again, and
        // the one after that.
        result.IsSuccess.Should().BeFalse();
        result.Error!.Message.Should().Contain("needs a reason");
    }

    [Fact]
    public async Task Switching_a_category_off_leaves_it_in_the_plan_marked_excluded()
    {
        var (service, db, runId, _) = Create(Permissions.ExecutionRun);

        await service.DecideAsync(runId, new PlanDecisionRequest(
            true,
            new[] { AgentPlanCategory.Smoke, AgentPlanCategory.Api },
            "Skipping security this cycle; the scope is being rewritten."));

        var items = await db.AgentTestPlanItems.ToListAsync();

        // Deleting it would make "we chose not to run security" and "security was never
        // proposed" look identical on a short plan, and only one of those is a decision.
        items.Should().HaveCount(4);
        items.Where(i => i.Included).Select(i => i.Category)
            .Should().BeEquivalentTo(new[] { AgentPlanCategory.Smoke, AgentPlanCategory.Api });
    }

    [Fact]
    public async Task The_totals_reflect_what_is_still_included()
    {
        var (service, _, runId, _) = Create(Permissions.ExecutionRun);

        var result = await service.DecideAsync(runId, new PlanDecisionRequest(
            true, new[] { AgentPlanCategory.Smoke }, "Smoke only."));

        result.Value!.TotalTests.Should().Be(18);
    }

    [Fact]
    public async Task Approving_a_plan_with_everything_switched_off_is_refused()
    {
        var (service, _, runId, _) = Create(Permissions.ExecutionRun);

        var result = await service.DecideAsync(runId, new PlanDecisionRequest(
            true, Array.Empty<AgentPlanCategory>(), "Changed my mind."));

        // The shape that matters: a pass that tests nothing and finishes reporting as though
        // it had run is worse than a pass nobody started.
        result.IsSuccess.Should().BeFalse();
        result.Error!.Message.Should().Contain("tests nothing");
        result.Error.Message.Should().Contain("Reject it instead");
    }

    [Fact]
    public async Task A_plan_is_decided_once()
    {
        var (service, _, runId, _) = Create(Permissions.ExecutionRun);

        await service.DecideAsync(runId, new PlanDecisionRequest(true, null, "Approved."));
        var second = await service.DecideAsync(runId, new PlanDecisionRequest(false, null, "Actually no."));

        second.IsSuccess.Should().BeFalse();
        second.Error!.Message.Should().Contain("already approved");
        second.Error.Message.Should().Contain("qa.lead@example.test");
    }

    [Fact]
    public async Task A_decision_is_written_to_the_agent_s_own_record_with_its_evidence()
    {
        var (service, db, runId, _) = Create(Permissions.ExecutionRun);

        await service.DecideAsync(runId, new PlanDecisionRequest(
            true, new[] { AgentPlanCategory.Smoke }, "Smoke only for this cycle."));

        var decision = await db.AgentDecisions.SingleAsync();
        decision.Phase.Should().Be(AgentPhase.Planning);
        decision.Reason.Should().Contain("Smoke only");

        // The journal masks free text on the way in, so the narrative carries a partly
        // redacted address — right for something that gets exported, and useless on its own as
        // a record of who decided. The user id rides alongside it precisely for that.
        decision.Summary.Should().Contain("approved by");
        decision.Summary.Should().NotContain("qa.lead@example.test");
        decision.ActorUserId.Should().Be(Guid.Parse("33333333-3333-3333-3333-333333333333"));
        // What was dropped is evidence too. A pass that ran a quarter of its plan should not
        // have to be reverse-engineered from the test count.
        decision.EvidenceJson.Should().Contain("categoriesExcluded");
        decision.EvidenceJson.Should().Contain("Security");
    }

    [Fact]
    public async Task A_run_with_no_plan_says_so_rather_than_inventing_one()
    {
        var (service, _, _, _) = Create(Permissions.ExecutionRun);

        (await service.GetAsync(Guid.NewGuid())).IsSuccess.Should().BeFalse();
    }
}
