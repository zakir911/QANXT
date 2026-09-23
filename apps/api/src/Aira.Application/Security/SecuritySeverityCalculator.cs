using System.Text.Json.Serialization;
using Aira.Domain.Security;

namespace Aira.Application.Security;

/// <summary>How hard it would be to make use of the flaw.</summary>
public enum Exploitability { Theoretical = 0, Difficult = 1, Straightforward = 2, Trivial = 3 }

/// <summary>What an attacker gets out of it.</summary>
public enum SecurityImpact { Minimal = 0, Limited = 1, Serious = 2, Severe = 3 }

/// <summary>What the attacker has to be before they start. Less is worse.</summary>
public enum PrivilegeRequired { Administrator = 0, AuthenticatedUser = 1, None = 2 }

/// <summary>What the flaw reaches.</summary>
public enum AffectedData { None = 0, NonSensitive = 1, PersonalData = 2, Credentials = 3 }

/// <summary>Who can reach the affected surface at all.</summary>
public enum Exposure { InternalOnly = 0, AuthenticatedUsers = 1, Public = 2 }

/// <summary>
/// The factors a severity is computed from.
/// </summary>
/// <remarks>
/// Stored on the finding, so the number is reproducible and arguable. The brief is explicit
/// that an LLM must not assign severity without structured reasoning; this is the structure,
/// and the model never touches it. A model may *propose* factors — that is a judgement about
/// an application it has seen evidence from — but the arithmetic is arithmetic.
/// </remarks>
public sealed record SeverityFactors(
    Exploitability Exploitability,
    SecurityImpact Impact,
    PrivilegeRequired PrivilegeRequired,
    AffectedData AffectedData,
    Exposure Exposure,
    /// <summary>True when the attack needs conditions the attacker does not control —
    /// a race, a specific configuration, a victim who has to click something.</summary>
    bool RequiresUnusualConditions = false)
{
    /// <summary>
    /// Weighted sum, 0–19.
    /// </summary>
    /// <remarks>
    /// Exploitability and impact carry the most weight because they are what a reader
    /// actually asks about. The rest adjust. Unusual conditions subtract rather than cap,
    /// so a severe-impact flaw behind a race is still not Informational.
    ///
    /// The exact weights are a judgement and are written here rather than buried, so a team
    /// that disagrees can change one number and see every severity move — which is the point
    /// of having a model at all rather than an opinion per finding.
    /// </remarks>
    [JsonIgnore]
    public int Score
    {
        get
        {
            var score = (int)Exploitability * 2
                      + (int)Impact * 2
                      + (int)PrivilegeRequired
                      + (int)AffectedData
                      + (int)Exposure;
            if (RequiresUnusualConditions) score -= 3;
            return Math.Max(0, score);
        }
    }

    /// <summary>The highest score the weights can produce: 3×2 + 3×2 + 2 + 3 + 2.</summary>
    /// <remarks>
    /// Named rather than left implicit because it was wrong once. The doc comment said the
    /// scale was 0–13 while the arithmetic ran to 19, and the bands had been calibrated
    /// against the number in the comment — so broken object level authorization, which
    /// should be High, came out Critical. A unit test pinning a real vulnerability class
    /// caught it; reading the code did not, because the code and its own description
    /// disagreed and only one of them ran.
    /// </remarks>
    public const int MaxScore = 19;

    /// <summary>The band, with the boundaries stated rather than implied.</summary>
    [JsonIgnore]
    public SecuritySeverity Severity => Score switch
    {
        >= 16 => SecuritySeverity.Critical,
        >= 12 => SecuritySeverity.High,
        >= 8 => SecuritySeverity.Medium,
        >= 4 => SecuritySeverity.Low,
        _ => SecuritySeverity.Informational
    };

    /// <summary>The sentence a report prints beside the severity, so the number never
    /// appears without the reasoning that produced it.</summary>
    public string Explain() =>
        $"{Severity} ({Score}/{MaxScore}): "
        + $"{Exploitability.ToString().ToLowerInvariant()} to exploit, "
        + $"{Impact.ToString().ToLowerInvariant()} impact, "
        + PrivilegeRequired switch
        {
            PrivilegeRequired.None => "no account needed",
            PrivilegeRequired.AuthenticatedUser => "any signed-in user",
            _ => "administrator only"
        }
        + $", reaches {AffectedData switch
        {
            AffectedData.None => "no data",
            AffectedData.NonSensitive => "non-sensitive data",
            AffectedData.PersonalData => "personal data",
            _ => "credentials"
        }}"
        + $", {Exposure switch
        {
            Exposure.Public => "publicly reachable",
            Exposure.AuthenticatedUsers => "reachable by signed-in users",
            _ => "internal only"
        }}"
        + (RequiresUnusualConditions ? ", but needs conditions the attacker does not control" : string.Empty)
        + ".";
}

/// <summary>
/// Turns factors into a severity, and refuses to do it any other way.
/// </summary>
/// <remarks>
/// There is deliberately no overload that takes a severity directly. Every severity in the
/// system comes from factors that were written down, which is what makes "why is this High"
/// a question with an answer.
/// </remarks>
public static class SecuritySeverityCalculator
{
    public static (SecuritySeverity Severity, int Score, string Explanation) Evaluate(SeverityFactors factors)
        => (factors.Severity, factors.Score, factors.Explain());

    /// <summary>
    /// Confidence is not severity and is computed from different things entirely: whether
    /// the observation was reproduced, and whether a second independent signal agreed.
    /// </summary>
    /// <remarks>
    /// A single unreproduced indicator is Low however alarming it looks. This is the rule
    /// that keeps "potential" and "confirmed" apart, and it is arithmetic rather than
    /// atmosphere.
    /// </remarks>
    public static SecurityConfidence ConfidenceFrom(bool reproduced, bool corroborated, bool unambiguous)
    {
        if (reproduced && unambiguous) return SecurityConfidence.High;
        if (reproduced || corroborated) return SecurityConfidence.Medium;
        return SecurityConfidence.Low;
    }
}
