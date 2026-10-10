using System.Text.Json;
using QaNxt.Application.Ai;
using QaNxt.Infrastructure.Ai.Providers;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace QaNxt.UnitTests.Ai;

/// <summary>Every discovered page has to contribute at least one scenario.
///
/// Each kind-specific generator refuses to invent a locator it cannot see: the login
/// generator needs a username, a password and a submit button, the form generator needs a
/// submit button. That refusal is right. Yielding nothing in its place was not. With every
/// discovered page falling into one of those branches the plan came back empty, the test_plan
/// schema requires at least one scenario, and the user was shown
/// "/scenarios: Value should have at least 1 items (minItems)" with no way to act on it.
///
/// The floor is the smoke scenario, which needs no elements: open the page, assert it
/// rendered. True of any page that exists, and honest about covering nothing more.</summary>
public class EmptyTestPlanTests
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

    private static int Count(JsonElement plan) => plan.GetProperty("scenarios").GetArrayLength();
    private static string Summary(JsonElement plan) => plan.GetProperty("summary").GetString()!;

    private static string Context(string pagesJson, bool requiresSignIn = false)
        => "{ \"baseUrl\": \"https://site.example.test/\", \"requirement\": null,"
         + " \"maxScenarios\": 20, \"requiresSignIn\": " + (requiresSignIn ? "true" : "false")
         + ", \"pages\": " + pagesJson + " }";

    /// <summary>A login page discovery recognised as such but whose fields it did not
    /// classify. The exact shape that produced the empty plan.</summary>
    private const string LoginWithNoRecognisedFields = """
        [ { "kind": "login", "route": "/signin", "title": "Sign in",
            "url": "https://site.example.test/signin", "elements": [] } ]
        """;

    [Fact]
    public void A_login_page_with_no_recognised_fields_still_produces_a_scenario()
    {
        var plan = Plan(Context(LoginWithNoRecognisedFields));

        // The schema's minItems is 1. Zero here is the user-visible failure.
        Count(plan).Should().BeGreaterThan(0,
            "an empty plan is rejected by the schema and surfaces as an unactionable error");

        var scenario = plan.GetProperty("scenarios")[0];
        scenario.GetProperty("name").GetString().Should().Contain("loads");
        scenario.GetProperty("steps").GetArrayLength().Should().BeGreaterThan(0);
    }

    [Fact]
    public void The_summary_says_which_pages_only_got_a_load_check()
    {
        var plan = Plan(Context(LoginWithNoRecognisedFields));

        // A page that only got "it loads" has not been covered, and a reviewer deciding
        // whether this suite means anything needs to be told that rather than infer it.
        Summary(plan).Should().Contain("only got a load check");
        Summary(plan).Should().Contain("/signin");
        Summary(plan).Should().Contain("not covered beyond loading");
    }

    [Fact]
    public void A_form_page_with_no_submit_button_still_produces_a_scenario()
    {
        var plan = Plan(Context("""
            [ { "kind": "form", "route": "/apply", "title": "Apply",
                "url": "https://site.example.test/apply",
                "elements": [ { "kind": "textInput", "accessibleName": "Full name" } ] } ]
            """));

        Count(plan).Should().BeGreaterThan(0);
        Summary(plan).Should().Contain("/apply");
    }

    [Fact]
    public void Several_unrecognised_pages_each_contribute_a_scenario()
    {
        var plan = Plan(Context("""
            [ { "kind": "login", "route": "/signin", "title": "Sign in",
                "url": "https://site.example.test/signin", "elements": [] },
              { "kind": "form", "route": "/apply", "title": "Apply",
                "url": "https://site.example.test/apply", "elements": [] },
              { "kind": "list", "route": "/items", "title": "Items",
                "url": "https://site.example.test/items", "elements": [] } ]
            """));

        Count(plan).Should().BeGreaterThanOrEqualTo(3, "no page may contribute nothing");
    }

    [Fact]
    public void A_recognised_login_page_still_gets_its_real_coverage_not_a_smoke_check()
    {
        // The fallback must not replace the specific generators. If it fires for a page that
        // was recognised properly, the suite silently got weaker.
        var plan = Plan(Context("""
            [ { "kind": "login", "route": "/signin", "title": "Sign in",
                "url": "https://site.example.test/signin",
                "elements": [
                  { "kind": "textInput", "accessibleName": "Email", "testId": "email", "type": "text" },
                  { "kind": "passwordInput", "accessibleName": "Password", "testId": "password", "type": "password" },
                  { "kind": "button", "accessibleName": "Sign in", "ariaRole": "button", "testId": "submit" }
                ] } ]
            """, requiresSignIn: true));

        Count(plan).Should().BeGreaterThan(1, "a recognised login page earns more than a load check");
        Summary(plan).Should().NotContain("only got a load check");
    }

    [Fact]
    public void A_public_site_is_not_told_the_customer_is_signed_in()
    {
        var plan = Plan(Context("""
            [ { "kind": "unknown", "route": "/about", "title": "About",
                "url": "https://site.example.test/about", "elements": [] } ]
            """, requiresSignIn: false));

        var scenario = plan.GetProperty("scenarios")[0];
        // Discovery never observed a sign-in on an application configured with no auth, so
        // stating it as a precondition describes something nobody can satisfy.
        scenario.GetProperty("preconditions").GetString().Should().Be("None.");
        scenario.GetProperty("objective").GetString().Should().NotContain("signed-in");
    }

    [Fact]
    public void An_application_that_does_authenticate_still_says_so()
    {
        var plan = Plan(Context("""
            [ { "kind": "dashboard", "route": "/home", "title": "Home",
                "url": "https://site.example.test/home", "elements": [] } ]
            """, requiresSignIn: true));

        var scenario = plan.GetProperty("scenarios")[0];
        scenario.GetProperty("preconditions").GetString().Should().Contain("signed in");
    }

    [Fact]
    public void A_plan_with_no_pages_at_all_is_still_well_formed()
    {
        // The service refuses before reaching here, so this is defence in depth rather than a
        // path a user takes. It must not throw.
        var act = () => Plan(Context("[]"));
        act.Should().NotThrow();
        Count(Plan(Context("[]"))).Should().Be(0,
            "with no pages there is genuinely nothing to generate; the service is what refuses");
    }
}
