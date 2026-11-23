using QaNxt.Application.Contracts;

namespace QaNxt.Application.Testing;

/// <summary>One application's element model, indexed by the ways a locator can name a
/// control, so a step's fingerprint is a lookup rather than a scan.
///
/// The scan it replaces was the other half of the cost: 8,599 elements searched for each
/// step of each of 7,602 executions. First-one-wins is kept from the
/// <c>FirstOrDefault</c> it stands in for.</summary>
public sealed class ElementFingerprintIndex
{
    private readonly Dictionary<string, ElementFingerprintPayload> _byTestId = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ElementFingerprintPayload> _byRole = new(StringComparer.Ordinal);
    private readonly Dictionary<(string Role, string Name), ElementFingerprintPayload> _byRoleAndName = new();
    private readonly Dictionary<string, ElementFingerprintPayload> _byLabel = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ElementFingerprintPayload> _byPlaceholder = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ElementFingerprintPayload> _byText = new(StringComparer.Ordinal);

    public void Add(string? testId, string? role, string? accessibleName, string? label,
        string? placeholder, string? text, ElementFingerprintPayload element)
    {
        if (testId is not null) _byTestId.TryAdd(testId, element);
        if (role is not null)
        {
            _byRole.TryAdd(role, element);
            if (accessibleName is not null) _byRoleAndName.TryAdd((role, accessibleName), element);
        }
        if (label is not null) _byLabel.TryAdd(label, element);
        if (placeholder is not null) _byPlaceholder.TryAdd(placeholder, element);
        if (text is not null) _byText.TryAdd(text, element);
    }

    /// <summary>The element this locator names, or null when the model holds nothing that
    /// matches — the same answer the scan gave, reached by lookup.</summary>
    public ElementFingerprintPayload? Match(LocatorDescriptor locator) => locator.Strategy switch
    {
        LocatorStrategy.TestId => _byTestId.GetValueOrDefault(locator.Value),
        // A role with no accessible name matches on role alone, as it did before.
        LocatorStrategy.Role => locator.Name is null
            ? _byRole.GetValueOrDefault(locator.Value)
            : _byRoleAndName.GetValueOrDefault((locator.Value, locator.Name)),
        LocatorStrategy.Label => _byLabel.GetValueOrDefault(locator.Value),
        LocatorStrategy.Placeholder => _byPlaceholder.GetValueOrDefault(locator.Value),
        LocatorStrategy.Text => _byText.GetValueOrDefault(locator.Value),
        _ => null
    };
}
