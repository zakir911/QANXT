using Aira.Application.Contracts;
using Aira.Domain.Enums;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Contracts;

/// <summary>This validator is the gate between an AI-authored plan and a real browser.
/// Every rejection it promises is asserted, because a gap here is a gap in the product's
/// core safety claim.</summary>
public class BrowserActionValidatorTests
{
    private static BrowserActionPolicy Policy(bool allowScript = false, bool allowXPath = true)
        => new(allowScript, allowXPath, (string url, out string reason) =>
        {
            reason = "blocked by test policy";
            return url.StartsWith("https://app.example.com", StringComparison.Ordinal);
        });

    private static LocatorDescriptor Button(string name) =>
        new() { Strategy = LocatorStrategy.Role, Value = "button", Name = name };

    [Fact]
    public void Accepts_a_well_formed_click()
    {
        var action = new BrowserAction { Action = BrowserActionType.Click, Target = Button("Sign in") };
        BrowserActionValidator.Validate(action, Policy()).IsValid.Should().BeTrue();
    }

    [Fact]
    public void Rejects_an_action_verb_outside_the_closed_set()
    {
        var action = new BrowserAction { Action = (BrowserActionType)777 };
        var result = BrowserActionValidator.Validate(action, Policy());
        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("Unknown action"));
    }

    [Fact]
    public void Rejects_script_execution_by_default()
    {
        var action = new BrowserAction { Action = BrowserActionType.ExecuteScript, Value = "fetch('/steal')" };
        var result = BrowserActionValidator.Validate(action, Policy());
        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("executeScript is not permitted"));
    }

    [Fact]
    public void Allows_script_execution_only_when_the_project_opts_in()
    {
        var action = new BrowserAction { Action = BrowserActionType.ExecuteScript, Value = "return document.title" };
        BrowserActionValidator.Validate(action, Policy(allowScript: true)).IsValid.Should().BeTrue();
    }

    [Fact]
    public void Rejects_navigation_to_a_url_the_guard_refuses()
    {
        var action = new BrowserAction { Action = BrowserActionType.Navigate, Url = "http://169.254.169.254/" };
        var result = BrowserActionValidator.Validate(action, Policy());
        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("is not allowed"));
    }

    [Fact]
    public void Accepts_navigation_to_an_allowed_url()
    {
        var action = new BrowserAction { Action = BrowserActionType.Navigate, Url = "https://app.example.com/login" };
        BrowserActionValidator.Validate(action, Policy()).IsValid.Should().BeTrue();
    }

    [Theory]
    [InlineData(BrowserActionType.Click)]
    [InlineData(BrowserActionType.Fill)]
    [InlineData(BrowserActionType.AssertVisible)]
    public void Rejects_actions_that_need_a_target_but_have_none(BrowserActionType type)
    {
        var action = new BrowserAction { Action = type, Value = "x" };
        BrowserActionValidator.Validate(action, Policy()).Errors
            .Should().Contain(e => e.Contains("requires a target locator"));
    }

    [Fact]
    public void Rejects_fill_without_a_value()
    {
        var action = new BrowserAction { Action = BrowserActionType.Fill, Target = Button("Username") };
        BrowserActionValidator.Validate(action, Policy()).Errors
            .Should().Contain(e => e.Contains("requires a value"));
    }

    [Fact]
    public void Rejects_credential_literals_in_step_values()
    {
        var action = new BrowserAction
        {
            Action = BrowserActionType.Fill,
            Target = Button("Password"),
            Value = "password=Sup3rSecret"
        };
        var result = BrowserActionValidator.Validate(action, Policy());
        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("${secret:name}"));
    }

    [Fact]
    public void Accepts_secret_references_as_values()
    {
        var action = new BrowserAction
        {
            Action = BrowserActionType.Fill,
            Target = Button("Password"),
            Value = "${secret:demo_bank_password}"
        };
        BrowserActionValidator.Validate(action, Policy()).IsValid.Should().BeTrue();
    }

    [Fact]
    public void Rejects_xpath_when_the_project_disables_it()
    {
        var action = new BrowserAction
        {
            Action = BrowserActionType.Click,
            Target = new LocatorDescriptor { Strategy = LocatorStrategy.Xpath, Value = "//div[3]/span[2]" }
        };
        BrowserActionValidator.Validate(action, Policy(allowXPath: false)).Errors
            .Should().Contain(e => e.Contains("XPath locators are disabled"));
    }

    [Fact]
    public void Rejects_an_absurd_timeout()
    {
        var action = new BrowserAction { Action = BrowserActionType.Wait, TimeoutMs = 10_000_000 };
        BrowserActionValidator.Validate(action, Policy()).Errors
            .Should().Contain(e => e.Contains("timeoutMs"));
    }

    [Fact]
    public void Rejects_deeply_nested_locators()
    {
        var deepest = new LocatorDescriptor { Strategy = LocatorStrategy.Css, Value = "span" };
        var nested = deepest;
        for (var i = 0; i < 5; i++)
            nested = new LocatorDescriptor { Strategy = LocatorStrategy.Css, Value = "div", Within = nested };

        var action = new BrowserAction { Action = BrowserActionType.Click, Target = nested };
        BrowserActionValidator.Validate(action, Policy()).Errors
            .Should().Contain(e => e.Contains("nesting"));
    }

    [Fact]
    public void Rejects_an_empty_locator_value()
    {
        var action = new BrowserAction
        {
            Action = BrowserActionType.Click,
            Target = new LocatorDescriptor { Strategy = LocatorStrategy.Role, Value = "" }
        };
        BrowserActionValidator.Validate(action, Policy()).Errors
            .Should().Contain(e => e.Contains("requires a value"));
    }

    [Fact]
    public void Assertion_actions_are_recognised_as_assertions()
    {
        new BrowserAction { Action = BrowserActionType.AssertText }.IsAssertion.Should().BeTrue();
        new BrowserAction { Action = BrowserActionType.Click }.IsAssertion.Should().BeFalse();
        new BrowserAction { Action = BrowserActionType.ExecuteScript }.IsAssertion.Should().BeFalse();
    }
}
