using Aira.Application.Contracts;
using Aira.Domain.Enums;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Contracts;

/// <summary>Shape inference. What a contract check can say about a change is limited by
/// what the shape records, so these tests are about what is deliberately kept and what is
/// deliberately not.</summary>
public class ApiSchemaShapeTests
{
    [Fact]
    public void Records_the_type_at_every_path()
    {
        var shape = ApiSchemaShape.Infer("""
            { "accounts": [ { "id": "acc-1", "balance": 20942.8, "closed": false } ], "count": 1 }
            """);

        shape.Should().NotBeNull();
        shape!.Fields.Should().Contain(new KeyValuePair<string, string>("$", "object"));
        shape.Fields.Should().Contain(new KeyValuePair<string, string>("$.accounts", "array"));
        shape.Fields.Should().Contain(new KeyValuePair<string, string>("$.accounts[]", "object"));
        shape.Fields.Should().Contain(new KeyValuePair<string, string>("$.accounts[].id", "string"));
        shape.Fields.Should().Contain(new KeyValuePair<string, string>("$.accounts[].balance", "number"));
        shape.Fields.Should().Contain(new KeyValuePair<string, string>("$.accounts[].closed", "boolean"));
        shape.Fields.Should().Contain(new KeyValuePair<string, string>("$.count", "number"));
    }

    [Fact]
    public void Collapses_array_elements_so_the_length_is_not_part_of_the_contract()
    {
        // Two accounts and nine accounts are the same contract. Anything else would report
        // a breaking change every time the test data changed.
        var two = ApiSchemaShape.Infer("""{ "a": [ { "id": "1" }, { "id": "2" } ] }""");
        var nine = ApiSchemaShape.Infer("""
            { "a": [ {"id":"1"},{"id":"2"},{"id":"3"},{"id":"4"},{"id":"5"},{"id":"6"},{"id":"7"},{"id":"8"},{"id":"9"} ] }
            """);

        two!.Fields.Should().BeEquivalentTo(nine!.Fields);
    }

    [Fact]
    public void Merges_disagreeing_element_types_rather_than_taking_the_last_one()
    {
        // One element has a string id and another a number. Saying "string" would hide that
        // a caller parsing ids is already at risk.
        var shape = ApiSchemaShape.Infer("""{ "a": [ { "id": "1" }, { "id": 2 } ] }""");

        shape!.Fields["$.a[].id"].Should().Be("number|string");
    }

    [Fact]
    public void Treats_integers_and_fractions_alike()
    {
        // An API that starts returning 1 instead of 1.0 has not changed its contract.
        var integer = ApiSchemaShape.Infer("""{ "balance": 1 }""");
        var fraction = ApiSchemaShape.Infer("""{ "balance": 1.5 }""");

        integer!.Fields["$.balance"].Should().Be("number");
        fraction!.Fields["$.balance"].Should().Be("number");
    }

    [Fact]
    public void Records_null_as_its_own_type()
    {
        var shape = ApiSchemaShape.Infer("""{ "closedAt": null }""");
        shape!.Fields["$.closedAt"].Should().Be("null");
    }

    [Fact]
    public void Reports_an_array_root_and_an_object_root_differently()
    {
        ApiSchemaShape.Infer("[1,2,3]")!.RootType.Should().Be("array");
        ApiSchemaShape.Infer("{}")!.RootType.Should().Be("object");
    }

    [Fact]
    public void Returns_null_for_anything_that_is_not_json()
    {
        // An HTML error page is not a contract, and inferring one from it would produce a
        // baseline that fails for ever.
        ApiSchemaShape.Infer("<html><body>500</body></html>").Should().BeNull();
        ApiSchemaShape.Infer("").Should().BeNull();
        ApiSchemaShape.Infer(null).Should().BeNull();
        ApiSchemaShape.Infer("{ \"truncated\": ").Should().BeNull();
    }

    [Fact]
    public void Quotes_a_field_name_that_would_otherwise_read_as_structure()
    {
        var shape = ApiSchemaShape.Infer("""{ "a.b": 1, "c[0]": 2 }""");

        shape!.Fields.Keys.Should().Contain("$.['a.b']");
        shape.Fields.Keys.Should().Contain("$.['c[0]']");
    }

    [Fact]
    public void Round_trips_through_storage()
    {
        var shape = ApiSchemaShape.Infer("""{ "accounts": [ { "id": "a", "balance": 1.5 } ] }""");
        var restored = ApiSchemaShape.FromJson(shape!.ToJson());

        restored.Should().NotBeNull();
        restored!.Fields.Should().BeEquivalentTo(shape.Fields);
    }

    [Fact]
    public void Stops_at_the_field_ceiling_rather_than_walking_an_unbounded_document()
    {
        var items = string.Join(',', Enumerable.Range(0, 400).Select(n => $"\"f{n}\": {n}"));
        var shape = ApiSchemaShape.Infer($"{{ {items} }}", maxFields: 50);

        shape!.FieldCount.Should().BeLessThanOrEqualTo(51);   // the root, plus the ceiling
    }
}

/// <summary>The classification. This is the part of contract testing that matters: a check
/// that calls every change breaking gets disabled within a week, and one that calls a
/// removed field safe is worse than nothing.</summary>
public class ApiContractComparerTests
{
    private static ApiSchemaShape Shape(string json) => ApiSchemaShape.Infer(json)!;

    private static ApiContractDifference Single(string baseline, string observed)
    {
        var differences = ApiContractComparer.Compare(Shape(baseline), Shape(observed));
        differences.Should().HaveCount(1, "the two documents differ in exactly one way");
        return differences[0];
    }

    [Fact]
    public void An_identical_response_produces_no_differences()
    {
        var json = """{ "accounts": [ { "id": "a", "balance": 1.5 } ] }""";
        ApiContractComparer.Compare(Shape(json), Shape(json)).Should().BeEmpty();
    }

    [Fact]
    public void A_removed_field_is_breaking()
    {
        var difference = Single("""{ "id": "a", "balance": 1.5 }""", """{ "id": "a" }""");

        difference.Kind.Should().Be(ContractChangeKind.Breaking);
        difference.Path.Should().Be("$.balance");
        difference.BaselineType.Should().Be("number");
        difference.ObservedType.Should().BeNull();
        difference.Description.Should().Contain("now absent");
    }

    [Fact]
    public void A_new_field_is_not_breaking()
    {
        var difference = Single("""{ "id": "a" }""", """{ "id": "a", "nickname": "Current" }""");

        difference.Kind.Should().Be(ContractChangeKind.NonBreaking);
        difference.Path.Should().Be("$.nickname");
        difference.Description.Should().Contain("Existing callers are unaffected");
    }

    [Fact]
    public void A_changed_scalar_type_is_breaking()
    {
        var difference = Single("""{ "balance": 1.5 }""", """{ "balance": "1.50" }""");

        difference.Kind.Should().Be(ContractChangeKind.Breaking);
        difference.BaselineType.Should().Be("number");
        difference.ObservedType.Should().Be("string");
        difference.Description.Should().Contain("parses it as the old type will fail");
    }

    [Fact]
    public void A_field_that_becomes_nullable_is_potentially_breaking()
    {
        // Every caller that null-checks is fine; every caller that does not is broken.
        // Which of those a team has is not something the platform can know.
        var differences = ApiContractComparer.Compare(
            Shape("""{ "a": [ { "closedAt": "2026-01-01" } ] }"""),
            Shape("""{ "a": [ { "closedAt": "2026-01-01" }, { "closedAt": null } ] }"""));

        differences.Should().HaveCount(1);
        differences[0].Kind.Should().Be(ContractChangeKind.PotentiallyBreaking);
        differences[0].ObservedType.Should().Be("null|string");
        differences[0].Description.Should().Contain("can now be null");
    }

    [Fact]
    public void A_field_that_stops_being_null_is_not_breaking()
    {
        var difference = Single(
            """{ "a": [ { "closedAt": null }, { "closedAt": "2026-01-01" } ] }""",
            """{ "a": [ { "closedAt": "2026-01-01" } ] }""");

        difference.Kind.Should().Be(ContractChangeKind.NonBreaking);
        difference.Description.Should().Contain("still works");
    }

    [Fact]
    public void A_field_only_ever_seen_as_null_is_potentially_breaking_when_its_type_appears()
    {
        // The baseline never recorded the real type, so this may not be a change at all.
        // Calling it breaking would make every nullable field a false alarm on the first
        // release that populates it.
        var difference = Single("""{ "closedAt": null }""", """{ "closedAt": "2026-01-01" }""");

        difference.Kind.Should().Be(ContractChangeKind.PotentiallyBreaking);
        difference.Description.Should().Contain("only ever observed as null");
    }

    [Fact]
    public void A_field_that_gains_a_second_type_is_potentially_breaking()
    {
        var difference = Single(
            """{ "a": [ { "id": "1" } ] }""",
            """{ "a": [ { "id": "1" }, { "id": 2 } ] }""");

        difference.Kind.Should().Be(ContractChangeKind.PotentiallyBreaking);
        difference.ObservedType.Should().Be("number|string");
        difference.Description.Should().Contain("assumes one type will fail on the other");
    }

    [Fact]
    public void A_structural_change_is_breaking_and_says_so()
    {
        var differences = ApiContractComparer.Compare(
            Shape("""{ "accounts": [ { "id": "a" } ] }"""),
            Shape("""{ "accounts": { "items": [ { "id": "a" } ] } }"""));

        var root = differences.Single(d => d.Path == "$.accounts");
        root.Kind.Should().Be(ContractChangeKind.Breaking);
        root.Description.Should().Contain("shape of the response at this point is different");
    }

    [Fact]
    public void A_success_becoming_an_error_is_breaking()
    {
        var differences = ApiContractComparer.Compare(
            Shape("""{ "accounts": [] }"""), Shape("""{ "error": "internal" }"""),
            baselineStatus: 200, observedStatus: 500);

        var status = differences.Single(d => d.Path == "$status");
        status.Kind.Should().Be(ContractChangeKind.Breaking);
        status.BaselineType.Should().Be("200");
        status.ObservedType.Should().Be("500");
        status.Description.Should().Contain("no longer works");
    }

    [Fact]
    public void An_error_becoming_a_success_is_not_breaking()
    {
        var differences = ApiContractComparer.Compare(
            Shape("""{ "error": "internal" }"""), Shape("""{ "error": "internal" }"""),
            baselineStatus: 500, observedStatus: 200);

        differences.Single().Kind.Should().Be(ContractChangeKind.NonBreaking);
        differences.Single().Description.Should().Contain("started working");
    }

    [Fact]
    public void One_success_code_becoming_another_is_potentially_breaking()
    {
        var differences = ApiContractComparer.Compare(
            Shape("{}"), Shape("{}"), baselineStatus: 200, observedStatus: 204);

        differences.Single().Kind.Should().Be(ContractChangeKind.PotentiallyBreaking);
    }

    [Fact]
    public void An_unchanged_status_produces_no_status_difference()
    {
        ApiContractComparer.Compare(Shape("{}"), Shape("{}"), 200, 200).Should().BeEmpty();
    }

    [Fact]
    public void Every_difference_names_the_path_and_both_types()
    {
        var differences = ApiContractComparer.Compare(
            Shape("""{ "id": "a", "balance": 1.5, "closedAt": "x" }"""),
            Shape("""{ "id": 1, "closedAt": "x", "nickname": "n" }"""));

        differences.Should().HaveCount(3);
        differences.Should().OnlyContain(d => d.Path.Length > 0 && d.Description.Length > 20);
        differences.Should().Contain(d => d.Kind == ContractChangeKind.Breaking && d.Path == "$.id");
        differences.Should().Contain(d => d.Kind == ContractChangeKind.Breaking && d.Path == "$.balance");
        differences.Should().Contain(d => d.Kind == ContractChangeKind.NonBreaking && d.Path == "$.nickname");
    }

    [Fact]
    public void A_description_reads_as_a_sentence_about_callers_rather_than_a_diff()
    {
        var difference = Single("""{ "balance": 1.5 }""", """{ "balance": "1.50" }""");

        difference.Description.Should().StartWith("\"balance\" changed from number to string");
        difference.Description.Should().EndWith(".");
    }

    [Fact]
    public void Stops_comparing_fields_once_the_status_class_has_changed()
    {
        // A baseline captured from an error response, and an endpoint that now works.
        var differences = ApiContractComparer.Compare(
            Shape("""{ "error": "unauthorized" }"""),
            Shape("""{ "accounts": [ { "id": "acc-1", "balance": 12.5 } ] }"""),
            baselineStatus: 401, observedStatus: 200);

        // One difference: the status. The endpoint started working, which is not breaking.
        differences.Should().ContainSingle(
            "an error body and a success body are different contracts, so diffing their "
            + "fields against each other says nothing true");
        differences[0].Path.Should().Be("$status");
        differences[0].Kind.Should().Be(ContractChangeKind.NonBreaking);

        // Specifically, the error field's disappearance is not reported as breaking. That is
        // the false positive this guards: telling a team that an endpoint which started
        // working has broken its callers (BUG-0040).
        differences.Should().NotContain(d => d.Path.Contains("error"));
    }

    [Fact]
    public void Still_compares_fields_when_both_responses_succeeded()
    {
        var differences = ApiContractComparer.Compare(
            Shape("""{ "id": "a", "sortCode": "11-22-33" }"""),
            Shape("""{ "id": "a" }"""),
            baselineStatus: 200, observedStatus: 201);

        // Different codes, same class, so the bodies are still comparable and a removed
        // field is still breaking.
        differences.Should().Contain(d => d.Path.Contains("sortCode")
            && d.Kind == ContractChangeKind.Breaking);
    }
}
