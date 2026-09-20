using System.Net;
using System.Net.Http.Json;
using Aira.Application.Identity;
using FluentAssertions;

namespace Aira.IntegrationTests;

/// <summary>Adding people to an organization, and taking their access away again.
///
/// The second half is the part that matters. A "disable" that leaves the account working
/// until its token happens to expire is not a disable, and the only way to know which one
/// this is is to disable an account and then try to use its existing session.</summary>
[Collection(ApiCollection.Name)]
public class UserManagementTests(ApiFactory factory)
{
    private static object Invite(string role = "qaEngineer", string? email = null) => new
    {
        email = email ?? $"member-{Guid.NewGuid():N}@example.test",
        displayName = "A Colleague",
        role
    };

    [Fact]
    public async Task An_organization_can_add_a_second_person()
    {
        var tenant = await factory.NewTenantAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/users", Invite(), ApiFactory.Json);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var invited = await response.Content.ReadFromJsonAsync<InvitedUser>(ApiFactory.Json);
        invited!.User.Roles.Should().ContainSingle();
        invited.TemporaryPassword.Should().NotBeNullOrWhiteSpace();
        // Nobody has signed in as this account yet, and the audit trail should be able to
        // tell that apart from an account in use.
        invited.User.Status.Should().Be(Domain.Enums.UserStatus.Invited);

        var users = await tenant.Client.GetFromJsonAsync<List<UserSummary>>("/api/v1/users", ApiFactory.Json);
        users!.Should().HaveCount(2);
    }

    [Fact]
    public async Task The_invited_person_can_sign_in_with_the_password_they_were_given()
    {
        // An invitation that produces an unusable password is not an invitation.
        var tenant = await factory.NewTenantAsync();
        var email = $"member-{Guid.NewGuid():N}@example.test";

        var invited = await (await tenant.Client.PostAsJsonAsync("/api/v1/users", Invite(email: email), ApiFactory.Json))
            .Content.ReadFromJsonAsync<InvitedUser>(ApiFactory.Json);

        var login = await factory.NewClient().PostAsJsonAsync("/api/v1/auth/login", new
        {
            email,
            password = invited!.TemporaryPassword,
            organizationSlug = (string?)null
        }, ApiFactory.Json);

        login.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task The_one_time_password_is_never_retrievable_afterwards()
    {
        var tenant = await factory.NewTenantAsync();

        var invited = await (await tenant.Client.PostAsJsonAsync("/api/v1/users", Invite(), ApiFactory.Json))
            .Content.ReadFromJsonAsync<InvitedUser>(ApiFactory.Json);

        var listing = await (await tenant.Client.GetAsync("/api/v1/users")).Content.ReadAsStringAsync();

        listing.Should().NotContain(invited!.TemporaryPassword);
        listing.Should().NotContain("passwordHash");
    }

    [Fact]
    public async Task Disabling_an_account_ends_the_session_it_already_holds()
    {
        // The whole point. Without the security stamp being checked on each request, this
        // passes for up to an hour after the account was disabled.
        var tenant = await factory.NewTenantAsync();
        var email = $"member-{Guid.NewGuid():N}@example.test";

        var invited = await (await tenant.Client.PostAsJsonAsync("/api/v1/users", Invite(email: email), ApiFactory.Json))
            .Content.ReadFromJsonAsync<InvitedUser>(ApiFactory.Json);

        var login = await factory.NewClient().PostAsJsonAsync("/api/v1/auth/login",
            new { email, password = invited!.TemporaryPassword, organizationSlug = (string?)null },
            ApiFactory.Json);
        var session = await login.Content.ReadFromJsonAsync<AuthResponse>(ApiFactory.Json);

        var theirClient = factory.NewClient();
        theirClient.DefaultRequestHeaders.Authorization = new("Bearer", session!.AccessToken);

        (await theirClient.GetAsync("/api/v1/auth/me")).StatusCode.Should().Be(HttpStatusCode.OK);

        var disable = await tenant.Client.PatchAsJsonAsync($"/api/v1/users/{invited.User.Id}",
            new { status = "disabled" }, ApiFactory.Json);
        disable.StatusCode.Should().Be(HttpStatusCode.OK);

        // Same token, same second — and it must stop working now, not when it expires.
        (await theirClient.GetAsync("/api/v1/auth/me")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Changing_a_role_ends_the_sessions_that_still_claim_the_old_one()
    {
        // A token carries its permissions as claims. Leaving an old token working after a
        // demotion means the demotion did not happen yet.
        var tenant = await factory.NewTenantAsync();
        var email = $"member-{Guid.NewGuid():N}@example.test";

        var invited = await (await tenant.Client.PostAsJsonAsync("/api/v1/users",
            Invite(role: "qaLead", email: email), ApiFactory.Json))
            .Content.ReadFromJsonAsync<InvitedUser>(ApiFactory.Json);

        var session = await (await factory.NewClient().PostAsJsonAsync("/api/v1/auth/login",
            new { email, password = invited!.TemporaryPassword, organizationSlug = (string?)null },
            ApiFactory.Json)).Content.ReadFromJsonAsync<AuthResponse>(ApiFactory.Json);

        var theirClient = factory.NewClient();
        theirClient.DefaultRequestHeaders.Authorization = new("Bearer", session!.AccessToken);
        (await theirClient.GetAsync("/api/v1/auth/me")).StatusCode.Should().Be(HttpStatusCode.OK);

        await tenant.Client.PatchAsJsonAsync($"/api/v1/users/{invited.User.Id}",
            new { role = "viewer" }, ApiFactory.Json);

        (await theirClient.GetAsync("/api/v1/auth/me")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Resetting_a_password_ends_every_session_the_account_holds()
    {
        var tenant = await factory.NewTenantAsync();
        var email = $"member-{Guid.NewGuid():N}@example.test";

        var invited = await (await tenant.Client.PostAsJsonAsync("/api/v1/users", Invite(email: email), ApiFactory.Json))
            .Content.ReadFromJsonAsync<InvitedUser>(ApiFactory.Json);

        var session = await (await factory.NewClient().PostAsJsonAsync("/api/v1/auth/login",
            new { email, password = invited!.TemporaryPassword, organizationSlug = (string?)null },
            ApiFactory.Json)).Content.ReadFromJsonAsync<AuthResponse>(ApiFactory.Json);

        var theirClient = factory.NewClient();
        theirClient.DefaultRequestHeaders.Authorization = new("Bearer", session!.AccessToken);

        var reset = await tenant.Client.PostAsync($"/api/v1/users/{invited.User.Id}/reset-password", null);
        reset.StatusCode.Should().Be(HttpStatusCode.OK);

        var reissued = await reset.Content.ReadFromJsonAsync<InvitedUser>(ApiFactory.Json);
        reissued!.TemporaryPassword.Should().NotBe(invited.TemporaryPassword);

        (await theirClient.GetAsync("/api/v1/auth/me")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // And the refresh token cannot be used to get a new session either.
        var refresh = await factory.NewClient().PostAsJsonAsync("/api/v1/auth/refresh",
            new { refreshToken = session.RefreshToken }, ApiFactory.Json);
        refresh.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task The_last_administrator_cannot_be_disabled_or_demoted()
    {
        // An organization with no administrator cannot be administered, and nothing inside
        // the product can repair that.
        var tenant = await factory.NewTenantAsync();

        var demote = await tenant.Client.PatchAsJsonAsync($"/api/v1/users/{tenant.Auth.User.UserId}",
            new { role = "viewer" }, ApiFactory.Json);

        demote.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await demote.Content.ReadAsStringAsync()).Should().Contain("only active administrator");
    }

    [Fact]
    public async Task Nobody_can_disable_their_own_account()
    {
        var tenant = await factory.NewTenantAsync();

        var response = await tenant.Client.PatchAsJsonAsync($"/api/v1/users/{tenant.Auth.User.UserId}",
            new { status = "disabled" }, ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await response.Content.ReadAsStringAsync()).Should().Contain("your own account");
    }

    [Fact]
    public async Task An_administrator_can_be_demoted_once_another_one_exists()
    {
        var tenant = await factory.NewTenantAsync();

        var second = await (await tenant.Client.PostAsJsonAsync("/api/v1/users",
            Invite(role: "organizationAdmin"), ApiFactory.Json))
            .Content.ReadFromJsonAsync<InvitedUser>(ApiFactory.Json);

        // Still refused: the new administrator has never signed in, so it is Invited rather
        // than Active, and an organization whose only active admin is demoted is stuck.
        var tooEarly = await tenant.Client.PatchAsJsonAsync($"/api/v1/users/{tenant.Auth.User.UserId}",
            new { role = "viewer" }, ApiFactory.Json);
        tooEarly.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        await tenant.Client.PatchAsJsonAsync($"/api/v1/users/{second!.User.Id}",
            new { status = "active" }, ApiFactory.Json);

        var now = await tenant.Client.PatchAsJsonAsync($"/api/v1/users/{tenant.Auth.User.UserId}",
            new { role = "viewer" }, ApiFactory.Json);
        now.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Superadmin_cannot_be_granted_through_an_invitation()
    {
        var tenant = await factory.NewTenantAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/users",
            Invite(role: "superAdmin"), ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task The_same_email_cannot_be_invited_twice()
    {
        var tenant = await factory.NewTenantAsync();
        var email = $"member-{Guid.NewGuid():N}@example.test";

        await tenant.Client.PostAsJsonAsync("/api/v1/users", Invite(email: email), ApiFactory.Json);
        var again = await tenant.Client.PostAsJsonAsync("/api/v1/users", Invite(email: email), ApiFactory.Json);

        again.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Reading_the_list_does_not_grant_the_right_to_change_it()
    {
        var tenant = await factory.NewTenantAsync();
        var reader = await factory.ClientWithPermissionsAsync(tenant, "user:read");

        (await reader.GetAsync("/api/v1/users")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await reader.PostAsJsonAsync("/api/v1/users", Invite(), ApiFactory.Json))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task One_tenant_cannot_see_or_change_another_tenants_people()
    {
        var alpha = await factory.NewTenantAsync("Alpha");
        var beta = await factory.NewTenantAsync("Beta");

        var invited = await (await alpha.Client.PostAsJsonAsync("/api/v1/users", Invite(), ApiFactory.Json))
            .Content.ReadFromJsonAsync<InvitedUser>(ApiFactory.Json);

        var betaSees = await beta.Client.GetFromJsonAsync<List<UserSummary>>("/api/v1/users", ApiFactory.Json);
        betaSees!.Should().ContainSingle().Which.Email.Should().Be(beta.Email);

        var reach = await beta.Client.PatchAsJsonAsync($"/api/v1/users/{invited!.User.Id}",
            new { status = "disabled" }, ApiFactory.Json);
        reach.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
