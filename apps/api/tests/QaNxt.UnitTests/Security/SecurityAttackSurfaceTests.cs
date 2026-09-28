using QaNxt.Application.Security;
using QaNxt.Domain.Enums;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Security;

using PageInput = SecurityAttackSurfaceBuilder.PageInput;
using ElementInput = SecurityAttackSurfaceBuilder.ElementInput;
using EndpointInput = SecurityAttackSurfaceBuilder.EndpointInput;

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
        => new(Guid.NewGuid(), route, $"https://app.test{route}", kind, authenticated, Seen, elements);

    private static EndpointInput Endpoint(
        string method = "GET", string template = "/api/accounts",
        string? sampleUrl = null, bool authenticated = true,
        string? contentType = null, string? body = null)
        => new(Guid.NewGuid(), method, template, sampleUrl ?? $"https://app.test{template}",
               authenticated, contentType, body, Seen);

    private static SecurityAttackSurface Build(
        IEnumerable<PageInput>? pages = null, IEnumerable<EndpointInput>? endpoints = null)
        => SecurityAttackSurfaceBuilder.Build(
            Guid.NewGuid(),
            (pages ?? Array.Empty<PageInput>()).ToList(),
            (endpoints ?? Array.Empty<EndpointInput>()).ToList());

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
}
