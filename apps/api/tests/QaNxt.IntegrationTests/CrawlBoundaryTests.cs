using System.Net;
using System.Net.Http.Json;
using QaNxt.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using QaNxt.Application.Abstractions;
using QaNxt.Domain;

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

/// <summary>Repairing applications that were stored before the blank-field fix.
///
/// Fixing the write path does nothing for rows already in the database, and a stored empty
/// exclusion list is a crawl that may open sign-out or a delete link on somebody else's
/// application. `RestoreBlankExcludedPaths` runs the repair once per deployment.
///
/// The statement under test is the one the migration runs, taken from the same constant,
/// because a test asserting against its own copy of the SQL can pass while the migration
/// is wrong.</summary>
[Collection(ApiCollection.Name)]
public class BlankExclusionRepairTests(ApiFactory factory)
{
    private const string Default = BlankExclusionRepair.DefaultExcludedPaths;

    /// <summary>Writes rows straight to the table: the API no longer lets a blank list in,
    /// which is the point of the fix and also why the damaged state has to be seeded.
    ///
    /// The project is created through the API first. Inventing a project id fails the
    /// applications foreign key, and a seed that cannot insert makes every assertion after
    /// it meaningless.</summary>
    private async Task<(Guid Blank, Guid Whitespace, Guid Chosen)> SeedAsync()
    {
        var tenant = await factory.NewTenantAsync();
        var created = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Repair",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);
        created.StatusCode.Should().Be(HttpStatusCode.Created);
        var project = await created.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        var projectId = project!.Id;

        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("integration test seeding");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();

        var organizationId = await db.Projects.AsNoTracking()
            .Where(x => x.Id == projectId).Select(x => x.OrganizationId).FirstAsync();

        Domain.Applications.Application Row(string excluded) => new()
        {
            Id = Guid.NewGuid(),
            OrganizationId = organizationId,
            ProjectId = projectId,
            Name = "Seeded",
            BaseUrl = "https://seeded.example.test/",
            Description = string.Empty,
            AllowedDomains = "seeded.example.test",
            ExcludedPaths = excluded,
            CreatedAt = DateTimeOffset.UtcNow
        };

        var blank = Row(string.Empty);
        var whitespace = Row("   ");
        var chosen = Row("/admin,/billing");
        db.Applications.AddRange(blank, whitespace, chosen);
        await db.SaveChangesAsync();

        return (blank.Id, whitespace.Id, chosen.Id);
    }

    private async Task<Dictionary<Guid, string>> ReadAsync(params Guid[] ids)
    {
        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("integration test inspection");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();

        return await db.Applications.AsNoTracking()
            .Where(a => ids.Contains(a.Id))
            .ToDictionaryAsync(a => a.Id, a => a.ExcludedPaths);
    }

    private async Task<int> RunRepairAsync()
    {
        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("integration test repair");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
        return await db.Database.ExecuteSqlRawAsync(BlankExclusionRepair.Sql);
    }

    [Fact]
    public async Task The_repair_restores_a_blank_list_and_leaves_a_chosen_one_alone()
    {
        var (blank, whitespace, chosen) = await SeedAsync();

        await RunRepairAsync();

        var after = await ReadAsync(blank, whitespace, chosen);
        after[blank].Should().Be(Default);
        // Whitespace reached the column as "" through the same defect, but a row holding
        // spaces would be just as unprotected, so the predicate trims before comparing.
        after[whitespace].Should().Be(Default);
        // The repair must not reach past the damage. A list somebody chose is theirs.
        after[chosen].Should().Be("/admin,/billing");
    }

    [Fact]
    public async Task The_repair_is_idempotent()
    {
        var (blank, whitespace, chosen) = await SeedAsync();
        await RunRepairAsync();

        // Nothing is left matching, so a second run is a no-op. A migration that is safe to
        // re-run is one nobody has to be careful with.
        var secondRun = await RunRepairAsync();

        secondRun.Should().Be(0);
        var after = await ReadAsync(blank, whitespace, chosen);
        after[blank].Should().Be(Default);
        after[chosen].Should().Be("/admin,/billing");
    }

    // There is deliberately no test that "the migration ran". Each run gets a fresh
    // database, so it has no legacy rows to repair and such a test would pass whether or
    // not Up() called anything. The statement is what can be wrong, so the statement is
    // what is tested; the one line wiring it into Up() is visible in review.
}
