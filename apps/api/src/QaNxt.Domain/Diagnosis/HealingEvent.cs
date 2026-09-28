using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Diagnosis;

/// <summary>A recorded attempt to recover from a broken locator. Nothing is ever healed
/// invisibly: the original locator, the replacement, the reasoning, the confidence and
/// the evidence are all retained, and applying a heal to the stored test requires an
/// approval unless the project policy is Auto.</summary>
public class HealingEvent : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid TestCaseId { get; set; }
    public Guid TestStepId { get; set; }
    public Guid? TestExecutionId { get; set; }
    public Guid? TestActionId { get; set; }

    /// <summary>The locator that stopped working, exactly as it was stored.</summary>
    public string OriginalLocatorJson { get; set; } = "{}";
    /// <summary>The locator that was used (or is proposed) instead.</summary>
    public string HealedLocatorJson { get; set; } = "{}";
    public string Reason { get; set; } = string.Empty;
    /// <summary>0-100. Compared against the project's threshold before any action.</summary>
    public int Confidence { get; set; }
    public string? ScoreBreakdownJson { get; set; }
    /// <summary>Artifact ids (DOM snapshot, screenshots) proving what the page looked like.</summary>
    public string? EvidenceRefsJson { get; set; }

    public HealingPolicy PolicyAtTime { get; set; }
    public HealingOutcome Outcome { get; set; } = HealingOutcome.Proposed;
    /// <summary>True only when the action, after healing, actually achieved its intent
    /// (verified by re-checking the step's assertions or post-conditions).</summary>
    public bool OutcomeVerified { get; set; }

    public bool ProducedByAi { get; set; }
    public Guid? AiRequestId { get; set; }

    public Guid? ReviewedByUserId { get; set; }
    public DateTimeOffset? ReviewedAt { get; set; }
    public string? ReviewComment { get; set; }
    public DateTimeOffset? AppliedAt { get; set; }

    public string? ApplicationBuildRef { get; set; }
    public DateTimeOffset OccurredAt { get; set; }
}
