using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using QaNxt.Application.Security;

namespace QaNxt.IntegrationTests;

/// <summary>The console's new scope editor has to send what this endpoint accepts.
///
/// The console had no editor at all, so this request shape had only ever been exercised by
/// hand-written curl and by tests that build the record directly. A form that posts a body
/// the API quietly ignores or rejects is the same defect as having no form: the user believes
/// they authorized something and nothing was stored.
///
/// So these send the exact JSON the editor builds, including the nullable fields it sends as
/// null and the camelCase the browser produces, and check what came back out.</summary>
[Collection(ApiCollection.Name)]
public class SecurityScopeEditorContractTests(ApiFactory factory)
{
    private const string Note =
        "Authorized by Z. Inamdar, owner, for the staging site only. Ticket QA-1, 2026-10-09.";

    private async Task<(TestTenant Tenant, Guid ApplicationId)> ApplicationAsync()
    {
        var tenant = await factory.NewTenantAsync();

        var projectResponse = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Scope Editor",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);
        var project = await projectResponse.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);

        var appResponse = await tenant.Client.PostAsJsonAsync("/api/v1/applications", new
        {
            projectId = project!.Id,
            name = "Public Site",
            baseUrl = "https://site.example.test/",
            description = "Created by an integration test",
            authStrategy = "none"
        }, ApiFactory.Json);
        appResponse.StatusCode.Should().Be(HttpStatusCode.Created);
        var application = await appResponse.Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);

        return (tenant, application!.Id);
    }

    /// <summary>Exactly the body the editor posts for a passive scope.</summary>
    private static object PassiveBody() => new
    {
        enabled = true,
        authorizationNote = Note,
        allowedDomains = "site.example.test",
        allowedApiDomains = (string?)null,
        allowedPaths = (string?)null,
        blockedPaths = (string?)null,
        environmentId = (Guid?)null,
        maxRequestsPerSecond = 5,
        maxConcurrentRequests = 2,
        maxScanDurationMinutes = 20,
        allowActiveTesting = false,
        allowDestructiveTesting = false,
        allowProduction = false
    };

    [Fact]
    public async Task The_editors_passive_body_is_accepted_and_stored_as_sent()
    {
        var (tenant, applicationId) = await ApplicationAsync();

        var saved = await tenant.Client.PutAsJsonAsync(
            $"/api/v1/security/applications/{applicationId}/scope", PassiveBody(), ApiFactory.Json);
        saved.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);

        var scope = await tenant.Client.GetFromJsonAsync<SecurityScopeSummary>(
            $"/api/v1/security/applications/{applicationId}/scope", ApiFactory.Json);

        scope!.Enabled.Should().BeTrue();
        scope.AuthorizationNote.Should().Be(Note);
        scope.AllowedDomains.Should().Be("site.example.test");
        scope.MaxRequestsPerSecond.Should().Be(5);
        scope.MaxConcurrentRequests.Should().Be(2);
        scope.MaxScanDurationMinutes.Should().Be(20);
        scope.AllowActiveTesting.Should().BeFalse();
        scope.AllowDestructiveTesting.Should().BeFalse();
        scope.AllowProduction.Should().BeFalse();
        scope.AuthorizedAt.Should().NotBeNull("a scope records when somebody authorized it");
        scope.AuthorizedByUserId.Should().NotBeNull("and who");
    }

    [Fact]
    public async Task Nulls_the_editor_sends_for_optional_lists_do_not_become_the_string_null()
    {
        var (tenant, applicationId) = await ApplicationAsync();

        await tenant.Client.PutAsJsonAsync(
            $"/api/v1/security/applications/{applicationId}/scope", PassiveBody(), ApiFactory.Json);

        var scope = await tenant.Client.GetFromJsonAsync<SecurityScopeSummary>(
            $"/api/v1/security/applications/{applicationId}/scope", ApiFactory.Json);

        // An allowlist containing the literal text "null" would match no host and the guard's
        // refusal would read like a product fault.
        scope!.AllowedApiDomains.Should().NotBe("null");
        scope.AllowedPaths.Should().NotBe("null");
        scope.BlockedPaths.Should().NotBe("null");
    }

    [Fact]
    public async Task An_edit_replaces_the_scope_rather_than_adding_a_second_one()
    {
        var (tenant, applicationId) = await ApplicationAsync();

        await tenant.Client.PutAsJsonAsync(
            $"/api/v1/security/applications/{applicationId}/scope", PassiveBody(), ApiFactory.Json);

        var first = await tenant.Client.GetFromJsonAsync<SecurityScopeSummary>(
            $"/api/v1/security/applications/{applicationId}/scope", ApiFactory.Json);

        await tenant.Client.PutAsJsonAsync($"/api/v1/security/applications/{applicationId}/scope", new
        {
            enabled = true,
            authorizationNote = Note,
            allowedDomains = "site.example.test,api.site.example.test",
            allowedApiDomains = "api.site.example.test",
            allowedPaths = (string?)null,
            blockedPaths = "/admin/billing",
            environmentId = (Guid?)null,
            maxRequestsPerSecond = 9,
            maxConcurrentRequests = 3,
            maxScanDurationMinutes = 30,
            allowActiveTesting = true,
            allowDestructiveTesting = false,
            allowProduction = false
        }, ApiFactory.Json);

        var second = await tenant.Client.GetFromJsonAsync<SecurityScopeSummary>(
            $"/api/v1/security/applications/{applicationId}/scope", ApiFactory.Json);

        second!.Id.Should().Be(first!.Id, "one application has one scope, not a history of them");
        second.MaxRequestsPerSecond.Should().Be(9);
        second.BlockedPaths.Should().Be("/admin/billing");
        second.AllowActiveTesting.Should().BeTrue();
    }

    [Fact]
    public async Task Withdrawing_authorization_keeps_the_record_of_who_gave_it()
    {
        var (tenant, applicationId) = await ApplicationAsync();

        await tenant.Client.PutAsJsonAsync(
            $"/api/v1/security/applications/{applicationId}/scope", PassiveBody(), ApiFactory.Json);

        // Exactly what the editor sends when "Scope is enabled" is unchecked.
        await tenant.Client.PutAsJsonAsync($"/api/v1/security/applications/{applicationId}/scope", new
        {
            enabled = false,
            authorizationNote = Note,
            allowedDomains = "site.example.test",
            allowedApiDomains = (string?)null,
            allowedPaths = (string?)null,
            blockedPaths = (string?)null,
            environmentId = (Guid?)null,
            maxRequestsPerSecond = 5,
            maxConcurrentRequests = 2,
            maxScanDurationMinutes = 20,
            allowActiveTesting = false,
            allowDestructiveTesting = false,
            allowProduction = false
        }, ApiFactory.Json);

        var scope = await tenant.Client.GetFromJsonAsync<SecurityScopeSummary>(
            $"/api/v1/security/applications/{applicationId}/scope", ApiFactory.Json);

        scope!.Enabled.Should().BeFalse();
        scope.AuthorizationNote.Should().Be(Note);
    }

    [Fact]
    public async Task Writing_a_scope_needs_the_authorize_permission()
    {
        var (tenant, applicationId) = await ApplicationAsync();

        // The console hides the button without this permission, and a hidden button is not a
        // security boundary. The endpoint has to refuse it too.
        var reader = await factory.ClientWithPermissionsAsync(
            tenant, Permissions.SecurityRead, Permissions.SecurityScan);

        var refused = await reader.PutAsJsonAsync(
            $"/api/v1/security/applications/{applicationId}/scope", PassiveBody(), ApiFactory.Json);
        refused.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        var still = await tenant.Client.GetAsync(
            $"/api/v1/security/applications/{applicationId}/scope");
        still.StatusCode.Should().Be(HttpStatusCode.NotFound, "nothing was authorized");
    }

    private sealed record AppIdResponse(Guid Id);
}
