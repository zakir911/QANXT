using System.Net;
using System.Net.Http.Json;
using QaNxt.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using QaNxt.Application.Abstractions;

namespace QaNxt.IntegrationTests;

/// <summary>Whether an application's robots.txt is respected is now something the crawler
/// acts on, so it has to be something a person can set and see.
///
/// It was neither. <c>RespectRobotsTxt</c> defaulted to true on the entity and appeared in
/// <c>ApplicationDetail</c>, but no create or update request carried it: the flag was
/// readable and permanently stuck. With the crawler enforcing it — and refusing an origin
/// whose robots.txt cannot be read — a stuck flag would have meant an application nobody
/// could explore and no way to say so.</summary>
[Collection(ApiCollection.Name)]
public class RobotsPolicyTests(ApiFactory factory)
{
    private async Task<(TestTenant Tenant, Guid ProjectId)> NewProjectAsync()
    {
        var tenant = await factory.NewTenantAsync();
        var response = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Public Site",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);

        var project = await response.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        return (tenant, project!.Id);
    }

    private static object Application(Guid projectId, bool? respectRobotsTxt) => new
    {
        projectId,
        name = "Public Site",
        baseUrl = "https://site.example.test/",
        description = "Created by an integration test",
        authStrategy = "none",
        respectRobotsTxt
    };

    private async Task<ApplicationDetailResponse> CreateAsync(TestTenant tenant, Guid projectId, bool? respect)
    {
        var response = await tenant.Client.PostAsJsonAsync("/api/v1/applications",
            Application(projectId, respect), ApiFactory.Json);
        response.StatusCode.Should().Be(HttpStatusCode.Created);
        return (await response.Content.ReadFromJsonAsync<ApplicationDetailResponse>(ApiFactory.Json))!;
    }

    private async Task<bool> StoredFlagAsync(Guid applicationId)
    {
        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("integration test inspection");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();

        return await db.Applications.AsNoTracking()
            .Where(a => a.Id == applicationId)
            .Select(a => a.RespectRobotsTxt)
            .FirstAsync();
    }

    private async Task<(QaNxt.Domain.Enums.AuditAction Action, string Summary)[]> AuditEntriesAsync(
        Guid applicationId)
    {
        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("integration test inspection");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();

        var rows = await db.AuditLogs.AsNoTracking()
            .Where(a => a.EntityId == applicationId)
            .OrderBy(a => a.OccurredAt)
            .Select(a => new { a.Action, a.Summary })
            .ToArrayAsync();

        return rows.Select(r => (r.Action, r.Summary)).ToArray();
    }

    private async Task<string[]> AuditSummariesAsync(Guid applicationId)
        => (await AuditEntriesAsync(applicationId)).Select(e => e.Summary).ToArray();

    [Fact]
    public async Task Robots_txt_is_respected_unless_the_request_says_otherwise()
    {
        var (tenant, projectId) = await NewProjectAsync();

        var created = await CreateAsync(tenant, projectId, respect: null);

        created.RespectRobotsTxt.Should().BeTrue();
        (await StoredFlagAsync(created.Id)).Should().BeTrue();
    }

    [Fact]
    public async Task An_application_can_be_registered_with_robots_txt_turned_off()
    {
        var (tenant, projectId) = await NewProjectAsync();

        var created = await CreateAsync(tenant, projectId, respect: false);

        created.RespectRobotsTxt.Should().BeFalse();
        // Asserted against the row as well as the response: the flag is read by the worker
        // from the database, so a response that says false over a row that says true would
        // be the same class of defect as the one being fixed.
        (await StoredFlagAsync(created.Id)).Should().BeFalse();
    }

    [Fact]
    public async Task Turning_robots_txt_off_at_registration_is_audited()
    {
        var (tenant, projectId) = await NewProjectAsync();

        var created = await CreateAsync(tenant, projectId, respect: false);

        var entries = await AuditEntriesAsync(created.Id);
        var robots = entries.Where(e => e.Summary.Contains("robots.txt")).ToArray();

        robots.Should().ContainSingle()
            .Which.Summary.Should().Contain("robots.txt will NOT be respected");
        // One decision, recorded the same way whether it is made at registration or later,
        // so a trail filtered by action shows both.
        robots[0].Action.Should().Be(QaNxt.Domain.Enums.AuditAction.ConfigurationChanged);
    }

    [Fact]
    public async Task Registering_with_robots_txt_on_is_not_audited_as_a_decision()
    {
        // The default is not a decision anybody made, and an audit trail that records it
        // on every application makes the entries that matter harder to find.
        var (tenant, projectId) = await NewProjectAsync();

        var created = await CreateAsync(tenant, projectId, respect: true);

        (await AuditSummariesAsync(created.Id)).Should().NotContain(s => s.Contains("robots.txt"));
    }

    [Fact]
    public async Task The_flag_can_be_changed_afterwards_and_the_change_is_audited()
    {
        var (tenant, projectId) = await NewProjectAsync();
        var created = await CreateAsync(tenant, projectId, respect: null);

        var off = await tenant.Client.PatchAsJsonAsync($"/api/v1/applications/{created.Id}",
            new { respectRobotsTxt = false }, ApiFactory.Json);
        off.StatusCode.Should().Be(HttpStatusCode.OK);
        (await StoredFlagAsync(created.Id)).Should().BeFalse();

        var on = await tenant.Client.PatchAsJsonAsync($"/api/v1/applications/{created.Id}",
            new { respectRobotsTxt = true }, ApiFactory.Json);
        on.StatusCode.Should().Be(HttpStatusCode.OK);
        (await StoredFlagAsync(created.Id)).Should().BeTrue();

        var summaries = await AuditSummariesAsync(created.Id);
        summaries.Should().Contain(s => s.Contains("robots.txt will NOT be respected"));
        summaries.Should().Contain(s => s.Contains("robots.txt will be respected"));
    }

    [Fact]
    public async Task An_update_that_does_not_mention_the_flag_leaves_it_alone()
    {
        var (tenant, projectId) = await NewProjectAsync();
        var created = await CreateAsync(tenant, projectId, respect: false);

        var response = await tenant.Client.PatchAsJsonAsync($"/api/v1/applications/{created.Id}",
            new { description = "Renamed by a test" }, ApiFactory.Json);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        (await StoredFlagAsync(created.Id)).Should().BeFalse();
    }
}

/// <summary>The fields of an application's detail document this suite reads.</summary>
public sealed record ApplicationDetailResponse(Guid Id, string BaseUrl, bool RespectRobotsTxt);
