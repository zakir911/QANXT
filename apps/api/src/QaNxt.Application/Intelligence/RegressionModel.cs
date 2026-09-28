namespace QaNxt.Application.Intelligence;

/// <summary>How a test's verdict has moved. Named from the point of view of someone
/// deciding what to look at first.</summary>
public enum RegressionKind
{
    /// <summary>Passing now and passing before. Nothing to do.</summary>
    Stable = 0,
    /// <summary>Failing now, and it was reliably passing before. The most actionable
    /// signal the platform has: something changed, and this caught it.</summary>
    Regressed = 1,
    /// <summary>Failing now and failing for a while. Already known; not news.</summary>
    Chronic = 2,
    /// <summary>Changing verdict without the code changing. Its results are not evidence.</summary>
    Unstable = 3,
    /// <summary>Failing before, passing now. Worth saying so — a fix landed.</summary>
    Recovered = 4,
    /// <summary>Not enough history to say anything honest.</summary>
    Unknown = 5
}

/// <summary>One verdict in a test's history, newest first when passed to the classifier.</summary>
public sealed record VerdictPoint(bool Passed, bool WasFlaky, DateTimeOffset At);

public sealed record RegressionVerdict(
    RegressionKind Kind,
    int Confidence,
    string Explanation)
{
    /// <summary>How many consecutive runs the current verdict has held.</summary>
    public int Streak { get; init; }
    /// <summary>Verdict changes across the window, as a percentage of the transitions
    /// possible. High means the test is telling you nothing.</summary>
    public int InstabilityPercent { get; init; }
}

/// <summary>Decides what a test's recent history means.
///
/// This exists because "failed" is not actionable on its own. A test that has failed for
/// three weeks and a test that failed for the first time this morning need completely
/// different responses, and a test that alternates needs to be fixed before either of its
/// verdicts is worth reading. The platform already refuses to hide a failure behind a
/// "flaky" label; this is the other half — telling a team which failures are new.
///
/// Deliberately conservative: with too little history it says so rather than guessing, and
/// it never downgrades a failure into something ignorable.</summary>
public static class RegressionClassifier
{
    /// <summary>Below this, history cannot distinguish a regression from noise.</summary>
    public const int MinimumHistory = 3;
    /// <summary>A failure this deep into a run of failures is established, not new.</summary>
    public const int ChronicThreshold = 4;
    /// <summary>Verdict churn at or above this makes a result untrustworthy.</summary>
    public const int UnstableThreshold = 40;
    /// <summary>Churn alone is not instability. A test that broke once and was fixed has
    /// two verdict changes and is behaving exactly as it should — calling that unstable
    /// would label every normal break-and-fix cycle untrustworthy, and a platform that
    /// cries wolf gets ignored. Instability means more than one cycle.</summary>
    public const int MinimumChangesForInstability = 3;

    /// <summary>History newest first. The first entry is the current verdict.</summary>
    public static RegressionVerdict Classify(IReadOnlyList<VerdictPoint> history)
    {
        if (history.Count == 0)
        {
            return new RegressionVerdict(RegressionKind.Unknown, 100,
                "This test has never run, so there is nothing to compare against.");
        }

        var current = history[0];
        var streak = StreakOf(history);
        var churn = InstabilityPercent(history);

        if (history.Count < MinimumHistory)
        {
            return new RegressionVerdict(RegressionKind.Unknown, 60,
                $"Only {history.Count} run(s) of history: too few to tell a regression from noise.")
            {
                Streak = streak,
                InstabilityPercent = churn
            };
        }

        // Instability is checked before anything else, because on an unstable test every
        // other reading is drawn from noise. It never turns a failure into a pass — an
        // unstable failing test is still a failing test, it is just also untrustworthy.
        var changes = VerdictChanges(history);
        if ((churn >= UnstableThreshold && changes >= MinimumChangesForInstability)
            || history.Count(p => p.WasFlaky) >= 2)
        {
            return new RegressionVerdict(RegressionKind.Unstable,
                Math.Min(95, 50 + churn),
                $"This test changed verdict across {churn}% of its last {history.Count} runs "
                + "without the code changing. Fix the test before reading its result.")
            {
                Streak = streak,
                InstabilityPercent = churn
            };
        }

        if (current.Passed)
        {
            var previouslyFailing = history.Skip(1).TakeWhile(p => !p.Passed).Count();
            if (previouslyFailing > 0)
            {
                return new RegressionVerdict(RegressionKind.Recovered,
                    ConfidenceFrom(history.Count, previouslyFailing),
                    $"Passing again after {previouslyFailing} failing run(s).")
                {
                    Streak = streak,
                    InstabilityPercent = churn
                };
            }

            return new RegressionVerdict(RegressionKind.Stable,
                ConfidenceFrom(history.Count, streak),
                $"Passing, and has passed for the last {streak} run(s).")
            {
                Streak = streak,
                InstabilityPercent = churn
            };
        }

        if (streak >= ChronicThreshold)
        {
            return new RegressionVerdict(RegressionKind.Chronic,
                ConfidenceFrom(history.Count, streak),
                $"Failing for {streak} consecutive runs. This is a known failure, not a new one.")
            {
                Streak = streak,
                InstabilityPercent = churn
            };
        }

        var priorPasses = history.Skip(streak).TakeWhile(p => p.Passed).Count();
        if (priorPasses >= 2)
        {
            return new RegressionVerdict(RegressionKind.Regressed,
                ConfidenceFrom(history.Count, priorPasses),
                $"Failing for the last {streak} run(s) after {priorPasses} consecutive passes. "
                + "Something changed.")
            {
                Streak = streak,
                InstabilityPercent = churn
            };
        }

        return new RegressionVerdict(RegressionKind.Chronic, 55,
            $"Failing, with no stable run of passes before it to regress from.")
        {
            Streak = streak,
            InstabilityPercent = churn
        };
    }

    /// <summary>How many runs the newest verdict has held.</summary>
    private static int StreakOf(IReadOnlyList<VerdictPoint> history)
    {
        var passed = history[0].Passed;
        var streak = 0;
        foreach (var point in history)
        {
            if (point.Passed != passed) break;
            streak++;
        }
        return streak;
    }

    /// <summary>Verdict changes as a percentage of the changes that could have happened.</summary>
    private static int InstabilityPercent(IReadOnlyList<VerdictPoint> history)
    {
        if (history.Count < 2) return 0;
        return (int)Math.Round(VerdictChanges(history) * 100.0 / (history.Count - 1));
    }

    /// <summary>How many times the verdict flipped across the window.</summary>
    private static int VerdictChanges(IReadOnlyList<VerdictPoint> history)
    {
        var changes = 0;
        for (var index = 1; index < history.Count; index++)
        {
            if (history[index].Passed != history[index - 1].Passed) changes++;
        }
        return changes;
    }

    /// <summary>More history and a longer run both make the reading more trustworthy. Never
    /// reaches certainty: this is an inference from a sample, not a measurement.</summary>
    private static int ConfidenceFrom(int historyCount, int supporting) =>
        Math.Clamp(45 + historyCount * 4 + supporting * 5, 45, 95);
}
