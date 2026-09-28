using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Testing;

/// <summary>The record of a single attempted action, including exactly which locator
/// was used and which alternatives existed. This is what makes healing explainable.</summary>
public class TestAction : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid TestExecutionId { get; set; }
    public TestExecution? TestExecution { get; set; }
    public Guid? TestStepId { get; set; }

    public int Order { get; set; }
    public BrowserActionType Action { get; set; }
    public string Description { get; set; } = string.Empty;
    public ExecutionStatus Status { get; set; } = ExecutionStatus.Pending;

    public DateTimeOffset StartedAt { get; set; }
    public int DurationMs { get; set; }

    public string? Url { get; set; }
    /// <summary>The locator actually used, serialized.</summary>
    public string? LocatorUsedJson { get; set; }
    /// <summary>Ranked alternatives considered, with scores. Populated on healing attempts.</summary>
    public string? LocatorAlternativesJson { get; set; }
    /// <summary>Masked value supplied to the action (a password becomes "***").</summary>
    public string? MaskedValue { get; set; }

    public bool WasHealed { get; set; }
    public int? HealingConfidence { get; set; }

    public string? ErrorMessage { get; set; }
    public Guid? BeforeScreenshotId { get; set; }
    public Guid? AfterScreenshotId { get; set; }
    /// <summary>Short justification when the action came from an AI plan; links to the AI request.</summary>
    public Guid? AiRequestId { get; set; }

    /// <summary>The whole accessibility result, when this step was a check.</summary>
    /// <remarks>
    /// Kept whole because a count is not actionable: somebody fixing a violation needs the
    /// rule, the element and the help URL. The counts below are projected out of it so a
    /// quality gate can read a number without parsing JSON on every evaluation.
    /// </remarks>
    public string? AccessibilityJson { get; set; }

    /// <summary>Violations found, at any impact. Null when this step was not a check.</summary>
    /// <remarks>
    /// Nullable on purpose. Zero means a check ran and found nothing; null means no check
    /// ran, and a gate that treated the two alike would report an unchecked page as clean.
    /// </remarks>
    public int? AccessibilityViolationCount { get; set; }

    /// <summary>Violations at critical or serious impact.</summary>
    public int? AccessibilitySeriousCount { get; set; }

    /// <summary>The whole visual comparison, when this step was one.</summary>
    public string? VisualJson { get; set; }

    /// <summary>What the comparison decided. Null when this step was not a visual check.</summary>
    /// <remarks>
    /// Kept as its own column so a gate can count differences without parsing JSON, and
    /// nullable for the same reason the accessibility counts are: "compared and matched"
    /// and "never compared" are different, and a gate that treated them alike would report
    /// an unchecked page as unchanged.
    /// </remarks>
    public string? VisualVerdict { get; set; }

    /// <summary>Proportion of pixels that differed, when a comparison happened.</summary>
    public decimal? VisualDifferencePercent { get; set; }
}
