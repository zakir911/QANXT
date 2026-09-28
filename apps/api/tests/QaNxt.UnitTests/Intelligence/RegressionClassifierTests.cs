using QaNxt.Application.Intelligence;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Intelligence;

/// <summary>"Failed" is not actionable on its own. A test failing for the first time today
/// and one failing for three weeks need different responses, and a test that alternates
/// needs fixing before either verdict is worth reading. These assert that the classifier
/// makes those distinctions — and, more importantly, that it never makes a failure look
/// like something safe to ignore.</summary>
public class RegressionClassifierTests
{
    private static IReadOnlyList<VerdictPoint> History(string pattern, string? flaky = null)
    {
        // Newest first. 'P' passed, 'F' failed; the optional second string marks which of
        // those the platform had labelled flaky.
        var at = DateTimeOffset.UtcNow;
        return pattern.Select((c, index) => new VerdictPoint(
            c == 'P',
            flaky is not null && index < flaky.Length && flaky[index] == 'Y',
            at.AddHours(-index))).ToList();
    }

    [Fact]
    public void A_first_failure_after_a_stable_run_of_passes_is_a_regression()
    {
        var verdict = RegressionClassifier.Classify(History("FPPPPP"));

        verdict.Kind.Should().Be(RegressionKind.Regressed);
        verdict.Explanation.Should().Contain("Something changed");
        verdict.Streak.Should().Be(1);
    }

    [Fact]
    public void A_long_standing_failure_is_chronic_rather_than_news()
    {
        var verdict = RegressionClassifier.Classify(History("FFFFFFPP"));

        verdict.Kind.Should().Be(RegressionKind.Chronic);
        verdict.Explanation.Should().Contain("known failure");
        verdict.Streak.Should().Be(6);
    }

    [Fact]
    public void A_test_that_alternates_is_reported_as_unstable()
    {
        var verdict = RegressionClassifier.Classify(History("PFPFPF"));

        verdict.Kind.Should().Be(RegressionKind.Unstable);
        verdict.InstabilityPercent.Should().BeGreaterThan(RegressionClassifier.UnstableThreshold);
    }

    [Fact]
    public void An_unstable_test_that_is_currently_failing_is_still_not_called_passing()
    {
        // The rule the whole platform is built on: nothing may turn a failure into a pass.
        var verdict = RegressionClassifier.Classify(History("FPFPFP"));

        verdict.Kind.Should().Be(RegressionKind.Unstable);
        verdict.Kind.Should().NotBe(RegressionKind.Stable);
        verdict.Explanation.Should().Contain("Fix the test");
    }

    [Fact]
    public void A_pass_after_failures_is_reported_as_a_recovery()
    {
        var verdict = RegressionClassifier.Classify(History("PFFPPP"));

        verdict.Kind.Should().Be(RegressionKind.Recovered);
        verdict.Explanation.Should().Contain("Passing again");
    }

    [Fact]
    public void A_consistently_passing_test_is_stable()
    {
        var verdict = RegressionClassifier.Classify(History("PPPPPP"));

        verdict.Kind.Should().Be(RegressionKind.Stable);
        verdict.Streak.Should().Be(6);
    }

    [Fact]
    public void Too_little_history_is_admitted_rather_than_guessed_at()
    {
        var verdict = RegressionClassifier.Classify(History("FP"));

        verdict.Kind.Should().Be(RegressionKind.Unknown);
        verdict.Explanation.Should().Contain("too few");
    }

    [Fact]
    public void A_test_that_never_ran_says_so()
    {
        var verdict = RegressionClassifier.Classify(Array.Empty<VerdictPoint>());

        verdict.Kind.Should().Be(RegressionKind.Unknown);
        verdict.Explanation.Should().Contain("never run");
    }

    [Fact]
    public void Repeated_flaky_labels_mark_a_test_unstable_even_when_verdicts_agree()
    {
        // The platform only ever labels a *pass* flaky, so a run of passes can still be
        // untrustworthy; the churn calculation alone would miss that.
        var verdict = RegressionClassifier.Classify(History("PPPPPP", flaky: "YYNNNN"));

        verdict.Kind.Should().Be(RegressionKind.Unstable);
    }

    [Fact]
    public void A_failure_with_no_stable_history_behind_it_is_not_called_a_regression()
    {
        // Nothing regressed: it was never reliably passing.
        var verdict = RegressionClassifier.Classify(History("FFPFF"));

        verdict.Kind.Should().NotBe(RegressionKind.Regressed);
    }

    [Fact]
    public void Confidence_never_claims_certainty()
    {
        var short_ = RegressionClassifier.Classify(History("FPPP"));
        var long_ = RegressionClassifier.Classify(History("FPPPPPPPPPPP"));

        long_.Confidence.Should().BeGreaterThan(short_.Confidence);
        long_.Confidence.Should().BeLessThanOrEqualTo(95);
    }

    [Fact]
    public void Classification_is_deterministic()
    {
        var history = History("FPPPPP");

        var first = RegressionClassifier.Classify(history);
        var second = RegressionClassifier.Classify(history);

        second.Kind.Should().Be(first.Kind);
        second.Confidence.Should().Be(first.Confidence);
        second.Explanation.Should().Be(first.Explanation);
    }
}
