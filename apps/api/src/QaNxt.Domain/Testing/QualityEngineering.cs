using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Testing;

/// <summary>A test case as it was before an edit. The current version lives on the test case
/// itself; this is the history that lets two versions be compared.</summary>
public class TestCaseVersion : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid TestCaseId { get; set; }
    public int Version { get; set; }
    /// <summary>The test case and its steps and assertions, serialised whole.</summary>
    public string SnapshotJson { get; set; } = "{}";
    public string ChangeSummary { get; set; } = string.Empty;
    public Guid? ChangedByUserId { get; set; }
}

/// <summary>Something the engine could not test, and why.
///
/// Recorded rather than omitted, because a scenario that silently does not exist is
/// indistinguishable from one that was never needed, and a coverage number computed without
/// it is a number that only goes up.</summary>
public class CoverageGap : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid ApplicationId { get; set; }
    public Guid? ApplicationFormId { get; set; }
    public string? FieldKey { get; set; }
    public TestCategory Category { get; set; }
    /// <summary>What is missing, e.g. "server-side size limit".</summary>
    public string Missing { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
    public string RecommendedAction { get; set; } = string.Empty;
    public CoverageGapStatus Status { get; set; }
}

/// <summary>A check only a person can make: screen-reader experience, a business rule the
/// application does not expose, a CAPTCHA. Created with its steps and expected result so it
/// can be done, and recorded with its verdict and evidence once it has been.</summary>
public class HumanVerificationTask : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid? ApplicationId { get; set; }
    public Guid? ApplicationFormId { get; set; }
    public Guid? TestCaseId { get; set; }

    public string Title { get; set; } = string.Empty;
    public TestCategory Category { get; set; }
    /// <summary>Why a machine cannot decide it.</summary>
    public string Reason { get; set; } = string.Empty;
    public string Steps { get; set; } = string.Empty;
    public string ExpectedResult { get; set; } = string.Empty;

    public HumanTaskStatus Status { get; set; } = HumanTaskStatus.Pending;
    public string? Comments { get; set; }
    /// <summary>Artifact keys of evidence the verifier uploaded.</summary>
    public string? EvidenceJson { get; set; }
    public Guid? AssignedToUserId { get; set; }
    public Guid? CompletedByUserId { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>generated, imported or manual.</summary>
    public string Origin { get; set; } = "generated";
    /// <summary>A generated task's stable identity, so regeneration does not duplicate it
    /// or reset a verdict somebody already gave.</summary>
    public string? GenerationKey { get; set; }
}

/// <summary>A finding read from a form's structure — a missing label, a password field on a
/// GET form — rather than from running it. Kept apart from test results on purpose.</summary>
public class FormFinding : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ApplicationId { get; set; }
    public Guid ApplicationFormId { get; set; }
    public FormFindingKind Kind { get; set; }
    public string Code { get; set; } = string.Empty;
    public string? FieldKey { get; set; }
    public string Message { get; set; } = string.Empty;
    /// <summary>info, warning or serious.</summary>
    public string Severity { get; set; } = "warning";
}
