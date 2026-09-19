using Aira.Application.Contracts;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Contracts;

public class LocatorDescriptorTests
{
    [Fact]
    public void Round_trips_through_json_including_fallbacks()
    {
        var locator = new LocatorDescriptor
        {
            Strategy = LocatorStrategy.Role,
            Value = "button",
            Name = "Sign in",
            Exact = true,
            Fallbacks = new[]
            {
                new LocatorDescriptor { Strategy = LocatorStrategy.TestId, Value = "login-submit" }
            }
        };

        var restored = LocatorDescriptor.FromJson(locator.ToJson());

        restored.Should().NotBeNull();
        restored!.Strategy.Should().Be(LocatorStrategy.Role);
        restored.Name.Should().Be("Sign in");
        restored.Fallbacks.Should().ContainSingle()
            .Which.Strategy.Should().Be(LocatorStrategy.TestId);
    }

    [Fact]
    public void FromJson_returns_null_rather_than_throwing_on_malformed_input()
        => LocatorDescriptor.FromJson("{not json").Should().BeNull();

    [Fact]
    public void Stability_ranks_semantic_strategies_above_structural_ones()
    {
        var testId = new LocatorDescriptor { Strategy = LocatorStrategy.TestId, Value = "x" }.StabilityScore();
        var role = new LocatorDescriptor { Strategy = LocatorStrategy.Role, Value = "button", Name = "Save" }.StabilityScore();
        var text = new LocatorDescriptor { Strategy = LocatorStrategy.Text, Value = "Save" }.StabilityScore();
        var css = new LocatorDescriptor { Strategy = LocatorStrategy.Css, Value = ".btn" }.StabilityScore();
        var xpath = new LocatorDescriptor { Strategy = LocatorStrategy.Xpath, Value = "//div[2]" }.StabilityScore();

        testId.Should().BeGreaterThan(role);
        role.Should().BeGreaterThan(text);
        text.Should().BeGreaterThan(css);
        css.Should().BeGreaterThan(xpath);
    }

    [Fact]
    public void A_role_locator_without_a_name_is_less_stable_than_one_with()
    {
        var named = new LocatorDescriptor { Strategy = LocatorStrategy.Role, Value = "button", Name = "Save" }.StabilityScore();
        var anonymous = new LocatorDescriptor { Strategy = LocatorStrategy.Role, Value = "button" }.StabilityScore();
        anonymous.Should().BeLessThan(named);
    }

    [Fact]
    public void Describe_produces_a_human_readable_form_for_reports()
    {
        new LocatorDescriptor { Strategy = LocatorStrategy.Role, Value = "button", Name = "Login" }
            .Describe().Should().Be("role=button name=\"Login\"");
        new LocatorDescriptor { Strategy = LocatorStrategy.TestId, Value = "submit" }
            .Describe().Should().Be("testId=\"submit\"");
    }
}
