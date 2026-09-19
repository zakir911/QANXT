using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Diagnosis;

/// <summary>The explained version of a failure. Every conclusion must cite evidence
/// that exists in the system; <see cref="EvidenceRefsJson"/> holds those citations.</summary>
public class FailureAnalysis : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid FailureId { get; set; }
    public Failure? Failure { get; set; }

    /// <summary>One-line statement of what failed, in product terms.</summary>
    public string Summary { get; set; } = string.Empty;
    /// <summary>Why it most likely failed.</summary>
    public string LikelyCause { get; set; } = string.Empty;
    public string Evidence { get; set; } = string.Empty;
    public string SuggestedAction { get; set; } = string.Empty;

    public FailureCategory Category { get; set; }
    /// <summary>0-100.</summary>
    public int Confidence { get; set; }
    public bool IsLikelyApplicationDefect { get; set; }
    public bool IsHealable { get; set; }

    /// <summary>Artifact and event ids backing each claim, so the UI can link to proof.</summary>
    public string? EvidenceRefsJson { get; set; }

    /// <summary>Which analyser produced this: the deterministic classifier or an LLM.</summary>
    public bool ProducedByAi { get; set; }
    public Guid? AiRequestId { get; set; }
    public LlmProviderKind? Provider { get; set; }
    public string? Model { get; set; }
}
