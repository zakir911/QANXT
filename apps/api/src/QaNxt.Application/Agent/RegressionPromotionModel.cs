using QaNxt.Domain.Enums;

namespace QaNxt.Application.Agent;

/// <summary>Where a candidate regression test came from.</summary>
public enum RegressionOrigin
{
    /// <summary>The security engine confirmed a vulnerability.</summary>
    ConfirmedSecurityFinding = 0,
    /// <summary>Exploration observed a journey that held up.</summary>
    ObservedJourney = 1,
    /// <summary>A failure somebody confirmed as a defect.</summary>
    ConfirmedDefect = 2,
    /// <summary>A locator the healer repaired, which a person approved.</summary>
    ApprovedHealing = 3
}

/// <summary>What is known about a candidate for the permanent suite.</summary>
public sealed record RegressionCandidate(
    RegressionOrigin Origin,
    string Subject,
    /// <summary>How many times the platform has seen this behave the same way.</summary>
    int TimesObserved,
    /// <summary>Whether a person has confirmed the underlying thing.</summary>
    bool HumanConfirmed,
    /// <summary>0-100 confidence in the observation itself.</summary>
    int Confidence,
    /// <summary>Whether it touches something a person called critical.</summary>
    bool BusinessCritical = false);

public sealed record PromotionDecision(
    bool Promote,
    bool NeedsApproval,
    string Reason,
    RiskLevel Priority);

/// <summary>
/// What earns a place in the permanent regression suite.
/// </summary>
/// <remarks>
/// <para>
/// A regression suite is a promise: everything in it runs on every release, for ever, and
/// somebody maintains it. The failure mode is not a missing test — it is a suite that grew by
/// a hundred exploratory interactions nobody vouched for, went amber, and got switched off.
/// So the bar is high and the rules differ by where a candidate came from.
/// </para>
/// <para>
/// A <strong>confirmed security finding</strong> is promoted automatically. It is the one case
/// with no judgement in it: the engine established the vulnerability with a reproducible
/// exchange, and a test that re-checks it is how anybody finds out if it comes back. Waiting
/// for a person here would mean the fix ships and nothing watches it.
/// </para>
/// <para>
/// Everything else needs somebody. An observed journey is an inference about what the
/// application is for; a repaired locator is a guess that worked once. Neither is a promise
/// worth making on the platform's own authority.
/// </para>
/// </remarks>
public static class RegressionPromotionModel
{
    /// <summary>How many times a journey must hold up before it is worth proposing at all.</summary>
    public const int JourneyObservationsRequired = 3;

    /// <summary>Below this, a candidate is not even proposed.</summary>
    public const int MinimumConfidence = 60;

    public static PromotionDecision Evaluate(RegressionCandidate candidate)
    {
        switch (candidate.Origin)
        {
            case RegressionOrigin.ConfirmedSecurityFinding:
                // No judgement, and no waiting. A confirmed finding was established with a
                // reproducible exchange; a test that re-checks it is the only thing that will
                // notice if the fix is reverted, and a person's approval adds nothing to that.
                return new PromotionDecision(
                    Promote: true, NeedsApproval: false,
                    "A confirmed security finding is re-checked on every release from now on. "
                    + "A finding that was fixed and comes back is a regression, and nothing "
                    + "else will notice it.",
                    RiskLevel.Critical);

            case RegressionOrigin.ConfirmedDefect when candidate.HumanConfirmed:
                return new PromotionDecision(
                    Promote: true, NeedsApproval: true,
                    "Somebody confirmed this as a defect. A test for it belongs in the suite, "
                    + "and a person reviews the test rather than the decision to have one.",
                    candidate.BusinessCritical ? RiskLevel.Critical : RiskLevel.High);

            case RegressionOrigin.ConfirmedDefect:
                return new PromotionDecision(
                    Promote: false, NeedsApproval: true,
                    "Nobody has confirmed this is a defect yet. A test that pins behaviour "
                    + "nobody has agreed is correct pins the wrong thing.",
                    RiskLevel.Medium);

            case RegressionOrigin.ObservedJourney
                when candidate.TimesObserved < JourneyObservationsRequired:
                return new PromotionDecision(
                    Promote: false, NeedsApproval: false,
                    $"Seen {candidate.TimesObserved} time(s); a journey earns a permanent test "
                    + $"at {JourneyObservationsRequired}. Once is a coincidence and the suite "
                    + "is where coincidences go to be maintained for ever.",
                    RiskLevel.Low);

            case RegressionOrigin.ObservedJourney when candidate.Confidence < MinimumConfidence:
                return new PromotionDecision(
                    Promote: false, NeedsApproval: false,
                    $"Confidence is {candidate.Confidence}. An inference about what the "
                    + "application is for is not a promise to test it for ever.",
                    RiskLevel.Low);

            case RegressionOrigin.ObservedJourney:
                return new PromotionDecision(
                    Promote: false, NeedsApproval: true,
                    $"Seen {candidate.TimesObserved} time(s) at {candidate.Confidence}% "
                    + "confidence. Worth proposing; a person decides whether it is worth "
                    + "maintaining, because they are the one who will.",
                    candidate.BusinessCritical ? RiskLevel.High : RiskLevel.Medium);

            case RegressionOrigin.ApprovedHealing:
                return new PromotionDecision(
                    Promote: false, NeedsApproval: true,
                    "A repaired locator is a guess that worked once. Promoting it would turn "
                    + "the repair into the specification.",
                    RiskLevel.Low);

            default:
                return new PromotionDecision(false, true,
                    "Nothing known about where this came from, so nothing is promoted on it.",
                    RiskLevel.Low);
        }
    }

    /// <summary>
    /// Whether a healing proposal may touch this test at all.
    /// </summary>
    /// <remarks>
    /// The one rule the healer must never be talked out of. A security regression test exists
    /// to fail when a vulnerability returns; a healer that "repairs" it into passing has not
    /// fixed a locator, it has removed the alarm. Kept here, next to the promotion rules, so
    /// that whoever adds the next origin sees it.
    /// </remarks>
    public static bool MayBeHealed(RegressionOrigin origin)
        => origin != RegressionOrigin.ConfirmedSecurityFinding;
}
