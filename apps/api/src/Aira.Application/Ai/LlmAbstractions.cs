using System.Text.Json.Serialization;
using Aira.Domain.Enums;

namespace Aira.Application.Ai;

/// <summary>A message in a model conversation. Content that originated in a tested
/// application is wrapped before it gets here — see <see cref="PromptBuilder"/>.</summary>
public sealed record LlmMessage(string Role, string Content)
{
    public static LlmMessage System(string content) => new("system", content);
    public static LlmMessage User(string content) => new("user", content);
    public static LlmMessage Assistant(string content) => new("assistant", content);
}

/// <summary>A request for structured output. The schema is not advisory: a response that
/// does not satisfy it is rejected rather than parsed optimistically.</summary>
public sealed record LlmRequest
{
    public required IReadOnlyList<LlmMessage> Messages { get; init; }
    public required string SchemaName { get; init; }
    /// <summary>JSON Schema the response must satisfy.</summary>
    public required string JsonSchema { get; init; }
    public int MaxTokens { get; init; } = 4000;
    /// <summary>Low by default: test generation and failure analysis want consistency,
    /// not variety. Two runs over the same evidence should reach the same conclusion.</summary>
    public double Temperature { get; init; } = 0.2;
    public string? Model { get; init; }
}

public sealed record LlmUsage(int PromptTokens, int CompletionTokens)
{
    public int TotalTokens => PromptTokens + CompletionTokens;
}

public sealed record LlmResponse(
    string Content,
    LlmUsage Usage,
    string Model,
    string? FinishReason,
    int LatencyMs);

/// <summary>A provider of language-model completions.
///
/// Every provider is reached through this interface, so the platform is never coupled to
/// one vendor's API shape, and a deployment with no API keys still works through the local
/// provider rather than failing or pretending.</summary>
public interface ILlmProvider
{
    LlmProviderKind Kind { get; }
    string DefaultModel { get; }
    /// <summary>False when the provider is not configured (no key, no endpoint). Callers
    /// fall back rather than throwing at the point of use.</summary>
    bool IsConfigured { get; }
    Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct = default);
    /// <summary>Estimated cost in USD, used for budget enforcement and reporting.</summary>
    decimal EstimateCostUsd(string model, LlmUsage usage);
}

/// <summary>Picks the provider for a project, falling back deliberately and visibly.</summary>
public interface ILlmProviderFactory
{
    ILlmProvider Resolve(LlmProviderKind preferred);
    IReadOnlyList<LlmProviderStatus> Describe();
}

public sealed record LlmProviderStatus(LlmProviderKind Kind, string Name, bool IsConfigured, string DefaultModel, string Notes);

/// <summary>The outcome of an orchestrated AI call, including everything needed to audit
/// it: which provider answered, what it cost, whether the response satisfied its schema,
/// and the request id that links a generated artifact back to its provenance.</summary>
public sealed record AiResult<T>
{
    public required bool IsSuccess { get; init; }
    public T? Value { get; init; }
    public Guid AiRequestId { get; init; }
    public LlmProviderKind Provider { get; init; }
    public string Model { get; init; } = string.Empty;
    public AiRequestStatus Status { get; init; }
    public string? Error { get; init; }
    public LlmUsage? Usage { get; init; }
    public decimal EstimatedCostUsd { get; init; }
    public bool FromCache { get; init; }
    /// <summary>True when the deterministic local provider produced this, so the UI can
    /// label it honestly rather than implying a frontier model was consulted.</summary>
    public bool IsLocalProvider => Provider == LlmProviderKind.Local;

    public static AiResult<T> Success(T value, Guid requestId, LlmProviderKind provider, string model,
        LlmUsage? usage, decimal cost, bool fromCache)
        => new()
        {
            IsSuccess = true, Value = value, AiRequestId = requestId, Provider = provider,
            Model = model, Status = fromCache ? AiRequestStatus.CacheHit : AiRequestStatus.Succeeded,
            Usage = usage, EstimatedCostUsd = cost, FromCache = fromCache
        };

    public static AiResult<T> Failure(Guid requestId, LlmProviderKind provider, string model,
        AiRequestStatus status, string error)
        => new()
        {
            IsSuccess = false, AiRequestId = requestId, Provider = provider,
            Model = model, Status = status, Error = error
        };
}
