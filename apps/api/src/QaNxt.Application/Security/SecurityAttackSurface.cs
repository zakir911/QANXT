using QaNxt.Domain.Enums;

namespace QaNxt.Application.Security;

public enum SecuritySurfaceKind { Page = 0, Endpoint = 1 }

/// <summary>One thing in the application worth pointing a security check at.</summary>
public sealed record SecuritySurfaceItem(
    SecuritySurfaceKind Kind,
    Guid Id,
    string Identifier,
    string? HttpMethod,
    bool RequiresAuthentication,
    bool ChangesState,
    bool AcceptsInput,
    bool AcceptsFileUpload,
    bool CarriesObjectIdentifier,
    bool CarriesUrlParameter,
    IReadOnlyList<string> Parameters,
    IReadOnlyList<string> RelevantChecks,
    /// <summary>Why it is here, in the terms a reader can disagree with.</summary>
    string Why);

/// <summary>What discovery found that is worth security testing, and what that does not cover.</summary>
public sealed record SecurityAttackSurface(
    Guid ApplicationId,
    IReadOnlyList<SecuritySurfaceItem> Items,
    int PagesInGraph,
    int EndpointsInGraph,
    DateTimeOffset? GraphLastSeenAt,
    IReadOnlyList<string> Caveats,
    IReadOnlyList<string> ChecksImplied,
    string Summary);

/// <summary>
/// Derives a security attack surface from the application knowledge graph.
/// </summary>
/// <remarks>
/// <para>
/// The graph already records what discovery walked: pages, their elements, the API calls the
/// UI made and whether each needed a session. That is most of what deciding where to point a
/// security check requires, and until now nothing read it for that purpose — scans went where
/// a scenario named rather than where the application actually is.
/// </para>
/// <para>
/// The single most important thing in this file is the caveat list. A surface derived from a
/// crawl that reached eleven pages is not the application's attack surface; it is the part of
/// it discovery happened to walk. Every consumer of this type gets that sentence alongside the
/// items, because a security tool that presents a partial surface as the surface teaches a
/// team that the places it did not look do not exist.
/// </para>
/// <para>
/// Pure and static on purpose. It takes the graph and returns the derivation, so the rules can
/// be argued with in a unit test rather than inferred from a database.
/// </para>
/// </remarks>
public static class SecurityAttackSurfaceBuilder
{
    private static readonly HashSet<string> MutatingMethods =
        new(StringComparer.OrdinalIgnoreCase) { "POST", "PUT", "PATCH", "DELETE" };

    private static readonly HashSet<string> BodyBindingMethods =
        new(StringComparer.OrdinalIgnoreCase) { "POST", "PUT", "PATCH" };

    /// <summary>Parameter names that name somewhere to go or something to fetch.</summary>
    private static readonly string[] RedirectishNames =
        { "url", "uri", "next", "redirect", "redirecturl", "returnurl", "return_to", "continue",
          "callback", "dest", "destination", "target", "link", "fetch", "image", "src", "path" };

    /// <summary>Page routes and endpoint templates that look like authentication.</summary>
    private static readonly string[] Authenticationish =
        { "login", "signin", "sign-in", "session", "auth", "token", "password", "reset", "forgot",
          "register", "signup", "sign-up", "mfa", "otp", "verify" };

    public sealed record PageInput(
        Guid Id, string Route, string NormalizedUrl, PageKind Kind,
        bool RequiresAuthentication, DateTimeOffset LastSeenAt,
        IReadOnlyList<ElementInput> Elements);

    public sealed record ElementInput(ElementKind Kind, string? Name, string? Type, string? Label);

    public sealed record EndpointInput(
        Guid Id, string Method, string UrlTemplate, string SampleUrl,
        bool RequiresAuthentication, string? RequestContentType, string? RequestSampleJson,
        DateTimeOffset LastSeenAt);

    public static SecurityAttackSurface Build(
        Guid applicationId,
        IReadOnlyCollection<PageInput> pages,
        IReadOnlyCollection<EndpointInput> endpoints)
    {
        var items = new List<SecuritySurfaceItem>();

        foreach (var page in pages) items.Add(FromPage(page));
        foreach (var endpoint in endpoints) items.Add(FromEndpoint(endpoint));

        var implied = items.SelectMany(i => i.RelevantChecks).Distinct().OrderBy(c => c).ToList();
        var lastSeen = pages.Select(p => p.LastSeenAt)
            .Concat(endpoints.Select(e => e.LastSeenAt))
            .DefaultIfEmpty()
            .Max();

        var caveats = BuildCaveats(pages, endpoints, implied);

        return new SecurityAttackSurface(
            applicationId, items, pages.Count, endpoints.Count,
            lastSeen == default ? null : lastSeen,
            caveats, implied,
            Summarise(items, pages.Count, endpoints.Count, implied.Count, caveats.Count));
    }

    // -----------------------------------------------------------------------

    private static SecuritySurfaceItem FromPage(PageInput page)
    {
        var inputs = page.Elements.Where(IsInput).ToList();
        var files = page.Elements.Any(e => e.Kind == ElementKind.FileInput
            || string.Equals(e.Type, "file", StringComparison.OrdinalIgnoreCase));
        var parameters = inputs.Select(e => e.Name ?? e.Label ?? e.Type ?? "unnamed")
            .Where(n => !string.IsNullOrWhiteSpace(n)).Distinct().ToList();

        var checks = new SortedSet<string>
        {
            // Every page a browser can reach carries headers and, usually, a cookie.
            SecurityChecks.SecurityHeaders,
            SecurityChecks.Cookies,
            SecurityChecks.SensitiveData,
            // And every page can read the fragment it was opened with. DOM XSS takes its
            // source from location.hash, location.search, document.referrer or window.name —
            // none of which is a form input — so implying it only where a form was found
            // missed exactly the pages this check exists for: the ones whose only input
            // arrives through the URL.
            SecurityChecks.DomXss
        };

        var reasons = new List<string> { "a page discovery reached" };

        if (inputs.Count > 0)
        {
            checks.Add(SecurityChecks.ReflectedXss);
            checks.Add(SecurityChecks.StoredXss);
            reasons.Add($"{inputs.Count} input element(s)");
        }
        if (files)
        {
            checks.Add(SecurityChecks.UploadRestrictions);
            reasons.Add("a file input");
        }
        if (IsAuthenticationish(page.Route) || page.Kind == PageKind.Login)
        {
            checks.Add(SecurityChecks.UserEnumeration);
            checks.Add(SecurityChecks.AccountLockout);
            checks.Add(SecurityChecks.SessionInvalidation);
            checks.Add(SecurityChecks.SessionLifetime);
            reasons.Add("it looks like authentication");
        }
        if (page.RequiresAuthentication)
        {
            checks.Add(SecurityChecks.MissingAuthorization);
            reasons.Add("it needs a session");
        }

        return new SecuritySurfaceItem(
            SecuritySurfaceKind.Page, page.Id,
            string.IsNullOrWhiteSpace(page.Route) ? page.NormalizedUrl : page.Route,
            HttpMethod: "GET",
            RequiresAuthentication: page.RequiresAuthentication,
            ChangesState: false,
            AcceptsInput: inputs.Count > 0,
            AcceptsFileUpload: files,
            CarriesObjectIdentifier: HasPlaceholder(page.NormalizedUrl),
            CarriesUrlParameter: false,
            Parameters: parameters,
            RelevantChecks: checks.ToList(),
            Why: string.Join("; ", reasons));
    }

    private static SecuritySurfaceItem FromEndpoint(EndpointInput endpoint)
    {
        var method = endpoint.Method.ToUpperInvariant();
        var mutates = MutatingMethods.Contains(method);
        var takesBody = BodyBindingMethods.Contains(method);
        var identifier = HasPlaceholder(endpoint.UrlTemplate);
        var query = QueryParameters(endpoint.SampleUrl);
        var bodyFields = BodyFields(endpoint.RequestSampleJson);
        var parameters = query.Concat(bodyFields).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var redirectish = parameters.Any(p => RedirectishNames.Contains(p.ToLowerInvariant()));
        var multipart = endpoint.RequestContentType?.Contains("multipart", StringComparison.OrdinalIgnoreCase) == true;

        var checks = new SortedSet<string> { SecurityChecks.SensitiveData, SecurityChecks.Cors };
        var reasons = new List<string> { $"an API call discovery observed ({method})" };

        if (endpoint.RequiresAuthentication)
        {
            checks.Add(SecurityChecks.MissingAuthorization);
            checks.Add(SecurityChecks.TokenVerification);
            checks.Add(SecurityChecks.ExcessiveData);
            reasons.Add("it needs a session");

            if (identifier)
            {
                // An authenticated endpoint that takes an object id is the BOLA shape, and
                // BOLA is the highest-priority capability in the brief.
                checks.Add(SecurityChecks.Bola);
                reasons.Add("it takes an object identifier");
            }
            else
            {
                // An authenticated collection is where a lesser role reaching a privileged
                // route shows up.
                checks.Add(SecurityChecks.VerticalEscalation);
            }
        }
        else
        {
            // Unauthenticated and returning something is exactly what missing authorization
            // looks like from outside, so it is worth checking rather than assumed public.
            checks.Add(SecurityChecks.MissingAuthorization);
            reasons.Add("it answered without a session");
        }

        if (mutates)
        {
            checks.Add(SecurityChecks.CsrfToken);
            checks.Add(SecurityChecks.OriginValidation);
            checks.Add(SecurityChecks.ReadOnlyWrite);
            reasons.Add("it changes state");
        }
        if (takesBody)
        {
            checks.Add(SecurityChecks.InputValidation);
            checks.Add(SecurityChecks.MassAssignment);
            checks.Add(SecurityChecks.NoSqlInjection);
            checks.Add(SecurityChecks.StoredXss);
        }
        if (string.Equals(method, "DELETE", StringComparison.OrdinalIgnoreCase))
        {
            checks.Add(SecurityChecks.UnsafeMethod);
            reasons.Add("it is a destructive verb");
        }
        if (query.Count > 0)
        {
            checks.Add(SecurityChecks.ReflectedXss);
            checks.Add(SecurityChecks.SqlInjection);
            checks.Add(SecurityChecks.CommandInjection);
            checks.Add(SecurityChecks.TemplateInjection);
            checks.Add(SecurityChecks.RateLimit);
            reasons.Add($"{query.Count} query parameter(s)");
        }
        if (redirectish)
        {
            checks.Add(SecurityChecks.OpenRedirect);
            checks.Add(SecurityChecks.Ssrf);
            reasons.Add("a parameter names a destination");
        }
        if (multipart)
        {
            checks.Add(SecurityChecks.UploadRestrictions);
            reasons.Add("it accepts a file");
        }
        if (IsAuthenticationish(endpoint.UrlTemplate))
        {
            checks.Add(SecurityChecks.UserEnumeration);
            checks.Add(SecurityChecks.AccountLockout);
            checks.Add(SecurityChecks.SessionInvalidation);
            checks.Add(SecurityChecks.SessionLifetime);
            checks.Add(SecurityChecks.ResetTokenReuse);
            reasons.Add("it looks like authentication");
        }

        return new SecuritySurfaceItem(
            SecuritySurfaceKind.Endpoint, endpoint.Id, endpoint.UrlTemplate, method,
            endpoint.RequiresAuthentication, mutates,
            AcceptsInput: parameters.Count > 0,
            AcceptsFileUpload: multipart,
            CarriesObjectIdentifier: identifier,
            CarriesUrlParameter: redirectish,
            Parameters: parameters,
            RelevantChecks: checks.ToList(),
            Why: string.Join("; ", reasons));
    }

    // -----------------------------------------------------------------------

    /// <summary>
    /// What this surface does not cover.
    /// </summary>
    /// <remarks>
    /// Always non-empty. The first caveat is unconditional, because the most misleading thing
    /// this type could do is present the part of an application discovery walked as the
    /// application. A reader who takes the list of items as complete will treat everywhere
    /// else as safe, and nothing here has looked at anywhere else.
    /// </remarks>
    private static List<string> BuildCaveats(
        IReadOnlyCollection<PageInput> pages,
        IReadOnlyCollection<EndpointInput> endpoints,
        IReadOnlyCollection<string> implied)
    {
        var caveats = new List<string>
        {
            "This is what discovery walked, not the application. Anything a crawl did not reach "
            + "is absent from this surface and is untested rather than safe."
        };

        if (pages.Count == 0 && endpoints.Count == 0)
        {
            caveats.Add("The knowledge graph is empty. Run discovery before reading anything into "
                      + "this surface.");
            return caveats;
        }
        if (endpoints.Count == 0)
        {
            caveats.Add("No API calls were observed. Either the application makes none, or discovery "
                      + "did not exercise the journeys that do — and those are very different.");
        }
        if (pages.All(p => !p.RequiresAuthentication) && endpoints.All(e => !e.RequiresAuthentication))
        {
            caveats.Add("Nothing in the graph required a session, so no authenticated surface was "
                      + "discovered. If the application has one, discovery did not sign in.");
        }
        if (!implied.Contains(SecurityChecks.UserEnumeration))
        {
            caveats.Add("No authentication surface was recognised, so the authentication and session "
                      + "checks are not implied by anything here.");
        }
        if (implied.Contains(SecurityChecks.DomXss))
        {
            caveats.Add("DOM-based XSS is decided in a browser rather than from a response, so it "
                      + "executes only where a scan has one. A scan that could not start a browser "
                      + "reports it untested rather than clean.");
        }

        return caveats;
    }

    private static string Summarise(
        IReadOnlyCollection<SecuritySurfaceItem> items,
        int pages, int endpoints, int checks, int caveats)
    {
        if (items.Count == 0)
        {
            return "Nothing has been discovered for this application, so there is no attack surface "
                 + "to describe. That is a statement about discovery, not about the application.";
        }

        var authenticated = items.Count(i => i.RequiresAuthentication);
        var mutating = items.Count(i => i.ChangesState);
        var withInput = items.Count(i => i.AcceptsInput);

        return $"{items.Count} item(s) from {pages} page(s) and {endpoints} endpoint(s): "
             + $"{authenticated} behind a session, {mutating} that change state, {withInput} that take "
             + $"input. Together they imply {checks} security check(s). {caveats} caveat(s) apply, and "
             + "the first of them is that this describes what discovery walked rather than the "
             + "application.";
    }

    // -----------------------------------------------------------------------

    private static bool IsInput(ElementInput element) => element.Kind is
        ElementKind.TextInput or ElementKind.PasswordInput or ElementKind.NumberInput
        or ElementKind.DateInput or ElementKind.TextArea or ElementKind.Select
        or ElementKind.FileInput or ElementKind.Checkbox or ElementKind.Radio;

    private static bool HasPlaceholder(string? template)
        => template?.Contains('{') == true && template.Contains('}');

    private static bool IsAuthenticationish(string? value)
        => value is not null
           && Authenticationish.Any(word => value.Contains(word, StringComparison.OrdinalIgnoreCase));

    private static List<string> QueryParameters(string? sampleUrl)
    {
        if (string.IsNullOrWhiteSpace(sampleUrl)) return new List<string>();
        var index = sampleUrl.IndexOf('?');
        if (index < 0 || index == sampleUrl.Length - 1) return new List<string>();

        return sampleUrl[(index + 1)..]
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(pair => pair.Split('=')[0])
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>
    /// Top-level field names from a captured request body.
    /// </summary>
    /// <remarks>
    /// Names only, never values. The sample is already masked at capture, and reading values
    /// here would put them in a second place that has to be masked correctly — one is enough.
    /// </remarks>
    private static List<string> BodyFields(string? requestSampleJson)
    {
        if (string.IsNullOrWhiteSpace(requestSampleJson)) return new List<string>();
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(requestSampleJson);
            if (document.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object)
                return new List<string>();
            return document.RootElement.EnumerateObject().Select(p => p.Name).ToList();
        }
        catch (System.Text.Json.JsonException)
        {
            // A body that is not JSON tells us nothing about its fields, and guessing at them
            // would put invented parameter names into a security report.
            return new List<string>();
        }
    }
}
