using System.Text.Json;
using System.Text.Json.Serialization;
using QaNxt.Application.Contracts;

namespace QaNxt.Application.Forms;

/// <summary>A form as discovery reported it. Mirrors <c>DiscoveredForm</c> in shared-types,
/// which is the contract the worker writes.</summary>
public sealed record DiscoveredFormModel
{
    [JsonPropertyName("key")] public string Key { get; init; } = string.Empty;
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    [JsonPropertyName("hasFormElement")] public bool HasFormElement { get; init; } = true;
    [JsonPropertyName("domIndex")] public int DomIndex { get; init; }
    [JsonPropertyName("action")] public string? Action { get; init; }
    [JsonPropertyName("method")] public string Method { get; init; } = "get";
    [JsonPropertyName("enctype")] public string? Enctype { get; init; }
    [JsonPropertyName("noValidate")] public bool NoValidate { get; init; }
    [JsonPropertyName("hasCsrfToken")] public bool HasCsrfToken { get; init; }
    [JsonPropertyName("hiddenFieldNames")] public List<string> HiddenFieldNames { get; init; } = new();
    [JsonPropertyName("locator")] public LocatorDescriptor Locator { get; init; } = new() { Strategy = LocatorStrategy.Css, Value = "form" };
    [JsonPropertyName("fields")] public List<FormFieldModel> Fields { get; init; } = new();
    [JsonPropertyName("buttons")] public List<FormButtonModel> Buttons { get; init; } = new();
    [JsonPropertyName("groupCount")] public int GroupCount { get; init; } = 1;
    [JsonPropertyName("visibleGroup")] public int VisibleGroup { get; init; }
    [JsonPropertyName("isMultiStep")] public bool IsMultiStep { get; init; }
    [JsonPropertyName("stepIndicatorText")] public string? StepIndicatorText { get; init; }
    [JsonPropertyName("dependencies")] public List<FormDependencyModel> Dependencies { get; init; } = new();
    [JsonPropertyName("probeNote")] public string? ProbeNote { get; init; }
    /// <summary>No field was visible when the page loaded: the form lives behind something.</summary>
    [JsonPropertyName("hiddenAtLoad")] public bool HiddenAtLoad { get; init; }
    /// <summary>The control that reveals a form hidden at load, when discovery found one.</summary>
    [JsonPropertyName("opener")] public FormOpenerModel? Opener { get; init; }

    public string ToJson() => JsonSerializer.Serialize(this, JsonDefaults.Options);

    public static DiscoveredFormModel? FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize<DiscoveredFormModel>(json, JsonDefaults.Options); }
        catch (JsonException) { return null; }
    }
}

public sealed record FormOpenerModel
{
    [JsonPropertyName("label")] public string Label { get; init; } = string.Empty;
    [JsonPropertyName("locator")] public LocatorDescriptor Locator { get; init; } = new() { Strategy = LocatorStrategy.Css, Value = "button" };
}

public sealed record FormFieldModel
{
    [JsonPropertyName("key")] public string Key { get; init; } = string.Empty;
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("elementId")] public string? ElementId { get; init; }
    [JsonPropertyName("testId")] public string? TestId { get; init; }
    [JsonPropertyName("label")] public string? Label { get; init; }
    [JsonPropertyName("hasAssociatedLabel")] public bool HasAssociatedLabel { get; init; }
    [JsonPropertyName("accessibleName")] public string? AccessibleName { get; init; }
    [JsonPropertyName("placeholder")] public string? Placeholder { get; init; }
    [JsonPropertyName("tagName")] public string TagName { get; init; } = "input";
    [JsonPropertyName("controlType")] public string ControlType { get; init; } = "text";
    [JsonPropertyName("htmlType")] public string? HtmlType { get; init; }
    [JsonPropertyName("role")] public string? Role { get; init; }
    [JsonPropertyName("required")] public bool Required { get; init; }
    [JsonPropertyName("readOnly")] public bool ReadOnly { get; init; }
    [JsonPropertyName("disabled")] public bool Disabled { get; init; }
    [JsonPropertyName("visible")] public bool Visible { get; init; } = true;
    [JsonPropertyName("defaultValue")] public string? DefaultValue { get; init; }
    [JsonPropertyName("checked")] public bool Checked { get; init; }
    [JsonPropertyName("constraints")] public Dictionary<string, string> Constraints { get; init; } = new();
    [JsonPropertyName("options")] public List<FormOptionModel> Options { get; init; } = new();
    [JsonPropertyName("autocomplete")] public string? Autocomplete { get; init; }
    [JsonPropertyName("inputMode")] public string? InputMode { get; init; }
    [JsonPropertyName("describedByText")] public string? DescribedByText { get; init; }
    [JsonPropertyName("ariaInvalid")] public bool AriaInvalid { get; init; }
    [JsonPropertyName("group")] public int Group { get; init; }
    [JsonPropertyName("groupLabel")] public string? GroupLabel { get; init; }
    [JsonPropertyName("locator")] public LocatorDescriptor Locator { get; init; } = new();

    /// <summary>The name a person reads: the label, else the accessible name, else the
    /// placeholder, else the control's name.</summary>
    [JsonIgnore]
    public string DisplayName => Label ?? AccessibleName ?? Placeholder ?? Name ?? Key;

    /// <summary>The identity used in coverage keys and test data.</summary>
    [JsonIgnore]
    public string Identity => Name ?? ElementId ?? Key;

    public string? Constraint(string name) => Constraints.TryGetValue(name, out var value) ? value : null;
}

public sealed record FormOptionModel
{
    [JsonPropertyName("value")] public string Value { get; init; } = string.Empty;
    [JsonPropertyName("label")] public string Label { get; init; } = string.Empty;
    [JsonPropertyName("disabled")] public bool Disabled { get; init; }
}

public sealed record FormButtonModel
{
    [JsonPropertyName("label")] public string Label { get; init; } = string.Empty;
    [JsonPropertyName("type")] public string Type { get; init; } = "submit";
    [JsonPropertyName("testId")] public string? TestId { get; init; }
    [JsonPropertyName("role")] public string Role { get; init; } = "submit";
    [JsonPropertyName("visible")] public bool Visible { get; init; } = true;
    [JsonPropertyName("disabled")] public bool Disabled { get; init; }
    [JsonPropertyName("locator")] public LocatorDescriptor Locator { get; init; } = new();
}

public sealed record FormDependencyModel
{
    [JsonPropertyName("trigger")] public string Trigger { get; init; } = string.Empty;
    [JsonPropertyName("triggerLabel")] public string TriggerLabel { get; init; } = string.Empty;
    [JsonPropertyName("triggerValue")] public string TriggerValue { get; init; } = string.Empty;
    [JsonPropertyName("shows")] public List<string> Shows { get; init; } = new();
    [JsonPropertyName("hides")] public List<string> Hides { get; init; } = new();
    [JsonPropertyName("becomesRequired")] public List<string> BecomesRequired { get; init; } = new();
    [JsonPropertyName("optionsOf")] public Dictionary<string, List<string>> OptionsOf { get; init; } = new();
}
