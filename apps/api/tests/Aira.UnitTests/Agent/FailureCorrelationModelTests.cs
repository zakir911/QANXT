using Aira.Application.Agent;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Agent;

/// <summary>
/// Grouping failures that share a cause.
/// </summary>
/// <remarks>
/// The grouping is allowed to be wrong in one direction only. Offering a group that turns out
/// to be a coincidence costs somebody a minute; hiding a failure inside a group costs a defect
/// that ships. So the invariant asserted hardest here is arithmetic: everything that goes in
/// comes out, in a group or beside one.
/// </remarks>
public class FailureCorrelationModelTests
{
    private static FailureSignal Failure(
        string reference, string? route = "/payments", string? api = null, int? status = null,
        string signature = "expected 200 but got 500", string classification = "ApplicationDefect")
        => new(Guid.NewGuid(), reference, $"Test {reference}", route, api, status,
            classification, signature, new DateTimeOffset(2026, 9, 25, 9, 0, 0, TimeSpan.Zero));

    // ---- The invariant --------------------------------------------------------

    [Fact]
    public void Every_failure_that_goes_in_comes_out()
    {
        var failures = new[]
        {
            Failure("TC-1", api: "POST /api/payment", status: 500),
            Failure("TC-2", api: "POST /api/payment", status: 500),
            Failure("TC-3", route: "/login", signature: "element not found"),
            Failure("TC-4", route: "/reports", signature: "timeout waiting for table")
        };

        var result = FailureCorrelationModel.Correlate(failures);

        // The one thing that must never be wrong. A group is a way of reading failures, not a
        // way of reducing them, and a failure that vanishes into a summary is a defect nobody
        // finds out about.
        result.TotalFailures.Should().Be(4);
        result.Groups.SelectMany(g => g.Members).Concat(result.Ungrouped)
            .Select(f => f.TestReference)
            .Should().BeEquivalentTo(new[] { "TC-1", "TC-2", "TC-3", "TC-4" });
    }

    [Fact]
    public void A_failure_belongs_to_exactly_one_group()
    {
        var failures = new[]
        {
            Failure("TC-1", route: "/payments", api: "POST /api/payment", status: 500),
            Failure("TC-2", route: "/payments", api: "POST /api/payment", status: 500),
            Failure("TC-3", route: "/payments", api: "POST /api/payment", status: 500)
        };

        var result = FailureCorrelationModel.Correlate(failures);

        // These share an API call, a route and a signature. Counted once, under the strongest
        // of the three, or the same failure appears three times and the counts stop meaning
        // anything.
        result.Groups.SelectMany(g => g.Members).Should().HaveCount(3);
        result.Groups.Should().ContainSingle();
    }

    // ---- The rules, strongest first ---------------------------------------------

    [Fact]
    public void A_shared_endpoint_returning_a_server_error_is_the_primary_failure()
    {
        var failures = Enumerable.Range(1, 17)
            .Select(i => Failure($"TC-{i}", api: "POST /api/payment", status: 500))
            .ToArray();

        var result = FailureCorrelationModel.Correlate(failures);

        var group = result.Groups.Should().ContainSingle().Subject;
        group.PrimaryFailure.Should().Contain("POST /api/payment").And.Contain("500");
        group.Count.Should().Be(17);
        group.Confidence.Should().BeGreaterThan(80);
        // Seventeen tests did not fail for seventeen reasons.
        group.Why.Should().Contain("more likely explanation");
    }

    [Fact]
    public void A_shared_refusal_is_offered_as_a_lead_rather_than_a_cause()
    {
        var failures = new[]
        {
            Failure("TC-1", api: "GET /api/accounts", status: 403),
            Failure("TC-2", api: "GET /api/accounts", status: 403),
            Failure("TC-3", api: "GET /api/accounts", status: 403)
        };

        var result = FailureCorrelationModel.Correlate(failures);

        var group = result.Groups.Should().ContainSingle().Subject;
        group.Confidence.Should().BeLessThan(80);
        // Usually one broken session. Sometimes three tests that are genuinely wrong, and the
        // wording has to leave room for that.
        group.Why.Should().Contain("lead rather than a cause");
    }

    [Fact]
    public void A_shared_route_alone_is_the_weakest_grouping_and_says_so()
    {
        var failures = new[]
        {
            Failure("TC-1", route: "/reports", signature: "element not found: table"),
            Failure("TC-2", route: "/reports", signature: "timeout waiting for chart")
        };

        var result = FailureCorrelationModel.Correlate(failures);

        var group = result.Groups.Should().ContainSingle().Subject;
        group.Confidence.Should().BeLessThan(50);
        group.Why.Should().Contain("not a conclusion about a cause");
    }

    [Fact]
    public void The_strongest_evidence_wins_when_several_rules_could_apply()
    {
        var failures = new[]
        {
            Failure("TC-1", route: "/payments", api: "POST /api/payment", status: 500,
                signature: "expected 200"),
            Failure("TC-2", route: "/payments", api: "POST /api/payment", status: 500,
                signature: "expected 200")
        };

        var result = FailureCorrelationModel.Correlate(failures);

        result.Groups.Should().ContainSingle()
            .Which.PrimaryFailure.Should().Contain("500");
    }

    [Fact]
    public void Groups_are_ordered_with_the_best_established_first()
    {
        var failures = new[]
        {
            Failure("TC-1", route: "/a", signature: "sig-a"),
            Failure("TC-2", route: "/a", signature: "sig-b"),
            Failure("TC-3", route: "/b", api: "POST /api/pay", status: 500, signature: "sig-c"),
            Failure("TC-4", route: "/c", api: "POST /api/pay", status: 500, signature: "sig-d")
        };

        var result = FailureCorrelationModel.Correlate(failures);

        result.Groups.First().PrimaryFailure.Should().Contain("500");
    }

    // ---- Not grouping -----------------------------------------------------------

    [Fact]
    public void One_failure_is_never_a_group()
    {
        var result = FailureCorrelationModel.Correlate(new[]
        {
            Failure("TC-1", api: "POST /api/payment", status: 500)
        });

        // A "group" of one is a failure wearing a hat, and it makes a list of individual
        // problems look like a list of correlated ones.
        result.Groups.Should().BeEmpty();
        result.Ungrouped.Should().ContainSingle();
    }

    [Fact]
    public void Failures_that_share_nothing_are_listed_individually_and_said_to_be()
    {
        var failures = new[]
        {
            Failure("TC-1", route: "/a", signature: "sig-a"),
            Failure("TC-2", route: "/b", signature: "sig-b"),
            Failure("TC-3", route: "/c", signature: "sig-c")
        };

        var result = FailureCorrelationModel.Correlate(failures);

        result.Groups.Should().BeEmpty();
        result.Ungrouped.Should().HaveCount(3);
        result.Summary.Should().Contain("listed individually because that is what they are");
    }

    [Fact]
    public void No_failures_is_not_an_error_and_not_a_group()
    {
        var result = FailureCorrelationModel.Correlate(Array.Empty<FailureSignal>());

        result.Groups.Should().BeEmpty();
        result.TotalFailures.Should().Be(0);
    }

    // ---- What a group reports ----------------------------------------------------

    [Fact]
    public void A_group_names_every_test_route_and_call_it_touches()
    {
        var failures = new[]
        {
            Failure("TC-1", route: "/payments", api: "POST /api/payment", status: 500),
            Failure("TC-2", route: "/checkout", api: "POST /api/payment", status: 500)
        };

        var group = FailureCorrelationModel.Correlate(failures).Groups.Single();

        group.AffectedTests.Should().BeEquivalentTo(new[] { "TC-1", "TC-2" });
        group.AffectedRoutes.Should().BeEquivalentTo(new[] { "/payments", "/checkout" });
        group.AffectedApiCalls.Should().BeEquivalentTo(new[] { "POST /api/payment" });
    }

    [Fact]
    public void A_group_is_never_certain()
    {
        var failures = Enumerable.Range(1, 50)
            .Select(i => Failure($"TC-{i}", api: "POST /api/payment", status: 500))
            .ToArray();

        // Fifty tests agreeing is strong evidence and still not proof: they could all be
        // wrong in the same way, which is exactly what a bad fixture looks like.
        FailureCorrelationModel.Correlate(failures).Groups.Single()
            .Confidence.Should().BeLessThan(100);
    }

    [Fact]
    public void The_summary_says_that_grouping_does_not_reduce_anything()
    {
        var failures = new[]
        {
            Failure("TC-1", api: "POST /api/payment", status: 500),
            Failure("TC-2", api: "POST /api/payment", status: 500),
            Failure("TC-3", route: "/elsewhere", signature: "unique")
        };

        FailureCorrelationModel.Correlate(failures).Summary
            .Should().Contain("not a way of reducing them");
    }
}
