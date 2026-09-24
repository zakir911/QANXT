namespace Aira.Application.Security;

/// <summary>
/// The canonical name of every security check, in one place.
/// </summary>
/// <remarks>
/// These strings are a contract between four things that must agree: the attack surface that
/// says which checks apply to a discovered endpoint, the change-impact selector that says
/// which to run after a change, the scan record that says which executed, and the gate that
/// reads coverage from that record. A check named one way in the selector and another way in
/// the scan record produces a gate that reports full coverage from a scan that ran nothing —
/// which is the failure this whole capability exists to prevent, arriving through a typo.
///
/// The JavaScript engine mirrors these in <c>verification/golden-tests/security/scenarios.mjs</c>,
/// and a golden test asserts the two lists are identical.
/// </remarks>
public static class SecurityChecks
{
    // Authorization
    public const string Bola = "authz.bola";
    public const string VerticalEscalation = "authz.vertical";
    public const string ReadOnlyWrite = "authz.readonly";
    public const string MissingAuthorization = "authz.missing";
    public const string TokenVerification = "authz.token";

    // Authentication and session
    public const string UserEnumeration = "auth.enumeration";
    public const string AccountLockout = "auth.lockout";
    public const string SessionInvalidation = "auth.session-logout";
    public const string SessionLifetime = "auth.session-lifetime";
    public const string ResetTokenReuse = "auth.reset-reuse";

    // API behaviour
    public const string MassAssignment = "api.mass-assignment";
    public const string InputValidation = "api.input-validation";
    public const string UnsafeMethod = "api.unsafe-method";
    public const string RateLimit = "api.rate-limit";
    public const string ExcessiveData = "api.excessive-data";

    // Cross-site scripting
    public const string ReflectedXss = "xss.reflected";
    public const string StoredXss = "xss.stored";
    public const string DomXss = "xss.dom";

    // Injection
    public const string SqlInjection = "injection.sql";
    public const string NoSqlInjection = "injection.nosql";
    public const string CommandInjection = "injection.command";
    public const string TemplateInjection = "injection.template";

    // Request handling
    public const string CsrfToken = "request.csrf";
    public const string OriginValidation = "request.origin";
    public const string UploadRestrictions = "request.upload";
    public const string OpenRedirect = "request.redirect";
    public const string Ssrf = "request.ssrf";

    // Passive
    public const string SecurityHeaders = "passive.headers";
    public const string Cookies = "passive.cookies";
    public const string Cors = "passive.cors";
    public const string SensitiveData = "passive.sensitive-data";
    public const string Misconfiguration = "passive.misconfiguration";

    public static IReadOnlyList<string> All { get; } = new[]
    {
        Bola, VerticalEscalation, ReadOnlyWrite, MissingAuthorization, TokenVerification,
        UserEnumeration, AccountLockout, SessionInvalidation, SessionLifetime, ResetTokenReuse,
        MassAssignment, InputValidation, UnsafeMethod, RateLimit, ExcessiveData,
        ReflectedXss, StoredXss, DomXss,
        SqlInjection, NoSqlInjection, CommandInjection, TemplateInjection,
        CsrfToken, OriginValidation, UploadRestrictions, OpenRedirect, Ssrf,
        SecurityHeaders, Cookies, Cors, SensitiveData, Misconfiguration
    };

    /// <summary>Checks that only a browser-driven scan can perform. Named so a response-only
    /// scan can report them as untested rather than silently omitting them.</summary>
    public static IReadOnlySet<string> RequiresBrowser { get; } = new HashSet<string> { DomXss };
}
