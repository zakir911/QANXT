namespace QaNxt.Application.Agent;

/// <summary>What is known about one test's past.</summary>
public sealed record TestHistory(
    Guid TestCaseId,
    string Reference,
    int ExecutionCount,
    int FailCount,
    /// <summary>0-100, as the ingest pipeline computed it. Not recomputed here: one
    /// definition of unstable, in the one place that sees every execution.</summary>
    int FlakinessScore,
    DateTimeOffset? LastExecutedAt,
    bool LastFailed,
    /// <summary>Whether a change in this build touches what this test covers.</summary>
    bool TouchedByChange,
    /// <summary>Whether a person called this area business-critical.</summary>
    bool BusinessCritical);

/// <summary>One reason a test is where it is in the order.</summary>
public sealed record PriorityReason(string Name, int Points, string Explanation);

public sealed record TestPriority(
    Guid TestCaseId,
    string Reference,
    int Score,
    IReadOnlyList<PriorityReason> Reasons,
    string Summary);

/// <summary>
/// Which tests are worth running first, from what has happened to them before.
/// </summary>
/// <remarks>
/// <para>
/// Explainable rules with fixed weights, not a learned model. The brief asks for that
/// explicitly and it is the right call anyway: a priority nobody can argue with is a priority
/// nobody trusts, and the moment somebody disagrees with an order they need to be able to see
/// which rule produced it rather than be told the model felt strongly.
/// </para>
/// <para>
/// The weights below are ordinary judgement and are meant to be argued with. What is not
/// negotiable is that every point is attributed: a score with unattributed points is a number
/// with a decimal place, which is what this exists instead of.
/// </para>
/// </remarks>
public static class TestHistoryModel
{
    /// <summary>What each signal can contribute. They sum past 100 on purpose — a test that
    /// is failing, unstable, freshly changed and business-critical should saturate.</summary>
    private const int ChangedPoints = 40;
    private const int FailingPoints = 30;
    private const int CriticalPoints = 25;
    private const int UnstablePoints = 15;
    private const int NeverRunPoints = 20;
    private const int StalePoints = 10;

    /// <summary>A test not run in this long is worth re-running for its own sake.</summary>
    public const int StaleAfterDays = 14;

    public static TestPriority Prioritise(TestHistory history, DateTimeOffset now)
    {
        var reasons = new List<PriorityReason>();

        if (history.TouchedByChange)
            reasons.Add(new PriorityReason("changed", ChangedPoints,
                "A change in this build touches what this test covers."));

        if (history.LastFailed)
            reasons.Add(new PriorityReason("failing", FailingPoints,
                "It failed the last time it ran. Re-running it is how a fix is confirmed and "
                + "how a flake is told from a defect."));
        else if (history.FailCount > 0 && history.ExecutionCount > 0)
        {
            // Past failures matter less than a current one, and the rate matters more than the
            // count: a test that has run a thousand times and failed twice is not a problem.
            var rate = history.FailCount * 100 / history.ExecutionCount;
            if (rate >= 20)
                reasons.Add(new PriorityReason("fails often", FailingPoints / 2,
                    $"It has failed {history.FailCount} of {history.ExecutionCount} run(s) "
                    + $"({rate}%), which is often enough to expect it again."));
        }

        if (history.BusinessCritical)
            reasons.Add(new PriorityReason("business-critical", CriticalPoints,
                "A person named this area as one the business would stop trading over."));

        if (history.FlakinessScore >= 50)
            reasons.Add(new PriorityReason("unstable", UnstablePoints,
                $"Its verdict has been changing ({history.FlakinessScore}/100). Running it "
                + "again is the cheapest way to find out whether it still is."));

        if (history.ExecutionCount == 0)
            reasons.Add(new PriorityReason("never run", NeverRunPoints,
                "It has never run, so nothing is known about what it establishes. A test that "
                + "has never executed is not coverage."));
        else if (history.LastExecutedAt is { } last && (now - last).TotalDays >= StaleAfterDays)
            reasons.Add(new PriorityReason("stale", StalePoints,
                $"It has not run for {(int)(now - last).TotalDays} day(s). What it last "
                + "established may no longer be true."));

        var score = Math.Clamp(reasons.Sum(r => r.Points), 0, 100);

        return new TestPriority(history.TestCaseId, history.Reference, score,
            reasons.OrderByDescending(r => r.Points).ToList(),
            Summarise(history, score, reasons));
    }

    /// <summary>
    /// Orders a set of tests, highest priority first.
    /// </summary>
    /// <remarks>
    /// Ties break on the reference rather than on whatever order the database returned, so two
    /// runs over the same data produce the same order. A selector that shuffles its own output
    /// cannot be compared between runs, and comparing between runs is most of what this is for.
    /// </remarks>
    public static IReadOnlyList<TestPriority> Order(
        IReadOnlyList<TestHistory> histories, DateTimeOffset now)
        => histories
            .Select(h => Prioritise(h, now))
            .OrderByDescending(p => p.Score)
            .ThenBy(p => p.Reference, StringComparer.Ordinal)
            .ToList();

    private static string Summarise(
        TestHistory history, int score, IReadOnlyList<PriorityReason> reasons)
    {
        if (reasons.Count == 0)
            return $"{history.Reference}: nothing about its history raises or lowers it. "
                 + "It runs in the ordinary order.";

        return $"{history.Reference} scores {score}: "
             + string.Join("; ", reasons.OrderByDescending(r => r.Points).Select(r => r.Name))
             + ".";
    }
}
