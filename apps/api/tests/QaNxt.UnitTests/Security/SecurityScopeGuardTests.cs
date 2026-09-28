using QaNxt.Application.Security;
using QaNxt.Domain.Security;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Security;

/// <summary>
/// The scope guard, branch by branch.
/// </summary>
/// <remarks>
/// Exhaustive on purpose. This function stands between the platform and somebody else's
/// application, and the failure mode is not a wrong answer on a screen — it is a request
/// that should never have been sent. Every refusal below is a request that does not happen.
///
/// The positive cases matter as much as the refusals. A guard that refuses everything is
/// trivially safe and useless, and would pass a suite that only checked denials.
/// </remarks>
public class SecurityScopeGuardTests
{
    private static SecurityScopeView Scope(
        bool enabled = true,
        string domains = "app.test",
        string apiDomains = "",
        string allowedPaths = "",
        string blockedPaths = "",
        Guid? environmentId = null,
        int rps = 5,
        int concurrent = 2,
        int durationMinutes = 30,
        bool active = true,
        bool destructive = false,
        bool production = false,
        bool authorized = true) => new(
        enabled,
        domains.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
        apiDomains.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
        allowedPaths.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
        blockedPaths.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
        environmentId, rps, concurrent, durationMinutes, active, destructive, production, authorized);

    private static SecurityRequest Request(
        string url = "https://app.test/dashboard",
        string method = "GET",
        SecurityRisk risk = SecurityRisk.Passive,
        SecurityProfile profile = SecurityProfile.Standard,
        Guid? environmentId = null,
        bool api = false) => new(url, method, risk, profile, environmentId, api);

    private static SecurityRequestContext Context(
        bool production = false,
        bool productionAuthorized = false,
        bool mayActive = true,
        bool mayDestructive = true,
        int rps = 0,
        int inFlight = 0,
        int elapsed = 0,
        bool targetPolicy = true,
        string targetReason = "") => new(
        production, productionAuthorized, mayActive, mayDestructive,
        rps, inFlight, elapsed, targetPolicy, targetReason);

    // ---- Authorization ---------------------------------------------------

    [Fact]
    public void A_missing_scope_authorizes_nothing()
    {
        var decision = SecurityScopeGuard.Evaluate(null, Request(), Context());

        decision.Allowed.Should().BeFalse();
        decision.Reason.Should().Be(SecurityDenialReason.ScopeMissing);
        // The wording carries the principle, because this is the message somebody reads when
        // they wonder why their scan did nothing.
        decision.Explanation.Should().Contain("not permission");
    }

    [Fact]
    public void A_scope_that_exists_but_is_not_enabled_authorizes_nothing()
    {
        var decision = SecurityScopeGuard.Evaluate(Scope(enabled: false), Request(), Context());

        decision.Allowed.Should().BeFalse();
        decision.Reason.Should().Be(SecurityDenialReason.ScopeDisabled);
    }

    [Fact]
    public void A_scope_with_no_written_authorization_authorizes_nothing()
    {
        var decision = SecurityScopeGuard.Evaluate(Scope(authorized: false), Request(), Context());

        decision.Allowed.Should().BeFalse();
        decision.Reason.Should().Be(SecurityDenialReason.ScopeMissing);
    }

    // ---- Target policy ---------------------------------------------------

    [Fact]
    public void The_platforms_own_target_policy_is_not_second_guessed()
    {
        var decision = SecurityScopeGuard.Evaluate(
            Scope(domains: "169.254.169.254"),
            Request(url: "http://169.254.169.254/latest/meta-data/"),
            Context(targetPolicy: false, targetReason: "link-local (cloud metadata)"));

        decision.Allowed.Should().BeFalse();
        decision.Reason.Should().Be(SecurityDenialReason.UrlRefusedByTargetPolicy);
        // Even with the host explicitly allowlisted in the security scope. A scope cannot
        // widen the SSRF control; it can only narrow what the control already permits.
        decision.Explanation.Should().Contain("link-local");
    }

    // ---- Domain ----------------------------------------------------------

    [Fact]
    public void An_empty_domain_allowlist_permits_nothing()
    {
        var decision = SecurityScopeGuard.Evaluate(Scope(domains: ""), Request(), Context());

        decision.Allowed.Should().BeFalse();
        decision.Reason.Should().Be(SecurityDenialReason.DomainNotAllowed);
        decision.Explanation.Should().Contain("permits nothing");
    }

    [Fact]
    public void A_host_outside_the_allowlist_is_refused()
    {
        var decision = SecurityScopeGuard.Evaluate(
            Scope(domains: "app.test"),
            Request(url: "https://evil.test/dashboard"),
            Context());

        decision.Allowed.Should().BeFalse();
        decision.Reason.Should().Be(SecurityDenialReason.DomainNotAllowed);
    }

    [Fact]
    public void An_api_request_uses_the_api_allowlist_when_one_is_set()
    {
        var scope = Scope(domains: "app.test", apiDomains: "api.test");

        SecurityScopeGuard.Evaluate(scope, Request(url: "https://api.test/v1/accounts", api: true), Context())
            .Allowed.Should().BeTrue();

        // The web host is not automatically an API host once an API allowlist exists.
        SecurityScopeGuard.Evaluate(scope, Request(url: "https://app.test/v1/accounts", api: true), Context())
            .Allowed.Should().BeFalse();
    }

    [Fact]
    public void An_api_request_falls_back_to_the_web_allowlist_when_no_api_list_is_set()
    {
        SecurityScopeGuard.Evaluate(
            Scope(domains: "app.test", apiDomains: ""),
            Request(url: "https://app.test/api/accounts", api: true),
            Context()).Allowed.Should().BeTrue();
    }

    // ---- Path ------------------------------------------------------------

    [Theory]
    [InlineData("/api", "/api", true)]
    [InlineData("/api", "/api/accounts", true)]
    [InlineData("/api", "/apifoo", false)]          // not a quiet widening
    [InlineData("/api/*", "/api/accounts/1", true)]
    [InlineData("/api/*", "/api", true)]
    [InlineData("/api/*", "/other", false)]
    [InlineData("/dash*", "/dashboard", true)]
    [InlineData("*", "/anything", true)]
    public void Path_patterns_match_the_way_the_documentation_says(string pattern, string path, bool expected)
        => SecurityScopeGuard.PathMatches(path, pattern).Should().Be(expected);

    [Fact]
    public void A_path_outside_the_allowed_paths_is_refused()
    {
        var decision = SecurityScopeGuard.Evaluate(
            Scope(allowedPaths: "/login,/dashboard"),
            Request(url: "https://app.test/admin"),
            Context());

        decision.Allowed.Should().BeFalse();
        decision.Reason.Should().Be(SecurityDenialReason.PathNotAllowed);
    }

    [Fact]
    public void A_blocked_path_wins_over_an_allowed_one()
    {
        // Named in both lists. The narrower, more deliberate statement is the one somebody
        // meant, so it wins.
        var decision = SecurityScopeGuard.Evaluate(
            Scope(allowedPaths: "/admin/*", blockedPaths: "/admin/production-delete"),
            Request(url: "https://app.test/admin/production-delete"),
            Context());

        decision.Allowed.Should().BeFalse();
        decision.Reason.Should().Be(SecurityDenialReason.PathBlocked);
    }

    [Fact]
    public void An_empty_allowed_path_list_permits_any_path_under_an_allowed_domain()
    {
        SecurityScopeGuard.Evaluate(
            Scope(allowedPaths: ""),
            Request(url: "https://app.test/anything/at/all"),
            Context()).Allowed.Should().BeTrue();
    }

    // ---- Method raises risk ----------------------------------------------

    [Fact]
    public void A_delete_labelled_passive_is_still_treated_as_destructive()
    {
        // The label is a claim; the verb is a fact. A control that believes the claim is not
        // a control.
        var decision = SecurityScopeGuard.Evaluate(
            Scope(active: true, destructive: false),
            Request(method: "DELETE", risk: SecurityRisk.Passive, profile: SecurityProfile.Deep),
            Context());

        decision.Allowed.Should().BeFalse();
        decision.Reason.Should().Be(SecurityDenialReason.DestructiveTestingNotAllowed);
    }

    [Fact]
    public void A_post_labelled_passive_is_treated_as_state_changing()
    {
        var decision = SecurityScopeGuard.Evaluate(
            Scope(active: false),
            Request(method: "POST", risk: SecurityRisk.Passive),
            Context());

        decision.Allowed.Should().BeFalse();
        decision.Reason.Should().Be(SecurityDenialReason.ActiveTestingNotAllowed);
    }

    [Fact]
    public void A_request_with_no_method_is_refused()
    {
        SecurityScopeGuard.Evaluate(Scope(), Request(method: "  "), Context())
            .Reason.Should().Be(SecurityDenialReason.MethodNotAllowed);
    }

    // ---- Profiles ---------------------------------------------------------

    [Fact]
    public void The_passive_profile_runs_only_passive_requests()
    {
        SecurityScopeGuard.Evaluate(
            Scope(), Request(risk: SecurityRisk.Active, profile: SecurityProfile.Passive), Context())
            .Reason.Should().Be(SecurityDenialReason.ProfileDoesNotPermit);

        SecurityScopeGuard.Evaluate(
            Scope(), Request(risk: SecurityRisk.Passive, profile: SecurityProfile.Passive), Context())
            .Allowed.Should().BeTrue();
    }

    [Fact]
    public void The_standard_profile_stops_short_of_destructive()
    {
        SecurityScopeGuard.Evaluate(
            Scope(destructive: true),
            Request(method: "DELETE", profile: SecurityProfile.Standard),
            Context()).Reason.Should().Be(SecurityDenialReason.ProfileDoesNotPermit);
    }

    [Fact]
    public void The_deep_profile_runs_destructive_requests_when_the_scope_authorizes_them()
    {
        SecurityScopeGuard.Evaluate(
            Scope(destructive: true),
            Request(method: "DELETE", profile: SecurityProfile.Deep),
            Context()).Allowed.Should().BeTrue();
    }

    [Fact]
    public void The_regression_profile_never_runs_destructive_requests()
    {
        // Reproducing a confirmed finding can need active requests. It never needs a DELETE.
        SecurityScopeGuard.Evaluate(
            Scope(destructive: true),
            Request(method: "DELETE", profile: SecurityProfile.Regression),
            Context()).Reason.Should().Be(SecurityDenialReason.ProfileDoesNotPermit);
    }

    // ---- Caller permissions ----------------------------------------------

    [Fact]
    public void A_caller_without_the_active_scan_permission_gets_passive_only()
    {
        SecurityScopeGuard.Evaluate(
            Scope(), Request(risk: SecurityRisk.Active), Context(mayActive: false))
            .Reason.Should().Be(SecurityDenialReason.PermissionDenied);

        SecurityScopeGuard.Evaluate(
            Scope(), Request(risk: SecurityRisk.Passive), Context(mayActive: false))
            .Allowed.Should().BeTrue();
    }

    [Fact]
    public void A_caller_without_the_destructive_permission_cannot_run_one_even_where_the_scope_allows_it()
    {
        SecurityScopeGuard.Evaluate(
            Scope(destructive: true),
            Request(method: "DELETE", profile: SecurityProfile.Deep),
            Context(mayDestructive: false))
            .Reason.Should().Be(SecurityDenialReason.PermissionDenied);
    }

    // ---- Production -------------------------------------------------------

    [Fact]
    public void Production_is_refused_by_default()
    {
        SecurityScopeGuard.Evaluate(
            Scope(production: false),
            Request(risk: SecurityRisk.Passive),
            Context(production: true, productionAuthorized: true))
            .Reason.Should().Be(SecurityDenialReason.ProductionNotAuthorized);
    }

    [Fact]
    public void Production_needs_both_the_environment_and_the_scope_to_agree()
    {
        // Scope says yes, environment has not been authorized.
        SecurityScopeGuard.Evaluate(
            Scope(production: true),
            Request(risk: SecurityRisk.Passive),
            Context(production: true, productionAuthorized: false))
            .Reason.Should().Be(SecurityDenialReason.ProductionNotAuthorized);

        // Both say yes: observation is permitted.
        SecurityScopeGuard.Evaluate(
            Scope(production: true),
            Request(risk: SecurityRisk.Passive),
            Context(production: true, productionAuthorized: true))
            .Allowed.Should().BeTrue();
    }

    [Fact]
    public void State_changing_tests_are_never_run_against_production()
    {
        // Every switch set as permissively as it can be.
        var decision = SecurityScopeGuard.Evaluate(
            Scope(production: true, active: true, destructive: true),
            Request(method: "POST", profile: SecurityProfile.Deep),
            Context(production: true, productionAuthorized: true,
                    mayActive: true, mayDestructive: true));

        decision.Allowed.Should().BeFalse();
        decision.Reason.Should().Be(SecurityDenialReason.ProductionNotAuthorized);
        decision.Explanation.Should().Contain("never");
    }

    [Fact]
    public void A_scan_naming_a_different_environment_from_the_scope_is_refused()
    {
        var authorized = Guid.NewGuid();
        var other = Guid.NewGuid();

        SecurityScopeGuard.Evaluate(
            Scope(environmentId: authorized),
            Request(environmentId: other),
            Context()).Reason.Should().Be(SecurityDenialReason.ProductionNotAuthorized);
    }

    // ---- Rate, concurrency, duration --------------------------------------

    [Fact]
    public void The_request_rate_limit_is_enforced()
    {
        SecurityScopeGuard.Evaluate(Scope(rps: 5), Request(), Context(rps: 5))
            .Reason.Should().Be(SecurityDenialReason.RateLimitExceeded);

        SecurityScopeGuard.Evaluate(Scope(rps: 5), Request(), Context(rps: 4))
            .Allowed.Should().BeTrue();
    }

    [Fact]
    public void The_concurrency_limit_is_enforced()
    {
        SecurityScopeGuard.Evaluate(Scope(concurrent: 2), Request(), Context(inFlight: 2))
            .Reason.Should().Be(SecurityDenialReason.ConcurrencyLimitExceeded);
    }

    [Fact]
    public void The_scan_duration_limit_is_enforced()
    {
        SecurityScopeGuard.Evaluate(Scope(durationMinutes: 30), Request(), Context(elapsed: 30))
            .Reason.Should().Be(SecurityDenialReason.ScanDurationExceeded);
    }

    // ---- The order of refusals -------------------------------------------

    [Fact]
    public void The_first_true_reason_is_the_one_recorded()
    {
        // A request that breaches several rules at once. The recorded reason is what somebody
        // reads afterwards, and "aimed at the wrong host" is more useful than "also over its
        // rate limit".
        var decision = SecurityScopeGuard.Evaluate(
            Scope(domains: "app.test", rps: 1),
            Request(url: "https://evil.test/x", method: "DELETE"),
            Context(rps: 99, inFlight: 99, elapsed: 999));

        decision.Reason.Should().Be(SecurityDenialReason.DomainNotAllowed);
    }

    [Fact]
    public void A_refusal_records_how_far_it_got()
    {
        var decision = SecurityScopeGuard.Evaluate(
            Scope(allowedPaths: "/login"),
            Request(url: "https://app.test/admin"),
            Context());

        // Enough to see that authorization, the target policy and the domain were fine and
        // the path was not — which is the whole value of a blocked-request log.
        decision.ChecksPassed.Should().ContainInOrder("authorization", "target-policy", "domain");
        decision.ChecksPassed.Should().NotContain("path");
    }

    // ---- The permissive case ----------------------------------------------

    [Fact]
    public void A_request_that_satisfies_every_rule_is_allowed_and_says_so()
    {
        var decision = SecurityScopeGuard.Evaluate(
            Scope(domains: "app.test", allowedPaths: "/api/*", active: true),
            Request(url: "https://app.test/api/accounts", method: "GET", risk: SecurityRisk.Active),
            Context());

        decision.Allowed.Should().BeTrue();
        decision.Reason.Should().Be(SecurityDenialReason.None);
        decision.ChecksPassed.Should().ContainInOrder(
            "authorization", "target-policy", "domain", "path", "method", "risk", "environment", "rate");
    }
}
