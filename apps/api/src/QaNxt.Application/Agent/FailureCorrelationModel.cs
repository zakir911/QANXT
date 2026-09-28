namespace QaNxt.Application.Agent;

/// <summary>One failure, reduced to what matters for grouping.</summary>
public sealed record FailureSignal(
    Guid ExecutionId,
    string TestReference,
    string TestName,
    /// <summary>The page or endpoint the test was on when it failed.</summary>
    string? Route,
    /// <summary>The API call that failed underneath it, if the correlator found one.</summary>
    string? FailingApiCall,
    int? ApiStatusCode,
    /// <summary>What the platform classified this as.</summary>
    string Classification,
    /// <summary>The assertion or error, normalised enough to compare.</summary>
    string Signature,
    DateTimeOffset FailedAt);

public sealed record CorrelatedGroup(
    /// <summary>What the platform believes is the one underlying problem.</summary>
    string PrimaryFailure,
    string Why,
    /// <summary>0-100. Never 100.</summary>
    int Confidence,
    IReadOnlyList<FailureSignal> Members,
    /// <summary>The distinct tests, routes and API calls this touches.</summary>
    IReadOnlyList<string> AffectedTests,
    IReadOnlyList<string> AffectedRoutes,
    IReadOnlyList<string> AffectedApiCalls)
{
    public int Count => Members.Count;
}

public sealed record CorrelationResult(
    IReadOnlyList<CorrelatedGroup> Groups,
    /// <summary>Failures that matched nothing. Listed, never hidden.</summary>
    IReadOnlyList<FailureSignal> Ungrouped,
    string Summary)
{
    public int TotalFailures => Groups.Sum(g => g.Count) + Ungrouped.Count;
}

/// <summary>
/// Grouping failures that share a cause.
/// </summary>
/// <remarks>
/// <para>
/// Seventeen red tests caused by one endpoint returning 500 is one problem, and a list of
/// seventeen is a worse description of it than a list of one with sixteen underneath. But the
/// grouping has to be wrong in only one direction: showing a group is a convenience, and
/// <strong>hiding a failure is a defect nobody finds out about</strong>. So every failure
/// appears somewhere — inside a group or in the ungrouped list — and the count of both
/// together always equals the number of failures that went in.
/// </para>
/// <para>
/// Deterministic, and the rules are ordered from strongest evidence to weakest: a shared
/// failing API call with a server error is a cause; a shared route is a coincidence that
/// might be a cause; a shared assertion signature is a pattern. Each carries a different
/// confidence, and none reaches certainty.
/// </para>
/// </remarks>
public static class FailureCorrelationModel
{
    /// <summary>Below this many members, a group is not worth making.</summary>
    private const int MinimumGroup = 2;

    public static CorrelationResult Correlate(IReadOnlyList<FailureSignal> failures)
    {
        if (failures.Count == 0)
            return new CorrelationResult(
                Array.Empty<CorrelatedGroup>(), Array.Empty<FailureSignal>(),
                "No failures to correlate.");

        var remaining = failures.ToList();
        var groups = new List<CorrelatedGroup>();

        // 1. A shared API call that returned a server error. The strongest signal there is:
        //    the tests did not fail for seventeen reasons, the endpoint did.
        foreach (var group in remaining
                     .Where(f => f.FailingApiCall is not null && f.ApiStatusCode >= 500)
                     .GroupBy(f => f.FailingApiCall!)
                     .Where(g => g.Count() >= MinimumGroup)
                     .ToList())
        {
            var members = group.ToList();
            var status = members.First().ApiStatusCode;
            groups.Add(Build(members,
                $"{group.Key} returned {status}",
                $"{members.Count} failing test(s) each made this call and each got {status}. "
                + "One endpoint failing is a more likely explanation than "
                + $"{members.Count} unrelated defects appearing at once.",
                confidence: 85));
            remaining.RemoveAll(f => members.Contains(f));
        }

        // 2. A shared API call that refused. Weaker: a 401 or 403 across several tests is
        //    usually one broken sign-in, but it can also be several genuinely wrong tests.
        foreach (var group in remaining
                     .Where(f => f.FailingApiCall is not null
                                 && f.ApiStatusCode is 401 or 403)
                     .GroupBy(f => f.FailingApiCall!)
                     .Where(g => g.Count() >= MinimumGroup)
                     .ToList())
        {
            var members = group.ToList();
            groups.Add(Build(members,
                $"{group.Key} refused with {members.First().ApiStatusCode}",
                $"{members.Count} failing test(s) were refused by the same endpoint. That is "
                + "usually one broken session or one changed permission rather than "
                + $"{members.Count} separate authorization defects — but it can be several "
                + "tests that are genuinely wrong, so this is a lead rather than a cause.",
                confidence: 60));
            remaining.RemoveAll(f => members.Contains(f));
        }

        // 3. The same assertion failing the same way across tests.
        foreach (var group in remaining
                     .Where(f => !string.IsNullOrWhiteSpace(f.Signature))
                     .GroupBy(f => f.Signature, StringComparer.OrdinalIgnoreCase)
                     .Where(g => g.Count() >= MinimumGroup)
                     .ToList())
        {
            var members = group.ToList();
            groups.Add(Build(members,
                $"The same check failed in {members.Count} test(s): {Trim(group.Key)}",
                "These failed on the same assertion with the same error. That is a shared "
                + "cause or a shared mistake, and either is worth looking at once rather than "
                + $"{members.Count} times.",
                confidence: 55));
            remaining.RemoveAll(f => members.Contains(f));
        }

        // 4. The same route. Weakest of all — two tests failing on one page may be two
        //    defects — so it is offered at low confidence and never presented as a cause.
        foreach (var group in remaining
                     .Where(f => !string.IsNullOrWhiteSpace(f.Route))
                     .GroupBy(f => f.Route!, StringComparer.OrdinalIgnoreCase)
                     .Where(g => g.Count() >= MinimumGroup)
                     .ToList())
        {
            var members = group.ToList();
            groups.Add(Build(members,
                $"{members.Count} test(s) failed on {group.Key}",
                "They share a page and nothing stronger. This may be one problem on that page "
                + "or it may be several; the grouping is a place to start looking, not a "
                + "conclusion about a cause.",
                confidence: 35));
            remaining.RemoveAll(f => members.Contains(f));
        }

        return new CorrelationResult(
            groups.OrderByDescending(g => g.Confidence).ThenByDescending(g => g.Count).ToList(),
            remaining,
            Summarise(failures.Count, groups, remaining));
    }

    private static CorrelatedGroup Build(
        IReadOnlyList<FailureSignal> members, string primary, string why, int confidence)
        => new(primary, why, confidence, members,
            members.Select(m => m.TestReference).Distinct().OrderBy(r => r).ToList(),
            members.Where(m => m.Route is not null).Select(m => m.Route!)
                .Distinct().OrderBy(r => r).ToList(),
            members.Where(m => m.FailingApiCall is not null).Select(m => m.FailingApiCall!)
                .Distinct().OrderBy(c => c).ToList());

    private static string Trim(string signature)
        => signature.Length <= 120 ? signature : signature[..117] + "…";

    private static string Summarise(
        int total, IReadOnlyList<CorrelatedGroup> groups, IReadOnlyList<FailureSignal> ungrouped)
    {
        if (groups.Count == 0)
            return $"{total} failure(s), none of which share enough to be grouped. They are "
                 + "listed individually because that is what they are.";

        var grouped = groups.Sum(g => g.Count);
        return
            $"{total} failure(s): {grouped} fall into {groups.Count} group(s) that appear to "
            + $"share a cause, and {ungrouped.Count} do not. Every failure is still listed "
            + "individually — a group is a way of reading them, not a way of reducing them.";
    }
}
