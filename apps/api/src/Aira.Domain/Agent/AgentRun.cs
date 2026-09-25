using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Agent;

/// <summary>One bounded pass of the autonomous agent over an application.
///
/// The bounds are copied onto the run when it starts rather than read from configuration
/// as it goes, so a historical run stays explainable after someone changes the defaults —
/// and so an agent already in flight cannot have its limits widened underneath it.
///
/// What the agent may do is deliberately narrow, and the narrowness is the design rather
/// than an omission. It explores, it scores, it generates tests, it runs them and it writes
/// up what it found. It never deletes a test, never edits an assertion, never approves a
/// healing proposal, never changes a quality gate and never marks a failure as anything
/// else. Everything it concludes is a proposal a person acts on.</summary>
public class AgentRun : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid ApplicationId { get; set; }
    public Applications.Application? Application { get; set; }

    public string Name { get; set; } = string.Empty;
    /// <summary>What the operator asked the agent to concentrate on, if anything.</summary>
    public string? Objective { get; set; }

    public AgentRunStatus Status { get; set; } = AgentRunStatus.Queued;
    public AgentPhase Phase { get; set; } = AgentPhase.Pending;

    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }

    // ---- Frozen bounds -----------------------------------------------------
    /// <summary>Whether this pass is allowed to crawl, or must use the existing graph.</summary>
    public bool ExploreEnabled { get; set; } = true;
    public int MaxPages { get; set; }
    public int MaxDepth { get; set; }
    /// <summary>How many areas the agent may generate tests for in one pass.</summary>
    public int MaxTargets { get; set; }
    /// <summary>How many test cases it may create in total.</summary>
    public int MaxGeneratedTests { get; set; }
    /// <summary>Wall-clock budget. An agent that cannot finish must stop, not continue.</summary>
    public int TimeBudgetSeconds { get; set; }
    /// <summary>Spend ceiling for model calls in this pass.</summary>
    public decimal MaxAiCostUsd { get; set; }
    /// <summary>Whether the agent may start a run of the tests it generated.</summary>
    public bool ExecuteEnabled { get; set; } = true;

    // ---- Frozen policy -----------------------------------------------------
    // Separate from the bounds above because they answer a different question. A bound says
    // how much of something the pass may do; these say whether a whole class of action is
    // available to it at all. Frozen for the same reason: changing the defaults must not
    // widen a pass that is already running.

    /// <summary>How many policy-checked actions this pass may take in total.</summary>
    public int MaxActions { get; set; }
    /// <summary>How many journeys it may record as candidates.</summary>
    public int MaxNewJourneys { get; set; }
    /// <summary>Whether a production environment may be touched at all. Off by default, and
    /// only ever on when the initiator separately held the permission for it.</summary>
    public bool AllowProduction { get; set; }
    /// <summary>Whether actions that cannot be assumed reversible may be taken.</summary>
    public bool AllowDestructiveActions { get; set; }
    /// <summary>Whether the pass may ask the security engine to scan.</summary>
    public bool AllowSecurityTesting { get; set; } = true;
    /// <summary>Whether a person has to approve anything that changes state. Cannot be
    /// switched off through the API: an agent that decides for itself that nothing needs
    /// approving has no human in the loop at all.</summary>
    public bool RequireApprovalForHighRisk { get; set; } = true;
    public int MaxParallelWorkers { get; set; }

    /// <summary>How many policy-checked actions have been taken, against
    /// <see cref="MaxActions"/>.</summary>
    public int ActionsTaken { get; set; }
    /// <summary>How many journeys this pass has recorded, against <see cref="MaxNewJourneys"/>.</summary>
    public int JourneysCreated { get; set; }

    /// <summary>
    /// Where to pick up, when a pass that stopped for a person is queued again.
    /// </summary>
    /// <remarks>
    /// Set when an approved plan re-queues the run. The phases before it are skipped rather
    /// than repeated: crawling again would change the application map underneath a plan
    /// somebody approved against the old one, and proposing a second plan would ask the same
    /// person the same question about work they have already authorized. Cleared as the pass
    /// resumes, so a later restart is not silently treated as a resume.
    /// </remarks>
    public AgentPhase? ResumeFromPhase { get; set; }

    /// <summary>
    /// The tests this pass has assembled so far, comma separated.
    /// </summary>
    /// <remarks>
    /// A pass that stops for a person is queued again from scratch and keeps nothing in
    /// memory, so anything a skipped phase had produced would be lost — and execution would
    /// run only whatever the phases after the resume point happened to rebuild. Generation
    /// appends here as it goes and execution reads it, so what the pass runs is what the pass
    /// assembled rather than what survived being restarted.
    /// </remarks>
    public string AssembledTestCaseIds { get; set; } = string.Empty;

    // ---- What it did -------------------------------------------------------
    public Guid? DiscoveryRunId { get; set; }
    public Guid? TestSuiteId { get; set; }
    public Guid? TestRunId { get; set; }

    public int PagesConsidered { get; set; }
    public int AreasAssessed { get; set; }
    public int TestsGenerated { get; set; }
    public int TestsExecuted { get; set; }
    public int FailuresInvestigated { get; set; }
    public int ProposalsMade { get; set; }
    public decimal AiCostUsd { get; set; }

    /// <summary>Why the agent stopped: finished its plan, hit a bound, or failed.</summary>
    public string? StopReason { get; set; }
    public string? ErrorMessage { get; set; }
    /// <summary>The write-up a person reads. Masked before it is stored.</summary>
    public string? Summary { get; set; }

    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }

    public ICollection<AgentStep> Steps { get; set; } = new List<AgentStep>();
    public ICollection<AgentFinding> Findings { get; set; } = new List<AgentFinding>();
    public ICollection<AgentDecision> Decisions { get; set; } = new List<AgentDecision>();
    public ICollection<AgentApproval> Approvals { get; set; } = new List<AgentApproval>();
}

/// <summary>One phase of one pass, recorded as it happens.
///
/// The agent is autonomous, which means nobody watched it work. The only way its conclusions
/// are worth anything is if every step it took can be read back afterwards, including the
/// ones that decided to do nothing.</summary>
public class AgentStep : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid AgentRunId { get; set; }
    public AgentRun? AgentRun { get; set; }

    public int Order { get; set; }
    public AgentPhase Phase { get; set; }
    public bool Succeeded { get; set; } = true;

    /// <summary>What the agent did, in a sentence a person can read.</summary>
    public string Description { get; set; } = string.Empty;
    /// <summary>Why it did that — the reasoning, not the outcome.</summary>
    public string? Rationale { get; set; }
    public string? Detail { get; set; }

    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public int DurationMs { get; set; }
}

/// <summary>Something the agent concluded. Always a proposal: the agent has no authority to
/// act on any of these, and the platform gives it none.</summary>
public class AgentFinding : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid AgentRunId { get; set; }
    public AgentRun? AgentRun { get; set; }

    public AgentFindingKind Kind { get; set; }
    public RiskLevel Severity { get; set; } = RiskLevel.Medium;

    public string Title { get; set; } = string.Empty;
    public string Detail { get; set; } = string.Empty;
    /// <summary>What a person could do about it. Never done automatically.</summary>
    public string? Recommendation { get; set; }
    /// <summary>How sure the agent is, 0-100. Never 100.</summary>
    public int Confidence { get; set; }

    /// <summary>The route or area this concerns.</summary>
    public string? Route { get; set; }
    public Guid? TestCaseId { get; set; }
    public Guid? TestExecutionId { get; set; }
    public Guid? FailureId { get; set; }

    /// <summary>Whether a model contributed, so a reader knows what produced this.</summary>
    public bool IsAiGenerated { get; set; }
}
