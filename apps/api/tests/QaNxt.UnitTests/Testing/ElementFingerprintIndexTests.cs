using FluentAssertions;
using QaNxt.Application.Contracts;
using QaNxt.Application.Testing;
using Xunit;

namespace QaNxt.UnitTests.Testing;

/// <summary>The index replaced a linear scan of one application's whole element model, run
/// once per step per execution. Speed is only worth having if the answer did not change, so
/// these tests hold the index against the scan it stands in for rather than against what the
/// index happens to do.</summary>
public class ElementFingerprintIndexTests
{
    /// <summary>One element, in the shape the matcher cares about.</summary>
    private sealed record Element(
        string? TestId, string? Role, string? AccessibleName, string? Label,
        string? Placeholder, string? Text);

    /// <summary>The model a real application produces: controls that share a role, two that
    /// share a role and differ by name, repeated labels, and plenty of nulls.</summary>
    private static readonly Element[] Model =
    {
        new("ship-save", "button", "Save", "Save shipment", null, "Save"),
        new(null, "button", "Cancel", null, null, "Cancel"),
        new("ship-ref", "textbox", "Reference", "Reference", "e.g. SHP-0001", null),
        new(null, "textbox", "Reference", "Reference", "e.g. SHP-0002", null),
        new("ship-save", "link", "Save", null, null, "Save a copy"),
        new(null, null, null, null, null, null),
        new(null, "combobox", null, "Carrier", null, null),
        new("ship-del", "button", "Delete", "Delete shipment", null, "Delete")
    };

    /// <summary>The matcher as it was before the index: a first-one-wins linear scan.</summary>
    private static Element? Scan(Element[] model, LocatorDescriptor locator) => locator.Strategy switch
    {
        LocatorStrategy.TestId => model.FirstOrDefault(e => e.TestId == locator.Value),
        LocatorStrategy.Role => model.FirstOrDefault(e =>
            e.Role == locator.Value && (locator.Name == null || e.AccessibleName == locator.Name)),
        LocatorStrategy.Label => model.FirstOrDefault(e => e.Label == locator.Value),
        LocatorStrategy.Placeholder => model.FirstOrDefault(e => e.Placeholder == locator.Value),
        LocatorStrategy.Text => model.FirstOrDefault(e => e.Text == locator.Value),
        _ => null
    };

    private static ElementFingerprintIndex Build(Element[] model)
    {
        var index = new ElementFingerprintIndex();
        foreach (var e in model)
        {
            index.Add(e.TestId, e.Role, e.AccessibleName, e.Label, e.Placeholder, e.Text,
                new ElementFingerprintPayload
                {
                    TestId = e.TestId,
                    AriaRole = e.Role,
                    AccessibleName = e.AccessibleName,
                    Label = e.Label,
                    Placeholder = e.Placeholder,
                    Text = e.Text
                });
        }

        return index;
    }

    /// <summary>Every locator a step could carry, including values no element has.</summary>
    public static TheoryData<LocatorStrategy, string, string?> EveryLocator()
    {
        var data = new TheoryData<LocatorStrategy, string, string?>();
        var strategies = new[]
        {
            LocatorStrategy.TestId, LocatorStrategy.Role, LocatorStrategy.Label,
            LocatorStrategy.Placeholder, LocatorStrategy.Text
        };

        var values = new List<string?>();
        foreach (var e in Model)
        {
            values.Add(e.TestId); values.Add(e.Role); values.Add(e.Label);
            values.Add(e.Placeholder); values.Add(e.Text);
        }
        values.Add("absent"); values.Add(string.Empty);

        var names = new string?[] { null, "Save", "Cancel", "Reference", "Delete", "absent" };

        foreach (var strategy in strategies)
        foreach (var value in values.Where(v => v is not null).Distinct())
        foreach (var name in names)
            data.Add(strategy, value!, name);

        return data;
    }

    [Theory]
    [MemberData(nameof(EveryLocator))]
    public void The_index_answers_what_the_scan_answered(LocatorStrategy strategy, string value, string? name)
    {
        var locator = new LocatorDescriptor { Strategy = strategy, Value = value, Name = name };

        var expected = Scan(Model, locator);
        var actual = Build(Model).Match(locator);

        if (expected is null)
        {
            actual.Should().BeNull(
                $"the scan found nothing for {strategy} '{value}' name '{name ?? "(none)"}'");
            return;
        }

        actual.Should().NotBeNull(
            $"the scan found an element for {strategy} '{value}' name '{name ?? "(none)"}'");
        actual!.TestId.Should().Be(expected.TestId);
        actual.AriaRole.Should().Be(expected.Role);
        actual.AccessibleName.Should().Be(expected.AccessibleName);
        actual.Label.Should().Be(expected.Label);
        actual.Placeholder.Should().Be(expected.Placeholder);
        actual.Text.Should().Be(expected.Text);
    }

    [Fact]
    public void A_role_with_no_name_matches_the_first_control_of_that_role()
    {
        var match = Build(Model).Match(new LocatorDescriptor
        {
            Strategy = LocatorStrategy.Role, Value = "button"
        });

        match.Should().NotBeNull();
        match!.AccessibleName.Should().Be("Save", "the Save button comes first in the model");
    }

    [Fact]
    public void A_role_with_a_name_needs_both_to_match()
    {
        var index = Build(Model);

        index.Match(new LocatorDescriptor
        {
            Strategy = LocatorStrategy.Role, Value = "button", Name = "Delete"
        })!.TestId.Should().Be("ship-del");

        index.Match(new LocatorDescriptor
        {
            // "Carrier" is a combobox, not a button.
            Strategy = LocatorStrategy.Role, Value = "button", Name = "Carrier"
        }).Should().BeNull();
    }

    [Fact]
    public void Repeated_keys_keep_the_first_element_as_the_scan_did()
    {
        // Two textboxes carry the label "Reference"; the first one wins, so the fingerprint
        // describes the control the test was authored against and not an arbitrary twin.
        Build(Model).Match(new LocatorDescriptor
        {
            Strategy = LocatorStrategy.Label, Value = "Reference"
        })!.Placeholder.Should().Be("e.g. SHP-0001");
    }

    [Fact]
    public void A_strategy_the_element_model_cannot_describe_has_no_fingerprint()
    {
        var index = Build(Model);

        // A CSS selector or an XPath is not a property the discovered model records, so there
        // is nothing to match against. Returning null leaves the step without a fingerprint,
        // which is honest; returning some element would hand the healer a wrong baseline.
        foreach (var strategy in new[] { LocatorStrategy.Css, LocatorStrategy.Xpath })
        {
            index.Match(new LocatorDescriptor { Strategy = strategy, Value = "button.save" })
                .Should().BeNull();
        }
    }

    [Fact]
    public void An_empty_model_matches_nothing_rather_than_throwing()
    {
        var index = Build(Array.Empty<Element>());

        index.Match(new LocatorDescriptor { Strategy = LocatorStrategy.TestId, Value = "ship-save" })
            .Should().BeNull();
        index.Match(new LocatorDescriptor { Strategy = LocatorStrategy.Role, Value = "button", Name = "Save" })
            .Should().BeNull();
    }
}
