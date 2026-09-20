using Aira.Domain.Enums;

namespace Aira.Application.Intelligence;

/// <summary>What is known about one area of an application, gathered from the knowledge
/// graph and from execution history. Kept separate from the database so the scoring itself
/// is a pure function that can be reasoned about and tested directly.</summary>
public sealed record RiskSignals
{
    public required string Route { get; init; }
    public PageKind Kind { get; init; } = PageKind.Unknown;
    public bool RequiresAuthentication { get; init; }

    /// <summary>Inputs, selects and file pickers: places a user changes something.</summary>
    public int InputElementCount { get; init; }
    /// <summary>Buttons and submits: places a change is committed.</summary>
    public int ActionElementCount { get; init; }
    /// <summary>Password, payment or file inputs — the elements whose failure costs most.</summary>
    public int SensitiveInputCount { get; init; }

    /// <summary>Tests that currently exercise this route at all.</summary>
    public int CoveringTestCount { get; init; }
    /// <summary>Assertions across those tests. A test with no assertions proves only that
    /// the steps ran, so coverage is counted by what is actually checked.</summary>
    public int AssertionCount { get; init; }

    public int RecentExecutionCount { get; init; }
    public int RecentFailureCount { get; init; }
    public int RecentFlakyCount { get; init; }
    /// <summary>Failures the analyser attributed to the application with high confidence.</summary>
    public int OpenDefectCount { get; init; }

    public int ConsoleErrorCount { get; init; }
    /// <summary>How many other pages link here: how many journeys pass through it.</summary>
    public int InboundTransitionCount { get; init; }
    public int LoadTimeMs { get; init; }
    /// <summary>Elements whose locators changed since the previous discovery — churn is a
    /// leading indicator that something is being worked on, and therefore breaking.</summary>
    public int ChangedElementCount { get; init; }
}

/// <summary>One reason a score is what it is. A number without these is not actionable:
/// nobody can act on "risk 72".</summary>
public sealed record RiskFactor(string Name, int Points, string Explanation);

public sealed record RiskAssessment(
    string Route,
    int Score,
    RiskLevel Level,
    IReadOnlyList<RiskFactor> Factors,
    string Summary)
{
    /// <summary>The single most useful thing to do about this area next, or null when the
    /// area is already well covered and behaving.</summary>
    public string? Recommendation { get; init; }
}

/// <summary>Scores how much attention an area of an application deserves.
///
/// Deliberately deterministic. A risk number that changes when a model is re-prompted
/// cannot be used to prioritise work, and a team that cannot see why an area scored highly
/// will not act on it — so every point is attributed to a named factor with a sentence
/// explaining it, and the same inputs always produce the same score.
///
/// The weights encode a view worth stating plainly: what a failure costs matters more than
/// how likely it is. An untested payment form scores above a flaky marketing page even
/// though the marketing page fails more often, because the payment form failing is the one
/// that ends up in a newspaper.</summary>
public static class RiskScorer
{
    // The maximum each factor can contribute. They sum to more than 100 on purpose: an area
    // that is bad in every way is capped at 100 rather than being allowed to run away, and
    // an area that is bad in three ways should already be near the top.
    private const int AuthBoundaryMax = 18;
    private const int MutationMax = 20;
    private const int CoverageGapMax = 22;
    private const int FailureHistoryMax = 20;
    private const int InstabilityMax = 10;
    private const int DefectMax = 12;
    private const int ErrorsMax = 8;
    private const int CentralityMax = 8;
    private const int ChurnMax = 10;
    private const int SlownessMax = 5;

    public static RiskAssessment Score(RiskSignals signals)
    {
        var factors = new List<RiskFactor>();

        AddAuthBoundary(signals, factors);
        AddMutationSurface(signals, factors);
        AddCoverageGap(signals, factors);
        AddFailureHistory(signals, factors);
        AddInstability(signals, factors);
        AddDefects(signals, factors);
        AddObservedErrors(signals, factors);
        AddCentrality(signals, factors);
        AddChurn(signals, factors);
        AddSlowness(signals, factors);

        var score = Math.Clamp(factors.Sum(f => f.Points), 0, 100);
        var level = LevelOf(score);

        return new RiskAssessment(
            signals.Route,
            score,
            level,
            // Largest contributor first: that is the one worth reading.
            factors.Where(f => f.Points > 0).OrderByDescending(f => f.Points).ToList(),
            Summarise(signals, score, level, factors))
        {
            Recommendation = Recommend(signals, factors)
        };
    }

    public static RiskLevel LevelOf(int score) => score switch
    {
        >= 70 => RiskLevel.Critical,
        >= 45 => RiskLevel.High,
        >= 20 => RiskLevel.Medium,
        _ => RiskLevel.Low
    };

    private static void AddAuthBoundary(RiskSignals s, List<RiskFactor> factors)
    {
        if (s.Kind == PageKind.Login)
        {
            factors.Add(new RiskFactor("Authentication boundary", AuthBoundaryMax,
                "This is the sign-in page. If it breaks, nobody can reach anything else, so it "
                + "fails closed for every user at once."));
            return;
        }

        if (s.RequiresAuthentication)
        {
            factors.Add(new RiskFactor("Behind authentication", 6,
                "Reaching this page depends on the sign-in flow continuing to work, so it "
                + "inherits that risk as well as its own."));
        }
    }

    private static void AddMutationSurface(RiskSignals s, List<RiskFactor> factors)
    {
        // Reading is recoverable; writing is not. A page that changes state is where a
        // defect turns into a wrong balance rather than a blank screen.
        var points = 0;
        if (s.Kind == PageKind.Form) points += 10;
        points += Math.Min(6, s.InputElementCount);
        points += Math.Min(4, s.ActionElementCount * 2);
        points += Math.Min(8, s.SensitiveInputCount * 4);
        points = Math.Min(MutationMax, points);

        if (points == 0) return;

        var detail = s.SensitiveInputCount > 0
            ? $"{s.InputElementCount} input(s) including {s.SensitiveInputCount} handling credentials, "
              + "payment details or uploads"
            : $"{s.InputElementCount} input(s) and {s.ActionElementCount} action(s)";

        factors.Add(new RiskFactor("Changes data", points,
            $"This page can change state: {detail}. A defect here writes something wrong rather "
            + "than merely displaying something wrong."));
    }

    private static void AddCoverageGap(RiskSignals s, List<RiskFactor> factors)
    {
        if (s.CoveringTestCount == 0)
        {
            factors.Add(new RiskFactor("No test coverage", CoverageGapMax,
                "Nothing tests this route, so there is no evidence it works and no warning when "
                + "it stops."));
            return;
        }

        if (s.AssertionCount == 0)
        {
            factors.Add(new RiskFactor("Coverage without assertions", 14,
                $"{s.CoveringTestCount} test(s) walk this route but assert nothing, so they prove "
                + "the steps completed and not that the result was right."));
            return;
        }

        // Thin coverage of a page with many ways to interact is still a gap.
        var interactive = s.InputElementCount + s.ActionElementCount;
        if (interactive >= 6 && s.AssertionCount < interactive / 3)
        {
            factors.Add(new RiskFactor("Thin coverage", 7,
                $"{s.AssertionCount} assertion(s) cover {interactive} interactive element(s), so "
                + "most of what this page does is unchecked."));
        }
    }

    private static void AddFailureHistory(RiskSignals s, List<RiskFactor> factors)
    {
        if (s.RecentExecutionCount == 0 || s.RecentFailureCount == 0) return;

        var rate = (double)s.RecentFailureCount / s.RecentExecutionCount;
        var points = (int)Math.Round(Math.Min(1.0, rate) * FailureHistoryMax);
        if (points == 0) return;

        factors.Add(new RiskFactor("Recent failures", points,
            $"{s.RecentFailureCount} of the last {s.RecentExecutionCount} execution(s) touching "
            + $"this route failed ({rate:P0})."));
    }

    private static void AddInstability(RiskSignals s, List<RiskFactor> factors)
    {
        if (s.RecentFlakyCount == 0) return;

        var points = Math.Min(InstabilityMax, s.RecentFlakyCount * 3);
        factors.Add(new RiskFactor("Unstable results", points,
            $"{s.RecentFlakyCount} recent execution(s) here changed verdict without the code "
            + "changing, so results from this route are weak evidence either way."));
    }

    private static void AddDefects(RiskSignals s, List<RiskFactor> factors)
    {
        if (s.OpenDefectCount == 0) return;

        var points = Math.Min(DefectMax, s.OpenDefectCount * 6);
        factors.Add(new RiskFactor("Open defects", points,
            $"{s.OpenDefectCount} failure(s) here were attributed to the application itself and "
            + "are still open."));
    }

    private static void AddObservedErrors(RiskSignals s, List<RiskFactor> factors)
    {
        if (s.ConsoleErrorCount == 0) return;

        var points = Math.Min(ErrorsMax, s.ConsoleErrorCount * 2);
        factors.Add(new RiskFactor("Errors in the browser", points,
            $"The page logged {s.ConsoleErrorCount} console error(s) while being explored, which "
            + "is a defect the application is reporting about itself."));
    }

    private static void AddCentrality(RiskSignals s, List<RiskFactor> factors)
    {
        if (s.InboundTransitionCount < 2) return;

        var points = Math.Min(CentralityMax, s.InboundTransitionCount);
        factors.Add(new RiskFactor("Many journeys pass through", points,
            $"{s.InboundTransitionCount} other page(s) lead here, so a failure blocks more than "
            + "one journey."));
    }

    private static void AddChurn(RiskSignals s, List<RiskFactor> factors)
    {
        if (s.ChangedElementCount == 0) return;

        var points = Math.Min(ChurnMax, s.ChangedElementCount);
        factors.Add(new RiskFactor("Recently changed", points,
            $"{s.ChangedElementCount} element(s) here changed since the previous exploration. "
            + "Areas being worked on are the areas that break."));
    }

    private static void AddSlowness(RiskSignals s, List<RiskFactor> factors)
    {
        const int SlowMs = 3000;
        if (s.LoadTimeMs < SlowMs) return;

        var points = Math.Min(SlownessMax, (s.LoadTimeMs - SlowMs) / 1000 + 1);
        factors.Add(new RiskFactor("Slow to load", points,
            $"The page took {s.LoadTimeMs}ms to load, which makes tests here more likely to time "
            + "out and users more likely to give up."));
    }

    private static string Summarise(RiskSignals s, int score, RiskLevel level, List<RiskFactor> factors)
    {
        if (factors.Count == 0 || score == 0)
        {
            return $"{s.Route} shows no risk signals: it is covered, it is passing and nothing about "
                 + "it has changed.";
        }

        var top = factors.OrderByDescending(f => f.Points).Take(2).Select(f => f.Name.ToLowerInvariant());
        return $"{s.Route} scores {score} ({level.ToString().ToLowerInvariant()} risk), mainly "
             + $"because of {string.Join(" and ", top)}.";
    }

    /// <summary>The one action most likely to reduce this score. Ordered by what a person
    /// would actually do first, not by points.</summary>
    private static string? Recommend(RiskSignals s, List<RiskFactor> factors)
    {
        if (s.CoveringTestCount == 0)
            return "Generate a test for this route — it has none.";

        if (s.AssertionCount == 0)
            return "Add assertions to the tests here; they currently prove only that the steps ran.";

        if (s.OpenDefectCount > 0)
            return "Triage the open defects attributed to this route before adding more coverage.";

        if (s.RecentFlakyCount > 0)
            return "Stabilise the unstable tests here; their results cannot be trusted as they are.";

        if (s.ConsoleErrorCount > 0)
            return "Investigate the console errors the application reports on this page.";

        if (factors.Any(f => f.Name == "Thin coverage"))
            return "Extend the assertions here to cover more of what the page does.";

        return null;
    }
}
