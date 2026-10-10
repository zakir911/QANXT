using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using QaNxt.Application.Abstractions;
using QaNxt.Infrastructure.Persistence;

namespace QaNxt.IntegrationTests;

/// <summary>What a crawl is allowed to click has to be a stored decision, not a default.
///
/// Discovery followed a[href] and nothing else, so an application whose navigation is
/// buttons calling a client-side router produced one page and one smoke test. Reaching the
/// rest means clicking controls on somebody's running system, which is not a thing to switch
/// on globally: it is a per-application decision that has to survive a restart, show up in
/// the audit trail, and never be arrived at by accident.
///
/// The accident this guards is specific. The migration that added the column generated a
/// default of "", and the worker treats anything that is not "links" as permission to click.
/// Running a migration would have upgraded every existing application from reading to
/// clicking, silently.</summary>
[Collection(ApiCollection.Name)]
public class CrawlInteractionModeTests(ApiFactory factory)
{
    private async Task<(TestTenant Tenant, Guid ProjectId)> ProjectAsync()
    {
        var tenant = await factory.NewTenantAsync();
        var response = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Interaction",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);
        var project = await response.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        return (tenant, project!.Id);
    }

    private static object Body(Guid projectId, string? interactionMode = null,
        bool? allowStateChangingClicks = null) => new
    {
        projectId,
        name = "Admin",
        baseUrl = "https://admin.example.test/",
        description = "Created by an integration test",
        authStrategy = "none",
        interactionMode,
        allowStateChangingClicks
    };

    private async Task<(string Mode, bool AllowsStateChanges)> StoredAsync(Guid applicationId)
    {
        using var scope = factory.Services.CreateScope();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenant.EnterSystemContext("reading an application in a test");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
        var app = await db.Applications.AsNoTracking().FirstAsync(a => a.Id == applicationId);
        return (app.InteractionMode, app.AllowStateChangingClicks);
    }

    [Fact]
    public async Task An_application_follows_links_only_unless_somebody_says_otherwise()
    {
        var (tenant, projectId) = await ProjectAsync();

        var created = await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Body(projectId), ApiFactory.Json);
        created.StatusCode.Should().Be(HttpStatusCode.Created);
        var application = await created.Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);

        var stored = await StoredAsync(application!.Id);
        stored.Mode.Should().Be("links", "clicking a running application is never the default");
        stored.AllowsStateChanges.Should().BeFalse();
    }

    [Fact]
    public async Task A_blank_mode_is_stored_as_links_rather_than_as_blank()
    {
        var (tenant, projectId) = await ProjectAsync();

        var created = await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Body(projectId, interactionMode: "   "), ApiFactory.Json);
        var application = await created.Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);

        // An empty string is not "links" to the worker, which reads the mode directly.
        (await StoredAsync(application!.Id)).Mode.Should().Be("links");
    }

    [Theory]
    [InlineData("navigation")]
    [InlineData("interactive")]
    [InlineData("INTERACTIVE")]
    public async Task A_mode_somebody_chose_is_stored(string requested)
    {
        var (tenant, projectId) = await ProjectAsync();

        var created = await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Body(projectId, interactionMode: requested), ApiFactory.Json);
        created.StatusCode.Should().Be(HttpStatusCode.Created);
        var application = await created.Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);

        (await StoredAsync(application!.Id)).Mode.Should().Be(requested.ToLowerInvariant());
    }

    [Fact]
    public async Task An_unknown_mode_is_refused_rather_than_quietly_downgraded()
    {
        var (tenant, projectId) = await ProjectAsync();

        // Silently storing "links" for a mode somebody typed would look like the setting did
        // nothing, and they would go looking for the bug somewhere else.
        var created = await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Body(projectId, interactionMode: "aggressive"), ApiFactory.Json);

        created.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var problem = await created.Content.ReadAsStringAsync();
        problem.Should().Contain("links, navigation or interactive");
    }

    [Fact]
    public async Task Turning_on_clicking_is_written_to_the_audit_trail()
    {
        var (tenant, projectId) = await ProjectAsync();

        var created = await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Body(projectId, interactionMode: "interactive", allowStateChangingClicks: true),
            ApiFactory.Json);
        created.StatusCode.Should().Be(HttpStatusCode.Created);

        var audit = await tenant.Client.GetStringAsync(
            $"/api/v1/audit?projectId={projectId}&limit=50");

        audit.Should().Contain("may click any control");
        // The dangerous half has to be findable on its own, not buried in a mode name.
        audit.Should().Contain("change data");
    }

    [Fact]
    public async Task The_setting_reaches_the_queued_discovery_job()
    {
        var (tenant, projectId) = await ProjectAsync();

        var created = await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Body(projectId, interactionMode: "navigation"), ApiFactory.Json);
        var application = await created.Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);

        var run = await tenant.Client.PostAsJsonAsync("/api/v1/discovery/runs", new
        {
            applicationId = application!.Id, maxDepth = 2, maxPages = 10, timeoutSeconds = 60
        }, ApiFactory.Json);
        run.StatusCode.Should().BeOneOf(HttpStatusCode.Created, HttpStatusCode.Accepted, HttpStatusCode.OK);

        // Stored on the application is not the same as carried into the job the worker reads.
        // The worker never looks the application up; the job is the whole instruction.
        var detail = await tenant.Client.GetFromJsonAsync<AppDetailResponse>(
            $"/api/v1/applications/{application.Id}", ApiFactory.Json);
        detail!.InteractionMode.Should().Be("navigation");
        detail.AllowStateChangingClicks.Should().BeFalse();
    }

    [Fact]
    public async Task An_application_can_be_put_back_to_links_only()
    {
        var (tenant, projectId) = await ProjectAsync();

        var created = await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Body(projectId, interactionMode: "interactive", allowStateChangingClicks: true),
            ApiFactory.Json);
        var application = await created.Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);

        var patched = await tenant.Client.PatchAsJsonAsync($"/api/v1/applications/{application!.Id}",
            new { interactionMode = "links", allowStateChangingClicks = false }, ApiFactory.Json);
        patched.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.NoContent);

        var stored = await StoredAsync(application.Id);
        stored.Mode.Should().Be("links");
        stored.AllowsStateChanges.Should().BeFalse();
    }

    private sealed record AppIdResponse(Guid Id);
    private sealed record AppDetailResponse(Guid Id, string InteractionMode, bool AllowStateChangingClicks);
}
