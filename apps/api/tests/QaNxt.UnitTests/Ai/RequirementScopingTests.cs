using System.Text.Json;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Ai;

/// <summary>
/// A requirement has to change what gets generated, or it is decoration.
///
/// Measured against a 137-screen freight application: eleven requirements were submitted
/// and the built-in planner returned eleven suites of 193 cases each. 2123 cases, 186
/// distinct, every requirement producing a byte-identical sweep of the whole application,
/// because the planner read the requirement only to quote it back in the summary.
///
/// These tests drive the planner through its public entry point, so they assert on the plan
/// a caller actually receives rather than on the scoping helper in isolation.
/// </summary>
public class RequirementScopingTests
{
    [Fact]
    public void Two_different_requirements_produce_two_different_suites()
    {
        var shipping = Routes(Plan(Freight(), "Book a shipment and track it to delivery"));
        var billing = Routes(Plan(Freight(), "Raise a credit note against a settled invoice"));

        shipping.Should().NotBeEmpty();
        billing.Should().NotBeEmpty();
        shipping.Should().NotBeEquivalentTo(billing,
            "eleven requirements returning one suite eleven times is the defect this fixes");

        shipping.Should().Contain(route => route.StartsWith("/shipments"));
        shipping.Should().NotContain(route => route.StartsWith("/billing"));
        billing.Should().Contain(route => route.StartsWith("/billing"));
        billing.Should().NotContain(route => route.StartsWith("/shipments"));
    }

    [Fact]
    public void No_requirement_still_sweeps_the_whole_application()
    {
        Routes(Plan(Freight(), requirement: null)).Should()
            .HaveCountGreaterThanOrEqualTo(4,
                "with nothing to narrow by, every discovered page is still in scope");
    }

    /// <summary>
    /// The trap the obvious implementation falls into.
    ///
    /// A back-office application puts the same sidebar on every screen, so "Shipments",
    /// "Billing" and "Customs" are element labels on all 137 pages. Matching requirement
    /// terms against every element therefore selects the entire application and the scoping
    /// silently does nothing — while appearing to work.
    /// </summary>
    [Fact]
    public void A_term_that_only_appears_in_the_global_navigation_does_not_select_every_page()
    {
        var routes = Routes(Plan(Freight(), "Book a shipment and track it to delivery"));

        routes.Should().NotContain("/customs/declarations",
            "'Shipments' is a sidebar link on the customs page too; chrome is not content");
        routes.Should().NotContain("/billing/invoices");
    }

    /// <summary>A requirement about a control rather than a screen still finds its page,
    /// because element labels are the fallback — just not the chrome ones.</summary>
    [Fact]
    public void A_requirement_naming_a_field_finds_the_page_holding_it()
    {
        var routes = Routes(Plan(Freight(), "The gross weight field must reject a negative value"));

        routes.Should().Contain("/shipments/new");
        routes.Should().HaveCount(1, "only one page carries that control");
    }

    [Fact]
    public void A_requirement_matching_nothing_sweeps_everything_and_says_so()
    {
        var plan = Plan(Freight(), "Comply with the Montreal Convention liability ceiling");

        Routes(plan).Should().HaveCountGreaterThanOrEqualTo(4,
            "scoping to nothing would silently produce an empty suite, which is worse");
        Summary(plan).Should().Contain("full sweep",
            "a requirement that did not narrow anything has to say it did not");
    }

    [Fact]
    public void The_summary_names_the_pages_it_chose_and_the_terms_it_chose_them_on()
    {
        var summary = Summary(Plan(Freight(), "Raise a credit note against a settled invoice"));

        summary.Should().Contain("/billing");
        summary.Should().Contain("were not tested for this requirement",
            "a reader has to know the rest of the application was skipped");
        summary.Should().Contain("words, not meaning",
            "this planner has no model and must not be read as understanding the requirement");
    }

    [Fact]
    public void Plural_and_singular_match_each_other()
    {
        Routes(Plan(Freight(), "A customs declaration can be released")).Should()
            .Contain("/customs/declarations");
    }

    /// <summary>
    /// The over-match that the first version of the scoping shipped with.
    ///
    /// Measured on the 137-screen freight application: the orders requirement produced 227
    /// cases, most of them for other domains, while the shipments requirement produced 29.
    /// The cause was the word "add" — "raise a sales order, ADD lines" matched "Add a
    /// customer", "Add a carrier" and "Add a vehicle" on that one term, alongside the orders
    /// pages that matched on three. Any page with a single matched term was kept.
    /// </summary>
    [Fact]
    public void A_page_matching_one_generic_verb_loses_to_pages_matching_the_domain()
    {
        var routes = Routes(Plan(Orders(),
            "An operator can raise a sales order, add lines, send it for approval and approve it."));

        routes.Should().Contain("/orders/sales/new", "it matches sales and order, not just a verb");
        routes.Should().Contain("/orders/sales");
        routes.Should().NotContain("/customers/new", "'Add a customer' matches only the word add");
        routes.Should().NotContain("/carriers/new");
        routes.Should().NotContain("/fleet/vehicles/new");
    }

    /// <summary>The threshold is relative, so a weak match is still kept when weak is the
    /// best there is. Dropping it would scope to nothing and produce a full sweep, losing
    /// the one page the requirement actually concerns.</summary>
    [Fact]
    public void A_one_term_match_is_kept_when_nothing_matches_more_strongly()
    {
        var routes = Routes(Plan(Orders(), "An operator can add a vehicle to the fleet"));

        routes.Should().Contain("/fleet/vehicles/new");
        routes.Should().NotContain("/orders/sales",
            "the orders pages carry none of these terms at all");
    }

    /// <summary>Four pages whose scores differ, which is what the threshold needs to
    /// discriminate between. Modelled on the real routes that produced the over-match.</summary>
    private static string Orders() => """
        [ { "kind": "form", "route": "/orders/sales/new", "title": "New sales order",
            "url": "https://freight.example.test/orders/sales/new", "elements": [] },
          { "kind": "list", "route": "/orders/sales", "title": "Sales orders",
            "url": "https://freight.example.test/orders/sales", "elements": [] },
          { "kind": "form", "route": "/customers/new", "title": "Add a customer",
            "url": "https://freight.example.test/customers/new", "elements": [] },
          { "kind": "form", "route": "/carriers/new", "title": "Add a carrier",
            "url": "https://freight.example.test/carriers/new", "elements": [] },
          { "kind": "form", "route": "/fleet/vehicles/new", "title": "Add a vehicle",
            "url": "https://freight.example.test/fleet/vehicles/new", "elements": [] } ]
        """;

    // ---- fixture ----------------------------------------------------------

    /// <summary>Five pages from three domains, each carrying the same sidebar — which is
    /// what a real back-office application looks like and what the naive scoping trips on.</summary>
    /// <summary>One page, one form, with the form element discovery records for it.</summary>
    private static string OneForm(bool withFormElement) => "[" + $$"""
        { "kind": "form", "route": "/orders/new", "title": "Place an order",
          "url": "https://freight.example.test/orders/new",
          "elements": [
            {{(withFormElement ? """{ "kind": "form", "accessibleName": "Place an order", "testId": "order-form" },""" : "")}}
            { "kind": "textInput", "accessibleName": "Customer", "label": "Customer",
              "testId": "customer", "type": "text", "isRequired": true },
            { "kind": "numberInput", "accessibleName": "Quantity", "label": "Quantity",
              "testId": "quantity", "type": "number", "isRequired": true },
            { "kind": "button", "accessibleName": "Place order", "label": "Place order",
              "testId": "order-submit", "ariaRole": "button" }
          ] }
        """ + "]";

    private static List<string> Actions(JsonElement plan)
        => plan.GetProperty("scenarios").EnumerateArray()
            .SelectMany(scenario => scenario.GetProperty("steps").EnumerateArray())
            .Select(step => step.GetProperty("action").GetString()!)
            .ToList();

    /// <summary>
    /// The planner's validation scenarios closed by asserting the submit control was still
    /// visible, which holds whether the application refused the submission, accepted it and
    /// redrew the form, or accepted it and did nothing. Both of them passed against every
    /// application regardless of behaviour.
    ///
    /// The form oracles were already written, already tested against a lab of deliberate
    /// defects, and used by the deterministic engine alone.
    /// </summary>
    [Fact]
    public void The_planner_closes_a_submission_with_the_form_oracles()
    {
        var actions = Actions(Plan(OneForm(withFormElement: true), requirement: null));

        actions.Should().Contain("assertFormAccepted");
        actions.Should().Contain("assertFormRejected");
    }

    [Fact]
    public void The_planner_no_longer_judges_a_refusal_by_whether_the_button_is_still_there()
    {
        var plan = Plan(OneForm(withFormElement: true), requirement: null);

        var visibilityChecks = plan.GetProperty("scenarios").EnumerateArray()
            .SelectMany(scenario => scenario.GetProperty("steps").EnumerateArray())
            .Where(step => step.GetProperty("action").GetString() == "assertVisible")
            .Select(step => step.GetProperty("target").GetProperty("value").GetString())
            .ToList();

        visibilityChecks.Should().NotContain("order-submit",
            "a submit control is on screen however the application behaved");
    }

    /// <summary>Where discovery did not record the form element there is nothing to point
    /// the oracle at, and the scenario asserts nothing rather than asserting something that
    /// cannot fail. The expectation says so.</summary>
    [Fact]
    public void Without_the_form_element_the_planner_asserts_nothing_and_says_why()
    {
        var plan = Plan(OneForm(withFormElement: false), requirement: null);

        Actions(plan).Should().NotContain("assertFormRejected");
        var validation = plan.GetProperty("scenarios").EnumerateArray()
            .First(s => s.GetProperty("name").GetString()!.Contains("required fields empty"));
        validation.GetProperty("expectedResults").GetString().Should()
            .Contain("Discovery found no form element");
    }

    private static string Freight()
    {
        string sidebar = """
            { "kind": "link", "accessibleName": "Shipments", "label": "Shipments", "testId": "nav-shipments" },
            { "kind": "link", "accessibleName": "Billing", "label": "Billing", "testId": "nav-billing" },
            { "kind": "link", "accessibleName": "Customs", "label": "Customs", "testId": "nav-customs" }
            """;

        string Page(string kind, string route, string title, string extra) => $$"""
            { "kind": "{{kind}}", "route": "{{route}}", "title": "{{title}}",
              "url": "https://freight.example.test{{route}}",
              "elements": [ {{sidebar}}{{(extra.Length > 0 ? "," + extra : "")}} ] }
            """;

        return "[" + string.Join(",", new[]
        {
            Page("list", "/shipments", "Shipments", ""),
            Page("form", "/shipments/new", "Book a shipment", """
                { "kind": "numberInput", "accessibleName": "Gross weight", "label": "Gross weight",
                  "testId": "gross-weight", "type": "number", "isRequired": true }
                """),
            Page("list", "/billing/invoices", "Invoices", ""),
            Page("form", "/billing/credit-notes", "Credit notes", """
                { "kind": "textInput", "accessibleName": "Reason", "label": "Reason", "testId": "reason" }
                """),
            Page("list", "/customs/declarations", "Declarations", "")
        }) + "]";
    }

    private static JsonElement Plan(string pages, string? requirement)
    {
        var context = JsonDocument.Parse($$"""
            { "baseUrl": "https://freight.example.test",
              "requirement": {{(requirement is null ? "null" : JsonSerializer.Serialize(requirement))}},
              "requiresSignIn": true,
              "pages": {{pages}} }
            """).RootElement;

        var generate = typeof(QaNxt.Infrastructure.Ai.Providers.LocalProvider).Assembly
            .GetType("QaNxt.Infrastructure.Ai.Providers.LocalTestPlanner")!
            .GetMethod("Generate")!;
        return JsonDocument.Parse((string)generate.Invoke(null, new object[] { context })!).RootElement;
    }

    private static string Summary(JsonElement plan) => plan.GetProperty("summary").GetString()!;

    /// <summary>The distinct routes the plan actually visits, read from the navigate step of
    /// every scenario — which is what "this page was tested" means.</summary>
    private static List<string> Routes(JsonElement plan)
        => plan.GetProperty("scenarios").EnumerateArray()
            .SelectMany(scenario => scenario.GetProperty("steps").EnumerateArray())
            .Where(step => step.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String)
            .Select(step => new Uri(step.GetProperty("url").GetString()!).AbsolutePath)
            .Distinct().OrderBy(route => route).ToList();
}
