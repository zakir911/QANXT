using System.Text.Json;
using QaNxt.Application.Ai;
using QaNxt.Infrastructure.Ai.Providers;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace QaNxt.UnitTests.Ai;

/// <summary>One discovered page has to produce real coverage, not one load check.
///
/// A user crawled an admin application, reached its login page, pressed Generate tests, and
/// got a single two-step scenario called "… loads". Twice, because they tried again. The
/// cause was not the page count: the planner only recognised three page shapes, and every
/// control on every other page contributed nothing. A page the login generator could not
/// fully classify fell all the way through to a smoke check even though it had a username
/// field, a password field and a button sitting right there.
///
/// Tests are now derived from the controls themselves. These check that the controls
/// produce the coverage a tester would write by hand, and that the engine still says so
/// honestly when a control genuinely offers nothing.</summary>
public class ElementCoverageTests
{
    private static JsonElement Plan(string contextJson)
    {
        var provider = new LocalProvider(NullLogger<LocalProvider>.Instance);
        var request = new LlmRequest
        {
            Messages = new[]
            {
                LlmMessage.User(
                    $"Generate a plan.\n{LocalProvider.ContextOpen}\n{contextJson}\n{LocalProvider.ContextClose}")
            },
            SchemaName = AiSchemaCatalog.TestPlan,
            JsonSchema = "{}"
        };

        var response = provider.CompleteAsync(request).GetAwaiter().GetResult();
        return JsonDocument.Parse(response.Content).RootElement.Clone();
    }

    private static List<JsonElement> Scenarios(JsonElement plan)
        => plan.GetProperty("scenarios").EnumerateArray().ToList();

    private static List<string> Names(JsonElement plan)
        => Scenarios(plan).Select(s => s.GetProperty("name").GetString()!).ToList();

    private static string Context(string pagesJson, bool requiresSignIn = true)
        => "{ \"baseUrl\": \"https://admin.example.test/\", \"requirement\": null,"
         + " \"maxScenarios\": 0, \"requiresSignIn\": " + (requiresSignIn ? "true" : "false")
         + ", \"pages\": " + pagesJson + " }";

    /// <summary>The user's page: a login screen whose fields the login generator did not
    /// classify, because the submit button is not labelled the way it expects.</summary>
    private const string LoginPage = """
        [ { "kind": "login", "route": "/IDSenseAdmin/login", "title": "IdentitySense Admin",
            "url": "https://admin.example.test/IDSenseAdmin/login",
            "elements": [
              { "kind": "textInput", "accessibleName": "Email", "label": "Email",
                "testId": "email", "type": "text", "isRequired": true },
              { "kind": "passwordInput", "accessibleName": "Password", "label": "Password",
                "testId": "pwd", "type": "password", "isRequired": true },
              { "kind": "button", "accessibleName": "Proceed", "ariaRole": "button", "testId": "go" }
            ] } ]
        """;

    [Fact]
    public void A_single_login_page_produces_far_more_than_a_load_check()
    {
        var plan = Plan(Context(LoginPage));

        // The symptom was exactly one scenario from exactly this shape of page.
        Scenarios(plan).Count.Should().BeGreaterThan(5,
            "two required fields with format rules are worth more than one test");

        Names(plan).Should().NotEqual(new[] { "IdentitySense Admin loads" });
    }

    [Fact]
    public void Required_fields_each_get_a_required_test()
    {
        var names = Names(Plan(Context(LoginPage)));

        names.Should().Contain(n => n.Contains("Email is required"));
        names.Should().Contain(n => n.Contains("Password is required"));
    }

    [Fact]
    public void An_email_field_gets_format_tests_from_its_label()
    {
        var names = Names(Plan(Context(LoginPage)));

        // Driven by the semantic dictionary, not by the page being a login page.
        names.Should().Contain(n => n.Contains("Email rejects") && n.Contains("no @"));
        names.Should().Contain(n => n.Contains("Email rejects") && n.Contains("domain with no dot"));
    }

    [Fact]
    public void Every_page_gets_an_accessibility_and_a_console_check()
    {
        var names = Names(Plan(Context(LoginPage)));

        names.Should().Contain(n => n.Contains("accessibility violations"));
        names.Should().Contain(n => n.Contains("without console errors"));
    }

    [Fact]
    public void An_amount_field_gets_numeric_boundaries_wherever_it_lives()
    {
        // A dashboard, which the old planner gave exactly one smoke scenario.
        var plan = Plan(Context("""
            [ { "kind": "dashboard", "route": "/admin/transfer", "title": "Transfer",
                "url": "https://admin.example.test/admin/transfer",
                "elements": [
                  { "kind": "textInput", "accessibleName": "Amount", "label": "Amount",
                    "testId": "amount", "type": "text", "isRequired": true },
                  { "kind": "button", "accessibleName": "Continue", "ariaRole": "button", "testId": "next" }
                ] } ]
            """));

        var names = Names(plan);
        names.Should().Contain(n => n.Contains("Amount rejects") && n.Contains("negative"));
        names.Should().Contain(n => n.Contains("Amount handles") && n.Contains("smallest payable"));
        names.Should().Contain(n => n.Contains("Amount is required"));
    }

    [Fact]
    public void A_date_field_gets_date_specific_cases()
    {
        var plan = Plan(Context("""
            [ { "kind": "form", "route": "/admin/report", "title": "Report",
                "url": "https://admin.example.test/admin/report",
                "elements": [
                  { "kind": "dateInput", "accessibleName": "Valid from", "label": "Valid from",
                    "testId": "from", "type": "date", "isRequired": false },
                  { "kind": "button", "accessibleName": "Run", "ariaRole": "button", "testId": "run" }
                ] } ]
            """));

        var names = Names(plan);
        names.Should().Contain(n => n.Contains("does not exist in that month"));
        names.Should().Contain(n => n.Contains("far in the past") || n.Contains("far in the future"));
    }

    [Fact]
    public void Selects_and_checkboxes_are_covered()
    {
        var plan = Plan(Context("""
            [ { "kind": "dashboard", "route": "/admin/settings", "title": "Settings",
                "url": "https://admin.example.test/admin/settings",
                "elements": [
                  { "kind": "select", "accessibleName": "Region", "label": "Region", "testId": "region" },
                  { "kind": "checkbox", "accessibleName": "Enable alerts", "label": "Enable alerts",
                    "testId": "alerts" }
                ] } ]
            """));

        var names = Names(plan);
        names.Should().Contain(n => n.Contains("Region can be changed"));
        names.Should().Contain(n => n.Contains("Enable alerts can be toggled"));
    }

    [Fact]
    public void Every_scenario_is_runnable_and_asserts_something()
    {
        // A scenario that only navigates proves nothing, and a step with no action cannot
        // be executed at all. Both have been real defects in this engine before.
        foreach (var scenario in Scenarios(Plan(Context(LoginPage))))
        {
            var steps = scenario.GetProperty("steps").EnumerateArray().ToList();
            steps.Should().NotBeEmpty();

            steps.Should().Contain(s => s.GetProperty("action").GetString() == "navigate");

            var assertions = steps.Sum(s => s.TryGetProperty("assertions", out var a)
                && a.ValueKind == JsonValueKind.Array ? a.GetArrayLength() : 0);
            assertions.Should().BeGreaterThan(0,
                $"\"{scenario.GetProperty("name").GetString()}\" asserts nothing");
        }
    }

    [Fact]
    public void A_public_page_is_not_given_a_signed_in_precondition()
    {
        var plan = Plan(Context("""
            [ { "kind": "form", "route": "/contact", "title": "Contact",
                "url": "https://admin.example.test/contact",
                "elements": [
                  { "kind": "textInput", "accessibleName": "Email", "label": "Email",
                    "testId": "email", "type": "email", "isRequired": true },
                  { "kind": "button", "accessibleName": "Send enquiry", "ariaRole": "button", "testId": "send" }
                ] } ]
            """, requiresSignIn: false));

        foreach (var scenario in Scenarios(plan))
        {
            scenario.GetProperty("preconditions").GetString()
                .Should().NotContain("signed in");
        }
    }

    [Fact]
    public void A_page_with_no_testable_control_still_says_so_honestly()
    {
        var plan = Plan(Context("""
            [ { "kind": "unknown", "route": "/about", "title": "About",
                "url": "https://admin.example.test/about", "elements": [] } ]
            """));

        // It still gets the page-level checks, so it is not a bare load check any more,
        // but nothing is invented for controls that are not there.
        Names(plan).Should().NotContain(n => n.Contains("is required"));
        Names(plan).Should().Contain(n => n.Contains("accessibility violations"));
    }

    [Fact]
    public void The_plan_is_not_truncated_at_forty()
    {
        // The schema capped scenarios at 40 and the planner took the first 40, so a large
        // application silently produced exactly forty tests and looked complete.
        var pages = string.Join(",", Enumerable.Range(1, 30).Select(i => $$"""
            { "kind": "form", "route": "/p{{i}}", "title": "Page {{i}}",
              "url": "https://admin.example.test/p{{i}}",
              "elements": [
                { "kind": "textInput", "accessibleName": "Email", "label": "Email",
                  "testId": "e{{i}}", "type": "email", "isRequired": true },
                { "kind": "button", "accessibleName": "Continue", "ariaRole": "button", "testId": "b{{i}}" } ] }
            """));

        var plan = Plan(Context($"[{pages}]"));

        Scenarios(plan).Count.Should().BeGreaterThan(40,
            "thirty pages with a required, format-checked field are worth more than forty tests");
    }
}
