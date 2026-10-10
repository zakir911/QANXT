using System.Text.Json.Serialization;
using QaNxt.Domain.Enums;

namespace QaNxt.Application.Discovery;

/// <summary>Mirrors the TypeScript `DiscoveryJob`. Field names are camel-cased on the
/// wire; the cross-language contract test keeps the two definitions aligned.</summary>
public sealed record DiscoveryJobPayload
{
    [JsonPropertyName("jobId")] public string JobId { get; init; } = string.Empty;
    [JsonPropertyName("discoveryRunId")] public Guid DiscoveryRunId { get; init; }
    [JsonPropertyName("organizationId")] public Guid OrganizationId { get; init; }
    [JsonPropertyName("projectId")] public Guid ProjectId { get; init; }
    [JsonPropertyName("applicationId")] public Guid ApplicationId { get; init; }
    [JsonPropertyName("baseUrl")] public string BaseUrl { get; init; } = string.Empty;
    [JsonPropertyName("browser")] public string Browser { get; init; } = "chromium";
    [JsonPropertyName("headless")] public bool Headless { get; init; } = true;
    [JsonPropertyName("auth")] public AuthConfigPayload Auth { get; init; } = new();
    [JsonPropertyName("budget")] public CrawlBudgetPayload Budget { get; init; } = new();
    [JsonPropertyName("callbackToken")] public string CallbackToken { get; init; } = string.Empty;
    [JsonPropertyName("callbackBaseUrl")] public string CallbackBaseUrl { get; init; } = string.Empty;
    [JsonPropertyName("correlationId")] public string CorrelationId { get; init; } = string.Empty;
}

public sealed record AuthConfigPayload
{
    [JsonPropertyName("strategy")] public AuthenticationStrategy Strategy { get; init; } = AuthenticationStrategy.None;
    [JsonPropertyName("loginUrl")] public string? LoginUrl { get; init; }
    [JsonPropertyName("usernameLocator")] public object? UsernameLocator { get; init; }
    [JsonPropertyName("passwordLocator")] public object? PasswordLocator { get; init; }
    [JsonPropertyName("submitLocator")] public object? SubmitLocator { get; init; }
    [JsonPropertyName("successLocator")] public object? SuccessLocator { get; init; }
    [JsonPropertyName("successUrlContains")] public string? SuccessUrlContains { get; init; }
    [JsonPropertyName("username")] public string? Username { get; init; }
    [JsonPropertyName("password")] public string? Password { get; init; }
    [JsonPropertyName("bearerToken")] public string? BearerToken { get; init; }
    [JsonPropertyName("storageStateJson")] public string? StorageStateJson { get; init; }
}

public sealed record CrawlBudgetPayload
{
    [JsonPropertyName("allowedHosts")] public string[] AllowedHosts { get; init; } = Array.Empty<string>();
    [JsonPropertyName("excludedPathPrefixes")] public string[] ExcludedPathPrefixes { get; init; } = Array.Empty<string>();
    [JsonPropertyName("maxDepth")] public int MaxDepth { get; init; } = 3;
    [JsonPropertyName("maxPages")] public int MaxPages { get; init; } = 50;
    [JsonPropertyName("maxActions")] public int MaxActions { get; init; } = 400;
    [JsonPropertyName("maxInstancesPerRouteShape")] public int MaxInstancesPerRouteShape { get; init; } = 3;
    [JsonPropertyName("timeoutSeconds")] public int TimeoutSeconds { get; init; } = 600;
    [JsonPropertyName("allowPrivateNetworks")] public bool AllowPrivateNetworks { get; init; }
    [JsonPropertyName("respectRobotsTxt")] public bool RespectRobotsTxt { get; init; } = true;
    [JsonPropertyName("interactionMode")] public string InteractionMode { get; init; } = "links";
    [JsonPropertyName("allowStateChangingClicks")] public bool AllowStateChangingClicks { get; init; }
}

// ---- Worker callbacks -------------------------------------------------------

public sealed record DiscoveryProgressPayload(
    [property: JsonPropertyName("pagesVisited")] int PagesVisited,
    [property: JsonPropertyName("pagesQueued")] int PagesQueued,
    [property: JsonPropertyName("elementsFound")] int ElementsFound,
    [property: JsonPropertyName("currentUrl")] string? CurrentUrl,
    [property: JsonPropertyName("message")] string Message);

public sealed record DiscoveryCompletionPayload
{
    [JsonPropertyName("status")] public string Status { get; init; } = "completed";
    [JsonPropertyName("startedAt")] public DateTimeOffset StartedAt { get; init; }
    [JsonPropertyName("completedAt")] public DateTimeOffset CompletedAt { get; init; }
    [JsonPropertyName("workerId")] public string WorkerId { get; init; } = string.Empty;
    [JsonPropertyName("pages")] public List<DiscoveredPagePayload> Pages { get; init; } = new();
    [JsonPropertyName("transitions")] public List<DiscoveredTransitionPayload> Transitions { get; init; } = new();
    [JsonPropertyName("apiEndpoints")] public List<DiscoveredApiEndpointPayload> ApiEndpoints { get; init; } = new();
    [JsonPropertyName("consoleErrors")] public List<ConsoleErrorPayload> ConsoleErrors { get; init; } = new();
    [JsonPropertyName("pagesBlockedByPolicy")] public int PagesBlockedByPolicy { get; init; }
    [JsonPropertyName("errorMessage")] public string? ErrorMessage { get; init; }
    [JsonPropertyName("progressLog")] public string ProgressLog { get; init; } = string.Empty;
}

public sealed record DiscoveredPagePayload
{
    [JsonPropertyName("url")] public string Url { get; init; } = string.Empty;
    [JsonPropertyName("normalizedUrl")] public string NormalizedUrl { get; init; } = string.Empty;
    [JsonPropertyName("route")] public string Route { get; init; } = string.Empty;
    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;
    [JsonPropertyName("kind")] public PageKind Kind { get; init; }
    [JsonPropertyName("depth")] public int Depth { get; init; }
    [JsonPropertyName("parentNormalizedUrl")] public string? ParentNormalizedUrl { get; init; }
    [JsonPropertyName("requiresAuthentication")] public bool RequiresAuthentication { get; init; }
    [JsonPropertyName("httpStatus")] public int? HttpStatus { get; init; }
    [JsonPropertyName("loadTimeMs")] public int LoadTimeMs { get; init; }
    [JsonPropertyName("consoleErrorCount")] public int ConsoleErrorCount { get; init; }
    [JsonPropertyName("visibleTextExcerpt")] public string VisibleTextExcerpt { get; init; } = string.Empty;
    [JsonPropertyName("screenshotKey")] public string? ScreenshotKey { get; init; }
    [JsonPropertyName("domKey")] public string? DomKey { get; init; }
    [JsonPropertyName("accessibilityKey")] public string? AccessibilityKey { get; init; }
    [JsonPropertyName("elements")] public List<DiscoveredElementPayload> Elements { get; init; } = new();
}

public sealed record DiscoveredElementPayload
{
    [JsonPropertyName("kind")] public ElementKind Kind { get; init; }
    [JsonPropertyName("tagName")] public string TagName { get; init; } = string.Empty;
    [JsonPropertyName("ariaRole")] public string? AriaRole { get; init; }
    [JsonPropertyName("accessibleName")] public string? AccessibleName { get; init; }
    [JsonPropertyName("text")] public string? Text { get; init; }
    [JsonPropertyName("label")] public string? Label { get; init; }
    [JsonPropertyName("placeholder")] public string? Placeholder { get; init; }
    [JsonPropertyName("testId")] public string? TestId { get; init; }
    [JsonPropertyName("elementId")] public string? ElementId { get; init; }
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("value")] public string? Value { get; init; }
    [JsonPropertyName("cssSelector")] public string? CssSelector { get; init; }
    [JsonPropertyName("xpath")] public string? Xpath { get; init; }
    [JsonPropertyName("domPath")] public string? DomPath { get; init; }
    [JsonPropertyName("parentSignature")] public string? ParentSignature { get; init; }
    [JsonPropertyName("neighbourText")] public string? NeighbourText { get; init; }
    [JsonPropertyName("bounding")] public BoundingPayload Bounding { get; init; } = new(0, 0, 0, 0);
    [JsonPropertyName("isVisible")] public bool IsVisible { get; init; }
    [JsonPropertyName("isEnabled")] public bool IsEnabled { get; init; }
    [JsonPropertyName("isRequired")] public bool IsRequired { get; init; }
    [JsonPropertyName("attributes")] public Dictionary<string, string> Attributes { get; init; } = new();
    [JsonPropertyName("preferredLocator")] public Contracts.LocatorDescriptor PreferredLocator { get; init; } = new();
    [JsonPropertyName("stabilityScore")] public int StabilityScore { get; init; }
}

public sealed record BoundingPayload(
    [property: JsonPropertyName("x")] int X,
    [property: JsonPropertyName("y")] int Y,
    [property: JsonPropertyName("width")] int Width,
    [property: JsonPropertyName("height")] int Height);

public sealed record DiscoveredTransitionPayload(
    [property: JsonPropertyName("fromNormalizedUrl")] string FromNormalizedUrl,
    [property: JsonPropertyName("toNormalizedUrl")] string ToNormalizedUrl,
    [property: JsonPropertyName("action")] string Action,
    [property: JsonPropertyName("triggerAccessibleName")] string? TriggerAccessibleName);

public sealed record DiscoveredApiEndpointPayload
{
    [JsonPropertyName("method")] public string Method { get; init; } = "GET";
    [JsonPropertyName("urlTemplate")] public string UrlTemplate { get; init; } = string.Empty;
    [JsonPropertyName("sampleUrl")] public string SampleUrl { get; init; } = string.Empty;
    [JsonPropertyName("timesObserved")] public int TimesObserved { get; init; } = 1;
    [JsonPropertyName("statusCode")] public int? StatusCode { get; init; }
    [JsonPropertyName("durationMs")] public int DurationMs { get; init; }
    [JsonPropertyName("requestSample")] public string? RequestSample { get; init; }
    [JsonPropertyName("responseSample")] public string? ResponseSample { get; init; }
    [JsonPropertyName("requestContentType")] public string? RequestContentType { get; init; }
    [JsonPropertyName("responseContentType")] public string? ResponseContentType { get; init; }
    [JsonPropertyName("requiresAuthentication")] public bool RequiresAuthentication { get; init; }
    [JsonPropertyName("triggeredByNormalizedUrl")] public string? TriggeredByNormalizedUrl { get; init; }
}

public sealed record ConsoleErrorPayload(
    [property: JsonPropertyName("level")] string Level,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("url")] string? Url,
    [property: JsonPropertyName("occurredAt")] DateTimeOffset OccurredAt);
