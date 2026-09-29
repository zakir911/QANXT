using System.Text.Json;
using QaNxt.Application.Ai;
using QaNxt.Infrastructure.Ai.Providers;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace QaNxt.UnitTests.Ai;

/// <summary>
/// A generated test case must not promise a check it does not make.
/// </summary>
/// <remarks>
/// <para>
/// BUG-0016 established that a generated assertion has to be able to fail. That is half the
/// requirement. The other half is that the assertion has to be about the thing the test case
/// says it is about, because the name, the objective and the expected results are what a
/// reviewer reads when deciding whether a green run means anything.
/// </para>
/// <para>
/// The invalid-filter-range scenario picks one of three closing assertions depending on what
/// discovery observed: a validation message if the page has an element that reports one, an
/// empty-state element if it has one, otherwise the records table being hidden. Those three
/// check different things. For a while all three shipped the same declared expectation,
/// "A validation message explains that the range is invalid", so the weakest of them passed
/// precisely when the application silently returned nothing — the behaviour the objective
/// named as the failure — and reported that as evidence the range had been refused.
/// </para>
/// <para>
/// This is not a rare branch. Discovery records a page before anything is interacted with, so
/// a validation message that only appears in response to the submit the scenario performs is
/// never in the element set. The lower tiers are the normal path for a server-rendered form.
/// </para>
/// </remarks>
public class GeneratedScenarioHonestyTests
{
    private const string ValidationPromise = "validation message";

    /// <summary>The element whose presence moves the generator from one tier to the next.
    /// Written as constants because <see cref="InlineDataAttribute"/> needs them.</summary>
    private const string NoExtraElement = "";
    private const string EmptyStateElement =
        ",\n                { \"kind\": \"text\", \"testId\": \"no-records\", \"accessibleName\": \"Nothing matched\" }";
    private const string ValidationElement =
        ",\n                { \"kind\": \"text\", \"ariaRole\": \"alert\", \"testId\": \"filter-error\", \"accessibleName\": \"Range is invalid\" }";

    // ---- Fixtures ---------------------------------------------------------

    /// <summary>A records page with a date-range filter and a table, in the shape discovery
    /// stores. <paramref name="extraElements"/> is where a test adds the element whose
    /// presence moves the generator to a different tier.</summary>
    private static string ListPageContext(string extraElements = NoExtraElement)
        => $$"""
        {
          "pages": [
            {
              "kind": "list",
              "route": "/accounts/acc-1003",
              "title": "Travel Card",
              "url": "http://localhost:4200/accounts/acc-1003",
              "elements": [
                { "kind": "table", "ariaRole": "table", "testId": "transactions-table", "accessibleName": "Transactions" },
                { "kind": "input", "type": "date", "testId": "filter-from", "label": "From" },
                { "kind": "input", "type": "date", "testId": "filter-to", "label": "To" },
                { "kind": "button", "ariaRole": "button", "testId": "apply-filter", "accessibleName": "Apply filter" }{{extraElements}}
              ]
            }
          ]
        }
        """;

    private static JsonElement Generate(string context)
    {
        var provider = new LocalProvider(NullLogger<LocalProvider>.Instance);
        var request = new LlmRequest
        {
            Messages = new[]
            {
                LlmMessage.User(
                    $"Generate a plan.\n{LocalProvider.ContextOpen}\n{context}\n{LocalProvider.ContextClose}")
            },
            SchemaName = AiSchemaCatalog.TestPlan,
            JsonSchema = "{}"
        };

        var response = provider.CompleteAsync(request).GetAwaiter().GetResult();
        return JsonDocument.Parse(response.Content).RootElement.Clone();
    }

    /// <summary>The one scenario that drives the filter with an impossible range. Found by
    /// what it does, not by its name, because its name is one of the things under test.</summary>
    private static JsonElement FilterRangeScenario(JsonElement plan)
    {
        var scenarios = plan.GetProperty("scenarios").EnumerateArray()
            .Where(s => s.GetProperty("steps").EnumerateArray().Any(step =>
                JsonSerializer.Serialize(step).Contains("filter-from", StringComparison.Ordinal)))
            .ToList();

        scenarios.Should().HaveCount(1, "the fixture describes exactly one date-range filter");
        return scenarios[0];
    }

    private static string ClosingAction(JsonElement scenario)
    {
        var steps = scenario.GetProperty("steps").EnumerateArray().ToList();
        return steps[^1].GetProperty("action").GetString()!;
    }

    private static string Declared(JsonElement scenario)
        => string.Join(' ',
            scenario.GetProperty("name").GetString(),
            scenario.GetProperty("objective").GetString(),
            scenario.GetProperty("expectedResults").GetString());

    // ---- The regression ---------------------------------------------------

    /// <summary>The demo bank's shape: the validation message is rendered on submit, so
    /// discovery never sees it and the generator falls to the table assertion.</summary>
    [Fact]
    public void A_scenario_that_only_checks_the_table_does_not_promise_a_validation_message()
    {
        var scenario = FilterRangeScenario(Generate(ListPageContext()));

        ClosingAction(scenario).Should().Be("assertHidden",
            "no validation or empty-state element was discovered, so the table is all there is to assert on");

        scenario.GetProperty("expectedResults").GetString()
            .Should().NotBe("A validation message explains that the range is invalid.");
        scenario.GetProperty("name").GetString()
            .Should().NotStartWith("Reject an invalid filter range",
                "nothing in this scenario distinguishes a refusal from a silently empty list");
    }

    /// <summary>Same page, but with an empty-state element to assert on.</summary>
    [Fact]
    public void A_scenario_that_only_checks_the_empty_state_does_not_promise_a_validation_message()
    {
        var scenario = FilterRangeScenario(Generate(ListPageContext(EmptyStateElement)));

        ClosingAction(scenario).Should().Be("assertVisible");
        JsonSerializer.Serialize(scenario.GetProperty("steps")).Should().Contain("no-records");
        scenario.GetProperty("expectedResults").GetString()
            .Should().NotBe("A validation message explains that the range is invalid.");
    }

    // ---- The positive control ---------------------------------------------

    /// <summary>Without this the fix could be "never mention a validation message anywhere",
    /// which would lose the one tier that genuinely checks for one.</summary>
    [Fact]
    public void A_scenario_that_checks_the_validation_message_still_promises_one()
    {
        var scenario = FilterRangeScenario(Generate(ListPageContext(ValidationElement)));

        ClosingAction(scenario).Should().Be("assertVisible");
        JsonSerializer.Serialize(scenario.GetProperty("steps")).Should().Contain("filter-error");

        scenario.GetProperty("name").GetString().Should().StartWith("Reject an invalid filter range");
        scenario.GetProperty("expectedResults").GetString()
            .Should().Be("A validation message explains that the range is invalid.");
    }

    // ---- The invariant the two above are instances of ---------------------

    /// <summary>Stated as a rule rather than three cases, so a fourth tier added later is
    /// covered without anybody remembering to extend this file.</summary>
    [Theory]
    [InlineData(NoExtraElement)]
    [InlineData(EmptyStateElement)]
    [InlineData(ValidationElement)]
    public void A_scenario_promises_a_validation_message_only_when_it_asserts_on_one(string extraElements)
    {
        var scenario = FilterRangeScenario(Generate(ListPageContext(extraElements)));

        var promisesValidation = Declared(scenario).Contains(ValidationPromise, StringComparison.OrdinalIgnoreCase)
            && !Declared(scenario).Contains("is not checked", StringComparison.OrdinalIgnoreCase);
        var assertsOnValidation = JsonSerializer.Serialize(scenario.GetProperty("steps"))
            .Contains("filter-error", StringComparison.Ordinal);

        promisesValidation.Should().Be(assertsOnValidation,
            "a generated test case may promise a validation message only when a step asserts on one");
    }
}
