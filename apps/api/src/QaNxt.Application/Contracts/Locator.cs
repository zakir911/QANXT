using System.Text.Json;
using System.Text.Json.Serialization;

namespace QaNxt.Application.Contracts;

/// <summary>How an element is found. Ordered roughly by resilience: semantic strategies
/// survive refactors, structural ones do not, which is why the score weights differ.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum LocatorStrategy
{
    /// <summary>ARIA role + accessible name. The most change-resistant strategy.</summary>
    Role = 0,
    TestId = 1,
    Label = 2,
    Placeholder = 3,
    Text = 4,
    AltText = 5,
    Title = 6,
    Css = 7,
    Xpath = 8
}

/// <summary>A locator plus its ordered fallbacks. This is the only locator shape the
/// execution engine accepts; a bare CSS string is never enough.</summary>
public sealed record LocatorDescriptor
{
    [JsonPropertyName("strategy")] public LocatorStrategy Strategy { get; init; } = LocatorStrategy.Role;

    /// <summary>The role for Role, the test id for TestId, the text for Text, the selector for Css.</summary>
    [JsonPropertyName("value")] public string Value { get; init; } = string.Empty;

    /// <summary>Accessible name, used with <see cref="LocatorStrategy.Role"/>.</summary>
    [JsonPropertyName("name")] public string? Name { get; init; }

    /// <summary>Require an exact rather than substring match on name/text.</summary>
    [JsonPropertyName("exact")] public bool Exact { get; init; }

    /// <summary>Disambiguates when several elements match; 0-based.</summary>
    [JsonPropertyName("nth")] public int? Nth { get; init; }

    /// <summary>Scopes the search, e.g. within a dialog or a table row.</summary>
    [JsonPropertyName("within")] public LocatorDescriptor? Within { get; init; }

    /// <summary>Tried in order if the primary does not resolve, before any healing is attempted.</summary>
    [JsonPropertyName("fallbacks")] public IReadOnlyList<LocatorDescriptor> Fallbacks { get; init; } = Array.Empty<LocatorDescriptor>();

    /// <summary>Human-readable form used in logs, reports and healing explanations.</summary>
    public string Describe() => Strategy switch
    {
        LocatorStrategy.Role => $"role={Value}" + (string.IsNullOrEmpty(Name) ? "" : $" name=\"{Name}\""),
        LocatorStrategy.TestId => $"testId=\"{Value}\"",
        LocatorStrategy.Label => $"label=\"{Value}\"",
        LocatorStrategy.Placeholder => $"placeholder=\"{Value}\"",
        LocatorStrategy.Text => $"text=\"{Value}\"",
        LocatorStrategy.AltText => $"altText=\"{Value}\"",
        LocatorStrategy.Title => $"title=\"{Value}\"",
        LocatorStrategy.Css => $"css={Value}",
        LocatorStrategy.Xpath => $"xpath={Value}",
        _ => Value
    };

    /// <summary>0-100 estimate of how likely this locator is to survive UI change.
    /// Used to pick a primary locator at authoring time and to break ties when healing.</summary>
    public int StabilityScore() => Strategy switch
    {
        LocatorStrategy.TestId => 95,
        LocatorStrategy.Role => string.IsNullOrEmpty(Name) ? 65 : 90,
        LocatorStrategy.Label => 85,
        LocatorStrategy.Placeholder => 70,
        LocatorStrategy.AltText => 70,
        LocatorStrategy.Title => 60,
        LocatorStrategy.Text => 55,
        LocatorStrategy.Css => 30,
        LocatorStrategy.Xpath => 15,
        _ => 20
    };

    public static LocatorDescriptor? FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize<LocatorDescriptor>(json, JsonDefaults.Options); }
        catch (JsonException) { return null; }
    }

    public string ToJson() => JsonSerializer.Serialize(this, JsonDefaults.Options);
}

public static class JsonDefaults
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };
}
