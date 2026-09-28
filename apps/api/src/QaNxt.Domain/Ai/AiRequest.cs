using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Ai;

/// <summary>Accounting and provenance for every model call. Prompts are stored with
/// secrets already masked, and are truncated to a configured budget.</summary>
public class AiRequest : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid? ProjectId { get; set; }
    public Guid? UserId { get; set; }

    public AiRequestKind Kind { get; set; }
    public LlmProviderKind Provider { get; set; }
    public string Model { get; set; } = string.Empty;
    public AiRequestStatus Status { get; set; } = AiRequestStatus.Pending;

    /// <summary>SHA-256 of the normalized prompt; the cache key and the dedupe key.</summary>
    public string PromptHash { get; set; } = string.Empty;
    public string? SystemPromptExcerpt { get; set; }
    public string? UserPromptExcerpt { get; set; }
    /// <summary>Name of the JSON schema the response had to satisfy.</summary>
    public string? ResponseSchemaName { get; set; }

    public int PromptTokens { get; set; }
    public int CompletionTokens { get; set; }
    public int TotalTokens { get; set; }
    public int LatencyMs { get; set; }
    public decimal EstimatedCostUsd { get; set; }
    public bool FromCache { get; set; }

    public string? ErrorMessage { get; set; }
    public string CorrelationId { get; set; } = string.Empty;

    public AiResponse? Response { get; set; }
}

/// <summary>The model's output, kept separately because it can be large and is read far
/// less often than the accounting row.</summary>
public class AiResponse : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid AiRequestId { get; set; }
    public AiRequest? Request { get; set; }

    /// <summary>Raw text returned by the provider (masked).</summary>
    public string RawContent { get; set; } = string.Empty;
    /// <summary>Parsed, schema-valid JSON. Null when validation rejected the response.</summary>
    public string? StructuredJson { get; set; }
    public bool SchemaValid { get; set; }
    public string? SchemaErrors { get; set; }
    public string? FinishReason { get; set; }
}
