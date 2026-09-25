namespace Aira.Application.Agent;

/// <summary>What one dimension of a release looked like.</summary>
public sealed record AssessmentLine(
    string Area,
    /// <summary>Measured, or explicitly not. Never inferred.</summary>
    bool Measured,
    int Executed,
    int Passed,
    int Failed,
    string Detail);

public enum ReleaseVerdict
{
    /// <summary>Everything measured came back within its thresholds.</summary>
    Clear = 0,
    /// <summary>A person has to look. Not a failure and emphatically not a pass.</summary>
    NeedsReview = 1,
    /// <summary>Something blocking. Stop.</summary>
    Blocked = 2,
    /// <summary>Not enough ran to say anything. Never reported as clear.</summary>
    NotAssessed = 3
}

public sealed record AutonomousAssessment(
    ReleaseVerdict Verdict,
    IReadOnlyList<AssessmentLine> Lines,
    IReadOnlyList<string> BlockingFactors,
    IReadOnlyList<string> UntestedAreas,
    string Summary);

/// <summary>Everything the assessment is allowed to look at.</summary>
public sealed record AssessmentInputs(
    int FunctionalExecuted, int FunctionalPassed, int FunctionalFailed,
    int ApiExecuted, int ApiPassed, int ApiFailed,
    bool SecurityScanned,
    int SecurityCritical, int SecurityHigh, int SecurityMedium,
    int SecurityRegressions,
    bool AccessibilityRun, int AccessibilityViolations,
    bool VisualRun, int VisualDifferences,
    int CriticalJourneysFailed,
    /// <summary>Whether a quality gate was configured and what it said.</summary>
    bool GateConfigured, bool GatePassed,
    IReadOnlyList<string> UntestedAreas);

/// <summary>
/// What an autonomous run is allowed to say about a release.
/// </summary>
/// <remarks>
/// <para>
/// There is no overall score, deliberately. A single number is the thing everybody reads and
/// the thing nobody can act on, and an AI-generated one is worse still: it launders several
/// measured facts and a few unmeasured ones into a figure that looks authoritative and cannot
/// be checked. So this reports the facts, the configured gate's verdict, and the blocking
/// factors by name.
/// </para>
/// <para>
/// The verdict that matters most is <c>NotAssessed</c>. A run where almost nothing executed
/// has not found a clean release — it has found nothing — and every other verdict in this
/// enum would be read as a statement about the application. This one is a statement about the
/// run.
/// </para>
/// </remarks>
public static class AutonomousAssessmentModel
{
    /// <summary>Below this many executed tests, a run cannot support a verdict.</summary>
    public const int MinimumExecutedForAVerdict = 1;

    public static AutonomousAssessment Assess(AssessmentInputs inputs)
    {
        var lines = new List<AssessmentLine>
        {
            new("Functional", inputs.FunctionalExecuted > 0,
                inputs.FunctionalExecuted, inputs.FunctionalPassed, inputs.FunctionalFailed,
                inputs.FunctionalExecuted == 0
                    ? "No functional test ran in this pass."
                    : $"{inputs.FunctionalPassed} of {inputs.FunctionalExecuted} passed."),

            new("API", inputs.ApiExecuted > 0,
                inputs.ApiExecuted, inputs.ApiPassed, inputs.ApiFailed,
                inputs.ApiExecuted == 0
                    ? "No API test ran in this pass."
                    : $"{inputs.ApiPassed} of {inputs.ApiExecuted} passed."),

            new("Security", inputs.SecurityScanned, 0, 0,
                inputs.SecurityCritical + inputs.SecurityHigh,
                inputs.SecurityScanned
                    ? $"{inputs.SecurityCritical} critical, {inputs.SecurityHigh} high, "
                      + $"{inputs.SecurityMedium} medium open; "
                      + $"{inputs.SecurityRegressions} regression(s)."
                    : "NOT SECURITY TESTED. No scan covers this pass, so nothing is known "
                      + "about its security posture from AIRA. This is not the same as having "
                      + "been tested and found clean."),

            new("Accessibility", inputs.AccessibilityRun, 0, 0, inputs.AccessibilityViolations,
                inputs.AccessibilityRun
                    ? $"{inputs.AccessibilityViolations} automated violation(s). Automated "
                      + "checks find a minority of real barriers."
                    : "No accessibility check ran."),

            new("Visual", inputs.VisualRun, 0, 0, inputs.VisualDifferences,
                inputs.VisualRun
                    ? $"{inputs.VisualDifferences} difference(s) against the baselines."
                    : "No visual comparison ran.")
        };

        var blocking = new List<string>();

        if (inputs.SecurityCritical > 0)
            blocking.Add($"{inputs.SecurityCritical} open critical security finding(s).");
        if (inputs.SecurityRegressions > 0)
            blocking.Add($"{inputs.SecurityRegressions} security finding(s) that were fixed "
                       + "and have come back.");
        if (inputs.CriticalJourneysFailed > 0)
            blocking.Add($"{inputs.CriticalJourneysFailed} critical journey(s) failed.");
        if (inputs.GateConfigured && !inputs.GatePassed)
            blocking.Add("The configured quality gate did not pass.");

        var review = new List<string>();
        if (inputs.SecurityHigh > 0)
            review.Add($"{inputs.SecurityHigh} open high-severity security finding(s).");
        if (inputs.FunctionalFailed > 0 || inputs.ApiFailed > 0)
            review.Add($"{inputs.FunctionalFailed + inputs.ApiFailed} test(s) failed.");
        if (!inputs.SecurityScanned)
            review.Add("No security scan covers this pass.");

        var totalExecuted = inputs.FunctionalExecuted + inputs.ApiExecuted;

        var verdict =
            totalExecuted < MinimumExecutedForAVerdict && !inputs.SecurityScanned
                ? ReleaseVerdict.NotAssessed
                : blocking.Count > 0 ? ReleaseVerdict.Blocked
                : review.Count > 0 ? ReleaseVerdict.NeedsReview
                : ReleaseVerdict.Clear;

        return new AutonomousAssessment(
            verdict, lines, blocking, inputs.UntestedAreas,
            Summarise(verdict, inputs, totalExecuted, blocking, review));
    }

    private static string Summarise(
        ReleaseVerdict verdict, AssessmentInputs inputs, int totalExecuted,
        IReadOnlyList<string> blocking, IReadOnlyList<string> review)
        => verdict switch
        {
            ReleaseVerdict.NotAssessed =>
                "NOT ASSESSED. This pass executed no tests and ran no scan, so nothing is "
                + "known about the release from it. This is a statement about the run, not "
                + "about the application, and it is not a clean result.",

            ReleaseVerdict.Blocked =>
                $"BLOCKED. {totalExecuted} test(s) executed. "
                + string.Join(" ", blocking)
                + " The blocking factors are named above rather than folded into a score, "
                + "because a number cannot be argued with and these can.",

            ReleaseVerdict.NeedsReview =>
                $"NEEDS REVIEW. {totalExecuted} test(s) executed. "
                + string.Join(" ", review)
                + " Nothing here blocks on its own; a person decides.",

            _ =>
                $"Within the scope and coverage of this pass, {totalExecuted} test(s) executed "
                + "and nothing was detected above the configured thresholds"
                + (inputs.SecurityScanned
                    ? ", and the security scan that covers it found nothing open above them either"
                    : ", though no security scan covers this pass")
                + ". This is not a statement that the application is correct or secure: areas "
                + "the pass did not reach are untested rather than clean."
        };
}
