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
/// Answering a question the agent stopped to ask, and what that releases.
/// </summary>
/// <remarks>
/// <para>
/// Written after a real pass got stuck. The approval was granted, the API answered 200 with
/// "granted", the audit entry was written — and the run sat at AwaitingApproval for ever,
/// because the check for "is anything else still pending" queried the database while the
/// approval's new status existed only in the change tracker. Every visible signal said it had
/// worked.
/// </para>
/// <para>
/// That is the shape these tests exist for: a workflow whose last step silently does nothing.
/// Each one asserts on the run's state afterwards rather than on the response, because the
/// response was right the whole time.
/// </para>
/// </remarks>
public class AgentApprovalFlowTests
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

    private static (AgentObservabilityService Service, QaNxtDbContext Db, Guid RunId, List<Guid> ApprovalIds)
        Create(int approvals = 1, params string[] permissions)
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
            Name = "Release validation",
            Status = AgentRunStatus.AwaitingApproval, Phase = AgentPhase.AwaitingApproval,
            ResumeFromPhase = AgentPhase.SecurityTesting,
            StopReason = "Waiting for somebody to answer: whether to scan this application"
        };

        var ids = new List<Guid>();
        var tools = new[] { "security.scan", "test.execute" };
        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
            db.AgentRuns.Add(run);
            for (var i = 0; i < approvals; i++)
            {
                var approval = new AgentApproval
                {
                    OrganizationId = OrgId, AgentRunId = run.Id, Tool = tools[i],
                    Reason = "requires approval", Proposal = "do the thing",
                    Risk = "StateChanging", Status = AgentApprovalStatus.Pending
                };
                db.AgentApprovals.Add(approval);
                ids.Add(approval.Id);
            }
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        var service = new AgentObservabilityService(
            db, new TestUser(permissions.Length == 0 ? new[] { Permissions.ExecutionRun } : permissions),
            new FixedClock(), new SilentAudit());
        return (service, db, run.Id, ids);
    }

    private static AgentApprovalDecisionRequest Grant(string why = "Authorized for this staging pass.")
        => new(true, why);

    // -----------------------------------------------------------------------

    [Fact]
    public async Task Granting_the_last_question_queues_the_run_again()
    {
        var (service, db, runId, approvals) = Create();

        var result = await service.DecideApprovalAsync(approvals[0], Grant());

        result.IsSuccess.Should().BeTrue(result.Error?.Message);

        // The assertion the original bug would have failed. The response was right; the run
        // was the thing that never moved.
        var run = await db.AgentRuns.FirstAsync(r => r.Id == runId);
        run.Status.Should().Be(AgentRunStatus.Queued);
        run.StopReason.Should().BeNull();
        run.ResumeFromPhase.Should().Be(AgentPhase.SecurityTesting,
            "it picks up at the phase that asked rather than starting over");
    }

    [Fact]
    public async Task A_run_with_another_question_outstanding_stays_parked()
    {
        var (service, db, runId, approvals) = Create(approvals: 2);

        await service.DecideApprovalAsync(approvals[0], Grant());

        (await db.AgentRuns.FirstAsync(r => r.Id == runId))
            .Status.Should().Be(AgentRunStatus.AwaitingApproval);
    }

    [Fact]
    public async Task Answering_both_questions_releases_the_run()
    {
        var (service, db, runId, approvals) = Create(approvals: 2);

        await service.DecideApprovalAsync(approvals[0], Grant());
        await service.DecideApprovalAsync(approvals[1], Grant());

        (await db.AgentRuns.FirstAsync(r => r.Id == runId))
            .Status.Should().Be(AgentRunStatus.Queued);
    }

    [Fact]
    public async Task Refusing_stops_the_run_and_says_what_was_not_established()
    {
        var (service, db, runId, approvals) = Create();

        await service.DecideApprovalAsync(approvals[0],
            new AgentApprovalDecisionRequest(false, "Not during the migration window."));

        var run = await db.AgentRuns.FirstAsync(r => r.Id == runId);
        run.Status.Should().Be(AgentRunStatus.Stopped);
        run.StopReason.Should().Contain("migration window");
        // The part that keeps a refusal from reading as a clean finish.
        run.StopReason.Should().Contain("nothing it would have established is known");
    }

    [Fact]
    public async Task An_answer_needs_a_reason()
    {
        var (service, db, runId, approvals) = Create();

        var result = await service.DecideApprovalAsync(approvals[0], new AgentApprovalDecisionRequest(true, "ok"));

        result.IsSuccess.Should().BeFalse();
        result.Error!.Message.Should().Contain("indistinguishable from the control being switched off");
        (await db.AgentRuns.FirstAsync(r => r.Id == runId))
            .Status.Should().Be(AgentRunStatus.AwaitingApproval);
    }

    [Fact]
    public async Task Answering_needs_permission_to_start_a_run()
    {
        var (service, _, _, approvals) = Create(1, Permissions.TestRead);

        var result = await service.DecideApprovalAsync(approvals[0], Grant());

        result.IsSuccess.Should().BeFalse();
        result.Error!.Message.Should().Contain("execution:run");
    }

    [Fact]
    public async Task A_question_is_answered_once()
    {
        var (service, _, _, approvals) = Create();

        await service.DecideApprovalAsync(approvals[0], Grant());
        var second = await service.DecideApprovalAsync(approvals[0], Grant());

        second.IsSuccess.Should().BeFalse();
        second.Error!.Message.Should().Contain("already granted");
    }

    [Fact]
    public async Task The_answer_and_who_gave_it_are_stored()
    {
        var (service, db, _, approvals) = Create();

        await service.DecideApprovalAsync(approvals[0], Grant("Authorized: staging only, ticket AQ-1."));

        var approval = await db.AgentApprovals.FirstAsync();
        approval.Status.Should().Be(AgentApprovalStatus.Granted);
        approval.DecidedByEmail.Should().Be("qa.lead@example.test");
        approval.DecidedByUserId.Should().Be(Guid.Parse("33333333-3333-3333-3333-333333333333"));
        approval.Justification.Should().Contain("ticket AQ-1");
        approval.DecidedAt.Should().Be(Noon);
    }

    [Fact]
    public async Task Granting_an_approval_for_a_run_that_already_finished_changes_nothing()
    {
        var (service, db, runId, approvals) = Create();
        var run = await db.AgentRuns.FirstAsync(r => r.Id == runId);
        run.Status = AgentRunStatus.Completed;
        await db.SaveChangesAsync();

        await service.DecideApprovalAsync(approvals[0], Grant());

        // A finished run is not restarted by a late answer. The approval records that somebody
        // said yes; it does not resurrect the pass that asked.
        (await db.AgentRuns.FirstAsync(r => r.Id == runId))
            .Status.Should().Be(AgentRunStatus.Completed);
    }
}
