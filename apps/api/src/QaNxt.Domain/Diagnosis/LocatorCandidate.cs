using QaNxt.Domain.Common;

namespace QaNxt.Domain.Diagnosis;

/// <summary>A scored alternative way of finding the element a step targets. Candidates
/// are produced both when a test is authored (fallbacks) and when a locator breaks.</summary>
public class LocatorCandidate : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid? TestStepId { get; set; }
    public Testing.TestStep? TestStep { get; set; }
    public Guid? HealingEventId { get; set; }
    public Guid? ApplicationElementId { get; set; }

    /// <summary>role | testId | label | placeholder | text | altText | title | css | xpath.</summary>
    public string Strategy { get; set; } = string.Empty;
    public string Value { get; set; } = string.Empty;
    public string? AccessibleName { get; set; }
    /// <summary>Full locator descriptor as JSON, ready to hand to the engine.</summary>
    public string DescriptorJson { get; set; } = "{}";

    /// <summary>0-100 total score.</summary>
    public int Score { get; set; }
    /// <summary>Per-signal contributions, so a human can see why this ranked where it did.</summary>
    public string? ScoreBreakdownJson { get; set; }
    /// <summary>0-100 heuristic resilience of this strategy to future UI change.</summary>
    public int StabilityScore { get; set; }
    public int Rank { get; set; }
    public bool IsPrimary { get; set; }
    /// <summary>True once this candidate has successfully resolved in a real execution.</summary>
    public bool VerifiedInExecution { get; set; }
    public int TimesUsed { get; set; }
    public int TimesFailed { get; set; }
}
