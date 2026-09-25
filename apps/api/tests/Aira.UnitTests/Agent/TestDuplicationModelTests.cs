using Aira.Application.Agent;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Agent;

/// <summary>
/// Whether a test already exists, before one is written.
/// </summary>
/// <remarks>
/// The failure being prevented: a generator asked twice for the same thing produces two tests
/// with different wording, both are kept, and a suite doubles while covering nothing new. The
/// opposite failure matters too and is worse — a test not written because something judged it
/// a duplicate is a coverage gap with no record — so the cases about <em>not</em> calling
/// something a duplicate are as carefully written as the ones about catching duplicates.
/// </remarks>
public class TestDuplicationModelTests
{
    private static ExistingTest Existing(
        string reference, string name, string objective, string target,
        TestDimension dimension = TestDimension.Ui, params string[] assertions)
        => new(Guid.NewGuid(), reference, name, objective, target, dimension, assertions);

    private static CandidateTest Candidate(
        string name, string objective, string target,
        TestDimension dimension = TestDimension.Ui, params string[] assertions)
        => new(name, objective, target, dimension, assertions);

    // ---- Generate ------------------------------------------------------------

    [Fact]
    public void Nothing_targeting_the_same_thing_means_write_it()
    {
        var decision = TestDuplicationModel.Evaluate(
            Candidate("Transfer money between accounts",
                "A customer moves funds from current to savings", "/payments"),
            new[] { Existing("TC-0001", "Sign in", "A customer signs in", "/login") });

        decision.Verdict.Should().Be(DuplicationVerdict.Generate);
        decision.ExistingTestId.Should().BeNull();
    }

    [Fact]
    public void The_same_target_with_a_different_purpose_is_not_a_duplicate()
    {
        var decision = TestDuplicationModel.Evaluate(
            Candidate("Reject a transfer that exceeds the daily limit",
                "The daily limit stops an oversized transfer", "/payments"),
            new[]
            {
                Existing("TC-0002", "Transfer money between accounts",
                    "A customer moves funds from current to savings", "/payments")
            });

        // Both are UI tests of /payments and they establish different things. Calling this a
        // duplicate loses the limit check entirely, and nothing would record that it happened.
        decision.Verdict.Should().Be(DuplicationVerdict.Generate);
        decision.Reason.Should().Contain("none of them is about the same thing");
    }

    [Fact]
    public void A_ui_test_and_an_api_test_of_the_same_route_are_never_duplicates()
    {
        var decision = TestDuplicationModel.Evaluate(
            Candidate("Transfer money", "A customer moves funds", "/payments", TestDimension.Api),
            new[]
            {
                Existing("TC-0002", "Transfer money", "A customer moves funds",
                    "/payments", TestDimension.Ui)
            });

        // Identical wording, identical target. One drives a browser and one calls an endpoint,
        // and one of them passing says nothing whatever about the other.
        decision.Verdict.Should().Be(DuplicationVerdict.Generate);
    }

    // ---- Reuse ---------------------------------------------------------------

    [Fact]
    public void The_same_intent_and_the_same_assertions_means_reuse_what_is_there()
    {
        var decision = TestDuplicationModel.Evaluate(
            Candidate("Transfer funds between accounts",
                "A customer transfers funds from current to savings", "/payments",
                TestDimension.Ui, "balance.decreased", "transaction.created"),
            new[]
            {
                Existing("TC-0002", "Transfer funds between accounts",
                    "A customer transfers funds from current to savings", "/payments",
                    TestDimension.Ui, "balance.decreased", "transaction.created")
            });

        decision.Verdict.Should().Be(DuplicationVerdict.Reuse);
        decision.ExistingReference.Should().Be("TC-0002");
        decision.Similarity.Should().BeGreaterOrEqualTo(TestDuplicationModel.SameIntentThreshold);
    }

    [Fact]
    public void Different_wording_for_the_same_test_is_still_the_same_test()
    {
        var decision = TestDuplicationModel.Evaluate(
            Candidate("Verify the user can transfer funds between their accounts",
                "Check that a customer transfers funds from current into savings", "/payments",
                TestDimension.Ui, "balance.decreased"),
            new[]
            {
                Existing("TC-0002", "Transfer funds between accounts",
                    "A customer transfers funds from current to savings", "/payments",
                    TestDimension.Ui, "balance.decreased")
            });

        // The exact failure this model exists for: "verify the user can" and "check that a
        // customer" are the same test in two voices, and a generator will produce both.
        decision.Verdict.Should().Be(DuplicationVerdict.Reuse);
    }

    // ---- Extend --------------------------------------------------------------

    [Fact]
    public void The_same_test_with_weaker_assertions_is_extended_rather_than_duplicated()
    {
        var decision = TestDuplicationModel.Evaluate(
            Candidate("Transfer funds between accounts",
                "A customer transfers funds from current to savings", "/payments",
                TestDimension.Ui, "balance.decreased", "transaction.created", "receipt.shown"),
            new[]
            {
                Existing("TC-0002", "Transfer funds between accounts",
                    "A customer transfers funds from current to savings", "/payments",
                    TestDimension.Ui, "balance.decreased")
            });

        // The interesting middle case. The missing checks are real coverage; writing a second
        // near-identical test beside the first is the wrong way to add them.
        decision.Verdict.Should().Be(DuplicationVerdict.Extend);
        decision.MissingAssertions.Should().BeEquivalentTo(
            new[] { "transaction.created", "receipt.shown" });
        decision.Reason.Should().Contain("Adding them to it is coverage");
    }

    [Fact]
    public void An_assertion_the_existing_test_already_has_is_not_reported_as_missing()
    {
        var decision = TestDuplicationModel.Evaluate(
            Candidate("Transfer funds between accounts",
                "A customer transfers funds from current to savings", "/payments",
                TestDimension.Ui, "balance.decreased", "receipt.shown"),
            new[]
            {
                Existing("TC-0002", "Transfer funds between accounts",
                    "A customer transfers funds from current to savings", "/payments",
                    TestDimension.Ui, "BALANCE.DECREASED")
            });

        decision.Verdict.Should().Be(DuplicationVerdict.Extend);
        decision.MissingAssertions.Should().BeEquivalentTo(new[] { "receipt.shown" });
    }

    // ---- Matching mechanics --------------------------------------------------

    [Fact]
    public void A_trailing_slash_does_not_make_a_different_target()
    {
        var decision = TestDuplicationModel.Evaluate(
            Candidate("Transfer funds between accounts",
                "A customer transfers funds from current to savings", "/payments/"),
            new[]
            {
                Existing("TC-0002", "Transfer funds between accounts",
                    "A customer transfers funds from current to savings", "/payments")
            });

        decision.Verdict.Should().Be(DuplicationVerdict.Reuse);
    }

    [Fact]
    public void Similarity_is_symmetric_and_reproducible()
    {
        var candidate = Candidate("Transfer funds between accounts",
            "A customer moves money from current to savings", "/payments");
        var existing = Existing("TC-0002", "Move money between accounts",
            "A customer transfers funds from current into savings", "/payments");

        var first = TestDuplicationModel.IntentSimilarity(candidate, existing);
        var second = TestDuplicationModel.IntentSimilarity(candidate, existing);

        // Explainability is the whole reason this is a word overlap rather than a model call.
        // A number that moves between two identical calls cannot be argued with.
        first.Should().Be(second);
        first.Should().BeInRange(0, 100);
    }

    [Fact]
    public void Filler_words_do_not_make_two_unrelated_tests_look_alike()
    {
        var decision = TestDuplicationModel.Evaluate(
            Candidate("Verify that the user should be able to check the balance",
                "Ensure the user can validate that this is correct", "/dashboard"),
            new[]
            {
                Existing("TC-0009", "Verify that the user should be able to check the receipt",
                    "Ensure the user can validate that this is correct", "/dashboard")
            });

        // Both sentences are nine-tenths scaffolding. If "verify", "should", "ensure" and
        // "user" counted, every generated test would look like every other one and real
        // coverage would be silently dropped as duplicate.
        decision.Verdict.Should().Be(DuplicationVerdict.Generate);
    }

    [Fact]
    public void A_test_with_nothing_significant_in_its_wording_matches_nothing()
    {
        var decision = TestDuplicationModel.Evaluate(
            Candidate("Test", "The test", "/payments"),
            new[] { Existing("TC-0002", "Test", "The test", "/payments") });

        // Both reduce to no significant words. Zero similarity means write it: an empty
        // comparison must not come back as "these are the same", which would drop the test.
        decision.Similarity.Should().Be(0);
        decision.Verdict.Should().Be(DuplicationVerdict.Generate);
    }

    [Fact]
    public void The_closest_non_match_is_named_so_a_person_can_disagree()
    {
        var decision = TestDuplicationModel.Evaluate(
            Candidate("Reject an oversized transfer", "The daily limit blocks it", "/payments"),
            new[]
            {
                Existing("TC-0002", "Transfer funds", "A customer transfers funds", "/payments"),
                Existing("TC-0003", "Sign out", "A customer signs out", "/payments")
            });

        decision.Verdict.Should().Be(DuplicationVerdict.Generate);
        decision.Reason.Should().Contain("closest:");
        decision.Reason.Should().MatchRegex("TC-000[23]");
    }
}
