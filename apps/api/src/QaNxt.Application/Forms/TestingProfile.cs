using System.Text.Json;
using System.Text.Json.Serialization;
using QaNxt.Application.Contracts;
using QaNxt.Domain.Enums;

namespace QaNxt.Application.Forms;

/// <summary>What the user asked to be tested on an application: which categories, at which
/// viewports and browsers, against which budgets, and how coverage is weighted.
///
/// The mode is a preset over the categories, nothing more. Within a category every
/// applicable technique is generated: a mode never trims a category to "a few tests", because
/// a category that is selected and then quietly thinned is the arbitrary limit this design
/// exists to remove.</summary>
public sealed record TestingProfile
{
    [JsonPropertyName("mode")] public TestingMode Mode { get; init; } = TestingMode.Comprehensive;

    /// <summary>The categories chosen by hand. Read only in Custom mode.</summary>
    [JsonPropertyName("categories")] public List<TestCategory> Categories { get; init; } = new();

    /// <summary>Viewports as width x height. Desktop first; the rest are responsive checks.</summary>
    [JsonPropertyName("viewports")] public List<NamedViewport> Viewports { get; init; } = DefaultViewports();

    [JsonPropertyName("browsers")] public List<BrowserType> Browsers { get; init; } =
        new() { BrowserType.Chromium, BrowserType.Firefox, BrowserType.Webkit };

    [JsonPropertyName("pageLoadBudgetMs")] public int PageLoadBudgetMs { get; init; } = 3000;
    [JsonPropertyName("submitBudgetMs")] public int SubmitBudgetMs { get; init; } = 2000;

    /// <summary>Whether inert marker markup may be typed into fields to detect reflection.
    /// It is a custom element with no script and no handler, so it can do nothing even where
    /// it is reflected; it is still a probe, and the security scope may forbid probing.</summary>
    [JsonPropertyName("allowSafeSecurityProbes")] public bool AllowSafeSecurityProbes { get; init; } = true;

    /// <summary>Visual difference tolerated before a check asks for review, in percent.</summary>
    [JsonPropertyName("visualThresholdPercent")] public double VisualThresholdPercent { get; init; } = 0.5;

    /// <summary>How much each category counts towards a form's coverage score, keyed by the
    /// category's name as it travels on the wire ("functional"). A category absent from the
    /// map weighs 1; a weight of 0 excludes it from the score.</summary>
    [JsonPropertyName("weights")] public Dictionary<string, int> Weights { get; init; } = DefaultWeights();

    public static readonly IReadOnlyList<TestCategory> AllCategories = Enum.GetValues<TestCategory>();

    private static readonly TestCategory[] QuickCategories =
    {
        TestCategory.Smoke, TestCategory.Functional, TestCategory.Negative, TestCategory.Accessibility
    };

    private static readonly TestCategory[] StandardCategories = QuickCategories.Concat(new[]
    {
        TestCategory.Boundary, TestCategory.Validation, TestCategory.InputValidation, TestCategory.CrossField,
        TestCategory.Dynamic, TestCategory.MultiStep, TestCategory.ErrorHandling, TestCategory.Security,
        TestCategory.Api, TestCategory.StateTransition, TestCategory.Recovery
    }).ToArray();

    /// <summary>The categories this profile actually generates.</summary>
    public IReadOnlySet<TestCategory> EffectiveCategories() => Mode switch
    {
        TestingMode.Quick => QuickCategories.ToHashSet(),
        TestingMode.Standard => StandardCategories.ToHashSet(),
        TestingMode.Custom => Categories.ToHashSet(),
        // Comprehensive and full regression apply everything that applies.
        _ => AllCategories.ToHashSet()
    };

    public bool Includes(TestCategory category) => EffectiveCategories().Contains(category);

    public int WeightOf(TestCategory category)
    {
        var key = CategoryKey(category);
        foreach (var (name, weight) in Weights)
        {
            if (string.Equals(name, key, StringComparison.OrdinalIgnoreCase)) return weight;
        }
        return 1;
    }

    /// <summary>A category's name as the wire carries it.</summary>
    public static string CategoryKey(TestCategory category)
    {
        var name = category.ToString();
        return char.ToLowerInvariant(name[0]) + name[1..];
    }

    public static List<NamedViewport> DefaultViewports() => new()
    {
        new("desktop", 1440, 900), new("laptop", 1280, 800), new("tablet", 768, 1024), new("mobile", 390, 844)
    };

    public static Dictionary<string, int> DefaultWeights() => new(StringComparer.OrdinalIgnoreCase)
    {
        ["functional"] = 3, ["negative"] = 2, ["validation"] = 2,
        ["boundary"] = 2, ["security"] = 2, ["accessibility"] = 2
    };

    public string ToJson() => JsonSerializer.Serialize(this, JsonDefaults.Options);

    public static TestingProfile FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new TestingProfile();
        try { return JsonSerializer.Deserialize<TestingProfile>(json, JsonDefaults.Options) ?? new TestingProfile(); }
        catch (JsonException) { return new TestingProfile(); }
    }

    /// <summary>Problems with a profile a user submitted, in words they can act on.</summary>
    public IReadOnlyList<string> Validate()
    {
        var problems = new List<string>();
        if (Mode == TestingMode.Custom && Categories.Count == 0)
            problems.Add("Custom mode needs at least one testing category. Choose some, or pick another mode.");
        if (Viewports.Count == 0) problems.Add("At least one viewport is needed.");
        foreach (var viewport in Viewports)
        {
            if (viewport.Width is < 200 or > 4000 || viewport.Height is < 200 or > 4000)
                problems.Add($"Viewport '{viewport.Name}' must be between 200 and 4000 pixels in each direction.");
        }
        if (Browsers.Count == 0) problems.Add("At least one browser is needed.");
        if (PageLoadBudgetMs is < 100 or > 120_000) problems.Add("The page-load budget must be between 100 ms and 120 s.");
        if (SubmitBudgetMs is < 100 or > 120_000) problems.Add("The submission budget must be between 100 ms and 120 s.");
        if (VisualThresholdPercent is < 0 or > 100) problems.Add("The visual threshold is a percentage between 0 and 100.");
        if (Weights.Values.Any(w => w is < 0 or > 10)) problems.Add("Category weights must be between 0 and 10.");
        return problems;
    }
}

public sealed record NamedViewport(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("width")] int Width,
    [property: JsonPropertyName("height")] int Height)
{
    public string Size => $"{Width}x{Height}";
}
