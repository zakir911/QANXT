using Aira.Domain.Security;

namespace Aira.Application.Security;

/// <summary>One security request, described in the terms the guard decides on.</summary>
public sealed record SecurityRequest(
    string Url,
    string Method,
    SecurityRisk Risk,
    SecurityProfile Profile,
    Guid? EnvironmentId = null,
    bool IsApiRequest = false,
    string? TestId = null);

/// <summary>The scope as the guard reads it: parsed, with the comma-separated fields split.</summary>
/// <remarks>
/// A separate shape from the entity so the guard stays a pure function over plain data. That
/// is what lets every branch be exercised in a unit test without a database, which for a
/// control that stands between the platform and somebody else's application is not a
/// nicety.
/// </remarks>
public sealed record SecurityScopeView(
    bool Enabled,
    IReadOnlyList<string> AllowedDomains,
    IReadOnlyList<string> AllowedApiDomains,
    IReadOnlyList<string> AllowedPaths,
    IReadOnlyList<string> BlockedPaths,
    Guid? EnvironmentId,
    int MaxRequestsPerSecond,
    int MaxConcurrentRequests,
    int MaxScanDurationMinutes,
    bool AllowActiveTesting,
    bool AllowDestructiveTesting,
    bool AllowProduction,
    bool HasAuthorizationNote)
{
    public static SecurityScopeView From(SecurityScope scope) => new(
        scope.Enabled,
        Split(scope.AllowedDomains),
        Split(scope.AllowedApiDomains),
        Split(scope.AllowedPaths),
        Split(scope.BlockedPaths),
        scope.EnvironmentId,
        scope.MaxRequestsPerSecond,
        scope.MaxConcurrentRequests,
        scope.MaxScanDurationMinutes,
        scope.AllowActiveTesting,
        scope.AllowDestructiveTesting,
        scope.AllowProduction,
        !string.IsNullOrWhiteSpace(scope.AuthorizationNote));

    private static IReadOnlyList<string> Split(string? value) =>
        string.IsNullOrWhiteSpace(value)
            ? Array.Empty<string>()
            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}

/// <summary>Context the guard needs that is not part of the scope itself.</summary>
public sealed record SecurityRequestContext(
    bool IsProductionEnvironment,
    bool ProductionTestingAuthorized,
    bool CallerMayRunActiveScans,
    bool CallerMayRunDestructiveScans,
    int RequestsInLastSecond = 0,
    int RequestsInFlight = 0,
    int ScanElapsedMinutes = 0,
    bool TargetPolicyAllows = true,
    string TargetPolicyReason = "");

/// <summary>What the guard decided, and everything it checked to decide it.</summary>
/// <param name="ChecksPassed">In order. Present so a refusal can be read as "it got this far",
/// which is what makes a blocked-request log worth keeping.</param>
public sealed record SecurityScopeDecision(
    bool Allowed,
    SecurityDenialReason Reason,
    string Explanation,
    IReadOnlyList<string> ChecksPassed)
{
    public static SecurityScopeDecision Allow(IReadOnlyList<string> checks) =>
        new(true, SecurityDenialReason.None, "Within scope.", checks);

    public static SecurityScopeDecision Deny(
        SecurityDenialReason reason, string explanation, IReadOnlyList<string> checks) =>
        new(false, reason, explanation, checks);
}

/// <summary>
/// The control every security request passes before it is issued.
/// </summary>
/// <remarks>
/// Deny by default, in the strong sense: there is no path through this function that returns
/// <c>Allow</c> without every check having run and passed. A missing scope, a disabled scope,
/// an empty allowlist and an unrecognised risk all refuse.
///
/// The order is not arbitrary. Cheap identity checks come before expensive permission ones so
/// a request aimed at the wrong host is refused for that reason rather than for a rate limit
/// it also happened to breach — the recorded reason is what somebody reads afterwards, and
/// the first true reason is the useful one.
///
/// It is a pure function. It touches no clock, no database and no network, takes its counters
/// as arguments, and returns a decision rather than performing one. Anything that wants to
/// issue a request has to ask first and cannot accidentally proceed on a decision it did not
/// read.
/// </remarks>
public static class SecurityScopeGuard
{
    /// <summary>Methods that change state, whatever the caller labelled the risk.</summary>
    private static readonly HashSet<string> MutatingMethods =
        new(StringComparer.OrdinalIgnoreCase) { "POST", "PUT", "PATCH", "DELETE" };

    /// <summary>Methods that cannot be assumed reversible.</summary>
    private static readonly HashSet<string> DestructiveMethods =
        new(StringComparer.OrdinalIgnoreCase) { "DELETE" };

    public static SecurityScopeDecision Evaluate(
        SecurityScopeView? scope, SecurityRequest request, SecurityRequestContext context)
    {
        var passed = new List<string>();

        // ---- 0. Is there an authorization at all -----------------------------
        if (scope is null)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.ScopeMissing,
                "This application has no security scope. Nobody has authorized security testing "
                + "against it, and the absence of a restriction is not permission.", passed);
        }
        if (!scope.Enabled)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.ScopeDisabled,
                "The application's security scope exists but is not enabled.", passed);
        }
        if (!scope.HasAuthorizationNote)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.ScopeMissing,
                "The security scope carries no written authorization. A scan nobody can point at "
                + "an authorization for is one nobody should have run.", passed);
        }
        passed.Add("authorization");

        // ---- 1. The URL must be one the platform would open at all -----------
        // The existing target policy is the SSRF control and is not duplicated here; the
        // security engine is subject to it exactly as the crawler is, and a second
        // implementation would be a second place for it to be wrong.
        if (!context.TargetPolicyAllows)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.UrlRefusedByTargetPolicy,
                $"The platform's target policy refuses this URL: {context.TargetPolicyReason}", passed);
        }
        if (!Uri.TryCreate(request.Url, UriKind.Absolute, out var uri))
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.DomainNotAllowed,
                "The URL is not absolute, so no host could be checked against the scope.", passed);
        }
        passed.Add("target-policy");

        // ---- 2. Domain -------------------------------------------------------
        var domains = request.IsApiRequest && scope.AllowedApiDomains.Count > 0
            ? scope.AllowedApiDomains
            : scope.AllowedDomains;

        if (domains.Count == 0)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.DomainNotAllowed,
                "The security scope names no allowed domains. An empty allowlist permits nothing.", passed);
        }
        if (!TargetUrlGuard.MatchesAllowlist(uri.Host, domains))
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.DomainNotAllowed,
                $"Host '{uri.Host}' is not in the security scope's allowed "
                + $"{(request.IsApiRequest && scope.AllowedApiDomains.Count > 0 ? "API " : string.Empty)}domains.", passed);
        }
        passed.Add("domain");

        // ---- 3. Path ---------------------------------------------------------
        // Blocked first. A path named in both lists is blocked: the narrower, more
        // deliberate statement wins, and somebody who wrote a path into BlockedPaths meant it.
        var path = uri.AbsolutePath;
        foreach (var blocked in scope.BlockedPaths)
        {
            if (PathMatches(path, blocked))
            {
                return SecurityScopeDecision.Deny(SecurityDenialReason.PathBlocked,
                    $"Path '{path}' is blocked by the security scope (pattern '{blocked}').", passed);
            }
        }
        if (scope.AllowedPaths.Count > 0 && !scope.AllowedPaths.Any(p => PathMatches(path, p)))
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.PathNotAllowed,
                $"Path '{path}' is not in the security scope's allowed paths.", passed);
        }
        passed.Add("path");

        // ---- 4. Method, and the risk the method actually implies --------------
        var method = (request.Method ?? string.Empty).Trim();
        if (method.Length == 0)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.MethodNotAllowed,
                "The request names no HTTP method.", passed);
        }

        // The caller declares a risk; the method can only raise it. A DELETE labelled
        // Passive is treated as Destructive, because the label is a claim and the verb is a
        // fact, and a control that believes the claim is not a control.
        var effectiveRisk = request.Risk;
        if (DestructiveMethods.Contains(method) && effectiveRisk < SecurityRisk.Destructive)
            effectiveRisk = SecurityRisk.Destructive;
        else if (MutatingMethods.Contains(method) && effectiveRisk < SecurityRisk.StateChanging)
            effectiveRisk = SecurityRisk.StateChanging;
        passed.Add("method");

        // ---- 5. Risk against what the scope and the profile authorize ---------
        if (!ProfilePermits(request.Profile, effectiveRisk))
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.ProfileDoesNotPermit,
                $"The {request.Profile.ToString().ToLowerInvariant()} profile does not run "
                + $"{effectiveRisk.ToString().ToLowerInvariant()} requests.", passed);
        }

        if (effectiveRisk >= SecurityRisk.Active && !scope.AllowActiveTesting)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.ActiveTestingNotAllowed,
                "The security scope does not permit active testing, so only observation of what "
                + "the application already serves is allowed.", passed);
        }
        if (effectiveRisk >= SecurityRisk.Destructive && !scope.AllowDestructiveTesting)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.DestructiveTestingNotAllowed,
                $"A {method} request is destructive and the security scope does not permit "
                + "destructive testing.", passed);
        }
        if (effectiveRisk >= SecurityRisk.Active && !context.CallerMayRunActiveScans)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.PermissionDenied,
                "This account may run passive scans but not active ones.", passed);
        }
        if (effectiveRisk >= SecurityRisk.Destructive && !context.CallerMayRunDestructiveScans)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.PermissionDenied,
                "This account may not run destructive security tests.", passed);
        }
        passed.Add("risk");

        // ---- 6. Environment ---------------------------------------------------
        if (scope.EnvironmentId is not null && request.EnvironmentId is not null
            && scope.EnvironmentId != request.EnvironmentId)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.ProductionNotAuthorized,
                "This scan names a different environment from the one the security scope "
                + "authorizes. A scope is written for one environment and does not carry over.", passed);
        }
        if (context.IsProductionEnvironment)
        {
            if (!scope.AllowProduction)
            {
                return SecurityScopeDecision.Deny(SecurityDenialReason.ProductionNotAuthorized,
                    "This is a production environment and the security scope does not authorize "
                    + "testing it. Production security testing is off by default.", passed);
            }
            if (!context.ProductionTestingAuthorized)
            {
                return SecurityScopeDecision.Deny(SecurityDenialReason.ProductionNotAuthorized,
                    "This is a production environment and testing it has not been authorized on "
                    + "the environment itself. Both the environment and the security scope have "
                    + "to say yes.", passed);
            }
            // Even with both, production gets observation only unless somebody has said
            // otherwise in the scope. Two independent switches, because production is the
            // case where a mistake is least recoverable.
            if (effectiveRisk >= SecurityRisk.StateChanging)
            {
                return SecurityScopeDecision.Deny(SecurityDenialReason.ProductionNotAuthorized,
                    "State-changing security tests are never run against production by this "
                    + "platform, whatever the scope allows elsewhere.", passed);
            }
        }
        passed.Add("environment");

        // ---- 7. Rate, concurrency, duration -----------------------------------
        if (scope.MaxRequestsPerSecond > 0 && context.RequestsInLastSecond >= scope.MaxRequestsPerSecond)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.RateLimitExceeded,
                $"The scan is at its limit of {scope.MaxRequestsPerSecond} request(s) per second.", passed);
        }
        if (scope.MaxConcurrentRequests > 0 && context.RequestsInFlight >= scope.MaxConcurrentRequests)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.ConcurrencyLimitExceeded,
                $"The scan already has {context.RequestsInFlight} request(s) in flight, at its "
                + $"limit of {scope.MaxConcurrentRequests}.", passed);
        }
        if (scope.MaxScanDurationMinutes > 0 && context.ScanElapsedMinutes >= scope.MaxScanDurationMinutes)
        {
            return SecurityScopeDecision.Deny(SecurityDenialReason.ScanDurationExceeded,
                $"The scan has run for {context.ScanElapsedMinutes} minute(s), at its limit of "
                + $"{scope.MaxScanDurationMinutes}.", passed);
        }
        passed.Add("rate");

        return SecurityScopeDecision.Allow(passed);
    }

    /// <summary>Which risks each profile runs. Regression is the odd one: it runs whatever a
    /// confirmed finding needs to reproduce, which can be active, but never destructive.</summary>
    private static bool ProfilePermits(SecurityProfile profile, SecurityRisk risk) => profile switch
    {
        SecurityProfile.Passive => risk == SecurityRisk.Passive,
        SecurityProfile.Standard => risk <= SecurityRisk.StateChanging,
        SecurityProfile.Deep => true,
        SecurityProfile.Regression => risk <= SecurityRisk.StateChanging,
        SecurityProfile.Custom => true,
        _ => false
    };

    /// <summary>Matches a path against a scope pattern. <c>*</c> at the end matches any
    /// remainder; anything else is an exact match or a match on the whole segment prefix.</summary>
    public static bool PathMatches(string path, string pattern)
    {
        pattern = (pattern ?? string.Empty).Trim();
        if (pattern.Length == 0) return false;
        if (pattern == "*" || pattern == "/*") return true;

        if (pattern.EndsWith("/*", StringComparison.Ordinal))
        {
            var prefix = pattern[..^2];
            return path.Equals(prefix, StringComparison.OrdinalIgnoreCase)
                || path.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase);
        }
        if (pattern.EndsWith('*'))
        {
            return path.StartsWith(pattern[..^1], StringComparison.OrdinalIgnoreCase);
        }

        // No wildcard: exact, or the pattern as a whole path segment prefix. "/api" matches
        // "/api" and "/api/accounts" but not "/apifoo", which would be a quiet widening of
        // the allowlist nobody asked for.
        return path.Equals(pattern, StringComparison.OrdinalIgnoreCase)
            || path.StartsWith(pattern.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase);
    }
}
