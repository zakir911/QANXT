using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Diagnosis;

/// <summary>A failed execution, classified. The raw engine error is kept verbatim —
/// analysis adds to it, never replaces or hides it.</summary>
public class Failure : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid TestExecutionId { get; set; }
    public Testing.TestExecution? TestExecution { get; set; }
    public Guid? TestActionId { get; set; }
    public Guid TestCaseId { get; set; }

    /// <summary>Deterministic classification from the rule-based classifier.</summary>
    public FailureCategory Category { get; set; } = FailureCategory.Unknown;
    /// <summary>0-100 confidence of the deterministic classification.</summary>
    public int CategoryConfidence { get; set; }

    /// <summary>Untouched message from Playwright or the engine.</summary>
    public string RawMessage { get; set; } = string.Empty;
    public string? RawStack { get; set; }
    /// <summary>Stable hash over the normalized message + step + case, used to cluster
    /// recurring failures and to detect new failures against a baseline run.</summary>
    public string Signature { get; set; } = string.Empty;

    public bool IsNewFailure { get; set; }
    public bool IsRegression { get; set; }
    public int OccurrenceCount { get; set; } = 1;
    public DateTimeOffset FirstSeenAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }

    public FailureAnalysis? Analysis { get; set; }
    public ICollection<Defect> Defects { get; set; } = new List<Defect>();
}
