using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace QaNxt.IntegrationTests;

/// <summary>What a session is allowed to do, and what one tenant can see of another.
///
/// Both guarantees are enforced server-side and neither can be checked from a unit test: a
/// permission is a policy applied by the pipeline, and tenant isolation is a query filter
/// applied by the DbContext. A regression in either is a security incident rather than a
/// bug, so they are asserted through real requests.</summary>
[Collection(ApiCollection.Name)]
public class AuthorizationTests(ApiFactory factory)
{
    private static object NewProject(string? key = null) => new
    {
        name = "Retail Banking",
        key = key ?? $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
        description = "Created by an integration test"
    };

    [Fact]
    public async Task A_session_without_the_permission_is_refused_the_write()
    {
        var tenant = await factory.NewTenantAsync();
        var readOnly = await factory.ClientWithPermissionsAsync(tenant, "project:read");

        var response = await readOnly.PostAsJsonAsync("/api/v1/projects", NewProject(), ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task The_same_session_is_allowed_the_read_it_does_have()
    {
        var tenant = await factory.NewTenantAsync();
        var readOnly = await factory.ClientWithPermissionsAsync(tenant, "project:read");

        var response = await readOnly.GetAsync("/api/v1/projects");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task A_session_carrying_no_permissions_cannot_even_read()
    {
        // An authenticated identity is not an authorized one; a token with an empty
        // permission set must open nothing.
        var tenant = await factory.NewTenantAsync();
        var powerless = await factory.ClientWithPermissionsAsync(tenant);

        var response = await powerless.GetAsync("/api/v1/projects");

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Changing_a_quality_gate_needs_more_than_reading_one()
    {
        // A pipeline account that could relax its own gate would not be a gate at all.
        var tenant = await factory.NewTenantAsync();
        var created = await tenant.Client.PostAsJsonAsync("/api/v1/projects", NewProject(), ApiFactory.Json);
        var project = await created.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);

        var reader = await factory.ClientWithPermissionsAsync(tenant, "project:read");

        var list = await reader.GetAsync($"/api/v1/quality-gates?projectId={project!.Id}");
        list.StatusCode.Should().Be(HttpStatusCode.OK);


        var write = await reader.PostAsJsonAsync($"/api/v1/quality-gates?projectId={project.Id}", new
        {
            name = "Relaxed", metric = "passRatePercent", operator_ = "greaterThanOrEqual", threshold = 0
        }, ApiFactory.Json);
        write.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task One_tenant_cannot_list_another_tenants_projects()
    {
        var alpha = await factory.NewTenantAsync("Alpha");
        var beta = await factory.NewTenantAsync("Beta");

        await alpha.Client.PostAsJsonAsync("/api/v1/projects", NewProject(), ApiFactory.Json);

        var betaSees = await beta.Client.GetFromJsonAsync<List<ProjectResponse>>("/api/v1/projects", ApiFactory.Json);

        betaSees.Should().BeEmpty();
    }

    [Fact]
    public async Task One_tenant_cannot_fetch_another_tenants_project_by_its_id()
    {
        var alpha = await factory.NewTenantAsync("Alpha");
        var beta = await factory.NewTenantAsync("Beta");

        var created = await alpha.Client.PostAsJsonAsync("/api/v1/projects", NewProject(), ApiFactory.Json);
        var project = await created.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);

        var response = await beta.Client.GetAsync($"/api/v1/projects/{project!.Id}");

        // Not found rather than forbidden: confirming that an id exists is itself a leak.
        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task One_tenant_cannot_write_into_another_tenants_project()
    {
        var alpha = await factory.NewTenantAsync("Alpha");
        var beta = await factory.NewTenantAsync("Beta");

        var created = await alpha.Client.PostAsJsonAsync("/api/v1/projects", NewProject(), ApiFactory.Json);
        var project = await created.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);

        var response = await beta.Client.PostAsJsonAsync($"/api/v1/quality-gates?projectId={project!.Id}", new
        {
            name = "Planted", metric = "failedCount", @operator = "lessThanOrEqual", threshold = 5
        }, ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Two_tenants_may_use_the_same_project_key_without_colliding()
    {
        // Uniqueness that is global rather than per-tenant leaks one customer's naming to
        // another, and lets either deny the other a key.
        var alpha = await factory.NewTenantAsync("Alpha");
        var beta = await factory.NewTenantAsync("Beta");

        var first = await alpha.Client.PostAsJsonAsync("/api/v1/projects", NewProject("SHARED"), ApiFactory.Json);
        var second = await beta.Client.PostAsJsonAsync("/api/v1/projects", NewProject("SHARED"), ApiFactory.Json);

        first.StatusCode.Should().Be(HttpStatusCode.Created);
        second.StatusCode.Should().Be(HttpStatusCode.Created);
    }

    [Fact]
    public async Task A_worker_token_cannot_be_used_as_a_user_session()
    {
        // A worker token is minted for one job and must not become a way into the console's
        // API, even though it is issued by the same signing key.
        var tenant = await factory.NewTenantAsync();
        var worker = factory.WorkerClient(tenant.OrganizationId, Guid.NewGuid(), "execution");

        var response = await worker.GetAsync("/api/v1/projects");

        response.StatusCode.Should().BeOneOf(HttpStatusCode.Forbidden, HttpStatusCode.Unauthorized);
    }
}

public sealed record ProjectResponse(Guid Id, string Name, string Key, string Description);
