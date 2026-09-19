using Aira.Domain.Common;

namespace Aira.Domain.Evidence;

/// <summary>A single request/response observed during an execution or discovery run.
/// Headers and bodies are masked at capture time in the worker.</summary>
public class NetworkEvent : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid? TestExecutionId { get; set; }
    public Guid? TestActionId { get; set; }
    public Guid? DiscoveryRunId { get; set; }

    public string Method { get; set; } = "GET";
    public string Url { get; set; } = string.Empty;
    public string? ResourceType { get; set; }
    public int? StatusCode { get; set; }
    public int DurationMs { get; set; }
    public long RequestSizeBytes { get; set; }
    public long ResponseSizeBytes { get; set; }
    /// <summary>Masked headers as JSON: authorization, cookie and api-key values are redacted.</summary>
    public string? RequestHeadersJson { get; set; }
    public string? ResponseHeadersJson { get; set; }
    /// <summary>Masked and truncated bodies. Non-text payloads are not stored here.</summary>
    public string? RequestBodyExcerpt { get; set; }
    public string? ResponseBodyExcerpt { get; set; }
    public bool IsFailed { get; set; }
    public string? FailureText { get; set; }
    public DateTimeOffset OccurredAt { get; set; }
}

/// <summary>A console message or uncaught JavaScript error from the page under test.</summary>
public class ConsoleEvent : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid? TestExecutionId { get; set; }
    public Guid? TestActionId { get; set; }
    public Guid? DiscoveryRunId { get; set; }

    public string Level { get; set; } = "log";   // log | info | warn | error | pageerror
    public string Message { get; set; } = string.Empty;
    public string? StackTrace { get; set; }
    public string? Url { get; set; }
    public DateTimeOffset OccurredAt { get; set; }
}
