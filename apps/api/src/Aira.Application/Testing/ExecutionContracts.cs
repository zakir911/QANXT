using System.Text.Json.Serialization;
using Aira.Application.Contracts;
using Aira.Domain.Enums;

namespace Aira.Application.Testing;

/// <summary>Mirrors the TypeScript `ExecutionJob`. Everything the worker needs, and
/// nothing it does not: no project configuration, no other tests, no user identity.</summary>
public sealed record ExecutionJobPayload
{
    [JsonPropertyName("jobId")] public string JobId { get; init; } = string.Empty;
    [JsonPropertyName("executionId")] public Guid ExecutionId { get; init; }
    [JsonPropertyName("organizationId")] public Guid OrganizationId { get; init; }
    [JsonPropertyName("projectId")] public Guid ProjectId { get; init; }
    [JsonPropertyName("testRunId")] public Guid TestRunId { get; init; }
    [JsonPropertyName("testCaseId")] public Guid TestCaseId { get; init; }
    [JsonPropertyName("testCaseName")] public string TestCaseName { get; init; } = string.Empty;
    [JsonPropertyName("testCaseVersion")] public int TestCaseVersion { get; init; }
    [JsonPropertyName("testCaseKind")] public string TestCaseKind { get; init; } = "ui";
    [JsonPropertyName("attempt")] public int Attempt { get; init; } = 1;
    [JsonPropertyName("browser")] public string Browser { get; init; } = "chromium";
    [JsonPropertyName("headless")] public bool Headless { get; init; } = true;
    [JsonPropertyName("baseUrl")] public string BaseUrl { get; init; } = string.Empty;
    /// <summary>Where relative API paths resolve. Equal to <see cref="BaseUrl"/> when the
    /// API is served from the same origin as the UI.</summary>
    [JsonPropertyName("apiBaseUrl")] public string ApiBaseUrl { get; init; } = string.Empty;
    [JsonPropertyName("auth")] public Discovery.AuthConfigPayload Auth { get; init; } = new();
    [JsonPropertyName("steps")] public List<ExecutionStepPayload> Steps { get; init; } = new();
    [JsonPropertyName("data")] public Dictionary<string, string> Data { get; init; } = new();
    [JsonPropertyName("secrets")] public Dictionary<string, string> Secrets { get; init; } = new();
    [JsonPropertyName("capture")] public CaptureSettingsPayload Capture { get; init; } = new();
    [JsonPropertyName("healing")] public HealingSettingsPayload Healing { get; init; } = new();
    [JsonPropertyName("allowScriptExecution")] public bool AllowScriptExecution { get; init; }
    /// <summary>False in an environment that refuses writes; the worker then refuses
    /// POST, PUT, PATCH and DELETE rather than attempting them.</summary>
    [JsonPropertyName("allowMutatingApiRequests")] public bool AllowMutatingApiRequests { get; init; } = true;
    [JsonPropertyName("allowedHosts")] public string[] AllowedHosts { get; init; } = Array.Empty<string>();
    [JsonPropertyName("allowPrivateNetworks")] public bool AllowPrivateNetworks { get; init; }
    [JsonPropertyName("defaultTimeoutMs")] public int DefaultTimeoutMs { get; init; } = 15000;
    [JsonPropertyName("callbackToken")] public string CallbackToken { get; init; } = string.Empty;
    [JsonPropertyName("callbackBaseUrl")] public string CallbackBaseUrl { get; init; } = string.Empty;
    [JsonPropertyName("correlationId")] public string CorrelationId { get; init; } = string.Empty;
}

public sealed record ExecutionStepPayload
{
    [JsonPropertyName("testStepId")] public Guid TestStepId { get; init; }
    [JsonPropertyName("order")] public int Order { get; init; }
    [JsonPropertyName("action")] public BrowserAction Action { get; init; } = new();
    [JsonPropertyName("fingerprint")] public ElementFingerprintPayload? Fingerprint { get; init; }
    [JsonPropertyName("assertions")] public List<PlannedAssertionPayload> Assertions { get; init; } = new();
    [JsonPropertyName("continueOnFailure")] public bool ContinueOnFailure { get; init; }
}

/// <summary>What the target element looked like when the step was written. Sent so the
/// worker can recognise a changed element without another round trip.</summary>
public sealed record ElementFingerprintPayload
{
    [JsonPropertyName("tagName")] public string? TagName { get; init; }
    [JsonPropertyName("ariaRole")] public string? AriaRole { get; init; }
    [JsonPropertyName("accessibleName")] public string? AccessibleName { get; init; }
    [JsonPropertyName("text")] public string? Text { get; init; }
    [JsonPropertyName("label")] public string? Label { get; init; }
    [JsonPropertyName("placeholder")] public string? Placeholder { get; init; }
    [JsonPropertyName("testId")] public string? TestId { get; init; }
    [JsonPropertyName("elementId")] public string? ElementId { get; init; }
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("domPath")] public string? DomPath { get; init; }
    [JsonPropertyName("parentSignature")] public string? ParentSignature { get; init; }
    [JsonPropertyName("neighbourText")] public string? NeighbourText { get; init; }
    [JsonPropertyName("bounding")] public Discovery.BoundingPayload? Bounding { get; init; }
}

public sealed record PlannedAssertionPayload
{
    [JsonPropertyName("assertionId")] public Guid AssertionId { get; init; }
    [JsonPropertyName("type")] public string Type { get; init; } = string.Empty;
    [JsonPropertyName("target")] public LocatorDescriptor? Target { get; init; }
    [JsonPropertyName("expected")] public string? Expected { get; init; }
    [JsonPropertyName("attribute")] public string? Attribute { get; init; }
    [JsonPropertyName("negate")] public bool Negate { get; init; }
    [JsonPropertyName("isSoft")] public bool IsSoft { get; init; }
    [JsonPropertyName("description")] public string Description { get; init; } = string.Empty;
}

public sealed record CaptureSettingsPayload
{
    [JsonPropertyName("video")] public bool Video { get; init; }
    [JsonPropertyName("trace")] public bool Trace { get; init; }
    [JsonPropertyName("har")] public bool Har { get; init; }
    [JsonPropertyName("screenshotOnEveryAction")] public bool ScreenshotOnEveryAction { get; init; }
    [JsonPropertyName("domSnapshotOnFailure")] public bool DomSnapshotOnFailure { get; init; } = true;
}

public sealed record HealingSettingsPayload
{
    [JsonPropertyName("policy")] public string Policy { get; init; } = "suggest";
    [JsonPropertyName("confidenceThreshold")] public int ConfidenceThreshold { get; init; } = 85;
}

// ---- Worker callbacks -------------------------------------------------------

public sealed record ActionResultPayload
{
    [JsonPropertyName("order")] public int Order { get; init; }
    [JsonPropertyName("testStepId")] public Guid? TestStepId { get; init; }
    [JsonPropertyName("action")] public string Action { get; init; } = string.Empty;
    [JsonPropertyName("description")] public string Description { get; init; } = string.Empty;
    [JsonPropertyName("status")] public ExecutionStatus Status { get; init; }
    [JsonPropertyName("startedAt")] public DateTimeOffset StartedAt { get; init; }
    [JsonPropertyName("durationMs")] public int DurationMs { get; init; }
    [JsonPropertyName("url")] public string? Url { get; init; }
    [JsonPropertyName("locatorUsed")] public LocatorDescriptor? LocatorUsed { get; init; }
    [JsonPropertyName("locatorAlternatives")] public List<RankedLocatorPayload>? LocatorAlternatives { get; init; }
    [JsonPropertyName("maskedValue")] public string? MaskedValue { get; init; }
    [JsonPropertyName("wasHealed")] public bool WasHealed { get; init; }
    [JsonPropertyName("healingConfidence")] public int? HealingConfidence { get; init; }
    [JsonPropertyName("errorMessage")] public string? ErrorMessage { get; init; }
    [JsonPropertyName("screenshotKeys")] public ScreenshotKeysPayload? ScreenshotKeys { get; init; }
    [JsonPropertyName("accessibility")] public AccessibilityResultPayload? Accessibility { get; init; }
    [JsonPropertyName("visual")] public VisualComparisonPayload? Visual { get; init; }
}

/// <summary>What a visual check compared, and what it decided.</summary>
public sealed record VisualViewportPayload(
    [property: JsonPropertyName("width")] int Width,
    [property: JsonPropertyName("height")] int Height);

public sealed record VisualComparisonPayload
{
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    /// <summary>match, differs, newBaseline or sizeChanged.</summary>
    [JsonPropertyName("verdict")] public string Verdict { get; init; } = string.Empty;
    [JsonPropertyName("differingPixels")] public int DifferingPixels { get; init; }
    [JsonPropertyName("totalPixels")] public int TotalPixels { get; init; }
    [JsonPropertyName("differencePercent")] public decimal DifferencePercent { get; init; }
    [JsonPropertyName("maxDifferencePercent")] public decimal MaxDifferencePercent { get; init; }
    [JsonPropertyName("width")] public int Width { get; init; }
    [JsonPropertyName("height")] public int Height { get; init; }
    [JsonPropertyName("baselineWidth")] public int? BaselineWidth { get; init; }
    [JsonPropertyName("baselineHeight")] public int? BaselineHeight { get; init; }
    [JsonPropertyName("baselineKey")] public string? BaselineKey { get; init; }
    [JsonPropertyName("actualKey")] public string? ActualKey { get; init; }
    [JsonPropertyName("diffKey")] public string? DiffKey { get; init; }
    /// <summary>What was painted over before comparing. Recorded so a reader can see what
    /// was not looked at — masking the region that keeps failing is the obvious way to make
    /// a visual check useless while appearing to run it.</summary>
    [JsonPropertyName("masked")] public List<string> Masked { get; init; } = [];
    /// <summary>The viewport this was captured at.</summary>
    /// <remarks>
    /// Part of a baseline's identity, and therefore part of what a reader needs: a
    /// comparison that does not say which size it was taken at cannot be reconciled with
    /// the baseline it used. Dropping it was caught by VIS-007.
    /// </remarks>
    [JsonPropertyName("viewport")] public VisualViewportPayload? Viewport { get; init; }
    [JsonPropertyName("browser")] public string? Browser { get; init; }
    [JsonPropertyName("capturedAt")] public DateTimeOffset? CapturedAt { get; init; }
}

/// <summary>
/// What an accessibility check found.
/// </summary>
/// <remarks>
/// Stored whole, as the worker reported it, because a count without the findings is not
/// actionable and a finding without its help URL is not either. The counts are also
/// projected onto the action so a quality gate can read a number without parsing JSON.
/// </remarks>
public sealed record AccessibilityResultPayload
{
    [JsonPropertyName("url")] public string Url { get; init; } = string.Empty;
    [JsonPropertyName("standards")] public List<string> Standards { get; init; } = [];
    [JsonPropertyName("violations")] public List<AccessibilityViolationPayload> Violations { get; init; } = [];
    [JsonPropertyName("passCount")] public int PassCount { get; init; }
    /// <summary>Checks axe could not decide, which a person must. Never counted as a pass.</summary>
    [JsonPropertyName("incompleteCount")] public int IncompleteCount { get; init; }
    [JsonPropertyName("counts")] public Dictionary<string, int> Counts { get; init; } = [];
    [JsonPropertyName("excluded")] public List<string> Excluded { get; init; } = [];
    [JsonPropertyName("engine")] public AccessibilityEnginePayload? Engine { get; init; }
    [JsonPropertyName("scannedAt")] public DateTimeOffset? ScannedAt { get; init; }
}

public sealed record AccessibilityViolationPayload
{
    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;
    [JsonPropertyName("impact")] public string? Impact { get; init; }
    [JsonPropertyName("help")] public string Help { get; init; } = string.Empty;
    [JsonPropertyName("helpUrl")] public string HelpUrl { get; init; } = string.Empty;
    [JsonPropertyName("tags")] public List<string> Tags { get; init; } = [];
    [JsonPropertyName("nodes")] public List<AccessibilityNodePayload> Nodes { get; init; } = [];
}

public sealed record AccessibilityNodePayload
{
    [JsonPropertyName("target")] public string Target { get; init; } = string.Empty;
    [JsonPropertyName("failureSummary")] public string? FailureSummary { get; init; }
    [JsonPropertyName("html")] public string? Html { get; init; }
}

public sealed record AccessibilityEnginePayload(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("version")] string Version);

public sealed record ScreenshotKeysPayload(
    [property: JsonPropertyName("before")] string? Before,
    [property: JsonPropertyName("after")] string? After);

public sealed record RankedLocatorPayload
{
    [JsonPropertyName("descriptor")] public LocatorDescriptor Descriptor { get; init; } = new();
    [JsonPropertyName("score")] public int Score { get; init; }
    [JsonPropertyName("rank")] public int Rank { get; init; }
    [JsonPropertyName("breakdown")] public Dictionary<string, int> Breakdown { get; init; } = new();
    [JsonPropertyName("stability")] public int Stability { get; init; }
}

public sealed record ExecutionCompletionPayload
{
    [JsonPropertyName("executionId")] public Guid ExecutionId { get; init; }
    [JsonPropertyName("status")] public ExecutionStatus Status { get; init; }
    [JsonPropertyName("startedAt")] public DateTimeOffset StartedAt { get; init; }
    [JsonPropertyName("completedAt")] public DateTimeOffset CompletedAt { get; init; }
    [JsonPropertyName("durationMs")] public int DurationMs { get; init; }
    [JsonPropertyName("browserVersion")] public string BrowserVersion { get; init; } = string.Empty;
    [JsonPropertyName("workerId")] public string WorkerId { get; init; } = string.Empty;
    [JsonPropertyName("stepsTotal")] public int StepsTotal { get; init; }
    [JsonPropertyName("stepsPassed")] public int StepsPassed { get; init; }
    [JsonPropertyName("stepsFailed")] public int StepsFailed { get; init; }
    [JsonPropertyName("stepsHealed")] public int StepsHealed { get; init; }
    [JsonPropertyName("consoleErrorCount")] public int ConsoleErrorCount { get; init; }
    [JsonPropertyName("networkErrorCount")] public int NetworkErrorCount { get; init; }
    [JsonPropertyName("errorMessage")] public string? ErrorMessage { get; init; }
    [JsonPropertyName("errorStack")] public string? ErrorStack { get; init; }
    [JsonPropertyName("artifacts")] public List<ArtifactPayload> Artifacts { get; init; } = new();
    [JsonPropertyName("consoleEvents")] public List<ConsoleEventPayload> ConsoleEvents { get; init; } = new();
    [JsonPropertyName("networkEvents")] public List<NetworkEventPayload> NetworkEvents { get; init; } = new();
    [JsonPropertyName("healingEvents")] public List<HealingEventPayload> HealingEvents { get; init; } = new();
    /// <summary>Present when the worker streamed actions; otherwise the completion carries them.</summary>
    [JsonPropertyName("actions")] public List<ActionResultPayload> Actions { get; init; } = new();
}

public sealed record ArtifactPayload
{
    [JsonPropertyName("kind")] public string Kind { get; init; } = "other";
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    [JsonPropertyName("storageKey")] public string StorageKey { get; init; } = string.Empty;
    [JsonPropertyName("contentType")] public string ContentType { get; init; } = "application/octet-stream";
    [JsonPropertyName("sizeBytes")] public long SizeBytes { get; init; }
    [JsonPropertyName("sha256")] public string Sha256 { get; init; } = string.Empty;
    [JsonPropertyName("isMasked")] public bool IsMasked { get; init; }
    [JsonPropertyName("actionOrder")] public int? ActionOrder { get; init; }
}

public sealed record ConsoleEventPayload
{
    [JsonPropertyName("level")] public string Level { get; init; } = "log";
    [JsonPropertyName("message")] public string Message { get; init; } = string.Empty;
    [JsonPropertyName("stackTrace")] public string? StackTrace { get; init; }
    [JsonPropertyName("url")] public string? Url { get; init; }
    [JsonPropertyName("occurredAt")] public DateTimeOffset OccurredAt { get; init; }
    [JsonPropertyName("actionOrder")] public int? ActionOrder { get; init; }
}

public sealed record NetworkEventPayload
{
    [JsonPropertyName("method")] public string Method { get; init; } = "GET";
    [JsonPropertyName("url")] public string Url { get; init; } = string.Empty;
    [JsonPropertyName("resourceType")] public string? ResourceType { get; init; }
    [JsonPropertyName("statusCode")] public int? StatusCode { get; init; }
    [JsonPropertyName("durationMs")] public int DurationMs { get; init; }
    [JsonPropertyName("requestSizeBytes")] public long RequestSizeBytes { get; init; }
    [JsonPropertyName("responseSizeBytes")] public long ResponseSizeBytes { get; init; }
    [JsonPropertyName("requestHeaders")] public Dictionary<string, string>? RequestHeaders { get; init; }
    [JsonPropertyName("responseHeaders")] public Dictionary<string, string>? ResponseHeaders { get; init; }
    [JsonPropertyName("requestBodyExcerpt")] public string? RequestBodyExcerpt { get; init; }
    [JsonPropertyName("responseBodyExcerpt")] public string? ResponseBodyExcerpt { get; init; }
    [JsonPropertyName("isFailed")] public bool IsFailed { get; init; }
    [JsonPropertyName("failureText")] public string? FailureText { get; init; }
    [JsonPropertyName("occurredAt")] public DateTimeOffset OccurredAt { get; init; }
    [JsonPropertyName("actionOrder")] public int? ActionOrder { get; init; }
}

public sealed record HealingEventPayload
{
    [JsonPropertyName("testStepId")] public Guid TestStepId { get; init; }
    [JsonPropertyName("originalLocator")] public LocatorDescriptor OriginalLocator { get; init; } = new();
    [JsonPropertyName("healedLocator")] public LocatorDescriptor HealedLocator { get; init; } = new();
    [JsonPropertyName("reason")] public string Reason { get; init; } = string.Empty;
    [JsonPropertyName("confidence")] public int Confidence { get; init; }
    [JsonPropertyName("breakdown")] public Dictionary<string, int> Breakdown { get; init; } = new();
    [JsonPropertyName("outcomeVerified")] public bool OutcomeVerified { get; init; }
    [JsonPropertyName("applied")] public bool Applied { get; init; }
    [JsonPropertyName("occurredAt")] public DateTimeOffset OccurredAt { get; init; }
}
