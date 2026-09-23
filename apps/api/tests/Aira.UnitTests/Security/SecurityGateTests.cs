using Aira.Application.Security;
using Aira.Domain.Security;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Security;

/// <summary>The security gate, tested on the cases that decide whether anyone can trust it.
///
/// Most of these are about absence rather than presence. A gate that fails on a critical
/// finding is easy and everybody writes it; a gate that refuses to go green because nobody
/// scanned, or because a finding was suppressed without a reason, is the one that stops a
/// pipeline from quietly becoming decoration.</summary>
public class SecurityGateTests
{
    private static SecurityScanCoverage FullScan(int issued = 200, int blocked = 0) => new(
        ScanRan: true, Profile: SecurityProfile.Standard,
        RequestsIssued: issued, RequestsBlocked: blocked,
        ChecksConfigured: new[] { "authz", "auth", "api", "xss", "injection" },
        ChecksExecuted: new[] { "authz", "auth", "api", "xss", "injection" },
        UntestedAreas: Array.Empty<string>());

    private static SecurityGateFinding Finding(
        SecuritySeverity severity = SecuritySeverity.High,
        bool isNew = true,
        SecurityConfidence confidence = SecurityConfidence.High,
        SecurityFindingStatus status = SecurityFindingStatus.Confirmed,
        bool regression = false,
        string? justification = null,
        string? decidedBy = null,
        bool hasEvidence = true,
        string id = "f-1") =>
        new(id, "BOLA", severity, confidence, status, isNew, regression, justification, decidedBy, hasEvidence);

    [Fact]
    public void A_scan_that_did_not_run_is_review_and_never_a_pass()
    {
        var coverage = new SecurityScanCoverage(false, SecurityProfile.Passive, 0, 0,
            Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>());

        var result = SecurityGateEvaluator.Evaluate(coverage, Array.Empty<SecurityGateFinding>());

        result.Outcome.Should().Be(SecurityGateOutcome.Review);
        result.Summary.Should().Contain("NOT SCANNED");
        result.Reasons.Should().ContainMatch("*has not been security tested*");
    }

    [Fact]
    public void A_clean_scan_never_claims_the_application_is_secure()
    {
        var result = SecurityGateEvaluator.Evaluate(FullScan(), Array.Empty<SecurityGateFinding>());

        result.Outcome.Should().Be(SecurityGateOutcome.Pass);
        result.Summary.Should().Contain(
            "Within the configured scope and test coverage, no security findings were detected");
        // The disclaimer itself contains the words "is secure" and "no vulnerabilities exist",
        // so the assertion has to be about the claim rather than the substring: the summary
        // must say these things are NOT being claimed.
        result.Summary.Should().Contain(
            "This is not a statement that the application is secure or that no vulnerabilities exist.");
        result.Summary.Should().NotContain("The application is secure");
        result.Summary.Should().NotContain("zero vulnerabilities");
    }

    [Fact]
    public void A_new_high_finding_fails_the_build()
    {
        var result = SecurityGateEvaluator.Evaluate(FullScan(), new[] { Finding() });

        result.Outcome.Should().Be(SecurityGateOutcome.Fail);
        result.Blocked.Should().BeTrue();
        result.Reasons.Should().ContainMatch("*1 new finding(s) at or above High*");
    }

    [Fact]
    public void A_new_medium_finding_does_not_fail_under_the_default_policy()
    {
        var result = SecurityGateEvaluator.Evaluate(
            FullScan(), new[] { Finding(severity: SecuritySeverity.Medium) });

        result.Outcome.Should().Be(SecurityGateOutcome.Pass);
    }

    [Fact]
    public void A_new_high_finding_on_a_single_unreproduced_indicator_goes_to_review_not_failure()
    {
        // A gate that stops a release on one low-confidence signal gets switched off within
        // a month, and then nothing is gated at all.
        var result = SecurityGateEvaluator.Evaluate(
            FullScan(), new[] { Finding(confidence: SecurityConfidence.Low) });

        result.Outcome.Should().Be(SecurityGateOutcome.Review);
        result.Blocked.Should().BeFalse();
        result.Reasons.Should().ContainMatch("*single unreproduced indicator*");
    }

    [Fact]
    public void A_regression_fails_at_any_severity()
    {
        var result = SecurityGateEvaluator.Evaluate(FullScan(), new[]
        {
            Finding(severity: SecuritySeverity.Low, isNew: false, regression: true,
                    status: SecurityFindingStatus.Regressed)
        });

        result.Outcome.Should().Be(SecurityGateOutcome.Fail);
        result.Reasons.Should().ContainMatch("*have come back*");
    }

    [Fact]
    public void A_suppression_with_no_justification_is_counted_as_open_and_fails()
    {
        // The whole point. A false-positive mark with no reason behind it is somebody
        // turning the check off, and a gate that honours it is decoration.
        var result = SecurityGateEvaluator.Evaluate(FullScan(), new[]
        {
            Finding(status: SecurityFindingStatus.FalsePositive, justification: null, decidedBy: "ada")
        });

        result.Outcome.Should().Be(SecurityGateOutcome.Fail);
        result.Reasons.Should().ContainMatch("*no written justification*");
    }

    [Fact]
    public void A_suppression_with_no_named_decision_maker_also_fails()
    {
        var result = SecurityGateEvaluator.Evaluate(FullScan(), new[]
        {
            Finding(status: SecurityFindingStatus.FalsePositive,
                    justification: "The endpoint returns only the caller's own records.", decidedBy: null)
        });

        result.Outcome.Should().Be(SecurityGateOutcome.Fail);
    }

    [Fact]
    public void A_properly_justified_false_positive_is_honoured()
    {
        var result = SecurityGateEvaluator.Evaluate(FullScan(), new[]
        {
            Finding(status: SecurityFindingStatus.FalsePositive,
                    justification: "Reviewed against the source: the endpoint filters by caller id.",
                    decidedBy: "ada@example.invalid")
        });

        result.Outcome.Should().Be(SecurityGateOutcome.Pass);
        // The suppression has to be visible. "No findings were detected" and "one was detected
        // and a person set it aside" are different sentences, and the reader needs the second.
        result.Summary.Should().Contain("1 finding(s) were detected and then suppressed or resolved");
    }

    [Fact]
    public void A_finding_with_no_evidence_is_neither_failed_nor_dismissed()
    {
        var result = SecurityGateEvaluator.Evaluate(FullScan(), new[]
        {
            Finding(severity: SecuritySeverity.Critical, hasEvidence: false)
        });

        result.Outcome.Should().Be(SecurityGateOutcome.Review);
        result.Reasons.Should().ContainMatch("*carry no evidence*");
    }

    [Fact]
    public void A_partial_scan_goes_to_review_rather_than_passing()
    {
        var coverage = FullScan() with
        {
            ChecksExecuted = new[] { "authz" }
        };

        var result = SecurityGateEvaluator.Evaluate(coverage, Array.Empty<SecurityGateFinding>());

        result.Outcome.Should().Be(SecurityGateOutcome.Review);
        result.Reasons.Should().ContainMatch("*Only 1 of 5 configured check(s) executed*");
    }

    [Fact]
    public void A_scan_whose_scope_refused_most_of_its_requests_goes_to_review()
    {
        var result = SecurityGateEvaluator.Evaluate(
            FullScan(issued: 20, blocked: 80), Array.Empty<SecurityGateFinding>());

        result.Outcome.Should().Be(SecurityGateOutcome.Review);
        result.Reasons.Should().ContainMatch("*refused by its own scope*");
    }

    [Fact]
    public void An_old_critical_finding_still_fails()
    {
        // "It was already there" is not a reason to ship it.
        var result = SecurityGateEvaluator.Evaluate(FullScan(), new[]
        {
            Finding(severity: SecuritySeverity.Critical, isNew: false)
        });

        result.Outcome.Should().Be(SecurityGateOutcome.Fail);
        result.Reasons.Should().ContainMatch("*does not become acceptable by being old*");
    }

    [Fact]
    public void An_old_high_finding_does_not_fail_but_is_reported()
    {
        var result = SecurityGateEvaluator.Evaluate(FullScan(), new[]
        {
            Finding(severity: SecuritySeverity.High, isNew: false)
        });

        result.Outcome.Should().Be(SecurityGateOutcome.Pass);
        result.Summary.Should().Contain("1 open finding(s)");
    }

    [Fact]
    public void A_resolved_finding_is_not_counted_as_open()
    {
        var result = SecurityGateEvaluator.Evaluate(FullScan(), new[]
        {
            Finding(severity: SecuritySeverity.Critical, isNew: false,
                    status: SecurityFindingStatus.Resolved)
        });

        result.Outcome.Should().Be(SecurityGateOutcome.Pass);
    }

    [Fact]
    public void Untested_areas_are_named_in_the_summary()
    {
        // The brief requires tested coverage to be distinguishable from untested areas, and a
        // summary that lists neither invites the reader to assume everything was covered.
        var coverage = FullScan() with
        {
            UntestedAreas = new[] { "DOM-based XSS (needs a browser-driven scan)", "cloud metadata (off by default)" }
        };

        var result = SecurityGateEvaluator.Evaluate(coverage, Array.Empty<SecurityGateFinding>());

        result.Summary.Should().Contain("Untested:");
        result.Summary.Should().Contain("DOM-based XSS");
    }

    [Fact]
    public void A_stricter_policy_can_fail_on_medium()
    {
        var policy = new SecurityGatePolicy { FailOnNewAtOrAbove = SecuritySeverity.Medium };

        var result = SecurityGateEvaluator.Evaluate(
            FullScan(), new[] { Finding(severity: SecuritySeverity.Medium) }, policy);

        result.Outcome.Should().Be(SecurityGateOutcome.Fail);
    }

    [Fact]
    public void Every_rule_reports_whether_it_was_measured()
    {
        var coverage = new SecurityScanCoverage(false, SecurityProfile.Passive, 0, 0,
            Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>());

        var result = SecurityGateEvaluator.Evaluate(coverage, Array.Empty<SecurityGateFinding>());

        result.Rules.Should().NotBeEmpty();
        result.Rules.Should().Contain(r => !r.Measured,
            "a rule nothing measured must say so rather than reporting as satisfied");
    }

    [Fact]
    public void A_scan_with_no_checks_configured_is_review_not_a_pass()
    {
        var coverage = FullScan() with
        {
            ChecksConfigured = Array.Empty<string>(), ChecksExecuted = Array.Empty<string>()
        };

        var result = SecurityGateEvaluator.Evaluate(coverage, Array.Empty<SecurityGateFinding>());

        result.Outcome.Should().Be(SecurityGateOutcome.Review);
        result.Reasons.Should().ContainMatch("*nothing was asked*");
    }
}
