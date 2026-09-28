using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Applications;

/// <summary>An ordered path through the application that represents something a user
/// actually does. Journeys come from discovery, from the recorder extension, from a
/// human, or from the agent, and they are what test generation works from.</summary>
public class Journey : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid ApplicationId { get; set; }
    public Application? Application { get; set; }

    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public JourneySource Source { get; set; } = JourneySource.Discovered;

    /// <summary>
    /// How well established this journey is: seen happening, asserted by a person, or guessed
    /// from structure.
    /// </summary>
    /// <remarks>
    /// Separate from <see cref="Source"/>, which says who produced it. The two answer different
    /// questions and conflating them is how an inference becomes a claim: a journey the agent
    /// proposed from the shape of a form has source AiProposed and evidence Inferred, and it is
    /// the second of those that decides whether the platform may describe the application as
    /// supporting it. Nothing reports an inferred journey as functionality the application has.
    /// </remarks>
    public JourneyEvidence Evidence { get; set; } = JourneyEvidence.Inferred;
    public RiskLevel Risk { get; set; } = RiskLevel.Medium;
    /// <summary>0-100 composite of business criticality, change frequency and failure history.</summary>
    public int RiskScore { get; set; }
    public string? RiskRationale { get; set; }
    public bool IsCritical { get; set; }
    public string Tags { get; set; } = string.Empty;

    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }

    public ICollection<JourneyStep> Steps { get; set; } = new List<JourneyStep>();
}

public class JourneyStep : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid JourneyId { get; set; }
    public Journey? Journey { get; set; }

    public int Order { get; set; }
    public BrowserActionType Action { get; set; }
    public string Description { get; set; } = string.Empty;
    public Guid? ApplicationPageId { get; set; }
    public Guid? ApplicationElementId { get; set; }
    /// <summary>Serialized locator in the platform's locator grammar.</summary>
    public string? TargetJson { get; set; }
    /// <summary>Masked; a recorded password becomes a secret reference, never a literal.</summary>
    public string? Value { get; set; }
    public string? Url { get; set; }
    public string? Annotation { get; set; }
    public string? ExpectedResult { get; set; }
    /// <summary>The attribute an assertAttribute step reads.</summary>
    public string? AttributeName { get; set; }
    /// <summary>How many elements an assertCount step expects.</summary>
    public int? ExpectedCount { get; set; }
}
