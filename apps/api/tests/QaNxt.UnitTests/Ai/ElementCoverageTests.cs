using System.Text.Json;
using QaNxt.Application.Ai;
using QaNxt.Application.Contracts;
using System.Text.Json.Serialization;
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
    /// <summary>
    /// Generates a plan and validates it against the real test_plan schema.
    ///
    /// The validation is the point. These tests originally passed <c>JsonSchema = "{}"</c>,
    /// which is what every other local-provider test does, so they exercised the generator
    /// and skipped the thing that actually rejects its output. A generator emitting a
    /// category and four step actions that were not in the schema's enums passed eleven
    /// green tests and failed on the first real press of the button.
    ///
    /// The orchestrator validates by schema name, so a test that does not is testing a
    /// different pipeline from the one the product runs.
    /// </summary>
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

        var validation = new SchemaValidator().Validate(response.Content, AiSchemaCatalog.TestPlan);
        validation.IsValid.Should().BeTrue(
            "the plan has to satisfy the schema the orchestrator validates against: "
            + string.Join("; ", validation.Errors.Take(5)));

        return JsonDocument.Parse(response.Content).RootElement.Clone();
    }

    /// <summary>Actions the browser worker implements, from its action-runner switch.
    ///
    /// Separate from the schema on purpose. The schema is what the orchestrator accepts and
    /// the runner is what can actually happen, and they had drifted: the schema allowed
    /// noConsoleErrors as an assertion the runner does not implement, and the runner
    /// implemented checkAccessibility which the schema did not allow. A step that validates
    /// and cannot run produces a test that fails for ever on a working application.</summary>
    private static readonly HashSet<string> ExecutableActions = new()
    {
        "navigate", "click", "doubleClick", "fill", "select", "check", "uncheck", "hover",
        "press", "upload", "download", "wait", "screenshot", "scroll",
        "checkAccessibility", "checkVisual", "executeScript",
        "assertUrl", "assertVisible", "assertHidden", "assertText", "assertValue",
        "assertCount", "assertAttribute", "assertEnabled", "assertDisabled"
    };

    /// <summary>Assertion types the browser worker implements.</summary>
    private static readonly HashSet<string> ExecutableAssertions = new()
    {
        "textEquals", "textContains", "visible", "hidden", "urlEquals", "urlContains",
        "valueEquals", "countEquals", "attributeEquals", "enabled", "disabled",
        "httpStatusEquals"
    };

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
    public void Every_page_gets_an_accessibility_check_and_a_reachability_check()
    {
        var names = Names(Plan(Context(LoginPage)));

        names.Should().Contain(n => n.Contains("accessibility violations"));
        // Was a console-error check. The schema lists noConsoleErrors but the worker does
        // not implement it, and an unimplemented assertion is reported as a failure, so
        // that test would have failed for ever against a healthy application.
        names.Should().Contain(n => n.Contains("reachable and stays on its own route"));
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

            // Either an explicit assertion, or an action that is itself the check:
            // checkAccessibility and checkVisual fail the step when they find a problem,
            // so they carry no separate assertion.
            var assertions = steps.Sum(s => s.TryGetProperty("assertions", out var a)
                && a.ValueKind == JsonValueKind.Array ? a.GetArrayLength() : 0);
            var selfAsserting = steps.Any(s =>
                s.GetProperty("action").GetString() is "checkAccessibility" or "checkVisual");

            (assertions > 0 || selfAsserting).Should().BeTrue(
                $"\"{scenario.GetProperty("name").GetString()}\" checks nothing");
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

    [Fact]
    public void Every_generated_step_is_one_the_worker_can_actually_run()
    {
        // Schema-valid is not the same as runnable. An unimplemented assertion is reported
        // by the runner as a failure, not skipped, so a test using one fails for ever
        // against a perfectly healthy application — which is worse than not generating it.
        var contexts = new[]
        {
            Context(LoginPage),
            Context("""
                [ { "kind": "dashboard", "route": "/admin/settings", "title": "Settings",
                    "url": "https://admin.example.test/admin/settings",
                    "elements": [
                      { "kind": "select", "accessibleName": "Region", "testId": "region" },
                      { "kind": "checkbox", "accessibleName": "Enable alerts", "testId": "alerts" },
                      { "kind": "dateInput", "accessibleName": "Valid from", "testId": "from", "type": "date" },
                      { "kind": "textInput", "accessibleName": "Amount", "testId": "amt", "isRequired": true } ] } ]
                """),
            Context("""
                [ { "kind": "unknown", "route": "/about", "title": "About",
                    "url": "https://admin.example.test/about", "elements": [] } ]
                """)
        };

        foreach (var context in contexts)
        {
            foreach (var scenario in Scenarios(Plan(context)))
            {
                var name = scenario.GetProperty("name").GetString();

                foreach (var step in scenario.GetProperty("steps").EnumerateArray())
                {
                    var action = step.GetProperty("action").GetString()!;
                    ExecutableActions.Should().Contain(action,
                        $"\"{name}\" uses the step action \"{action}\", which the worker does not run");

                    if (!step.TryGetProperty("assertions", out var assertions)
                        || assertions.ValueKind != JsonValueKind.Array) continue;

                    foreach (var assertion in assertions.EnumerateArray())
                    {
                        var type = assertion.GetProperty("type").GetString()!;
                        ExecutableAssertions.Should().Contain(type,
                            $"\"{name}\" asserts \"{type}\", which the worker does not implement");
                    }
                }
            }
        }
    }

    [Fact]
    public void Every_generated_step_survives_the_step_validator_the_service_runs()
    {
        // The third gate, and the one that dropped all eight scenarios on a user's screen
        // after the first two were satisfied. Schema-valid and worker-implemented still is
        // not enough: BrowserActionValidator refuses a fill with an empty value, an
        // assertUrl with no expected, and a select with no value, and TestGenerationService
        // drops any scenario containing one.
        //
        // Checking two of three gates is how the same class of defect reached a user twice.
        // This runs the real validator over every step the engine produces.
        var policy = new BrowserActionPolicy(
            AllowScriptExecution: false,
            AllowXPathLocators: true,
            (string url, out string reason) => { reason = string.Empty; return true; });

        var contexts = new[]
        {
            Context(LoginPage),
            Context("""
                [ { "kind": "dashboard", "route": "/admin/settings", "title": "Settings",
                    "url": "https://admin.example.test/admin/settings",
                    "elements": [
                      { "kind": "select", "accessibleName": "Region", "testId": "region" },
                      { "kind": "checkbox", "accessibleName": "Enable alerts", "testId": "alerts" },
                      { "kind": "dateInput", "accessibleName": "Valid from", "testId": "from", "type": "date" },
                      { "kind": "textInput", "accessibleName": "Amount", "testId": "amt", "isRequired": true } ] } ]
                """),
            Context("""
                [ { "kind": "form", "route": "/apply", "title": "Apply",
                    "url": "https://admin.example.test/apply",
                    "elements": [
                      { "kind": "textInput", "accessibleName": "Full name", "testId": "n", "isRequired": true } ] } ]
                """),
            Context("""
                [ { "kind": "unknown", "route": "/about", "title": "About",
                    "url": "https://admin.example.test/about", "elements": [] } ]
                """)
        };

        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
        };

        foreach (var context in contexts)
        {
            var plan = Plan(context);

            foreach (var scenario in Scenarios(plan))
            {
                var name = scenario.GetProperty("name").GetString();

                foreach (var step in scenario.GetProperty("steps").EnumerateArray())
                {
                    var action = JsonSerializer.Deserialize<BrowserAction>(step.GetRawText(), options);
                    action.Should().NotBeNull($"\"{name}\" has a step that will not deserialise");

                    var validation = BrowserActionValidator.Validate(action!, policy);
                    validation.IsValid.Should().BeTrue(
                        $"\"{name}\" step \"{step.GetProperty("description").GetString()}\" "
                        + $"would be dropped: {string.Join("; ", validation.Errors)}");
                }
            }
        }
    }
}
