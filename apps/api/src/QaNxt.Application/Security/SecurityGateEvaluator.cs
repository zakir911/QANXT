using QaNxt.Domain.Security;

namespace QaNxt.Application.Security;

/// <summary>What a security gate decided, and why.</summary>
/// <remarks>
/// Three outcomes rather than two. "A person has to look at this" is a real answer, and
/// folding it into either pass or fail loses information a release decision needs: a scan
/// that could not run is not a scan that found nothing, and a build that goes green because
/// nobody scanned is the failure mode this whole file exists to prevent.
/// </remarks>
public enum SecurityGateOutcome { Pass = 0, Review = 1, Fail = 2 }

/// <summary>One finding, reduced to what the gate needs to decide.</summary>
public sealed record SecurityGateFinding(
    string Id,
    string Category,
    SecuritySeverity Severity,
    SecurityConfidence Confidence,
    SecurityFindingStatus Status,
    bool IsNew,
    /// <summary>True when this finding was previously Resolved and has been seen again.</summary>
    bool IsRegression = false,
    /// <summary>Required when Status is FalsePositive or Accepted. A suppression with no
    /// stated reason is indistinguishable from someone turning the check off.</summary>
    string? Justification = null,
    /// <summary>Who decided, for the statuses that need a person.</summary>
    string? DecidedBy = null,
    /// <summary>True when the finding carries at least one request/response exchange.</summary>
    bool HasEvidence = true);

/// <summary>What the scan actually covered, which the gate weighs as heavily as what it found.</summary>
public sealed record SecurityScanCoverage(
    bool ScanRan,
    SecurityProfile Profile,
    int RequestsIssued,
    int RequestsBlocked,
    /// <summary>Check names the scan was configured to run.</summary>
    IReadOnlyCollection<string> ChecksConfigured,
    /// <summary>Check names that actually produced a verdict.</summary>
    IReadOnlyCollection<string> ChecksExecuted,
    /// <summary>Areas nothing tested, named. DOM XSS on a response-only scan belongs here.</summary>
    IReadOnlyCollection<string> UntestedAreas);

public sealed record SecurityGateRuleResult(
    string Name, bool Passed, bool Measured, string Explanation);

public sealed record SecurityGateResult(
    SecurityGateOutcome Outcome,
    string Summary,
    IReadOnlyList<SecurityGateRuleResult> Rules,
    IReadOnlyList<string> Reasons)
{
    public bool Blocked => Outcome == SecurityGateOutcome.Fail;
}

/// <summary>Thresholds a project sets. The defaults are the strict ones.</summary>
public sealed record SecurityGatePolicy
{
    /// <summary>Findings at or above this severity fail the build when they are new.</summary>
    public SecuritySeverity FailOnNewAtOrAbove { get; init; } = SecuritySeverity.High;

    /// <summary>Findings at or above this severity fail the build even when they are not new.
    /// Above the new-finding threshold on purpose: a critical flaw does not become acceptable
    /// by being old.</summary>
    public SecuritySeverity FailOnExistingAtOrAbove { get; init; } = SecuritySeverity.Critical;

    /// <summary>A previously resolved finding reappearing always fails, at any severity.
    /// Turning this off is possible and is a decision somebody signs for.</summary>
    public bool FailOnRegression { get; init; } = true;

    /// <summary>Low-confidence findings go to review rather than failing the build. A single
    /// unreproduced indicator is not grounds for stopping a release, and treating it as such
    /// is how a security gate gets switched off within a month.</summary>
    public bool ReviewLowConfidenceInsteadOfFailing { get; init; } = true;

    /// <summary>The fraction of configured checks that must have executed for the result to
    /// count as a scan at all.</summary>
    public decimal MinimumCheckCoverage { get; init; } = 0.8m;
}

/// <summary>Decides whether a security scan should stop a pipeline.
///
/// The rules that matter are the ones about absence rather than presence:
///
///   A scan that did not run is not a pass. It is REVIEW, and the summary says so.
///   A scan whose scope blocked most of its requests is not a pass either.
///   A suppressed finding with no written justification is not suppressed.
///   A finding with no evidence never counts towards failing OR passing — it is not a
///   finding yet, and the gate says it needs review rather than quietly dropping it.
///
/// The summary never says an application is secure, and never says there are no
/// vulnerabilities. What it can honestly say is what was tested and what was found, and
/// that is what it says.</summary>
public static class SecurityGateEvaluator
{
    public static SecurityGateResult Evaluate(
        SecurityScanCoverage coverage,
        IReadOnlyCollection<SecurityGateFinding> findings,
        SecurityGatePolicy? policy = null)
    {
        policy ??= new SecurityGatePolicy();
        var rules = new List<SecurityGateRuleResult>();
        var reasons = new List<string>();
        var outcome = SecurityGateOutcome.Pass;

        void Escalate(SecurityGateOutcome to, string reason)
        {
            if (to > outcome) outcome = to;
            reasons.Add(reason);
        }

        // ---- Did a scan happen at all? --------------------------------------
        if (!coverage.ScanRan)
        {
            rules.Add(new SecurityGateRuleResult("A security scan ran", false, false,
                "No security scan ran for this build."));
            Escalate(SecurityGateOutcome.Review,
                "No security scan ran, so this build has not been security tested. That is not the same "
                + "as having been tested and found clean, and the gate will not report it as a pass.");
            return new SecurityGateResult(outcome,
                "NOT SCANNED. No security tests were executed for this build, so nothing is known about "
                + "its security posture from QA NXT.", rules, reasons);
        }
        rules.Add(new SecurityGateRuleResult("A security scan ran", true, true,
            $"{coverage.RequestsIssued} request(s) issued under the {coverage.Profile} profile."));

        // ---- How much of it ran? ---------------------------------------------
        var configured = coverage.ChecksConfigured.Count;
        var executed = coverage.ChecksExecuted.Count;
        var checkCoverage = configured == 0 ? 0m : (decimal)executed / configured;
        var coverageOk = configured > 0 && checkCoverage >= policy.MinimumCheckCoverage;

        rules.Add(new SecurityGateRuleResult(
            "Enough of the configured checks executed", coverageOk, configured > 0,
            configured == 0
                ? "No checks were configured, so there was nothing to execute."
                : $"{executed} of {configured} configured check(s) executed "
                  + $"({Percent(checkCoverage)}; the policy requires {Percent(policy.MinimumCheckCoverage)})."));

        if (!coverageOk)
        {
            Escalate(SecurityGateOutcome.Review, configured == 0
                ? "No security checks were configured, so a clean result means only that nothing was asked."
                : $"Only {executed} of {configured} configured check(s) executed. A result from a partial "
                  + "scan describes the part that ran and nothing else.");
        }

        // ---- What the scope stopped it reaching -------------------------------
        var attempted = coverage.RequestsIssued + coverage.RequestsBlocked;
        var blockedShare = attempted == 0 ? 0m : (decimal)coverage.RequestsBlocked / attempted;
        var reachedEnough = blockedShare <= 0.25m;
        rules.Add(new SecurityGateRuleResult(
            "The scan reached what it was aiming at", reachedEnough, attempted > 0,
            $"{coverage.RequestsBlocked} of {attempted} request(s) were refused by the scope "
            + $"({Percent(blockedShare)})."));
        if (!reachedEnough)
        {
            Escalate(SecurityGateOutcome.Review,
                $"{Percent(blockedShare)} of the scan's requests were refused by its own scope. The findings "
                + "describe the part of the application the scan was allowed to reach.");
        }

        // ---- Suppressions that are not suppressions ---------------------------
        var unjustified = findings
            .Where(f => f.Status is SecurityFindingStatus.FalsePositive or SecurityFindingStatus.Accepted)
            .Where(f => string.IsNullOrWhiteSpace(f.Justification) || string.IsNullOrWhiteSpace(f.DecidedBy))
            .ToList();

        rules.Add(new SecurityGateRuleResult(
            "Every suppressed finding carries a written justification and a name",
            unjustified.Count == 0, true,
            unjustified.Count == 0
                ? "No finding is suppressed without a reason."
                : $"{unjustified.Count} finding(s) are marked false positive or accepted with no "
                  + "justification or no named decision-maker."));

        if (unjustified.Count > 0)
        {
            // These are treated as though they were never suppressed. A silent suppression is
            // how a security gate becomes decoration.
            Escalate(SecurityGateOutcome.Fail,
                $"{unjustified.Count} finding(s) are suppressed with no written justification or no named "
                + "decision-maker. They are counted as open, because an unexplained suppression is "
                + "indistinguishable from switching the check off.");
        }

        var suppressedIds = findings
            .Where(f => f.Status is SecurityFindingStatus.FalsePositive or SecurityFindingStatus.Accepted)
            .Where(f => !unjustified.Contains(f))
            .Select(f => f.Id).ToHashSet();

        // ---- Findings with nothing behind them ---------------------------------
        var evidenceless = findings.Where(f => !f.HasEvidence).ToList();
        rules.Add(new SecurityGateRuleResult(
            "Every finding carries evidence", evidenceless.Count == 0, true,
            evidenceless.Count == 0
                ? "Every finding carries at least one request/response exchange."
                : $"{evidenceless.Count} finding(s) have no evidence."));
        if (evidenceless.Count > 0)
        {
            Escalate(SecurityGateOutcome.Review,
                $"{evidenceless.Count} finding(s) carry no evidence. They are neither failed nor dismissed: "
                + "a claim nobody can check is not yet a finding, and dropping it silently is worse than "
                + "saying so.");
        }

        var open = findings
            .Where(f => !suppressedIds.Contains(f.Id))
            .Where(f => f.HasEvidence)
            .Where(f => f.Status is not SecurityFindingStatus.Resolved)
            .ToList();

        // ---- Regressions --------------------------------------------------------
        var regressions = open.Where(f => f.IsRegression).ToList();
        rules.Add(new SecurityGateRuleResult(
            "No previously resolved finding has reappeared", regressions.Count == 0, true,
            regressions.Count == 0
                ? "No regression."
                : $"{regressions.Count} finding(s) previously resolved have been detected again: "
                  + string.Join(", ", regressions.Select(f => $"{f.Category} ({f.Severity})"))));
        if (regressions.Count > 0 && policy.FailOnRegression)
        {
            Escalate(SecurityGateOutcome.Fail,
                $"{regressions.Count} security finding(s) that were fixed have come back. A regression "
                + "fails at any severity: something that was repaired has been undone.");
        }

        // ---- New findings --------------------------------------------------------
        var newBlocking = open
            .Where(f => f.IsNew && !f.IsRegression && f.Severity >= policy.FailOnNewAtOrAbove)
            .ToList();
        var newLowConfidence = newBlocking
            .Where(f => f.Confidence == SecurityConfidence.Low && policy.ReviewLowConfidenceInsteadOfFailing)
            .ToList();
        var newFailing = newBlocking.Except(newLowConfidence).ToList();

        rules.Add(new SecurityGateRuleResult(
            $"No new finding at or above {policy.FailOnNewAtOrAbove}", newFailing.Count == 0, true,
            newFailing.Count == 0
                ? $"No new finding at or above {policy.FailOnNewAtOrAbove} with better than low confidence."
                : string.Join(", ", newFailing.Select(f => $"{f.Category} ({f.Severity}, {f.Confidence})"))));

        if (newFailing.Count > 0)
        {
            Escalate(SecurityGateOutcome.Fail,
                $"{newFailing.Count} new finding(s) at or above {policy.FailOnNewAtOrAbove}: "
                + string.Join(", ", newFailing.Select(f => f.Category)) + ".");
        }
        if (newLowConfidence.Count > 0)
        {
            Escalate(SecurityGateOutcome.Review,
                $"{newLowConfidence.Count} new finding(s) at or above {policy.FailOnNewAtOrAbove} rest on a "
                + "single unreproduced indicator. A person should look rather than the build stopping.");
        }

        // ---- Existing findings that are too severe to carry -----------------------
        var existingTooSevere = open
            .Where(f => !f.IsNew && !f.IsRegression && f.Severity >= policy.FailOnExistingAtOrAbove)
            .ToList();
        rules.Add(new SecurityGateRuleResult(
            $"No open finding at or above {policy.FailOnExistingAtOrAbove}", existingTooSevere.Count == 0, true,
            existingTooSevere.Count == 0
                ? $"No pre-existing finding at or above {policy.FailOnExistingAtOrAbove}."
                : string.Join(", ", existingTooSevere.Select(f => $"{f.Category} ({f.Severity})"))));
        if (existingTooSevere.Count > 0)
        {
            Escalate(SecurityGateOutcome.Fail,
                $"{existingTooSevere.Count} open finding(s) at or above {policy.FailOnExistingAtOrAbove} "
                + "were already present. A finding does not become acceptable by being old.");
        }

        return new SecurityGateResult(outcome, Summarise(outcome, coverage, open, findings), rules, reasons);
    }

    /// <summary>
    /// A whole-number percentage with no space before the sign.
    /// </summary>
    /// <remarks>
    /// Formatted by hand rather than with "P0". .NET's percent format inserts a space before
    /// the sign, which made this read "100 %" and — more to the point — differ from the
    /// JavaScript mirror's string for the same decision. The two implementations are supposed
    /// to produce the same sentence, and a difference nobody notices is how they drift.
    /// </remarks>
    private static string Percent(decimal value)
        => $"{Math.Round(value * 100, MidpointRounding.AwayFromZero):0}%";

    /// <summary>The sentence a reader will quote. It never says "secure" and never says
    /// "no vulnerabilities" — both are claims no scan can support.</summary>
    private static string Summarise(
        SecurityGateOutcome outcome,
        SecurityScanCoverage coverage,
        IReadOnlyCollection<SecurityGateFinding> open,
        IReadOnlyCollection<SecurityGateFinding> all)
    {
        var executed = $"{coverage.ChecksExecuted.Count} of {coverage.ChecksConfigured.Count} configured "
                       + $"check(s), {coverage.RequestsIssued} request(s) issued";
        var untested = coverage.UntestedAreas.Count == 0
            ? string.Empty
            : $" Untested: {string.Join("; ", coverage.UntestedAreas)}.";

        // Findings that were detected and then set aside. They belong in the summary even when
        // nothing is open, because "no findings were detected" reads very differently from
        // "three were detected and a person decided they were not problems", and a reader
        // deciding whether to ship needs the second sentence rather than the first.
        var setAside = all.Count - open.Count;
        var setAsideNote = setAside == 0
            ? string.Empty
            : $" {setAside} finding(s) were detected and then suppressed or resolved; they are listed "
              + "with the reason and the person who decided.";

        if (open.Count == 0)
        {
            // The exact sentence the brief requires, because the tempting one is a lie.
            return "Within the configured scope and test coverage, no security findings were detected by "
                   + $"the executed QA NXT security tests ({executed}). This is not a statement that the "
                   + $"application is secure or that no vulnerabilities exist.{setAsideNote}{untested}";
        }

        var bySeverity = open.GroupBy(f => f.Severity)
            .OrderByDescending(g => g.Key)
            .Select(g => $"{g.Count()} {g.Key}")
            .ToList();

        var verb = outcome switch
        {
            SecurityGateOutcome.Fail => "BLOCKED",
            SecurityGateOutcome.Review => "NEEDS REVIEW",
            _ => "PASSED"
        };

        return $"{verb}. {open.Count} open finding(s) ({string.Join(", ", bySeverity)}) from {executed}."
               + $"{setAsideNote} Findings describe what these tests reached; areas they did not reach "
               + $"are untested, not clean.{untested}";
    }
}
