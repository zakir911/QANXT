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
/// What the agent writes down, and what it refuses to write down.
/// </summary>
/// <remarks>
/// The agent works unattended. Everything it concludes is a claim nobody watched it form, so
/// the only thing that makes those claims worth reading is that each one carries what it
/// rests on. These tests are about that rule and the two places it could quietly lapse:
/// a decision recorded with an empty evidence array, and a secret arriving in the evidence.
/// </remarks>
public class AgentJournalTests
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

    private static (AgentJournal Journal, QaNxtDbContext Db, Guid RunId) Create()
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
            Name = "Release validation", Status = AgentRunStatus.Running
        };

        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
            db.AgentRuns.Add(run);
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        return (new AgentJournal(db, new FixedClock(), new SecretMasker()), db, run.Id);
    }

    private static AgentDecisionRecord Decision(
        IReadOnlyList<AgentEvidence>? evidence = null, bool allowed = true)
        => new(AgentPhase.Prioritizing,
            "Selected the payment regression suite.",
            "The payment API changed and payments are business-critical.",
            evidence ?? new[]
            {
                new AgentEvidence("changedEndpoint", "POST /api/transfers"),
                new AgentEvidence("businessCriticality", "high, set by the operator")
            },
            Allowed: allowed);

    // -----------------------------------------------------------------------

    [Fact]
    public async Task A_decision_is_recorded_with_its_reason_and_its_evidence()
    {
        var (journal, db, runId) = Create();

        await journal.RecordAsync(runId, Decision());

        var stored = await db.AgentDecisions.SingleAsync();
        stored.Summary.Should().Contain("payment regression");
        stored.Reason.Should().Contain("business-critical");
        stored.EvidenceJson.Should().Contain("changedEndpoint").And.Contain("POST /api/transfers");
        stored.Sequence.Should().Be(1);
        stored.OccurredAt.Should().Be(Noon);
    }

    [Fact]
    public async Task A_decision_with_no_evidence_is_refused()
    {
        var (journal, db, runId) = Create();

        var act = async () => await journal.RecordAsync(
            runId, Decision(evidence: Array.Empty<AgentEvidence>()));

        // The rule this class exists for. Not a warning and not an empty array on disk: a
        // decision nobody can check reads exactly like a reasoned one, which is worse than
        // no record at all.
        await act.Should().ThrowAsync<ArgumentException>()
            .WithMessage("*carries no evidence*");
        (await db.AgentDecisions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task A_refusal_needs_no_evidence_because_the_guard_s_answer_is_the_evidence()
    {
        var (journal, db, runId) = Create();

        await journal.RecordAsync(runId, Decision(
            evidence: Array.Empty<AgentEvidence>(), allowed: false) with
        {
            Denial = AgentDenial.ApprovalRequired
        });

        // Demanding more than the guard's own answer would push callers into inventing some,
        // and invented evidence is the failure this whole area is about.
        (await db.AgentDecisions.SingleAsync()).Allowed.Should().BeFalse();
    }

    [Fact]
    public async Task Decisions_are_numbered_in_the_order_they_happened()
    {
        var (journal, db, runId) = Create();

        await journal.RecordAsync(runId, Decision());
        await journal.RecordAsync(runId, Decision());
        await journal.RecordAsync(runId, Decision());

        // A timeline that has to guess at ordering from timestamps is a timeline that gets it
        // wrong the first time two things happen in the same millisecond.
        (await db.AgentDecisions.OrderBy(d => d.Sequence).Select(d => d.Sequence).ToListAsync())
            .Should().Equal(1, 2, 3);
    }

    [Fact]
    public async Task A_secret_in_the_evidence_is_masked_before_it_is_stored()
    {
        var (journal, db, runId) = Create();

        await journal.RecordAsync(runId, Decision(new[]
        {
            new AgentEvidence("request", "authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def")
        }));

        // Masked on the way in rather than on the way out. Evidence is read by the console,
        // the CLI and two reports, and masking at each of those is three chances to forget.
        var stored = await db.AgentDecisions.SingleAsync();
        stored.EvidenceJson.Should().NotContain("eyJhbGciOiJIUzI1NiJ9");
        stored.EvidenceJson.Should().Contain("REDACTED");
    }

    [Fact]
    public async Task An_identifier_survives_masking_because_it_is_not_free_text()
    {
        var (journal, db, runId) = Create();
        var actor = Guid.Parse("33333333-3333-3333-3333-333333333333");

        await journal.RecordAsync(runId, Decision() with { ActorUserId = actor });

        // Found by writing a test that expected a GUID in the evidence and watching it come
        // back redacted: the masker cannot tell an identifier from a credential, and a bare
        // GUID is a perfectly good shape for an API key. Weakening the masker to preserve it
        // would trade a real protection for a convenience, so identifiers get their own
        // column and the trail stays complete without touching the masker.
        var stored = await db.AgentDecisions.SingleAsync();
        stored.ActorUserId.Should().Be(actor);
    }

    [Fact]
    public async Task An_identifier_written_into_the_evidence_is_still_masked()
    {
        var (journal, db, runId) = Create();

        await journal.RecordAsync(runId, Decision(new[]
        {
            new AgentEvidence("decidedBy", "33333333-3333-3333-3333-333333333333")
        }));

        // The other half of the same finding, pinned so nobody "fixes" the masker later to
        // make an id survive in prose. Prose is where a secret would be.
        (await db.AgentDecisions.SingleAsync())
            .EvidenceJson.Should().NotContain("33333333-3333-3333-3333-333333333333");
    }

    [Fact]
    public async Task A_deterministic_decision_records_that_no_model_was_consulted()
    {
        var (journal, db, runId) = Create();

        await journal.RecordAsync(runId, Decision());

        // "The agent decided" and "a model suggested and the agent accepted" are different
        // facts. A reader should be able to tell them apart without being told.
        var stored = await db.AgentDecisions.SingleAsync();
        stored.AiRequestId.Should().BeNull();
        stored.AiCostUsd.Should().Be(0m);
    }

    [Fact]
    public async Task A_decision_a_model_contributed_to_carries_its_cost()
    {
        var (journal, db, runId) = Create();
        var aiRequestId = Guid.NewGuid();

        await journal.RecordAsync(runId, Decision() with
        {
            AiRequestId = aiRequestId, AiCostUsd = 0.0042m
        });

        var stored = await db.AgentDecisions.SingleAsync();
        stored.AiRequestId.Should().Be(aiRequestId);
        stored.AiCostUsd.Should().Be(0.0042m);
    }

    // ---- The guard's answers, recorded ---------------------------------------

    [Fact]
    public async Task A_refused_action_records_which_rung_stopped_it()
    {
        var (journal, db, runId) = Create();
        var request = new AgentActionRequest("test.execute", EnvironmentKind.Production);
        var decision = AgentPolicyGuard.Evaluate(
            AgentPolicy.Default with { AllowProduction = true }, request,
            new AgentRunState(0, 0, 0, 0, false,
                new HashSet<string> { Permissions.ExecutionRun }, new HashSet<string>()));

        await journal.RecordActionAsync(runId, AgentPhase.Executing, request, decision,
            Array.Empty<AgentEvidence>(), "Tried to run the generated tests.");

        var stored = await db.AgentDecisions.SingleAsync();
        stored.Allowed.Should().BeFalse();
        stored.Denial.Should().Be(nameof(AgentDenial.EnvironmentNotPermitted));
        stored.Result.Should().Be("Not performed.");
        // Where it got to, so somebody reading this widens the right thing — or, better,
        // realises that widening it is not what they want.
        stored.EvidenceJson.Should().Contain("policyRungsPassed");
    }

    [Fact]
    public async Task A_permitted_action_records_the_risk_it_was_judged_at()
    {
        var (journal, db, runId) = Create();
        var request = new AgentActionRequest("browser.click", EnvironmentKind.Staging,
            DeclaredRisk: AgentActionRisk.StateChanging);
        var decision = AgentPolicyGuard.Evaluate(
            AgentPolicy.Default with { RequireApprovalForHighRisk = false }, request,
            new AgentRunState(0, 0, 0, 0, false, new HashSet<string>(), new HashSet<string>()));

        await journal.RecordActionAsync(runId, AgentPhase.Exploring, request, decision,
            new[] { new AgentEvidence("element", "Submit payment") },
            "Clicked the payment submit button.", result: "Navigated to /payments/confirm");

        var stored = await db.AgentDecisions.SingleAsync();
        stored.Allowed.Should().BeTrue();
        // The declared risk, not the tool's floor: a caller that knows this click submits a
        // payment said so, and the record has to keep that rather than the generic answer.
        stored.Risk.Should().Be(nameof(AgentActionRisk.StateChanging));
        stored.Result.Should().Contain("/payments/confirm");
    }

    // ---- Approvals -----------------------------------------------------------

    [Fact]
    public async Task Asking_for_approval_records_the_question_rather_than_waiting()
    {
        var (journal, db, runId) = Create();

        await journal.RequestApprovalAsync(runId, "security.scan",
            "security.scan is StateChanging and this run requires approval.",
            "Scan the payment API for authorization flaws.",
            nameof(AgentActionRisk.StateChanging),
            new[] { new AgentEvidence("scope", "authorized for staging, ticket SEC-114") },
            expectedImpact: "Up to 200 requests against staging over about four minutes.");

        var approval = await db.AgentApprovals.SingleAsync();
        approval.Status.Should().Be(AgentApprovalStatus.Pending);
        approval.Tool.Should().Be("security.scan");
        approval.ExpectedImpact.Should().Contain("200 requests");
        // Nothing was granted by asking. A pending question is not permission, and the run
        // continues without the action rather than blocking on a person who may be asleep.
        approval.DecidedByUserId.Should().BeNull();
    }

    [Fact]
    public async Task The_same_question_is_not_asked_twice_in_one_run()
    {
        var (journal, db, runId) = Create();

        var first = await journal.RequestApprovalAsync(runId, "test.execute", "why", "what",
            nameof(AgentActionRisk.StateChanging),
            new[] { new AgentEvidence("tests", "32 generated") });
        var second = await journal.RequestApprovalAsync(runId, "test.execute", "why", "what",
            nameof(AgentActionRisk.StateChanging),
            new[] { new AgentEvidence("tests", "32 generated") });

        // A queue that re-asks the same thing every time the loop comes round is a queue
        // nobody reads, and an unread approval queue is the same as no approval at all.
        second.Should().Be(first);
        (await db.AgentApprovals.CountAsync()).Should().Be(1);
    }

    [Fact]
    public async Task Only_granted_approvals_count_and_they_are_scoped_to_their_run()
    {
        var (journal, db, runId) = Create();

        await journal.RequestApprovalAsync(runId, "test.execute", "why", "what",
            nameof(AgentActionRisk.StateChanging), new[] { new AgentEvidence("k", "v") });
        await journal.RequestApprovalAsync(runId, "security.scan", "why", "what",
            nameof(AgentActionRisk.StateChanging), new[] { new AgentEvidence("k", "v") });

        var granted = await db.AgentApprovals.FirstAsync(a => a.Tool == "test.execute");
        granted.Status = AgentApprovalStatus.Granted;
        await db.SaveChangesAsync();

        var approvals = await journal.GrantedApprovalsAsync(runId);

        approvals.Should().BeEquivalentTo(new[] { "test.execute" });
        // The pending one is absent, which is the point: unanswered is not yes.
        approvals.Should().NotContain("security.scan");
    }
}
