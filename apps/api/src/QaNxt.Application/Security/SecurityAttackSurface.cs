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

    /// <param name="Url">
    /// The address the page was actually served at, query string and all.
    ///
    /// A page's route is its path — `/view.asp` — and a page reached by a query parameter is
    /// only served at `/view.asp?id=1`. Pointing the scan at the route alone asked for a URL
    /// the application does not serve: on a permit register, `/view.asp` answers "no such
    /// permit", so the header checks measured that 404 and the personal-data check looked at
    /// a page holding nothing. The same mistake as appending a path to a base URL that has
    /// one, in a different place.
    ///
    /// Used as the target where the route alone cannot reach the page. Ordinary pages are
    /// still named by their route, which is what a reader wants to see in a report.
    /// </param>
    public sealed record PageInput(
        Guid Id, string Route, string NormalizedUrl, PageKind Kind,
        bool RequiresAuthentication, DateTimeOffset LastSeenAt,
        IReadOnlyList<ElementInput> Elements,
        string? Url = null);

    public sealed record ElementInput(ElementKind Kind, string? Name, string? Type, string? Label);

    public sealed record EndpointInput(
        Guid Id, string Method, string UrlTemplate, string SampleUrl,
        bool RequiresAuthentication, string? RequestContentType, string? RequestSampleJson,
        DateTimeOffset LastSeenAt);

    /// <summary>A form discovery found, as the application declares it submits.</summary>
    /// <remarks>
    /// A third source of surface, and for the write checks the only reliable one.
    ///
    /// Discovery never submits a form — it must not, because submitting one changes the
    /// application — so the only requests it observes against an API are the reads. Every
    /// endpoint was therefore recorded as a GET, every GET is non-mutating, and every check
    /// that needs a write endpoint was skipped for the endpoints that actually write: CSRF,
    /// origin validation, read-only enforcement, mass assignment and stored XSS. A scan of a
    /// clinical scheduler ran read-only enforcement against its sign-in endpoint and nothing
    /// else, on an application whose booking endpoint any signed-in role could post to.
    ///
    /// A form carrying `method="post" action="/api/appointments"` is the application stating
    /// where it writes, which is better evidence than an observed request rather than worse.
    /// Nothing is sent to find out: the declaration is read from the page.
    /// </remarks>
    public sealed record FormInput(
        Guid Id, string Route, string? Action, string Method, string PageUrl,
        bool HasCsrfToken, bool RequiresAuthentication, DateTimeOffset LastSeenAt);

    /// <summary>
    /// Where the application signs in, as its owner configured it.
    ///
    /// A fourth source of surface, for the one endpoint a crawl structurally cannot find.
    /// The sign-in is performed by the authenticator before the crawl starts, so it is never
    /// an observed request; and an application whose sign-in is a JSON endpoint rather than a
    /// page has no login page to classify either. Measured on an order API: the endpoint that
    /// issues its tokens was on no surface, so every authentication check — user enumeration,
    /// lockout, session lifetime — was unimplied, against the single most attacked address in
    /// any application.
    ///
    /// It is a declaration, not a discovery: somebody typed it in, which is why it can be
    /// trusted and why nothing is sent to find it.
    /// </summary>
    public sealed record SignInInput(string Endpoint, DateTimeOffset LastSeenAt);

    public static SecurityAttackSurface Build(
        Guid applicationId,
        IReadOnlyCollection<PageInput> pages,
        IReadOnlyCollection<EndpointInput> endpoints,
        IReadOnlyCollection<FormInput>? forms = null,
        SignInInput? signIn = null)
    {
        var items = new List<SecuritySurfaceItem>();

        foreach (var page in pages) items.Add(FromPage(page));
        foreach (var endpoint in endpoints) items.Add(FromEndpoint(endpoint));

        // Only where the form declares a write, and only where no observed endpoint already
        // covers the same verb and address: an endpoint seen in flight carries a sample
        // payload and a content type, which is strictly more to work with.
        var declared = (forms ?? Array.Empty<FormInput>())
            .Select(DeclaredEndpoint)
            .Where(e => e is not null)
            .Select(e => e!)
            .Where(e => !endpoints.Any(seen =>
                string.Equals(seen.Method, e.Method, StringComparison.OrdinalIgnoreCase)
                && string.Equals(NormalizeTemplate(seen.UrlTemplate), NormalizeTemplate(e.UrlTemplate), StringComparison.OrdinalIgnoreCase)))
            .GroupBy(e => $"{e.Method} {NormalizeTemplate(e.UrlTemplate)}", StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .ToList();
        foreach (var endpoint in declared) items.Add(FromEndpoint(endpoint));

        // The sign-in, when its owner told us where it is and neither discovery nor a form
        // already covers it. POST, because that is what a sign-in is, and that verb is what
        // makes the write checks apply to it as well as the authentication ones.
        var signInEndpoint = SignInEndpoint(signIn);
        if (signInEndpoint is not null
            && !endpoints.Concat(declared).Any(seen =>
                string.Equals(NormalizeTemplate(seen.UrlTemplate), NormalizeTemplate(signInEndpoint.UrlTemplate),
                    StringComparison.OrdinalIgnoreCase)))
        {
            items.Add(FromEndpoint(signInEndpoint));
        }
        else
        {
            signInEndpoint = null;
        }

        var implied = items.SelectMany(i => i.RelevantChecks).Distinct().OrderBy(c => c).ToList();
        var lastSeen = pages.Select(p => p.LastSeenAt)
            .Concat(endpoints.Select(e => e.LastSeenAt))
            .Concat(declared.Select(e => e.LastSeenAt))
            .DefaultIfEmpty()
            .Max();
        var extra = declared.Count + (signInEndpoint is null ? 0 : 1);

        var caveats = BuildCaveats(pages, endpoints, implied);

        return new SecurityAttackSurface(
            applicationId, items, pages.Count, endpoints.Count + extra,
            lastSeen == default ? null : lastSeen,
            caveats, implied,
            Summarise(items, pages.Count, endpoints.Count + extra, implied.Count, caveats.Count));
    }

    /// <summary>
    /// The endpoint a form declares it submits to, or null when it declares no write.
    ///
    /// A GET form is left out: it reads, and its page is already surface. A form with no
    /// action submits to the page it is on, which HTML says and this follows.
    /// </summary>
    /// <summary>The configured sign-in as a surface endpoint, or null when there is none or
    /// it is not an address this can reach.</summary>
    private static EndpointInput? SignInEndpoint(SignInInput? signIn)
    {
        if (signIn is null || string.IsNullOrWhiteSpace(signIn.Endpoint)) return null;
        if (!Uri.TryCreate(signIn.Endpoint, UriKind.Absolute, out var absolute)) return null;
        if (absolute.Scheme != Uri.UriSchemeHttp && absolute.Scheme != Uri.UriSchemeHttps) return null;

        return new EndpointInput(
            Guid.Empty, "POST", absolute.GetLeftPart(UriPartial.Path), absolute.ToString(),
            // Not authenticated: signing in is what a caller does before they have a session,
            // and treating it as authenticated would imply the object-authorization shape on
            // an endpoint that owns no objects.
            RequiresAuthentication: false,
            RequestContentType: null, RequestSampleJson: null, LastSeenAt: signIn.LastSeenAt);
    }

    private static EndpointInput? DeclaredEndpoint(FormInput form)
    {
        if (!MutatingMethods.Contains(form.Method)) return null;

        var target = string.IsNullOrWhiteSpace(form.Action) ? form.PageUrl : form.Action!;
        if (!Uri.TryCreate(target, UriKind.Absolute, out var absolute))
        {
            if (!Uri.TryCreate(form.PageUrl, UriKind.Absolute, out var page)) return null;
            if (!Uri.TryCreate(page, target, out absolute)) return null;
        }

        return new EndpointInput(
            form.Id,
            form.Method.ToUpperInvariant(),
            absolute.GetLeftPart(UriPartial.Path),
            absolute.ToString(),
            form.RequiresAuthentication,
            // A form posts its fields as a URL-encoded body unless it says otherwise, and
            // what they are called is the form model's business rather than this one's.
            "application/x-www-form-urlencoded",
            null,
            form.LastSeenAt);
    }

    /// <summary>Where to point a check at this page: an address that serves it.</summary>
    private static string PageTarget(PageInput page, bool carriesQuery)
    {
        // A page the route alone cannot reach is named by the address it was served at.
        if (carriesQuery && !string.IsNullOrWhiteSpace(page.Url)) return page.Url!;
        if (!string.IsNullOrWhiteSpace(page.Route)) return page.Route;
        return page.NormalizedUrl;
    }

    private static string NormalizeTemplate(string template)
        => Uri.TryCreate(template, UriKind.Absolute, out var parsed)
            ? parsed.GetLeftPart(UriPartial.Path).TrimEnd('/')
            : template.TrimEnd('/');

    // -----------------------------------------------------------------------

    private static SecuritySurfaceItem FromPage(PageInput page)
    {
        var inputs = page.Elements.Where(IsInput).ToList();
        var files = page.Elements.Any(e => e.Kind == ElementKind.FileInput
            || string.Equals(e.Type, "file", StringComparison.OrdinalIgnoreCase));
        // A page's own query string is part of its input surface.
        //
        // This read only the page's form elements, and declared CarriesUrlParameter false
        // for every page. So a search results page at /shipments?q=... was described as a
        // page that takes no URL parameter, the reflected-XSS check was only ever pointed
        // at API endpoints carrying a {v} placeholder, and a search term written into the
        // results unescaped — among the commonest vulnerabilities there is — was invisible
        // to the scan by construction.
        var queryParameters = QueryParametersOf(page.NormalizedUrl);
        var parameters = inputs.Select(e => e.Name ?? e.Label ?? e.Type ?? "unnamed")
            .Concat(queryParameters)
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
        if (queryParameters.Count > 0)
        {
            // A value that arrives in the URL is reflected back by whatever renders the
            // page, with no form involved at all.
            checks.Add(SecurityChecks.ReflectedXss);
            checks.Add(SecurityChecks.SqlInjection);
            reasons.Add($"the query parameter(s) {string.Join(", ", queryParameters)}");
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
            PageTarget(page, queryParameters.Count > 0),
            HttpMethod: "GET",
            RequiresAuthentication: page.RequiresAuthentication,
            ChangesState: false,
            AcceptsInput: inputs.Count > 0,
            AcceptsFileUpload: files,
            CarriesObjectIdentifier: HasPlaceholder(page.NormalizedUrl),
            CarriesUrlParameter: queryParameters.Count > 0,
            Parameters: parameters,
            RelevantChecks: checks.ToList(),
            Why: string.Join("; ", reasons));
    }

    /// <summary>The query parameter names a discovered URL carries, if any.
    ///
    /// Read from the URL discovery recorded rather than inferred: a page reached as
    /// <c>/shipments?q=exception&amp;status=open</c> takes two values through its address,
    /// and those are as injectable as any form field.</summary>
    private static List<string> QueryParametersOf(string? normalizedUrl)
    {
        if (string.IsNullOrWhiteSpace(normalizedUrl)) return new List<string>();

        var question = normalizedUrl.IndexOf('?');
        if (question < 0 || question == normalizedUrl.Length - 1) return new List<string>();

        var names = new List<string>();
        foreach (var pair in normalizedUrl[(question + 1)..].Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var name = pair.Split('=', 2)[0].Trim();
            // A placeholder discovery substituted is a parameter name too, but an empty or
            // absurd one is not worth sending payloads at.
            if (name.Length is > 0 and <= 64 && !names.Contains(name, StringComparer.Ordinal))
                names.Add(name);
        }
        return names;
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

        // An endpoint that takes an identifier will be given one it cannot parse, by a
        // client with a bug long before anyone malicious tries. Whether it refuses cleanly
        // or answers with a stack trace is the cheapest question in security testing, and
        // it does not depend on having a session: an anonymous caller can ask it too.
        if (identifier)
        {
            checks.Add(SecurityChecks.ErrorDisclosure);
            reasons.Add("it takes an identifier that can be made unparseable");
        }

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
