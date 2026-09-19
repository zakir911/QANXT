using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Testing;

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
}
