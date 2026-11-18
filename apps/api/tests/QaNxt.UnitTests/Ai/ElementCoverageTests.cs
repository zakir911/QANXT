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

    /// <summary>Actions the planner is allowed to emit, each one implemented by the browser
    /// worker's action-runner switch.
    ///
    /// Separate from the schema on purpose. The schema is what the orchestrator accepts and
    /// the runner is what can actually happen, and they had drifted: the schema allowed
    /// noConsoleErrors as an assertion the runner does not implement, and the runner
    /// implemented checkAccessibility which the schema did not allow. A step that validates
    /// and cannot run produces a test that fails for ever on a working application.
    ///
    /// This is a subset of the runner's switch rather than a copy of it. The runner also
    /// implements reload, goBack, goForward, setViewport, clearCookies and setOffline, which
    /// the planner has no reason to emit; listing them here would let it start doing so
    /// unnoticed. So adding an entry means checking the runner implements it, not just that
    /// the schema allows it — `clear` was added against action-runner.ts's `case 'clear'`,
    /// which calls Playwright's locator.clear.</summary>
    private static readonly HashSet<string> ExecutableActions = new()
    {
        "navigate", "click", "doubleClick", "fill", "clear", "select", "check", "uncheck",
        "hover", "press", "upload", "download", "wait", "screenshot", "scroll",
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

    /// <summary>
    /// A long page title must not take the whole suite down with it.
    ///
    /// Found by pointing the platform at a 137-screen logistics application. Its dashboard
    /// greets the signed-in user by name, an earlier run's tests had filled that field with
    /// a 256-character boundary value, and the resulting &lt;title&gt; was 289 characters.
    ///
    /// The page's kind-specific generator produced nothing, so it fell back to the smoke
    /// scenario — and that builder constructs its object literal directly instead of going
    /// through Scenario(), which is where every other name gets bounded. The name came out
    /// at 295 characters, the test_plan schema caps a name at 200, the whole plan failed
    /// validation, and generation answered 503 with no tests for ANY page.
    ///
    /// The page here deliberately carries no usable control, because that is what sends it
    /// down the smoke path. An earlier version of this test gave the page a text input,
    /// which routed it through the truncating builder and passed against the bug.
    /// </summary>
    [Fact]
    public void A_very_long_page_title_on_a_smoke_fallback_still_produces_a_valid_plan()
    {
        var longTitle = "Good morning, " + new string('A', 275);
        var page = $$"""
            [ { "kind": "unknown", "route": "/dashboard", "title": "{{longTitle}}",
                "url": "https://admin.example.test/dashboard", "elements": [] } ]
            """;

        // Plan() validates against the real test_plan schema, so without the bound this
        // throws rather than merely producing an ugly name.
        var plan = Plan(Context(page));

        Scenarios(plan).Should().NotBeEmpty("a long title is not a reason to generate nothing");
        Names(plan).Should().OnlyContain(name => name.Length <= 200,
            "the schema caps a scenario name at 200 characters");
    }

    /// <summary>The same page shape, with a control, so the truncating path is covered too
    /// and the part of the name that says what the test does survives the trim.</summary>
    [Fact]
    public void A_very_long_page_title_keeps_what_the_test_does_in_the_name()
    {
        var longTitle = "Good morning, " + new string('A', 275);
        var page = $$"""
            [ { "kind": "form", "route": "/account/profile", "title": "{{longTitle}}",
                "url": "https://admin.example.test/account/profile",
                "elements": [
                  { "kind": "textInput", "accessibleName": "Display name", "label": "Display name",
                    "testId": "display-name", "type": "text", "isRequired": true }
                ] } ]
            """;

        var names = Names(Plan(Context(page)));

        names.Should().OnlyContain(name => name.Length <= 200);
        names.Should().Contain(name => name.Contains("Display name"),
            "trimming the title must not cut off what the scenario is for");
    }

    /// <summary>
    /// A generated test that the browser physically cannot perform is worse than no test.
    ///
    /// A run against a 137-screen application reported 28 failures. None of them was the
    /// application misbehaving; every one was the runner unable to drive the page, and a
    /// team reading that summary goes hunting for 28 defects that do not exist. Ten were
    /// these two cases: filling a native date input with text, and a number input with
    /// letters. Playwright refuses both before the application is ever involved.
    /// </summary>
    [Fact]
    public void A_native_date_input_gets_no_test_that_types_text_into_it()
    {
        var page = """
            [ { "kind": "form", "route": "/shipments/new", "title": "Book a shipment",
                "url": "https://admin.example.test/shipments/new",
                "elements": [
                  { "kind": "dateInput", "accessibleName": "Collection date", "label": "Collection date",
                    "testId": "collection-date", "type": "date", "isRequired": true } ] } ]
            """;

        var steps = AllStepValues(Plan(Context(page)));

        steps.Should().NotContain("not-a-date", "the browser refuses it, so the test could only fail on a fill error");
        steps.Should().NotContain("31/02/2026", "a native date input cannot hold a slash-separated value");
        steps.Should().NotContain("   ", "spaces are not a date either");
        // What survives is still worth having: a well-formed date at the extremes.
        steps.Should().Contain(value => value == "1900-01-01" || value == "2999-12-31",
            "a date the browser accepts still tests the application's own range checking");
    }

    [Fact]
    public void A_native_number_input_gets_no_test_that_types_letters_into_it()
    {
        var page = """
            [ { "kind": "form", "route": "/orders/sales/new", "title": "New sales order",
                "url": "https://admin.example.test/orders/sales/new",
                "elements": [
                  { "kind": "numberInput", "accessibleName": "Quantity", "label": "Quantity",
                    "testId": "quantity", "type": "number", "isRequired": true } ] } ]
            """;

        var steps = AllStepValues(Plan(Context(page)));

        steps.Should().NotContain("abc", "Playwright cannot type text into input[type=number]");
        steps.Should().NotContain("   ", "nor spaces");
        steps.Should().Contain("-1", "a negative number IS typeable, and is a real test");
    }

    /// <summary>A text input that happens to hold a date keeps the format tests: there the
    /// browser does not enforce anything, so what the application accepts is the question.</summary>
    [Fact]
    public void A_text_input_holding_a_date_still_gets_its_format_tests()
    {
        var page = """
            [ { "kind": "form", "route": "/legacy", "title": "Legacy form",
                "url": "https://admin.example.test/legacy",
                "elements": [
                  { "kind": "textInput", "accessibleName": "Delivery date", "label": "Delivery date",
                    "testId": "delivery-date", "type": "text", "isRequired": true } ] } ]
            """;

        AllStepValues(Plan(Context(page))).Should().Contain("not-a-date",
            "a text input holds anything, so what the application rejects is worth testing");
    }

    /// <summary>
    /// A read-only control accepts nothing, from a test or from a person.
    ///
    /// IsValidationSurface's comment had always said so; the code only checked the kind,
    /// so a readonly field got the full battery and every test failed on a fill timeout.
    /// </summary>
    [Fact]
    public void A_read_only_field_gets_no_validation_tests()
    {
        var page = """
            [ { "kind": "form", "route": "/account/profile", "title": "Your profile",
                "url": "https://admin.example.test/account/profile",
                "elements": [
                  { "kind": "textInput", "accessibleName": "Team", "label": "Team",
                    "testId": "team", "type": "text", "isReadOnly": true },
                  { "kind": "textInput", "accessibleName": "Display name", "label": "Display name",
                    "testId": "display-name", "type": "text", "isRequired": true } ] } ]
            """;

        var names = Names(Plan(Context(page)));

        names.Should().NotContain(name => name.Contains("Team"),
            "nothing can be typed into it, so there is nothing to validate");
        names.Should().Contain(name => name.Contains("Display name"),
            "the editable field beside it is still covered");
    }

    /// <summary>
    /// Choosing an option means choosing one that exists.
    ///
    /// The planner passed a hard-coded "1" to selectOption, which matches by value or
    /// label. On a select whose options are identifiers or codes that matches nothing and
    /// times out. Sixteen of the 28 failures in the measured run were this, once for every
    /// select on every page.
    /// </summary>
    [Fact]
    public void A_select_is_tested_with_an_option_it_actually_has()
    {
        var page = """
            [ { "kind": "form", "route": "/shipments/new", "title": "Book a shipment",
                "url": "https://admin.example.test/shipments/new",
                "elements": [
                  { "kind": "select", "accessibleName": "Customer", "label": "Customer",
                    "testId": "customer", "type": "select-one",
                    "options": [ { "value": "", "label": "Choose a customer" },
                                 { "value": "cus-001", "label": "Halvorsen Components" } ] } ] } ]
            """;

        var plan = Plan(Context(page));

        Names(plan).Should().Contain(name => name.Contains("Customer can be changed"));
        AllStepValues(plan).Should().Contain("cus-001",
            "the option the test chooses has to be one the select offers");
        AllStepValues(plan).Should().NotContain("1",
            "an index is not an option value and matches nothing");
    }

    [Fact]
    public void A_select_whose_options_were_not_captured_gets_no_test()
    {
        var page = """
            [ { "kind": "form", "route": "/shipments/new", "title": "Book a shipment",
                "url": "https://admin.example.test/shipments/new",
                "elements": [
                  { "kind": "select", "accessibleName": "Carrier", "label": "Carrier",
                    "testId": "carrier", "type": "select-one" } ] } ]
            """;

        Names(Plan(Context(page))).Should().NotContain(name => name.Contains("Carrier can be changed"),
            "a test that guesses an option value fails for its own reasons, which reads as "
            + "an application defect");
    }

    /// <summary>
    /// A required-field test has to empty the field, or it tests nothing.
    ///
    /// The scenario used to leave the control untouched, reasoning that not filling it is a
    /// truer test of required-ness than clearing it. That holds on a form for creating
    /// something. On a form for editing something the control arrives carrying the current
    /// value, so "untouched" means "holding something valid", the submit is correctly
    /// accepted, and the test reports that a required field is not enforced.
    ///
    /// Measured against a 137-screen application: 20 of the 22 failures in the first half of
    /// a run were this, every one false, across customers, shipments and sales orders. They
    /// read as credible application defects, which makes them more misleading than a
    /// Playwright timeout — that at least looks like a tool error.
    /// </summary>
    [Fact]
    public void A_required_field_test_empties_the_field_before_submitting()
    {
        var page = """
            [ { "kind": "form", "route": "/customers/cus-002/edit", "title": "Edit a customer",
                "url": "https://admin.example.test/customers/cus-002/edit",
                "elements": [
                  { "kind": "textInput", "accessibleName": "Town or city", "label": "Town or city",
                    "testId": "edit-city", "type": "text", "isRequired": true },
                  { "kind": "button", "accessibleName": "Save changes", "ariaRole": "button",
                    "testId": "edit-customer-save" } ] } ]
            """;

        var scenario = Scenarios(Plan(Context(page)))
            .First(s => s.GetProperty("name").GetString()!.Contains("Town or city is required"));

        var actions = scenario.GetProperty("steps").EnumerateArray()
            .Select(step => step.GetProperty("action").GetString()).ToList();

        actions.Should().Contain("clear",
            "a form that arrives pre-populated accepts the submit, and rightly so, unless "
            + "the field is emptied first");

        // Order matters: clearing after the submit proves nothing.
        actions.IndexOf("clear").Should().BeLessThan(actions.IndexOf("click"),
            "the field has to be empty at the moment of submitting");
    }

    /// <summary>Every value any step would type, so a test can assert on what the runner
    /// would actually be asked to do.</summary>
    private static List<string> AllStepValues(JsonElement plan)
        => Scenarios(plan)
            .SelectMany(scenario => scenario.GetProperty("steps").EnumerateArray())
            .Select(step => step.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.String
                ? v.GetString() : null)
            .Where(value => value is not null)
            .Select(value => value!)
            .ToList();

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
        names.Should().Contain(n => n.Contains("far in the past") || n.Contains("far in the future"));

        // This test used to require a "31/02/2026 does not exist in that month" case here
        // too, and the planner duly produced one. It could never run: a native date input
        // holds a yyyy-mm-dd value and the browser refuses anything else before the
        // application sees it, so the case failed on a fill error every time and read in
        // the summary as an application defect. The impossible-date case is still generated
        // for a text input holding a date, where it tests something — see
        // A_text_input_holding_a_date_still_gets_its_format_tests.
        names.Should().NotContain(n => n.Contains("does not exist in that month"));
    }

    [Fact]
    public void Selects_and_checkboxes_are_covered()
    {
        var plan = Plan(Context("""
            [ { "kind": "dashboard", "route": "/admin/settings", "title": "Settings",
                "url": "https://admin.example.test/admin/settings",
                "elements": [
                  { "kind": "select", "accessibleName": "Region", "label": "Region", "testId": "region",
                    "options": [ { "value": "", "label": "All regions" },
                                 { "value": "emea", "label": "EMEA" } ] },
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
