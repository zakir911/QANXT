using System.Net;
using System.Net.Http.Json;
using QaNxt.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using QaNxt.Application.Abstractions;

namespace QaNxt.IntegrationTests;

/// <summary>The crawl boundary's defaults have to survive a blank field.
///
/// <c>ExcludedPaths</c> defaults to <c>/logout,/signout,/delete</c>, and that default is the
/// only thing stopping discovery from clicking sign-out or a delete link on somebody else's
/// application. It was written as <c>request.ExcludedPaths?.Trim() ?? "/logout,…"</c>, which
/// never fires for an empty string: <c>""?.Trim()</c> is <c>""</c>, not null. Clearing the
/// field in the console therefore stored an empty exclusion list and the protection was gone,
/// silently (QA pass, ISSUE-001).
///
/// Blank means "I did not choose", which is the default. An explicit list means that list.
/// There is deliberately no way to store an empty exclusion list through this request shape:
/// nobody has asked for one, and the accident is what this guards.</summary>
[Collection(ApiCollection.Name)]
public class CrawlBoundaryTests(ApiFactory factory)
{
    private const string DefaultExclusions = "/logout,/signout,/delete";

    private async Task<(TestTenant Tenant, Guid ProjectId)> NewProjectAsync()
    {
        var tenant = await factory.NewTenantAsync();
        var response = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Crawl Boundary",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);

        var project = await response.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        return (tenant, project!.Id);
    }

    private async Task<Guid> CreateAsync(TestTenant tenant, Guid projectId, string? excludedPaths)
    {
        var response = await tenant.Client.PostAsJsonAsync("/api/v1/applications", new
        {
            projectId,
            name = "Public Site",
            baseUrl = "https://site.example.test/",
            description = "Created by an integration test",
            authStrategy = "none",
            excludedPaths
        }, ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.Created);
        var detail = await response.Content.ReadFromJsonAsync<ApplicationBoundaryResponse>(ApiFactory.Json);
        return detail!.Id;
    }

    private async Task<string> StoredExclusionsAsync(Guid applicationId)
    {
        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("integration test inspection");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();

        return await db.Applications.AsNoTracking()
            .Where(a => a.Id == applicationId)
            .Select(a => a.ExcludedPaths)
            .FirstAsync();
    }

    [Theory]
    [InlineData(null)]          // the field was never sent
    [InlineData("")]            // the field was sent, cleared
    [InlineData("   ")]         // the field was sent with whitespace
    public async Task A_blank_exclusion_list_keeps_the_default(string? excludedPaths)
    {
        var (tenant, projectId) = await NewProjectAsync();

        var id = await CreateAsync(tenant, projectId, excludedPaths);

        // Asserted against the row, not the response: the worker reads the row, and an empty
        // list there is what would let a crawl open /logout on somebody else's application.
        (await StoredExclusionsAsync(id)).Should().Be(DefaultExclusions);
    }

    [Fact]
    public async Task An_explicit_exclusion_list_is_stored_as_given()
    {
        var (tenant, projectId) = await NewProjectAsync();

        var id = await CreateAsync(tenant, projectId, "/admin,/billing");

        // The guard must not reach past the blank case and overwrite a real choice.
        (await StoredExclusionsAsync(id)).Should().Be("/admin,/billing");
    }

    [Fact]
    public async Task Clearing_the_exclusion_list_on_an_update_restores_the_default()
    {
        var (tenant, projectId) = await NewProjectAsync();
        var id = await CreateAsync(tenant, projectId, "/admin");

        var response = await tenant.Client.PatchAsJsonAsync($"/api/v1/applications/{id}",
            new { excludedPaths = "" }, ApiFactory.Json);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        (await StoredExclusionsAsync(id)).Should().Be(DefaultExclusions);
    }

    [Fact]
    public async Task An_update_can_still_change_the_exclusion_list()
    {
        var (tenant, projectId) = await NewProjectAsync();
        var id = await CreateAsync(tenant, projectId, "/admin");

        await tenant.Client.PatchAsJsonAsync($"/api/v1/applications/{id}",
            new { excludedPaths = "/billing,/exports" }, ApiFactory.Json);

        (await StoredExclusionsAsync(id)).Should().Be("/billing,/exports");
    }

    [Fact]
    public async Task An_update_that_does_not_mention_the_exclusion_list_leaves_it_alone()
    {
        var (tenant, projectId) = await NewProjectAsync();
        var id = await CreateAsync(tenant, projectId, "/admin");

        await tenant.Client.PatchAsJsonAsync($"/api/v1/applications/{id}",
            new { description = "Renamed by a test" }, ApiFactory.Json);

        (await StoredExclusionsAsync(id)).Should().Be("/admin");
    }
}

/// <summary>The one field of the created application this suite reads back.</summary>
public sealed record ApplicationBoundaryResponse(Guid Id, string ExcludedPaths);
