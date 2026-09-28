using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Diagnosis;

/// <summary>A proposed or tracked product defect. AI may propose; only a human (or an
/// explicit integration policy) promotes a proposal into a tracked defect.</summary>
public class Defect : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid? FailureId { get; set; }
    public Failure? Failure { get; set; }
    public Guid? TestCaseId { get; set; }
    public Guid? TestExecutionId { get; set; }

    public string Title { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string StepsToReproduce { get; set; } = string.Empty;
    public string ExpectedBehaviour { get; set; } = string.Empty;
    public string ActualBehaviour { get; set; } = string.Empty;

    public DefectSeverity Severity { get; set; } = DefectSeverity.Major;
    public DefectStatus Status { get; set; } = DefectStatus.Proposed;
    public int Confidence { get; set; }
    public bool ProposedByAi { get; set; }
    public Guid? AiRequestId { get; set; }
    /// <summary>Artifact ids attached as proof.</summary>
    public string? EvidenceRefsJson { get; set; }

    /// <summary>Identifier in the external tracker once exported.</summary>
    public string? ExternalKey { get; set; }
    public string? ExternalUrl { get; set; }

    public Guid? AssignedToUserId { get; set; }
    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
}
