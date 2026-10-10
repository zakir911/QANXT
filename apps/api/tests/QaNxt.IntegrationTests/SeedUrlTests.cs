using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using QaNxt.Application.Abstractions;
using QaNxt.Infrastructure.Persistence;

namespace QaNxt.IntegrationTests;

/// <summary>Discovery has to be able to reach pages nothing links to.
///
/// A crawl starts at one URL and spreads by following links. An application whose
/// navigation is a client-side router publishes no links, so the crawl finds the landing
/// page and stops however large the budget is — which is how a user got one page and one
/// test from an admin application with many screens.
///
/// Clicking navigation is one answer and it requires turning something on. Naming the
/// routes is the other, it needs no clicking at all, and the person who owns the
/// application already knows them.</summary>
[Collection(ApiCollection.Name)]
public class SeedUrlTests(ApiFactory factory)
{
    private async Task<(TestTenant Tenant, Guid ProjectId)> ProjectAsync()
    {
        var tenant = await factory.NewTenantAsync();
        var response = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Seeds",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);
        var project = await response.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        return (tenant, project!.Id);
    }

    private static object Body(Guid projectId, string? seedUrls = null, bool? useSitemap = null) => new
    {
        projectId,
        name = "Admin",
        baseUrl = "https://admin.example.test/",
        description = "Created by an integration test",
        authStrategy = "none",
        seedUrls,
        useSitemap
    };

    private async Task<(string Seeds, bool Sitemap)> StoredAsync(Guid applicationId)
    {
        using var scope = factory.Services.CreateScope();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenant.EnterSystemContext("reading an application in a test");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
        var app = await db.Applications.AsNoTracking().FirstAsync(a => a.Id == applicationId);
        return (app.SeedUrls, app.UseSitemap);
    }

    private async Task<Guid> CreateAsync(TestTenant tenant, object body)
    {
        var response = await tenant.Client.PostAsJsonAsync("/api/v1/applications", body, ApiFactory.Json);
        response.StatusCode.Should().Be(HttpStatusCode.Created);
        var created = await response.Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);
        return created!.Id;
    }

    [Fact]
    public async Task Routes_pasted_with_newlines_are_stored_as_a_list()
    {
        var (tenant, projectId) = await ProjectAsync();

        // How people actually paste them: out of a browser, a spreadsheet or a sitemap.
        var id = await CreateAsync(tenant, Body(projectId,
            seedUrls: "/dashboard\n/users\n\n  /reports/monthly  \n"));

        var stored = await StoredAsync(id);
        stored.Seeds.Should().Be("/dashboard,/users,/reports/monthly");
    }

    [Fact]
    public async Task A_route_listed_twice_is_stored_once()
    {
        var (tenant, projectId) = await ProjectAsync();

        var id = await CreateAsync(tenant, Body(projectId, seedUrls: "/users,/users,/USERS"));

        // A route listed twice is not two routes, and the crawl would skip the repeat
        // anyway while the stored value implied otherwise.
        (await StoredAsync(id)).Seeds.Should().Be("/users");
    }

    [Fact]
    public async Task The_sitemap_is_read_unless_somebody_turns_it_off()
    {
        var (tenant, projectId) = await ProjectAsync();

        var onByDefault = await CreateAsync(tenant, Body(projectId));
        (await StoredAsync(onByDefault)).Sitemap.Should().BeTrue();

        var turnedOff = await CreateAsync(tenant, Body(projectId, useSitemap: false));
        (await StoredAsync(turnedOff)).Sitemap.Should().BeFalse();
    }

    [Fact]
    public async Task Routes_can_be_added_to_an_application_that_already_exists()
    {
        var (tenant, projectId) = await ProjectAsync();
        var id = await CreateAsync(tenant, Body(projectId));

        (await StoredAsync(id)).Seeds.Should().BeEmpty();

        // The case this is for: an application registered before anybody knew the crawl
        // could not reach its pages.
        var patched = await tenant.Client.PatchAsJsonAsync($"/api/v1/applications/{id}",
            new { seedUrls = "/dashboard\n/users" }, ApiFactory.Json);
        patched.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.NoContent);

        (await StoredAsync(id)).Seeds.Should().Be("/dashboard,/users");
    }

    [Fact]
    public async Task The_detail_endpoint_returns_them_so_the_form_can_show_them()
    {
        var (tenant, projectId) = await ProjectAsync();
        var id = await CreateAsync(tenant, Body(projectId, seedUrls: "/dashboard,/users"));

        var detail = await tenant.Client.GetFromJsonAsync<AppDetailResponse>(
            $"/api/v1/applications/{id}", ApiFactory.Json);

        // Stored but unreadable would mean the edit form silently cleared them on the next
        // save, which is how the credentials nearly went.
        detail!.SeedUrls.Should().Be("/dashboard,/users");
        detail.UseSitemap.Should().BeTrue();
    }

    [Fact]
    public async Task Editing_something_else_does_not_clear_the_routes()
    {
        var (tenant, projectId) = await ProjectAsync();
        var id = await CreateAsync(tenant, Body(projectId, seedUrls: "/dashboard,/users"));

        await tenant.Client.PatchAsJsonAsync($"/api/v1/applications/{id}",
            new { maxPages = 120 }, ApiFactory.Json);

        (await StoredAsync(id)).Seeds.Should().Be("/dashboard,/users");
    }

    private sealed record AppIdResponse(Guid Id);
    private sealed record AppDetailResponse(Guid Id, string SeedUrls, bool UseSitemap);
}
