using Aira.Domain.Enums;

namespace Aira.Application.Quality;

/// <summary>What a change was found to affect.</summary>
public sealed record ImpactSet(
    IReadOnlySet<string> Routes,
    IReadOnlySet<string> ApiPaths,
    IReadOnlySet<string> Tags,
    IReadOnlySet<string> TestReferences,
    bool Everything)
{
    public static readonly ImpactSet Empty = new(
        new HashSet<string>(StringComparer.OrdinalIgnoreCase),
        new HashSet<string>(StringComparer.OrdinalIgnoreCase),
        new HashSet<string>(StringComparer.OrdinalIgnoreCase),
        new HashSet<string>(StringComparer.OrdinalIgnoreCase),
        Everything: false);

    public bool IsEmpty => !Everything && Routes.Count == 0 && ApiPaths.Count == 0
        && Tags.Count == 0 && TestReferences.Count == 0;
}

/// <summary>Everything the scorer needs to know about one candidate test, gathered from
/// what is already stored about it.</summary>
public sealed record RegressionCandidate(
    Guid TestCaseId,
    string Reference,
    string Name,
    TestCaseKind Kind,
    TestPriority Priority,
    RiskLevel Risk,
    IReadOnlyList<string> Tags,
    /// <summary>Page routes this test visits, from its steps' URLs.</summary>
    IReadOnlyList<string> Routes,
    /// <summary>API paths this test calls, from its steps' request descriptions.</summary>
    IReadOnlyList<string> ApiPaths,
    int ExecutionCount,
    int FailCount,
    int FlakinessScore,
    ExecutionStatus? LastStatus,
    DateTimeOffset? LastExecutedAt);

/// <summary>One component of a test's score, with the reason it contributed.</summary>
public sealed record ScoreComponent(string Name, int Points, int Maximum, string Reason);

public sealed record ScoredTest(
    Guid TestCaseId,
    string Reference,
    string Name,
    TestCaseKind Kind,
    TestPriority Priority,
    RiskLevel Risk,
    int Score,
    IReadOnlyList<ScoreComponent> Components,
    IReadOnlyList<string> Reasons,
    bool IsImpacted);

/// <summary>Scores tests for a regression run, and shows its working.
///
/// The score is the product's answer to "why did you run these and not those?", and a
/// number without that answer is worse than no number: a team that cannot see why a test
/// was skipped has no way to tell a good selection from a broken one, and will eventually
/// find out the expensive way.
///
/// So every component is capped, named, and carries the sentence that earned it. The
/// weights are ordinary judgements, stated here rather than buried:
///
///  - <b>Impact, 40</b> — whether the change reaches this test at all. The largest, because
///    it is the only component that is about this change rather than about this test.
///  - <b>Risk, 20</b> — what it costs to be wrong about this area.
///  - <b>History, 20</b> — a test that has been failing or flaking recently is worth
///    running again. Instability is information, not noise.
///  - <b>Staleness, 10</b> — a test nobody has run for a fortnight is the one most likely
///    to have quietly rotted.
///  - <b>Always, 10</b> — a project's smoke set runs whatever changed.
///
/// Nothing here is learned or tuned. A selector whose weights drift on its own cannot be
/// reproduced, and a release decision that cannot be reproduced is not a decision.</summary>
public static class RegressionScoring
{
    public const int ImpactWeight = 40;
    public const int RiskWeight = 20;
    public const int HistoryWeight = 20;
    public const int StalenessWeight = 10;
    public const int AlwaysWeight = 10;

    /// <summary>Tags a project always runs, whatever changed.</summary>
    public static readonly IReadOnlySet<string> AlwaysRunTags =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "smoke", "critical", "always" };

    /// <summary>How long a test may go unrun before staleness scores at all.</summary>
    public static readonly TimeSpan StalenessFloor = TimeSpan.FromDays(1);
    /// <summary>And when it scores the maximum.</summary>
    public static readonly TimeSpan StalenessCeiling = TimeSpan.FromDays(14);

    public static ScoredTest Score(RegressionCandidate test, ImpactSet impact, DateTimeOffset now)
    {
        var components = new List<ScoreComponent>
        {
            ImpactOf(test, impact),
            RiskOf(test),
            HistoryOf(test),
            StalenessOf(test, now),
            AlwaysOf(test)
        };

        var score = Math.Clamp(components.Sum(c => c.Points), 0, 100);
        var impactComponent = components[0];

        // Reasons are the components that actually contributed. A list that includes
        // "history: 0, this test has never failed" is noise dressed as transparency.
        var reasons = components
            .Where(c => c.Points > 0)
            .Select(c => c.Reason)
            .ToList();

        if (reasons.Count == 0)
        {
            reasons.Add("Nothing about this change or this test's history argues for running it.");
        }

        return new ScoredTest(
            test.TestCaseId, test.Reference, test.Name, test.Kind, test.Priority, test.Risk,
            score, components, reasons, IsImpacted: impactComponent.Points > 0);
    }

    /// <summary>Whether the change reaches this test, and how directly.</summary>
    private static ScoreComponent ImpactOf(RegressionCandidate test, ImpactSet impact)
    {
        if (impact.Everything)
        {
            return new ScoreComponent("impact", ImpactWeight, ImpactWeight,
                "The change touches shared code, so every test is in scope.");
        }

        if (impact.TestReferences.Contains(test.Reference))
        {
            return new ScoreComponent("impact", ImpactWeight, ImpactWeight,
                $"A rule names {test.Reference} directly.");
        }

        var matchedRoutes = test.Routes.Where(impact.Routes.Contains).Distinct().ToList();
        var matchedApis = test.ApiPaths.Where(path => MatchesAny(path, impact.ApiPaths)).Distinct().ToList();

        if (matchedRoutes.Count > 0 || matchedApis.Count > 0)
        {
            var what = string.Join(", ", matchedRoutes.Concat(matchedApis).Take(4));
            return new ScoreComponent("impact", ImpactWeight, ImpactWeight,
                $"This test exercises {what}, which the change affects.");
        }

        var matchedTags = test.Tags.Where(impact.Tags.Contains).ToList();
        if (matchedTags.Count > 0)
        {
            // A tag is a weaker statement than a route: it says the team associates this
            // test with the area, not that the test goes there.
            return new ScoreComponent("impact", ImpactWeight * 3 / 4, ImpactWeight,
                $"This test is tagged {string.Join(", ", matchedTags)}, which the change affects.");
        }

        return new ScoreComponent("impact", 0, ImpactWeight,
            "The change does not reach anything this test exercises.");
    }

    private static ScoreComponent RiskOf(RegressionCandidate test)
    {
        var points = (test.Priority, test.Risk) switch
        {
            (TestPriority.Critical, _) or (_, RiskLevel.Critical) => RiskWeight,
            (TestPriority.High, _) or (_, RiskLevel.High) => RiskWeight * 3 / 4,
            (TestPriority.Medium, _) or (_, RiskLevel.Medium) => RiskWeight / 2,
            _ => RiskWeight / 4
        };

        return new ScoreComponent("risk", points, RiskWeight,
            $"Priority {Lower(test.Priority)}, risk {Lower(test.Risk)}.");
    }

    /// <summary>What this test's recent behaviour argues.</summary>
    private static ScoreComponent HistoryOf(RegressionCandidate test)
    {
        if (test.ExecutionCount == 0)
        {
            // Never run is not "clean". A test nobody has executed is the one whose
            // behaviour is least known.
            return new ScoreComponent("history", HistoryWeight / 2, HistoryWeight,
                "This test has never run, so nothing is known about it.");
        }

        var failureRate = test.FailCount * 100 / Math.Max(1, test.ExecutionCount);
        var lastFailed = test.LastStatus is ExecutionStatus.Failed or ExecutionStatus.Error
            or ExecutionStatus.TimedOut;

        var points = 0;
        var reasons = new List<string>();

        if (lastFailed)
        {
            points += HistoryWeight / 2;
            reasons.Add("it failed last time it ran");
        }

        if (test.FlakinessScore >= 20)
        {
            points += HistoryWeight / 4;
            reasons.Add($"its results are unstable ({test.FlakinessScore}/100)");
        }

        if (failureRate >= 20)
        {
            points += HistoryWeight / 4;
            reasons.Add($"it has failed {failureRate}% of its {test.ExecutionCount} run(s)");
        }

        points = Math.Min(points, HistoryWeight);

        return new ScoreComponent("history", points, HistoryWeight,
            reasons.Count > 0
                ? $"Recent behaviour: {string.Join("; ", reasons)}."
                : $"Stable: {test.ExecutionCount} run(s), {failureRate}% failed.");
    }

    private static ScoreComponent StalenessOf(RegressionCandidate test, DateTimeOffset now)
    {
        if (test.LastExecutedAt is null)
        {
            return new ScoreComponent("staleness", StalenessWeight, StalenessWeight,
                "It has never been run.");
        }

        var age = now - test.LastExecutedAt.Value;
        if (age <= StalenessFloor)
        {
            return new ScoreComponent("staleness", 0, StalenessWeight,
                $"Last run {Describe(age)} ago.");
        }

        var span = StalenessCeiling - StalenessFloor;
        var beyond = age - StalenessFloor;
        var points = (int)Math.Round(StalenessWeight * Math.Min(1.0, beyond.TotalSeconds / span.TotalSeconds));

        return new ScoreComponent("staleness", points, StalenessWeight,
            $"Last run {Describe(age)} ago.");
    }

    private static ScoreComponent AlwaysOf(RegressionCandidate test)
    {
        var matched = test.Tags.Where(AlwaysRunTags.Contains).ToList();
        return matched.Count > 0
            ? new ScoreComponent("always", AlwaysWeight, AlwaysWeight,
                $"Tagged {string.Join(", ", matched)}, which this project always runs.")
            : new ScoreComponent("always", 0, AlwaysWeight, "Not part of the always-run set.");
    }

    /// <summary>Matches a path a test calls against the affected paths, allowing an affected
    /// template to cover the concrete paths under it.</summary>
    private static bool MatchesAny(string path, IReadOnlySet<string> affected)
    {
        if (affected.Contains(path)) return true;

        foreach (var candidate in affected)
        {
            if (TemplateCovers(candidate, path)) return true;
        }
        return false;
    }

    /// <summary>True when <paramref name="template"/> — which may contain
    /// <c>{placeholders}</c> — describes <paramref name="path"/>.</summary>
    public static bool TemplateCovers(string template, string path)
    {
        var templateSegments = template.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var pathSegments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (templateSegments.Length != pathSegments.Length) return false;

        for (var index = 0; index < templateSegments.Length; index++)
        {
            var segment = templateSegments[index];
            if (segment.StartsWith('{') && segment.EndsWith('}')) continue;
            if (!string.Equals(segment, pathSegments[index], StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }

    private static string Lower<T>(T value) where T : notnull =>
        value.ToString()!.ToLowerInvariant();

    private static string Describe(TimeSpan age) => age.TotalDays >= 1
        ? $"{(int)age.TotalDays} day(s)"
        : age.TotalHours >= 1
            ? $"{(int)age.TotalHours} hour(s)"
            : $"{Math.Max(1, (int)age.TotalMinutes)} minute(s)";
}

/// <summary>Matches a repository path against a glob.
///
/// Small on purpose: <c>*</c> matches within one segment, <c>**</c> crosses them, <c>?</c>
/// matches one character. A team writing <c>src/pages/accounts/**</c> should get what they
/// expect without reading a specification, and a pattern language rich enough to surprise
/// them would be a liability in something that decides which tests to skip.</summary>
public static class PathGlob
{
    public static bool Matches(string pattern, string path)
    {
        if (string.IsNullOrWhiteSpace(pattern)) return false;

        var normalizedPath = path.Replace('\\', '/').TrimStart('.', '/');
        var normalizedPattern = pattern.Replace('\\', '/').TrimStart('.', '/');

        var regex = "^" + string.Concat(Translate(normalizedPattern)) + "$";
        return System.Text.RegularExpressions.Regex.IsMatch(
            normalizedPath, regex,
            System.Text.RegularExpressions.RegexOptions.IgnoreCase,
            TimeSpan.FromMilliseconds(250));
    }

    private static IEnumerable<string> Translate(string pattern)
    {
        for (var index = 0; index < pattern.Length; index++)
        {
            var character = pattern[index];
            if (character == '*')
            {
                if (index + 1 < pattern.Length && pattern[index + 1] == '*')
                {
                    index++;
                    // `**/` should also match nothing at all, so `src/**/x.ts` covers
                    // `src/x.ts` as well as `src/a/b/x.ts`.
                    if (index + 1 < pattern.Length && pattern[index + 1] == '/')
                    {
                        index++;
                        yield return "(?:.*/)?";
                        continue;
                    }
                    yield return ".*";
                    continue;
                }
                yield return "[^/]*";
                continue;
            }
            if (character == '?') { yield return "[^/]"; continue; }
            yield return System.Text.RegularExpressions.Regex.Escape(character.ToString());
        }
    }
}
