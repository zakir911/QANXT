using System.Text.Json.Serialization;
using Aira.Domain.Enums;

namespace Aira.Application.Contracts;

/// <summary>The only shape the execution engine will run. AI-produced plans are
/// deserialized into this and then validated by <see cref="BrowserActionValidator"/>
/// before a browser is touched.</summary>
public sealed record BrowserAction
{
    [JsonPropertyName("action")] public BrowserActionType Action { get; init; }
    [JsonPropertyName("description")] public string Description { get; init; } = string.Empty;
    [JsonPropertyName("target")] public LocatorDescriptor? Target { get; init; }

    /// <summary>Literal text, or a reference: <c>${secret:name}</c> or <c>${data:field}</c>.
    /// Literal-looking credentials are rejected by the validator.</summary>
    [JsonPropertyName("value")] public string? Value { get; init; }

    [JsonPropertyName("url")] public string? Url { get; init; }
    [JsonPropertyName("timeoutMs")] public int? TimeoutMs { get; init; }
    [JsonPropertyName("expected")] public string? Expected { get; init; }
    [JsonPropertyName("attribute")] public string? Attribute { get; init; }
    [JsonPropertyName("count")] public int? Count { get; init; }
    [JsonPropertyName("key")] public string? Key { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
    [JsonPropertyName("critical")] public bool Critical { get; init; } = true;

    public bool IsAssertion => (int)Action >= 20 && (int)Action < 90;
}

public sealed record BrowserActionValidationResult(bool IsValid, IReadOnlyList<string> Errors)
{
    public static readonly BrowserActionValidationResult Valid = new(true, Array.Empty<string>());
    public static BrowserActionValidationResult Invalid(params string[] errors) => new(false, errors);
}

/// <summary>Strict, closed-world validation of an action before execution. This is the
/// gate that stops a hijacked or hallucinating model from doing something unintended:
/// unknown verbs, missing targets, forbidden scripting and credential literals are all
/// rejected here rather than in the browser.</summary>
public static class BrowserActionValidator
{
    private static readonly HashSet<BrowserActionType> RequireTarget = new()
    {
        BrowserActionType.Click, BrowserActionType.DoubleClick, BrowserActionType.Fill,
        BrowserActionType.Select, BrowserActionType.Check, BrowserActionType.Uncheck,
        BrowserActionType.Hover, BrowserActionType.Upload, BrowserActionType.Scroll,
        BrowserActionType.AssertText, BrowserActionType.AssertVisible, BrowserActionType.AssertHidden,
        BrowserActionType.AssertValue, BrowserActionType.AssertCount, BrowserActionType.AssertAttribute,
        BrowserActionType.AssertEnabled, BrowserActionType.AssertDisabled
    };

    private static readonly HashSet<BrowserActionType> RequireValue = new()
    {
        BrowserActionType.Fill, BrowserActionType.Select, BrowserActionType.Press
    };

    /// <summary>Patterns that suggest a real credential has been inlined into a plan.
    /// Test data must use <c>${secret:...}</c> references instead.</summary>
    private static readonly string[] CredentialHints = { "password=", "apikey=", "api_key=", "bearer ", "authorization:" };

    public static BrowserActionValidationResult Validate(BrowserAction action, BrowserActionPolicy policy)
    {
        var errors = new List<string>();

        if (!Enum.IsDefined(typeof(BrowserActionType), action.Action))
            errors.Add($"Unknown action '{(int)action.Action}'. Only the documented action set may be used.");

        if (action.Action == BrowserActionType.ExecuteScript)
        {
            if (!policy.AllowScriptExecution)
                errors.Add("executeScript is not permitted: enable script execution on the project and grant execution:script.");
            if (string.IsNullOrWhiteSpace(action.Value))
                errors.Add("executeScript requires a script body in 'value'.");
        }

        if (RequireTarget.Contains(action.Action) && action.Target is null)
            errors.Add($"Action '{action.Action}' requires a target locator.");

        if (RequireValue.Contains(action.Action) && string.IsNullOrEmpty(action.Value))
            errors.Add($"Action '{action.Action}' requires a value.");

        if (action.Action == BrowserActionType.Navigate)
        {
            if (string.IsNullOrWhiteSpace(action.Url))
                errors.Add("navigate requires a url.");
            else if (!policy.UrlGuard(action.Url!, out var reason))
                errors.Add($"navigate to '{action.Url}' is not allowed: {reason}");
        }

        if (action.Action == BrowserActionType.AssertUrl && string.IsNullOrWhiteSpace(action.Expected))
            errors.Add("assertUrl requires an expected value.");

        if (action.Action == BrowserActionType.AssertAttribute && string.IsNullOrWhiteSpace(action.Attribute))
            errors.Add("assertAttribute requires an attribute name.");

        if (action.Action == BrowserActionType.AssertCount && action.Count is null)
            errors.Add("assertCount requires a count.");

        if (action.Action == BrowserActionType.Upload && string.IsNullOrWhiteSpace(action.FilePath))
            errors.Add("upload requires a filePath from the managed test-file store.");

        if (action.Target is not null)
            ValidateLocator(action.Target, policy, errors, depth: 0);

        if (action.TimeoutMs is < 0 or > 300_000)
            errors.Add("timeoutMs must be between 0 and 300000.");

        if (!string.IsNullOrEmpty(action.Value) && !IsReference(action.Value!))
        {
            var lowered = action.Value!.ToLowerInvariant();
            if (CredentialHints.Any(h => lowered.Contains(h)))
                errors.Add("Credential-like literals are not permitted in a step value; use a ${secret:name} reference.");
        }

        return errors.Count == 0 ? BrowserActionValidationResult.Valid : new BrowserActionValidationResult(false, errors);
    }

    private static bool IsReference(string value) =>
        value.StartsWith("${secret:", StringComparison.Ordinal) || value.StartsWith("${data:", StringComparison.Ordinal);

    private static void ValidateLocator(LocatorDescriptor locator, BrowserActionPolicy policy, List<string> errors, int depth)
    {
        if (depth > 3) { errors.Add("Locator nesting is limited to 3 levels."); return; }
        if (!Enum.IsDefined(typeof(LocatorStrategy), locator.Strategy))
            errors.Add("Unknown locator strategy.");
        if (string.IsNullOrWhiteSpace(locator.Value))
            errors.Add($"Locator of strategy '{locator.Strategy}' requires a value.");
        if (locator.Value.Length > 512)
            errors.Add("Locator value exceeds 512 characters.");
        if (locator.Nth is < 0)
            errors.Add("Locator 'nth' must be zero or greater.");
        if (locator.Strategy == LocatorStrategy.Xpath && !policy.AllowXPathLocators)
            errors.Add("XPath locators are disabled for this project because they are the least stable strategy.");
        if (locator.Within is not null) ValidateLocator(locator.Within, policy, errors, depth + 1);
        if (locator.Fallbacks.Count > 8)
            errors.Add("At most 8 fallback locators are allowed.");
        foreach (var fb in locator.Fallbacks) ValidateLocator(fb, policy, errors, depth + 1);
    }
}

/// <summary>Project-scoped rules applied during validation.</summary>
public sealed record BrowserActionPolicy(
    bool AllowScriptExecution,
    bool AllowXPathLocators,
    UrlGuardDelegate UrlGuard);

public delegate bool UrlGuardDelegate(string url, out string reason);
