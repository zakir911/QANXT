using QaNxt.Application.Security;
using QaNxt.Domain.Enums;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Security;

using PageInput = SecurityAttackSurfaceBuilder.PageInput;
using ElementInput = SecurityAttackSurfaceBuilder.ElementInput;
using EndpointInput = SecurityAttackSurfaceBuilder.EndpointInput;
using FormInput = SecurityAttackSurfaceBuilder.FormInput;
using StateChangingLinkInput = SecurityAttackSurfaceBuilder.StateChangingLinkInput;

/// <summary>The rules that decide where a security check gets pointed.
///
/// These are worth pinning because the failure is quiet in both directions: a rule that fires
/// too narrowly leaves a real surface untested and nothing says so, and one that fires on
/// everything produces a surface nobody reads.</summary>
public class SecurityAttackSurfaceTests
{
    private static readonly DateTimeOffset Seen = new(2026, 9, 24, 0, 0, 0, TimeSpan.Zero);

    private static PageInput Page(
        string route = "/dashboard", PageKind kind = PageKind.Dashboard,
        bool authenticated = true, params ElementInput[] elements)
        => new(Guid.NewGuid(), route, $"https://app.test{route}", kind, authenticated, Seen, elements,
               $"https://app.test{route}");

    private static PageInput ParameterisedPage(string route, string url)
        => new(Guid.NewGuid(), route, url.Replace("=1", "={v}"), PageKind.Detail, true, Seen,
               Array.Empty<ElementInput>(), url);

    /// <summary>
    /// A link discovery would not follow is still a thing to test.
    ///
    /// Discovery finds a link whose own words say it approves, deletes or cancels something,
    /// refuses to follow it — mapping an application must not alter it — and records a gap
    /// saying so. The gap was where it stopped: the address never reached the surface, so
    /// nothing probed it even where the owner had authorized destructive testing.
    ///
    /// Measured across this project's own labs, that one omission accounts for five planted
    /// defects on three applications: a claim a viewer may settle, a rejected declaration
    /// anyone may release, an evidence upload, a cancel hidden from a receptionist and
    /// permitted by the endpoint, and a permit approval that is a GET any role may issue.
    /// </summary>
    [Fact]
    public void A_link_whose_words_say_it_changes_something_is_on_the_surface()
    {
        var surface = Build(
            pages: new[] { Page("/list") },
            stateChangingLinks: new[]
            {
                new StateChangingLinkInput("https://app.test/approve.asp?id=1", Seen)
            });

        var item = surface.Items.Should()
            .ContainSingle(i => i.Identifier.Contains("/approve.asp")).Subject;
        item.HttpMethod.Should().Be("GET");
        item.ChangesState.Should().BeTrue();
        item.Why.Should().Contain("its own words say it changes something");
    }

    [Fact]
    public void It_implies_the_checks_that_ask_whether_a_state_change_was_guarded()
    {
        var surface = Build(
            pages: new[] { Page("/list") },
            stateChangingLinks: new[]
            {
                new StateChangingLinkInput("https://app.test/approve.asp?id=1", Seen)
            });

        var item = surface.Items.Single(i => i.Identifier.Contains("/approve.asp"));

        // The point of putting it on the surface at all: who may issue it, and whether a
        // state change should have needed more than a link.
        item.RelevantChecks.Should().Contain(SecurityChecks.UnsafeMethod);
    }

    [Fact]
    public void A_link_already_covered_by_an_observed_endpoint_is_not_added_twice()
    {
        // An endpoint seen in flight carries a method, a sample payload and a content type,
        // which is strictly more to work with than a URL read off an anchor.
        var surface = Build(
            pages: new[] { Page("/list") },
            endpoints: new[]
            {
                new EndpointInput(Guid.NewGuid(), "GET", "https://app.test/approve.asp",
                    "https://app.test/approve.asp?id=1", true, null, null, Seen)
            },
            stateChangingLinks: new[]
            {
                new StateChangingLinkInput("https://app.test/approve.asp?id=1", Seen)
            });

        surface.Items.Count(i => i.Identifier.Contains("/approve.asp")).Should().Be(1);
    }

    [Fact]
    public void A_link_that_is_not_an_address_is_left_out_rather_than_guessed_at()
    {
        var surface = Build(
            pages: new[] { Page("/list") },
            stateChangingLinks: new[]
            {
                new StateChangingLinkInput("javascript:cancel()", Seen),
                new StateChangingLinkInput("", Seen),
                new StateChangingLinkInput("mailto:ops@app.test", Seen)
            });

        surface.Items.Should().OnlyContain(i => i.Identifier.Contains("/list"));
    }

    /// <summary>
    /// A page reached by a query parameter is only served at the address that carries it. The
    /// route alone asked for a URL the application does not serve: on a permit register
    /// `/view.asp` answers "no such permit", so the header checks measured that 404 and the
    /// personal-data check read a page holding nothing.
    /// </summary>
    [Fact]
    public void A_page_reached_by_a_query_parameter_is_targeted_at_an_address_that_serves_it()
    {
        var surface = Build(pages: new[] {
            ParameterisedPage("/view.asp", "https://app.test/view.asp?id=1") });

        surface.Items.Should().ContainSingle().Which.Identifier
            .Should().Be("https://app.test/view.asp?id=1");
    }

    [Fact]
    public void An_ordinary_page_is_still_named_by_its_route()
    {
        Build(pages: new[] { Page("/dashboard") }).Items.Should().ContainSingle()
            .Which.Identifier.Should().Be("/dashboard");
    }

    [Fact]
    public void A_parameterised_page_whose_address_was_not_recorded_falls_back_to_its_route()
    {
        var page = new PageInput(Guid.NewGuid(), "/view.asp", "https://app.test/view.asp?id={v}",
            PageKind.Detail, true, Seen, Array.Empty<ElementInput>(), null);

        Build(pages: new[] { page }).Items.Should().ContainSingle()
            .Which.Identifier.Should().Be("/view.asp");
    }

    private static EndpointInput Endpoint(
        string method = "GET", string template = "/api/accounts",
        string? sampleUrl = null, bool authenticated = true,
        string? contentType = null, string? body = null)
        => new(Guid.NewGuid(), method, template, sampleUrl ?? $"https://app.test{template}",
               authenticated, contentType, body, Seen);

    private static FormInput Form(
        string method = "post", string? action = "/api/appointments",
        string route = "/schedule", string pageUrl = "https://app.test/schedule",
        bool csrf = false, bool authenticated = true)
        => new(Guid.NewGuid(), route, action, method, pageUrl, csrf, authenticated, Seen);

    private static SecurityAttackSurface Build(
        IEnumerable<PageInput>? pages = null, IEnumerable<EndpointInput>? endpoints = null,
        IEnumerable<FormInput>? forms = null, SecurityAttackSurfaceBuilder.SignInInput? signIn = null,
        IEnumerable<StateChangingLinkInput>? stateChangingLinks = null)
        => SecurityAttackSurfaceBuilder.Build(
            Guid.NewGuid(),
            (pages ?? Array.Empty<PageInput>()).ToList(),
            (endpoints ?? Array.Empty<EndpointInput>()).ToList(),
            (forms ?? Array.Empty<FormInput>()).ToList(),
            signIn,
            (stateChangingLinks ?? Array.Empty<StateChangingLinkInput>()).ToList());

    private static SecurityAttackSurfaceBuilder.SignInInput SignIn(string endpoint)
        => new(endpoint, Seen);

    /// <summary>
    /// The one endpoint a crawl structurally cannot find.
    ///
    /// The authenticator signs in before the crawl starts, so the sign-in is never an
    /// observed request; and an application whose sign-in is a JSON endpoint rather than a
    /// page has no login page to classify either. Measured on an order API: the endpoint
    /// issuing its tokens was on no surface, so user enumeration, lockout and session
    /// lifetime were all unimplied — against the most attacked address in any application.
    /// </summary>
    [Fact]
    public void The_configured_sign_in_is_on_the_surface_even_though_no_crawl_sees_it()
    {
        var surface = Build(
            pages: new[] { Page("/", PageKind.Detail) },
            signIn: SignIn("http://api.test/api/auth/token"));

        surface.Items.Should().Contain(item => item.Identifier.Contains("/api/auth/token"));
        surface.ChecksImplied.Should().Contain(SecurityChecks.AccountLockout)
            .And.Contain(SecurityChecks.UserEnumeration);
    }

    /// <summary>A sign-in is a write, so the checks about writes apply to it too.</summary>
    [Fact]
    public void The_sign_in_is_treated_as_a_write()
    {
        var surface = Build(signIn: SignIn("http://api.test/api/auth/token"));

        surface.ChecksImplied.Should().Contain(SecurityChecks.CsrfToken)
            .And.Contain(SecurityChecks.OriginValidation);
    }

    /// <summary>Signing in is what a caller does before they have a session, so it must not
    /// read as an authenticated endpoint — which would imply the object-authorization shape
    /// on an endpoint that owns no objects.</summary>
    [Fact]
    public void The_sign_in_is_not_treated_as_an_authenticated_endpoint()
    {
        var surface = Build(signIn: SignIn("http://api.test/api/auth/token"));

        surface.ChecksImplied.Should().NotContain(SecurityChecks.Bola);
    }

    [Fact]
    public void A_sign_in_discovery_already_found_is_not_added_twice()
    {
        var surface = Build(
            endpoints: new[] { Endpoint("POST", "http://api.test/api/auth/token") },
            signIn: SignIn("http://api.test/api/auth/token"));

        surface.Items.Count(item => item.Identifier.Contains("/api/auth/token")).Should().Be(1);
        surface.EndpointsInGraph.Should().Be(1);
    }

    [Fact]
    public void A_sign_in_that_is_not_an_address_is_left_out_rather_than_guessed_at()
    {
        Build(signIn: SignIn("/api/auth/token")).Items.Should().BeEmpty(
            "the service resolves a relative value against the base URL before this; anything "
            + "still not absolute here is not an address");
        Build(signIn: SignIn("javascript:void(0)")).Items.Should().BeEmpty();
    }

    /// <summary>
    /// Discovery never submits a form, so the only requests it observes against an API are
    /// the reads. Every endpoint was therefore a GET, every GET is non-mutating, and every
    /// check needing a write endpoint was skipped for the endpoints that write: CSRF, origin
    /// validation, read-only enforcement, mass assignment, stored XSS. A scan of a clinical
    /// scheduler ran read-only enforcement against its sign-in endpoint and nothing else.
    /// </summary>
    [Fact]
    public void A_form_that_declares_a_post_puts_its_endpoint_on_the_surface()
    {
        var surface = Build(forms: new[] { Form(method: "post", action: "/api/appointments") });

        var item = surface.Items.Should().ContainSingle().Subject;
        item.Identifier.Should().Contain("/api/appointments");
        item.RelevantChecks.Should().Contain(new[]
        {
            SecurityChecks.CsrfToken, SecurityChecks.OriginValidation,
            SecurityChecks.ReadOnlyWrite, SecurityChecks.MassAssignment
        });
    }

    [Fact]
    public void A_get_form_declares_no_write_and_adds_nothing()
    {
        // Its page is already surface, and a GET form reads.
        Build(forms: new[] { Form(method: "get", action: "/search") }).Items.Should().BeEmpty();
    }

    [Fact]
    public void A_form_with_no_action_submits_to_its_own_page()
    {
        var surface = Build(forms: new[] {
            Form(method: "post", action: null, pageUrl: "https://app.test/new.asp") });

        surface.Items.Should().ContainSingle().Which.Identifier.Should().Contain("/new.asp");
    }

    /// <summary>
    /// An endpoint seen in flight carries a sample payload and a content type, which is
    /// strictly more to work with than a declaration, so the declaration does not displace
    /// it or sit beside it as a duplicate.
    /// </summary>
    [Fact]
    public void A_declared_endpoint_an_observed_one_already_covers_is_not_added_twice()
    {
        var surface = Build(
            endpoints: new[] { Endpoint("POST", "https://app.test/api/appointments") },
            forms: new[] { Form(method: "post", action: "https://app.test/api/appointments") });

        surface.Items.Should().ContainSingle();
        surface.EndpointsInGraph.Should().Be(1);
    }

    [Fact]
    public void Two_forms_posting_to_the_same_endpoint_are_one_item()
    {
        var surface = Build(forms: new[]
        {
            Form(method: "post", action: "/api/appointments", route: "/schedule"),
            Form(method: "post", action: "/api/appointments", route: "/schedule/new")
        });

        surface.Items.Should().ContainSingle();
    }

    [Fact]
    public void An_authenticated_endpoint_taking_an_object_identifier_implies_BOLA()
    {
        // The highest-priority capability in the brief, and the shape it actually has.
        var surface = Build(endpoints: new[] { Endpoint(template: "/api/accounts/{id}") });

        surface.Items.Single().RelevantChecks.Should().Contain(SecurityChecks.Bola);
        surface.Items.Single().CarriesObjectIdentifier.Should().BeTrue();
    }

    [Fact]
    public void An_authenticated_collection_implies_vertical_escalation_rather_than_BOLA()
    {
        // A collection has no identifier to swap, so BOLA does not apply to it. Reporting it
        // would be the false positive the lab's safe endpoints exist to catch.
        var checks = Build(endpoints: new[] { Endpoint(template: "/api/accounts") })
            .Items.Single().RelevantChecks;

        checks.Should().Contain(SecurityChecks.VerticalEscalation);
        checks.Should().NotContain(SecurityChecks.Bola);
    }

    [Fact]
    public void A_state_changing_endpoint_implies_CSRF_and_origin_validation()
    {
        var checks = Build(endpoints: new[] { Endpoint("POST", "/api/transfers") })
            .Items.Single().RelevantChecks;

        checks.Should().Contain(new[]
        {
            SecurityChecks.CsrfToken, SecurityChecks.OriginValidation, SecurityChecks.ReadOnlyWrite
        });
    }

    [Fact]
    public void A_GET_does_not_imply_CSRF()
    {
        Build(endpoints: new[] { Endpoint() }).Items.Single()
            .RelevantChecks.Should().NotContain(SecurityChecks.CsrfToken);
    }

    [Fact]
    public void A_DELETE_implies_the_unsafe_method_check()
        => Build(endpoints: new[] { Endpoint("DELETE", "/api/notes/{id}") })
            .Items.Single().RelevantChecks.Should().Contain(SecurityChecks.UnsafeMethod);

    [Fact]
    public void Query_parameters_imply_the_injection_family()
    {
        var checks = Build(endpoints: new[]
        {
            Endpoint(template: "/api/products", sampleUrl: "https://app.test/api/products?name=widget")
        }).Items.Single().RelevantChecks;

        checks.Should().Contain(new[]
        {
            SecurityChecks.ReflectedXss, SecurityChecks.SqlInjection,
            SecurityChecks.CommandInjection, SecurityChecks.TemplateInjection
        });
    }

    [Fact]
    public void An_endpoint_with_no_parameters_does_not_imply_injection()
        => Build(endpoints: new[] { Endpoint() }).Items.Single()
            .RelevantChecks.Should().NotContain(SecurityChecks.SqlInjection);

    [Theory]
    [InlineData("next")]
    [InlineData("returnUrl")]
    [InlineData("callback")]
    [InlineData("image")]
    public void A_parameter_naming_a_destination_implies_open_redirect_and_SSRF(string name)
    {
        var checks = Build(endpoints: new[]
        {
            Endpoint(template: "/redirect", sampleUrl: $"https://app.test/redirect?{name}=/home")
        }).Items.Single().RelevantChecks;

        checks.Should().Contain(new[] { SecurityChecks.OpenRedirect, SecurityChecks.Ssrf });
    }

    [Fact]
    public void An_ordinary_parameter_does_not_imply_SSRF()
        => Build(endpoints: new[]
            {
                Endpoint(template: "/api/search", sampleUrl: "https://app.test/api/search?q=hello")
            }).Items.Single().RelevantChecks.Should().NotContain(SecurityChecks.Ssrf);

    [Fact]
    public void A_multipart_endpoint_implies_the_upload_checks()
        => Build(endpoints: new[] { Endpoint("POST", "/api/upload", contentType: "multipart/form-data") })
            .Items.Single().RelevantChecks.Should().Contain(SecurityChecks.UploadRestrictions);

    [Fact]
    public void A_file_input_on_a_page_implies_the_upload_checks()
    {
        var page = Page("/profile", PageKind.Form, true,
            new ElementInput(ElementKind.FileInput, "avatar", "file", "Avatar"));

        Build(pages: new[] { page }).Items.Single()
            .RelevantChecks.Should().Contain(SecurityChecks.UploadRestrictions);
    }

    [Fact]
    public void A_body_binding_endpoint_implies_mass_assignment_and_input_validation()
    {
        var checks = Build(endpoints: new[]
        {
            Endpoint("PATCH", "/api/users/{id}", body: """{"displayName":"***"}""")
        }).Items.Single().RelevantChecks;

        checks.Should().Contain(new[] { SecurityChecks.MassAssignment, SecurityChecks.InputValidation });
    }

    [Fact]
    public void Body_field_names_are_read_and_values_are_not()
    {
        var item = Build(endpoints: new[]
        {
            Endpoint("POST", "/api/notes", body: """{"title":"a secret value","ownerId":"u-1"}""")
        }).Items.Single();

        item.Parameters.Should().Contain(new[] { "title", "ownerId" });
        // The captured sample is masked already; putting values in a second place would mean
        // masking correctly in two places, and one is enough.
        string.Join(' ', item.Parameters).Should().NotContain("a secret value");
    }

    [Fact]
    public void A_body_that_is_not_JSON_contributes_no_invented_parameters()
        => Build(endpoints: new[] { Endpoint("POST", "/api/notes", body: "not json at all") })
            .Items.Single().Parameters.Should().BeEmpty();

    [Theory]
    [InlineData("/api/session")]
    [InlineData("/login")]
    [InlineData("/api/password-reset")]
    public void An_authentication_surface_implies_the_authentication_family(string template)
    {
        var checks = Build(endpoints: new[] { Endpoint("POST", template, authenticated: false) })
            .Items.Single().RelevantChecks;

        checks.Should().Contain(new[]
        {
            SecurityChecks.UserEnumeration, SecurityChecks.AccountLockout,
            SecurityChecks.SessionInvalidation, SecurityChecks.SessionLifetime
        });
    }

    [Fact]
    public void A_login_page_implies_the_authentication_family_from_its_kind_alone()
        => Build(pages: new[] { Page("/entry", PageKind.Login, false) })
            .Items.Single().RelevantChecks.Should().Contain(SecurityChecks.UserEnumeration);

    [Fact]
    public void Every_page_implies_the_passive_checks()
    {
        var checks = Build(pages: new[] { Page() }).Items.Single().RelevantChecks;

        checks.Should().Contain(new[]
        {
            SecurityChecks.SecurityHeaders, SecurityChecks.Cookies, SecurityChecks.SensitiveData
        });
    }

    [Fact]
    public void Every_page_implies_DOM_XSS_even_one_with_no_form_at_all()
    {
        // The source is location.hash, location.search, document.referrer or window.name —
        // none of which is a form input. Implying it only where a form was found missed the
        // pages this check exists for: the ones whose only input arrives through the URL.
        var withAForm = Page("/search", PageKind.Form, false,
            new ElementInput(ElementKind.TextInput, "q", "text", "Search"));
        var withoutOne = Page("/dom", PageKind.Unknown, false);

        foreach (var page in new[] { withAForm, withoutOne })
        {
            Build(pages: new[] { page }).Items.Single()
                .RelevantChecks.Should().Contain(SecurityChecks.DomXss);
        }
    }

    [Fact]
    public void The_DOM_XSS_caveat_says_it_needs_a_browser_and_reads_untested_without_one()
    {
        var surface = Build(pages: new[] { Page("/dom", PageKind.Unknown, false) });

        // It is decidable now, in a browser. What the caveat has to carry is that a scan
        // without one reports the area untested rather than clean.
        surface.Caveats.Should().ContainMatch("*browser*");
        surface.Caveats.Should().ContainMatch("*untested rather than clean*");
    }

    [Fact]
    public void The_first_caveat_is_always_that_this_is_what_discovery_walked()
    {
        // Unconditional on purpose. A reader who takes the item list as complete will treat
        // everywhere else as safe, and nothing here has looked at anywhere else.
        foreach (var surface in new[]
                 {
                     Build(),
                     Build(pages: new[] { Page() }),
                     Build(endpoints: new[] { Endpoint() })
                 })
        {
            surface.Caveats.Should().NotBeEmpty();
            surface.Caveats[0].Should().Contain("not the application");
        }
    }

    [Fact]
    public void An_empty_graph_describes_discovery_rather_than_the_application()
    {
        var surface = Build();

        surface.Items.Should().BeEmpty();
        surface.Summary.Should().Contain("statement about discovery, not about the application");
        surface.Caveats.Should().ContainMatch("*Run discovery*");
    }

    [Fact]
    public void A_graph_with_no_authenticated_surface_says_so()
        => Build(pages: new[] { Page("/home", PageKind.Dashboard, false) })
            .Caveats.Should().ContainMatch("*discovery did not sign in*");

    [Fact]
    public void A_graph_with_no_observed_API_calls_says_so()
        => Build(pages: new[] { Page() })
            .Caveats.Should().ContainMatch("*No API calls were observed*");

    [Fact]
    public void Every_check_a_surface_implies_is_a_known_check()
    {
        // A surface implying a check nobody can run would select nothing and report full
        // coverage, which is the way a typo turns into a false green.
        var surface = Build(
            pages: new[]
            {
                Page("/login", PageKind.Login, false, new ElementInput(ElementKind.PasswordInput, "password", "password", "Password")),
                Page("/profile", PageKind.Form, true, new ElementInput(ElementKind.FileInput, "avatar", "file", "Avatar"))
            },
            endpoints: new[]
            {
                Endpoint("POST", "/api/session", authenticated: false, body: """{"username":"***"}"""),
                Endpoint(template: "/api/accounts/{id}"),
                Endpoint("DELETE", "/api/notes/{id}"),
                Endpoint(template: "/redirect", sampleUrl: "https://app.test/redirect?next=/home")
            });

        surface.ChecksImplied.Should().OnlyContain(check => SecurityChecks.All.Contains(check));
        surface.ChecksImplied.Should().NotBeEmpty();
    }

    [Fact]
    public void Every_item_says_why_it_is_in_the_surface()
    {
        var surface = Build(
            pages: new[] { Page() },
            endpoints: new[] { Endpoint("POST", "/api/transfers") });

        surface.Items.Should().OnlyContain(item => !string.IsNullOrWhiteSpace(item.Why));
    }

    [Fact]
    public void The_summary_never_implies_the_surface_is_complete()
    {
        var summary = Build(
            pages: new[] { Page() }, endpoints: new[] { Endpoint() }).Summary;

        summary.Should().Contain("what discovery walked rather than the application");
    }

    [Fact]
    public void A_pages_query_string_is_part_of_its_input_surface()
    {
        // This read only a page's form elements and declared CarriesUrlParameter false for
        // every page, so a search results page at /shipments?q=... was described as taking
        // no URL parameter. The reflected-XSS check was therefore only ever pointed at API
        // endpoints carrying a {v} placeholder, and a search term written into the results
        // unescaped — among the commonest vulnerabilities there is — could not be found at
        // all. FP_D28 sits on exactly that URL.
        var page = new PageInput(Guid.NewGuid(), "/shipments",
            "https://app.test/shipments?q=exception&status=open", PageKind.List, true, Seen,
            Array.Empty<ElementInput>());

        var item = Build(new[] { page })
            .Items.Single(i => i.Kind == SecuritySurfaceKind.Page);

        item.CarriesUrlParameter.Should().BeTrue();
        item.Parameters.Should().Contain(new[] { "q", "status" });
        item.RelevantChecks.Should().Contain(SecurityChecks.ReflectedXss,
            "a value arriving in the URL is reflected by whatever renders the page");
        item.Why.Should().Contain("query parameter");
    }

    [Fact]
    public void A_page_with_no_query_string_still_carries_no_url_parameter()
    {
        var item = Build(new[] { Page("/dashboard") })
            .Items.Single(i => i.Kind == SecuritySurfaceKind.Page);

        item.CarriesUrlParameter.Should().BeFalse();
    }

    [Fact]
    public void A_query_string_and_a_form_both_contribute_parameters()
    {
        var page = new PageInput(Guid.NewGuid(), "/shipments",
            "https://app.test/shipments?q=exception", PageKind.List, true, Seen,
            new[] { new ElementInput(ElementKind.TextInput, "reference", "text", "Reference") });

        var item = Build(new[] { page })
            .Items.Single(i => i.Kind == SecuritySurfaceKind.Page);

        item.Parameters.Should().Contain("q");
        item.Parameters.Should().Contain("reference");
    }

    [Fact]
    public void A_malformed_query_string_does_not_produce_a_parameter()
    {
        // An empty name, or a trailing "?", is not something to send payloads at.
        foreach (var url in new[] { "https://app.test/x?", "https://app.test/x?=1", "https://app.test/x?&&" })
        {
            var page = new PageInput(Guid.NewGuid(), "/x", url, PageKind.List, true, Seen,
                Array.Empty<ElementInput>());

            Build(new[] { page })
                .Items.Single(i => i.Kind == SecuritySurfaceKind.Page)
                .CarriesUrlParameter.Should().BeFalse($"\"{url}\" names no parameter");
        }
    }

    [Fact]
    public void A_repeated_query_parameter_is_listed_once()
    {
        var page = new PageInput(Guid.NewGuid(), "/x", "https://app.test/x?tag=a&tag=b",
            PageKind.List, true, Seen, Array.Empty<ElementInput>());

        Build(new[] { page })
            .Items.Single(i => i.Kind == SecuritySurfaceKind.Page)
            .Parameters.Where(p => p == "tag").Should().HaveCount(1);
    }
}
