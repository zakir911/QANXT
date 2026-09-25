using Aira.Application.Agent;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Agent;

/// <summary>
/// Which tests are worth running first, and why.
/// </summary>
/// <remarks>
/// The brief asks for explainable rules rather than a learned model, and the reason shows up
/// in these tests: every one of them can name the rule that produced the answer. A priority
/// nobody can argue with is a priority nobody trusts.
/// </remarks>
public class TestHistoryModelTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 25, 12, 0, 0, TimeSpan.Zero);

    private static TestHistory History(
        string reference = "TC-0001", int executions = 20, int failures = 0,
        int flakiness = 0, int daysSinceRun = 1, bool lastFailed = false,
        bool changed = false, bool critical = false)
        => new(Guid.NewGuid(), reference, executions, failures, flakiness,
            executions == 0 ? null : Now.AddDays(-daysSinceRun),
            lastFailed, changed, critical);

    // ---- Each rule ------------------------------------------------------------

    [Fact]
    public void A_test_nothing_has_happened_to_scores_nothing_and_says_so()
    {
        var priority = TestHistoryModel.Prioritise(History(), Now);

        priority.Score.Should().Be(0);
        priority.Reasons.Should().BeEmpty();
        priority.Summary.Should().Contain("runs in the ordinary order");
    }

    [Fact]
    public void A_change_touching_what_a_test_covers_is_the_strongest_single_signal()
    {
        var changed = TestHistoryModel.Prioritise(History(changed: true), Now);
        var failing = TestHistoryModel.Prioritise(History(lastFailed: true), Now);
        var critical = TestHistoryModel.Prioritise(History(critical: true), Now);

        // Everything else is about the past. A change is about this build.
        changed.Score.Should().BeGreaterThan(failing.Score);
        changed.Score.Should().BeGreaterThan(critical.Score);
    }

    [Fact]
    public void A_test_that_failed_last_time_is_raised_and_the_reason_names_why()
    {
        var priority = TestHistoryModel.Prioritise(History(lastFailed: true), Now);

        priority.Reasons.Should().Contain(r => r.Name == "failing");
        priority.Reasons.Single(r => r.Name == "failing")
            .Explanation.Should().Contain("how a flake is told from a defect");
    }

    [Fact]
    public void Old_failures_count_as_a_rate_rather_than_a_count()
    {
        // Two failures in a thousand runs is not a problem; two in five is.
        var reliable = TestHistoryModel.Prioritise(History(executions: 1000, failures: 2), Now);
        var unreliable = TestHistoryModel.Prioritise(History(executions: 5, failures: 2), Now);

        reliable.Reasons.Should().NotContain(r => r.Name == "fails often");
        unreliable.Reasons.Should().Contain(r => r.Name == "fails often");
    }

    [Fact]
    public void A_current_failure_outweighs_a_history_of_them()
    {
        var failingNow = TestHistoryModel.Prioritise(
            History(executions: 20, failures: 1, lastFailed: true), Now);
        var failedOften = TestHistoryModel.Prioritise(
            History(executions: 20, failures: 10, lastFailed: false), Now);

        failingNow.Score.Should().BeGreaterThan(failedOften.Score);
        // And the two never both apply, or the same fact would be counted twice.
        failingNow.Reasons.Should().NotContain(r => r.Name == "fails often");
    }

    [Fact]
    public void An_area_a_person_called_critical_is_raised()
    {
        TestHistoryModel.Prioritise(History(critical: true), Now)
            .Reasons.Should().Contain(r =>
                r.Name == "business-critical"
                && r.Explanation.Contains("stop trading over"));
    }

    [Fact]
    public void A_test_that_has_never_run_is_raised_because_it_is_not_coverage()
    {
        var priority = TestHistoryModel.Prioritise(History(executions: 0), Now);

        priority.Reasons.Should().Contain(r => r.Name == "never run");
        // The sentence that matters. A suite of tests nobody has executed is an intention.
        priority.Reasons.Single(r => r.Name == "never run")
            .Explanation.Should().Contain("has never executed is not coverage");
    }

    [Fact]
    public void A_test_nobody_has_run_lately_is_raised_a_little()
    {
        var fresh = TestHistoryModel.Prioritise(History(daysSinceRun: 1), Now);
        var stale = TestHistoryModel.Prioritise(
            History(daysSinceRun: TestHistoryModel.StaleAfterDays + 1), Now);

        fresh.Reasons.Should().NotContain(r => r.Name == "stale");
        stale.Reasons.Should().Contain(r => r.Name == "stale");
        stale.Reasons.Single(r => r.Name == "stale")
            .Explanation.Should().Contain("may no longer be true");
    }

    [Fact]
    public void Instability_is_read_from_the_stored_score_rather_than_recomputed()
    {
        var stable = TestHistoryModel.Prioritise(History(flakiness: 20), Now);
        var unstable = TestHistoryModel.Prioritise(History(flakiness: 60), Now);

        // One definition of unstable, in the one place that sees every execution. A second
        // definition here would eventually disagree with the first, and both would be shown.
        stable.Reasons.Should().NotContain(r => r.Name == "unstable");
        unstable.Reasons.Should().Contain(r => r.Name == "unstable");
    }

    // ---- The score ---------------------------------------------------------------

    [Fact]
    public void Every_point_is_attributed_to_a_named_reason()
    {
        var priority = TestHistoryModel.Prioritise(
            History(lastFailed: true, changed: true, critical: true, flakiness: 70), Now);

        // The property that makes this worth having instead of a model: the number is the sum
        // of things somebody can disagree with individually.
        priority.Reasons.Sum(r => r.Points)
            .Should().BeGreaterOrEqualTo(priority.Score);
        priority.Reasons.Should().OnlyContain(r => !string.IsNullOrWhiteSpace(r.Explanation));
    }

    [Fact]
    public void The_score_is_capped_so_that_everything_wrong_at_once_does_not_run_away()
    {
        TestHistoryModel.Prioritise(
            History(executions: 0, lastFailed: true, changed: true, critical: true,
                flakiness: 90), Now)
            .Score.Should().BeLessOrEqualTo(100);
    }

    [Fact]
    public void Reasons_are_listed_with_the_heaviest_first()
    {
        var priority = TestHistoryModel.Prioritise(
            History(changed: true, flakiness: 80, daysSinceRun: 30), Now);

        priority.Reasons.Select(r => r.Points)
            .Should().BeInDescendingOrder();
    }

    // ---- Ordering ------------------------------------------------------------------

    [Fact]
    public void Ordering_is_the_same_every_time_for_the_same_input()
    {
        var histories = new[]
        {
            History("TC-0003", changed: true),
            History("TC-0001", changed: true),
            History("TC-0002", lastFailed: true)
        };

        var first = TestHistoryModel.Order(histories, Now).Select(p => p.Reference).ToList();
        var second = TestHistoryModel.Order(histories, Now).Select(p => p.Reference).ToList();

        // Ties break on the reference rather than on whatever order the database returned.
        // A selector that shuffles its own output cannot be compared between runs, and
        // comparing between runs is most of what this is for.
        first.Should().Equal(second);
        first.Should().Equal("TC-0001", "TC-0003", "TC-0002");
    }

    [Fact]
    public void The_most_urgent_test_comes_first()
    {
        var histories = new[]
        {
            History("TC-0001"),
            History("TC-0002", changed: true, lastFailed: true, critical: true),
            History("TC-0003", lastFailed: true)
        };

        TestHistoryModel.Order(histories, Now).First().Reference.Should().Be("TC-0002");
    }
}
