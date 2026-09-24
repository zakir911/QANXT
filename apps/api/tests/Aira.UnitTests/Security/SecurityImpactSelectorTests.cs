using Aira.Application.Security;
using Aira.Domain.Enums;
using Aira.Domain.Security;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Security;

using PageInput = SecurityAttackSurfaceBuilder.PageInput;
using ElementInput = SecurityAttackSurfaceBuilder.ElementInput;
using EndpointInput = SecurityAttackSurfaceBuilder.EndpointInput;
using OpenFinding = SecurityImpactSelector.OpenFinding;

/// <summary>Choosing which security checks a change calls for.
///
/// Narrowing a security scan is useful and dangerous in equal measure: fewer checks produce
/// fewer findings, and fewer findings look like progress. Most of these tests are about the
/// two rules that stop that — open findings keep their check whatever changed, and a narrowed
/// selection still reports the full implied set as configured.</summary>
public class SecurityImpactSelectorTests
{
    private static readonly DateTimeOffset Seen = new(2026, 9, 24, 0, 0, 0, TimeSpan.Zero);

    private static SecurityAttackSurface Surface()
        => SecurityAttackSurfaceBuilder.Build(
            Guid.NewGuid(),
            new[]
            {
                new PageInput(Guid.NewGuid(), "/login", "https://app.test/login", PageKind.Login,
                    false, Seen, new[] { new ElementInput(ElementKind.PasswordInput, "password", "password", "Password") }),
                new PageInput(Guid.NewGuid(), "/profile", "https://app.test/profile", PageKind.Form,
                    true, Seen, new[] { new ElementInput(ElementKind.FileInput, "avatar", "file", "Avatar") })
            },
            new[]
            {
                new EndpointInput(Guid.NewGuid(), "GET", "/api/accounts/{id}",
                    "https://app.test/api/accounts/1", true, null, null, Seen),
                new EndpointInput(Guid.NewGuid(), "POST", "/api/transfers",
                    "https://app.test/api/transfers", true, "application/json",
                    """{"to":"***","amount":1}""", Seen),
                new EndpointInput(Guid.NewGuid(), "GET", "/api/search",
                    "https://app.test/api/search?q=x", true, null, null, Seen)
            });

    private static SecuritySelectionResult Select(
        IEnumerable<string>? routes = null, IEnumerable<string>? apiPaths = null,
        bool everything = false, IEnumerable<OpenFinding>? open = null,
        SecurityAttackSurface? surface = null)
        => SecurityImpactSelector.Select(
            surface ?? Surface(),
            (routes ?? Array.Empty<string>()).ToList(),
            (apiPaths ?? Array.Empty<string>()).ToList(),
            everything,
            (open ?? Array.Empty<OpenFinding>()).ToList());

    [Fact]
    public void A_change_reaching_an_endpoint_selects_the_checks_that_endpoint_implies()
    {
        var result = Select(apiPaths: new[] { "/api/transfers" });

        result.Selected.Select(s => s.Check).Should().Contain(new[]
        {
            SecurityChecks.CsrfToken, SecurityChecks.OriginValidation, SecurityChecks.InputValidation
        });
        result.Selected.Should().OnlyContain(s => s.BecauseOfChange);
    }

    [Fact]
    public void A_concrete_path_matches_a_surface_recorded_as_a_template()
    {
        // The case the selector exists for: git reports a concrete path, the graph holds a
        // template, and a literal comparison would match neither.
        Select(apiPaths: new[] { "/api/accounts/42" })
            .Selected.Select(s => s.Check).Should().Contain(SecurityChecks.Bola);
    }

    [Fact]
    public void A_change_elsewhere_does_not_select_that_endpoints_checks()
        => Select(apiPaths: new[] { "/api/search" })
            .Selected.Select(s => s.Check).Should().NotContain(SecurityChecks.CsrfToken);

    [Fact]
    public void A_change_that_matches_nothing_says_so_rather_than_implying_safety()
    {
        var result = Select(apiPaths: new[] { "/api/something-undiscovered" });

        result.Selected.Should().BeEmpty();
        result.Notes.Should().ContainMatch("*not the same as the change being safe*");
        result.Summary.Should().Contain("says nothing about whether the change is safe");
    }

    [Fact]
    public void A_change_affecting_everything_selects_every_implied_check()
    {
        var result = Select(everything: true);

        result.Selected.Select(s => s.Check).Should().BeEquivalentTo(result.ChecksImplied);
        result.IsNarrowed.Should().BeFalse();
        result.NotSelected.Should().BeEmpty();
    }

    [Fact]
    public void An_open_finding_keeps_its_check_selected_whatever_the_change_touched()
    {
        // The rule that stops a narrowed scan from hiding a regression.
        var result = Select(
            apiPaths: new[] { "/api/search" },
            open: new[] { new OpenFinding("BOLA", SecurityChecks.Bola, SecurityFindingStatus.Confirmed) });

        var bola = result.Selected.Single(s => s.Check == SecurityChecks.Bola);
        bola.BecauseOfOpenFinding.Should().BeTrue();
        bola.BecauseOfChange.Should().BeFalse();
        result.Notes.Should().ContainMatch("*how a regression hides*");
    }

    [Fact]
    public void A_check_selected_for_both_reasons_keeps_both()
    {
        var result = Select(
            apiPaths: new[] { "/api/accounts/{id}" },
            open: new[] { new OpenFinding("BOLA", SecurityChecks.Bola, SecurityFindingStatus.Regressed) });

        var bola = result.Selected.Single(s => s.Check == SecurityChecks.Bola);
        bola.BecauseOfChange.Should().BeTrue();
        bola.BecauseOfOpenFinding.Should().BeTrue();
    }

    [Theory]
    [InlineData(SecurityFindingStatus.Potential)]
    [InlineData(SecurityFindingStatus.Confirmed)]
    [InlineData(SecurityFindingStatus.NeedsReview)]
    [InlineData(SecurityFindingStatus.Regressed)]
    public void Every_live_status_keeps_its_check(SecurityFindingStatus status)
        => Select(open: new[] { new OpenFinding("BOLA", SecurityChecks.Bola, status) })
            .Selected.Should().Contain(s => s.Check == SecurityChecks.Bola);

    [Theory]
    [InlineData(SecurityFindingStatus.Resolved)]
    [InlineData(SecurityFindingStatus.FalsePositive)]
    [InlineData(SecurityFindingStatus.Accepted)]
    public void A_settled_finding_does_not_force_its_check(SecurityFindingStatus status)
        => Select(open: new[] { new OpenFinding("BOLA", SecurityChecks.Bola, status) })
            .Selected.Should().BeEmpty();

    [Fact]
    public void An_open_finding_naming_an_unknown_check_is_reported_rather_than_silently_dropped()
    {
        // Otherwise a finding recorded before a check was renamed stops being re-tested and
        // nothing says so.
        var result = Select(open: new[]
        {
            new OpenFinding("BOLA", "authz.bola-old-name", SecurityFindingStatus.Confirmed)
        });

        result.Selected.Should().BeEmpty();
        result.Notes.Should().ContainMatch("*names no known check*");
        result.Notes.Should().ContainMatch("*not being re-tested by this run*");
    }

    [Fact]
    public void A_narrowed_selection_still_reports_the_full_implied_set_as_configured()
    {
        // The rule that stops narrowing from buying a green gate: the gate divides executed by
        // configured, and configured stays the whole surface.
        var result = Select(apiPaths: new[] { "/api/search" });

        result.ChecksImplied.Count.Should().BeGreaterThan(result.Selected.Count);
        result.IsNarrowed.Should().BeTrue();
        result.NotSelected.Should().NotBeEmpty();
        result.Notes.Should().ContainMatch("*does not change what a clean result is allowed to claim*");
    }

    [Fact]
    public void The_checks_not_running_are_named_rather_than_counted()
    {
        var result = Select(apiPaths: new[] { "/api/search" });

        result.NotSelected.Should().Contain(SecurityChecks.CsrfToken);
        result.NotSelected.Should().OnlyContain(check => SecurityChecks.All.Contains(check));
    }

    [Fact]
    public void A_narrowed_selection_reaching_the_gate_cannot_pass_on_coverage()
    {
        // The integration that matters. This is the selector's output handed to the gate the
        // way a scan would report it, and the answer has to be REVIEW.
        var result = Select(apiPaths: new[] { "/api/search" });

        var gate = SecurityGateEvaluator.Evaluate(
            new SecurityScanCoverage(
                ScanRan: true, Profile: SecurityProfile.Regression,
                RequestsIssued: 50, RequestsBlocked: 0,
                ChecksConfigured: result.ChecksImplied,
                ChecksExecuted: result.Selected.Select(s => s.Check).ToList(),
                UntestedAreas: result.NotSelected),
            Array.Empty<SecurityGateFinding>());

        gate.Outcome.Should().Be(SecurityGateOutcome.Review);
        gate.Reasons.Should().ContainMatch("*configured check(s) executed*");
    }

    [Fact]
    public void An_undiscovered_application_selects_nothing_and_says_why()
    {
        var empty = SecurityAttackSurfaceBuilder.Build(
            Guid.NewGuid(), Array.Empty<PageInput>(), Array.Empty<EndpointInput>());

        var result = Select(everything: true, surface: empty);

        result.Selected.Should().BeEmpty();
        result.Notes.Should().ContainMatch("*Run discovery*");
        result.Summary.Should().Contain("has not been discovered");
    }

    [Fact]
    public void A_page_change_selects_page_checks_and_not_API_checks()
    {
        var result = Select(routes: new[] { "/profile" });

        var checks = result.Selected.Select(s => s.Check).ToList();
        checks.Should().Contain(SecurityChecks.UploadRestrictions);
        checks.Should().NotContain(SecurityChecks.CsrfToken);
    }

    [Fact]
    public void Every_selection_says_which_surface_it_came_from_and_why()
        => Select(everything: true).Selected.Should().OnlyContain(
            s => !string.IsNullOrWhiteSpace(s.Surface) && !string.IsNullOrWhiteSpace(s.Reason));
}
