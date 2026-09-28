using QaNxt.Application.Security;
using QaNxt.Domain.Security;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Security;

/// <summary>
/// The severity model, pinned against the findings it is meant to describe.
/// </summary>
/// <remarks>
/// These tests are the argument for the weights. Each one names a real vulnerability class
/// and asserts the band it should land in, so changing a weight breaks the case that
/// justified it rather than silently moving every severity in the product.
/// </remarks>
public class SecuritySeverityTests
{
    [Fact]
    public void An_unauthenticated_endpoint_leaking_credentials_is_critical()
    {
        // The api-lab's unverified token: trivially forged, no account needed, reaches
        // credentials, publicly exposed.
        var factors = new SeverityFactors(
            Exploitability.Trivial, SecurityImpact.Severe,
            PrivilegeRequired.None, AffectedData.Credentials, Exposure.Public);

        factors.Severity.Should().Be(SecuritySeverity.Critical);
        factors.Explain().Should().Contain("no account needed").And.Contain("credentials");
    }

    [Fact]
    public void Reading_another_users_account_as_a_signed_in_user_is_high_not_critical()
    {
        // BOLA in the access-control lab. Trivial and serious, but it needs an account and
        // reaches personal data rather than credentials — which is the distinction that
        // separates High from Critical and is worth being able to point at.
        var factors = new SeverityFactors(
            Exploitability.Trivial, SecurityImpact.Serious,
            PrivilegeRequired.AuthenticatedUser, AffectedData.PersonalData, Exposure.AuthenticatedUsers);

        factors.Severity.Should().Be(SecuritySeverity.High);
    }

    [Fact]
    public void A_missing_security_header_is_medium_at_most()
    {
        // The brief says not to treat every missing header as critical. The factors say so
        // too: a header is not itself exploitable and reaches no data on its own.
        var factors = new SeverityFactors(
            Exploitability.Difficult, SecurityImpact.Limited,
            PrivilegeRequired.None, AffectedData.None, Exposure.Public);

        factors.Severity.Should().BeOneOf(SecuritySeverity.Low, SecuritySeverity.Medium);
    }

    [Fact]
    public void An_exposed_source_map_is_low()
    {
        var factors = new SeverityFactors(
            Exploitability.Straightforward, SecurityImpact.Minimal,
            PrivilegeRequired.None, AffectedData.NonSensitive, Exposure.Public);

        factors.Severity.Should().BeOneOf(SecuritySeverity.Low, SecuritySeverity.Medium);
    }

    [Fact]
    public void A_theoretical_flaw_reaching_nothing_is_informational()
    {
        var factors = new SeverityFactors(
            Exploitability.Theoretical, SecurityImpact.Minimal,
            PrivilegeRequired.Administrator, AffectedData.None, Exposure.InternalOnly);

        factors.Severity.Should().Be(SecuritySeverity.Informational);
        factors.Score.Should().Be(0);
    }

    [Fact]
    public void Unusual_conditions_reduce_severity_without_erasing_it()
    {
        var direct = new SeverityFactors(
            Exploitability.Trivial, SecurityImpact.Severe,
            PrivilegeRequired.None, AffectedData.Credentials, Exposure.Public);
        var conditional = direct with { RequiresUnusualConditions = true };

        conditional.Score.Should().Be(direct.Score - 3);
        // Lower, but a severe-impact credential leak behind a race is still not something
        // to file under Informational.
        conditional.Severity.Should().BeOneOf(SecuritySeverity.High, SecuritySeverity.Critical);
        conditional.Explain().Should().Contain("conditions the attacker does not control");
    }

    [Fact]
    public void The_score_never_goes_below_zero()
    {
        var factors = new SeverityFactors(
            Exploitability.Theoretical, SecurityImpact.Minimal,
            PrivilegeRequired.Administrator, AffectedData.None, Exposure.InternalOnly,
            RequiresUnusualConditions: true);

        factors.Score.Should().Be(0);
    }

    [Fact]
    public void The_same_factors_always_produce_the_same_severity()
    {
        // Reproducibility is the whole claim. A severity that moves between runs is an
        // opinion wearing a number's clothes.
        var factors = new SeverityFactors(
            Exploitability.Straightforward, SecurityImpact.Serious,
            PrivilegeRequired.AuthenticatedUser, AffectedData.PersonalData, Exposure.Public);

        var first = SecuritySeverityCalculator.Evaluate(factors);
        var second = SecuritySeverityCalculator.Evaluate(factors);

        second.Should().BeEquivalentTo(first);
    }

    [Fact]
    public void Every_severity_carries_the_reasoning_that_produced_it()
    {
        var factors = new SeverityFactors(
            Exploitability.Trivial, SecurityImpact.Serious,
            PrivilegeRequired.None, AffectedData.PersonalData, Exposure.Public);

        var (severity, score, explanation) = SecuritySeverityCalculator.Evaluate(factors);

        explanation.Should().StartWith(severity.ToString());
        explanation.Should().Contain($"{score}/{SeverityFactors.MaxScore}");
        // A reader gets every factor, not just the verdict.
        explanation.Should().Contain("trivial to exploit").And.Contain("serious impact");
    }

    // ---- Confidence is a different question ------------------------------

    [Fact]
    public void A_single_unreproduced_indicator_is_low_confidence_however_alarming()
    {
        SecuritySeverityCalculator.ConfidenceFrom(reproduced: false, corroborated: false, unambiguous: true)
            .Should().Be(SecurityConfidence.Low);
    }

    [Fact]
    public void Reproduction_or_corroboration_raises_confidence_to_medium()
    {
        SecuritySeverityCalculator.ConfidenceFrom(reproduced: true, corroborated: false, unambiguous: false)
            .Should().Be(SecurityConfidence.Medium);
        SecuritySeverityCalculator.ConfidenceFrom(reproduced: false, corroborated: true, unambiguous: false)
            .Should().Be(SecurityConfidence.Medium);
    }

    [Fact]
    public void High_confidence_needs_both_reproduction_and_evidence_that_admits_no_other_reading()
    {
        SecuritySeverityCalculator.ConfidenceFrom(reproduced: true, corroborated: true, unambiguous: true)
            .Should().Be(SecurityConfidence.High);
        // Reproduced but ambiguous is not enough.
        SecuritySeverityCalculator.ConfidenceFrom(reproduced: true, corroborated: true, unambiguous: false)
            .Should().Be(SecurityConfidence.Medium);
    }

    [Fact]
    public void Confidence_and_severity_are_independent()
    {
        // A critical-severity finding can be low confidence, and must be reportable as
        // exactly that rather than being promoted or suppressed.
        var factors = new SeverityFactors(
            Exploitability.Trivial, SecurityImpact.Severe,
            PrivilegeRequired.None, AffectedData.Credentials, Exposure.Public);

        factors.Severity.Should().Be(SecuritySeverity.Critical);
        SecuritySeverityCalculator.ConfidenceFrom(false, false, false).Should().Be(SecurityConfidence.Low);
    }
}
