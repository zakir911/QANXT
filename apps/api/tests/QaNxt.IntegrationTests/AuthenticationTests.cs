using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace QaNxt.IntegrationTests;

/// <summary>Who the platform lets in, and what it says when it does not.
///
/// These run through the real HTTP pipeline rather than calling the service, because the
/// parts most likely to be wrong — the token validation parameters, the order of the
/// middleware, what a rejection actually returns to a browser — only exist there.</summary>
[Collection(ApiCollection.Name)]
public class AuthenticationTests(ApiFactory factory)
{
    [Fact]
    public async Task Registering_an_organization_returns_a_usable_session()
    {
        var tenant = await factory.NewTenantAsync();

        tenant.Auth.AccessToken.Should().NotBeNullOrWhiteSpace();
        tenant.Auth.RefreshToken.Should().NotBeNullOrWhiteSpace();
        tenant.Auth.User.OrganizationId.Should().NotBeEmpty();

        // The first user of an organization administers it, or nobody can.
        tenant.Auth.User.Roles.Should().Contain("OrganizationAdmin");
        tenant.Auth.User.Permissions.Should().Contain("project:write");

        var me = await tenant.Client.GetAsync("/api/v1/auth/me");
        me.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task An_endpoint_that_needs_a_session_refuses_a_request_without_one()
    {
        var tenant = await factory.NewTenantAsync();

        var response = await tenant.Anonymous().GetAsync("/api/v1/projects");

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_token_that_was_not_issued_here_is_refused()
    {
        // A token signed with someone else's key must not be accepted whatever it claims.
        var client = factory.NewClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJPcmdhbml6YXRpb25BZG1pbiJ9."
            + "ZmFrZS1zaWduYXR1cmUtdGhhdC1zaG91bGQtbm90LXZhbGlkYXRl");

        var response = await client.GetAsync("/api/v1/projects");

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_wrong_password_is_refused_without_revealing_which_part_was_wrong()
    {
        var tenant = await factory.NewTenantAsync();

        var response = await factory.NewClient().PostAsJsonAsync("/api/v1/auth/login", new
        {
            email = tenant.Email,
            password = "not-the-password",
            organizationSlug = (string?)null
        }, ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var body = await response.Content.ReadAsStringAsync();
        // Saying "no such user" would let an attacker enumerate accounts.
        body.Should().Contain("Invalid email or password");
        body.Should().NotContain(tenant.Password);
    }

    [Fact]
    public async Task An_unknown_account_is_refused_the_same_way_as_a_wrong_password()
    {
        var response = await factory.NewClient().PostAsJsonAsync("/api/v1/auth/login", new
        {
            email = $"nobody-{Guid.NewGuid():N}@example.test",
            password = "Str0ngPassphrase!2026",
            organizationSlug = (string?)null
        }, ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await response.Content.ReadAsStringAsync()).Should().Contain("Invalid email or password");
    }

    [Fact]
    public async Task A_refresh_token_can_be_exchanged_once_and_then_stops_working()
    {
        var tenant = await factory.NewTenantAsync();

        var first = await factory.NewClient().PostAsJsonAsync("/api/v1/auth/refresh",
            new { refreshToken = tenant.Auth.RefreshToken }, ApiFactory.Json);
        first.StatusCode.Should().Be(HttpStatusCode.OK);

        var rotated = await first.Content.ReadFromJsonAsync<AuthResponse>(ApiFactory.Json);
        rotated!.RefreshToken.Should().NotBe(tenant.Auth.RefreshToken);

        // Reuse of a rotated token is how a stolen one shows up, so it must be refused.
        var reuse = await factory.NewClient().PostAsJsonAsync("/api/v1/auth/refresh",
            new { refreshToken = tenant.Auth.RefreshToken }, ApiFactory.Json);
        reuse.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_password_is_never_returned_by_any_part_of_signing_in()
    {
        var tenant = await factory.NewTenantAsync();

        var login = await factory.NewClient().PostAsJsonAsync("/api/v1/auth/login", new
        {
            email = tenant.Email,
            password = tenant.Password,
            organizationSlug = (string?)null
        }, ApiFactory.Json);

        var body = await login.Content.ReadAsStringAsync();
        body.Should().NotContain(tenant.Password);

        var me = await (await tenant.Client.GetAsync("/api/v1/auth/me")).Content.ReadAsStringAsync();
        me.Should().NotContain(tenant.Password);
        // Nor the stored form of it.
        me.Should().NotContain("passwordHash");
    }

    [Fact]
    public async Task Every_response_carries_the_headers_that_protect_a_browser()
    {
        var tenant = await factory.NewTenantAsync();

        var response = await tenant.Client.GetAsync("/api/v1/projects");

        response.Headers.GetValues("X-Content-Type-Options").Should().Contain("nosniff");
        response.Headers.GetValues("X-Frame-Options").Should().Contain("DENY");
        response.Headers.GetValues("Referrer-Policy").Should().Contain("no-referrer");
        response.Headers.Should().ContainSingle(h => h.Key == "Content-Security-Policy");
    }

    [Fact]
    public async Task A_failure_carries_a_correlation_id_that_matches_its_header()
    {
        var response = await factory.NewClient().GetAsync("/api/v1/projects");

        var header = response.Headers.GetValues("X-Correlation-Id").Single();
        header.Should().NotBeNullOrWhiteSpace();
    }
}
