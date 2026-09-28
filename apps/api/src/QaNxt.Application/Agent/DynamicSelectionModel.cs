using QaNxt.Domain.Enums;

namespace QaNxt.Application.Agent;

/// <summary>Something the pass observed while it was running.</summary>
public sealed record MidRunObservation(
    string What,
    /// <summary>Where it happened.</summary>
    string Where,
    int? HttpStatus = null,
    string? Detail = null);

/// <summary>A test the pass wants to add because of what it just saw.</summary>
public sealed record DynamicSelection(
    string Reason,
    /// <summary>The observation that triggered it, quoted rather than summarised.</summary>
    MidRunObservation Trigger,
    /// <summary>Which kind of testing this asks for.</summary>
    TestDimension Dimension,
    /// <summary>What to look at.</summary>
    string Target,
    RiskLevel Risk,
    /// <summary>What the pass expects to establish. Stated in advance so a reader can see
    /// whether it did.</summary>
    string Expectation);

/// <summary>
/// Choosing what else to look at, from what the run has already seen.
/// </summary>
/// <remarks>
/// <para>
/// The fixed phase order makes a pass reproducible, and it also makes it blind: a payment
/// endpoint returning 403 halfway through is the most interesting thing that will happen in
/// the run, and a loop that cannot react to it will finish its plan and report the 403 as one
/// failure among many.
/// </para>
/// <para>
/// So evidence can add work — and only add. A dynamic selection never removes anything the
/// plan called for, never widens what the policy permits, and never reaches outside the
/// authorized scope: it produces a request that goes through the same policy gate as
/// everything else, and is refused there if it should be. Reacting to evidence is a reason to
/// do more, never a reason to be allowed more.
/// </para>
/// <para>
/// Every selection records the observation that caused it, verbatim. "Why is this test here"
/// is the question somebody asks about exactly these, because they are the ones nobody asked
/// for.
/// </para>
/// </remarks>
public static class DynamicSelectionModel
{
    public static IReadOnlyList<DynamicSelection> React(
        MidRunObservation observation, bool securityAuthorized)
    {
        var selections = new List<DynamicSelection>();

        switch (observation.HttpStatus)
        {
            // An authorization refusal mid-run is the signal worth the most. Either the test
            // is signed in as the wrong identity, or the application refuses something it
            // should allow, or it allows something for others that it refused here — and the
            // third is a finding rather than a failure.
            case 401 or 403 when securityAuthorized:
                selections.Add(new DynamicSelection(
                    $"{observation.Where} refused with {observation.HttpStatus} during the run. "
                    + "Whether that refusal is applied consistently across identities is a "
                    + "different question from whether this test passed, and it is the more "
                    + "interesting one.",
                    observation, TestDimension.Security, observation.Where, RiskLevel.High,
                    "Either the control is applied to every identity, which makes this a test "
                    + "problem, or it is not, which makes it a finding."));
                break;

            case 401 or 403:
                // Without authorization there is no scanning, and saying nothing here would
                // leave the most interesting observation of the run unrecorded.
                selections.Add(new DynamicSelection(
                    $"{observation.Where} refused with {observation.HttpStatus}. Checking "
                    + "whether the control holds across identities would need security "
                    + "testing, which this application has not authorized.",
                    observation, TestDimension.Api, observation.Where, RiskLevel.Medium,
                    "Re-runs the call as the identity the test used, to separate a wrong test "
                    + "from a wrong refusal. It cannot establish anything about other identities."));
                break;

            case >= 500:
                selections.Add(new DynamicSelection(
                    $"{observation.Where} returned {observation.HttpStatus}. A server error is "
                    + "the application's own failure rather than a disagreement with the test, "
                    + "so it is worth reaching directly rather than only through the UI.",
                    observation, TestDimension.Api, observation.Where, RiskLevel.High,
                    "Establishes whether the endpoint fails on its own or only in the sequence "
                    + "the UI test drove it through."));
                break;

            case 404 when observation.Detail?.Contains("template", StringComparison.OrdinalIgnoreCase) == true:
                selections.Add(new DynamicSelection(
                    $"{observation.Where} returned 404 for an identifier the run had just "
                    + "created. That is either a timing problem or a real one.",
                    observation, TestDimension.Api, observation.Where, RiskLevel.Medium,
                    "Re-reads the resource after a delay, which separates the two."));
                break;
        }

        return selections;
    }

    /// <summary>
    /// Bounds a set of selections so reacting to evidence cannot become the whole run.
    /// </summary>
    /// <remarks>
    /// Without this, one broken endpoint producing forty 500s produces forty selections, and a
    /// pass that was supposed to execute a plan spends its budget on one problem it had
    /// already found. Highest risk first, then de-duplicated by target, then capped.
    /// </remarks>
    public static IReadOnlyList<DynamicSelection> Bound(
        IReadOnlyList<DynamicSelection> selections, int limit)
        => selections
            .GroupBy(s => (s.Dimension, s.Target))
            .Select(g => g.OrderBy(s => s.Risk).First())
            .OrderBy(s => s.Risk)
            .ThenBy(s => s.Target, StringComparer.Ordinal)
            .Take(Math.Max(0, limit))
            .ToList();
}
