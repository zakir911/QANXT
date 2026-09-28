using System.Text.RegularExpressions;

namespace QaNxt.Application.Agent;

/// <summary>What to do with a candidate test.</summary>
public enum DuplicationVerdict
{
    /// <summary>Nothing like it exists. Write it.</summary>
    Generate = 0,
    /// <summary>Something covers the same intent against the same target. Use that.</summary>
    Reuse = 1,
    /// <summary>Something covers the target but asserts less. Add the missing assertions.</summary>
    Extend = 2
}

/// <summary>A test that already exists, reduced to what matters for comparison.</summary>
public sealed record ExistingTest(
    Guid Id,
    string Reference,
    string Name,
    string Objective,
    /// <summary>The page, endpoint or journey it exercises.</summary>
    string Target,
    TestDimension Dimension,
    /// <summary>What it checks, as stable identifiers rather than prose.</summary>
    IReadOnlyList<string> Assertions);

/// <summary>A test the agent is considering writing.</summary>
public sealed record CandidateTest(
    string Name,
    string Objective,
    string Target,
    TestDimension Dimension,
    IReadOnlyList<string> Assertions);

public sealed record DuplicationDecision(
    DuplicationVerdict Verdict,
    /// <summary>The test that made this the answer, if one did.</summary>
    Guid? ExistingTestId,
    string? ExistingReference,
    string Reason,
    /// <summary>0-100. How alike the candidate and the match are.</summary>
    int Similarity,
    /// <summary>For Extend: what the existing test does not check.</summary>
    IReadOnlyList<string> MissingAssertions);

/// <summary>
/// Whether a test already exists, before one is written.
/// </summary>
/// <remarks>
/// <para>
/// The failure this prevents is specific and common: a generator asked twice for the same
/// thing produces two tests with different wording, both are kept, and a suite quietly doubles
/// in size while covering nothing new. Running the same check twice is not more coverage. It
/// is the same coverage and twice the maintenance, and it makes a coverage number go up while
/// the thing it measures does not.
/// </para>
/// <para>
/// Comparison is deliberately structural rather than semantic. Target and dimension must match
/// exactly; the objective is compared as a bag of significant words. A model could judge
/// "these two tests mean the same thing" more cleverly and would sometimes be wrong in a
/// direction nobody could audit — a test silently not written because something judged it a
/// duplicate is a coverage gap with no record. Deterministic and occasionally over-cautious is
/// the right trade here: the worst case is one redundant test, which a person can see and
/// delete.
/// </para>
/// </remarks>
public static class TestDuplicationModel
{
    /// <summary>At or above this, the candidate is the same test.</summary>
    public const int SameIntentThreshold = 70;

    /// <summary>Words that carry no signal about what a test is for.</summary>
    private static readonly HashSet<string> Noise = new(StringComparer.OrdinalIgnoreCase)
    {
        "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "that", "this",
        "is", "are", "be", "should", "must", "can", "will", "when", "then", "given", "it",
        "test", "tests", "testing", "verify", "verifies", "check", "checks", "ensure", "ensures",
        "validate", "validates", "user", "users"
    };

    public static DuplicationDecision Evaluate(
        CandidateTest candidate, IReadOnlyList<ExistingTest> existing)
    {
        // Same target, same dimension. A UI test and an API test against /payments are not
        // duplicates of each other however similarly they are worded — they establish
        // different things and one passing says nothing about the other.
        var comparable = existing
            .Where(e => e.Dimension == candidate.Dimension
                        && string.Equals(Normalise(e.Target), Normalise(candidate.Target),
                                         StringComparison.Ordinal))
            .ToList();

        if (comparable.Count == 0)
            return new DuplicationDecision(DuplicationVerdict.Generate, null, null,
                $"No existing {candidate.Dimension} test targets {candidate.Target}.",
                0, Array.Empty<string>());

        var best = comparable
            .Select(e => (Test: e, Score: IntentSimilarity(candidate, e)))
            .OrderByDescending(x => x.Score)
            .First();

        if (best.Score < SameIntentThreshold)
            return new DuplicationDecision(DuplicationVerdict.Generate, null, null,
                $"{comparable.Count} test(s) target {candidate.Target}, but none of them is "
                + $"about the same thing (closest: {best.Test.Reference} at {best.Score}%).",
                best.Score, Array.Empty<string>());

        var missing = candidate.Assertions
            .Where(a => !best.Test.Assertions.Contains(a, StringComparer.OrdinalIgnoreCase))
            .ToList();

        if (missing.Count == 0)
            return new DuplicationDecision(DuplicationVerdict.Reuse,
                best.Test.Id, best.Test.Reference,
                $"{best.Test.Reference} already covers this: same target, same intent "
                + $"({best.Score}%), and it checks everything the candidate would.",
                best.Score, Array.Empty<string>());

        // The interesting middle. Same test, weaker assertions — so the coverage that is
        // missing is real, and writing a second near-identical test is the wrong way to add it.
        return new DuplicationDecision(DuplicationVerdict.Extend,
            best.Test.Id, best.Test.Reference,
            $"{best.Test.Reference} covers this target with the same intent ({best.Score}%) but "
            + $"does not check {missing.Count} thing(s) the candidate would. Adding them to it "
            + "is coverage; writing a second test beside it is duplication.",
            best.Score, missing);
    }

    /// <summary>
    /// How alike two tests are, 0-100, from the significant words in their names and objectives.
    /// </summary>
    /// <remarks>
    /// A Jaccard overlap, which is crude and has the property that matters: it is symmetric,
    /// reproducible, and explainable to somebody who disagrees with the answer.
    /// </remarks>
    public static int IntentSimilarity(CandidateTest candidate, ExistingTest existing)
    {
        var a = Significant($"{candidate.Name} {candidate.Objective}");
        var b = Significant($"{existing.Name} {existing.Objective}");

        if (a.Count == 0 || b.Count == 0) return 0;

        var shared = a.Intersect(b, StringComparer.OrdinalIgnoreCase).Count();
        var union = a.Union(b, StringComparer.OrdinalIgnoreCase).Count();
        return union == 0 ? 0 : (int)Math.Round(shared * 100.0 / union);
    }

    private static HashSet<string> Significant(string text)
        => new(Regex.Split(text.ToLowerInvariant(), @"[^a-z0-9]+")
                .Where(w => w.Length > 2 && !Noise.Contains(w)),
            StringComparer.OrdinalIgnoreCase);

    private static string Normalise(string target)
        => target.Trim().TrimEnd('/').ToLowerInvariant();
}
