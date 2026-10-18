using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using QaNxt.Application.Abstractions;
using QaNxt.Domain.Enums;
using QaNxt.Infrastructure.Persistence;
using ApplicationPageEntity = QaNxt.Domain.Applications.ApplicationPage;
using ApplicationElementEntity = QaNxt.Domain.Applications.ApplicationElement;

namespace QaNxt.IntegrationTests;

/// <summary>"Watch in a browser window" on the Testing page reaches the run. The run always
/// carried a headless flag and sent it to the worker, but runs started from the Testing page
/// hard-coded it to true, so there was no way to watch one.</summary>
[Collection(ApiCollection.Name)]
public class WatchedRunTests(ApiFactory factory)
{
    private sealed record AppIdResponse(Guid Id);
    private sealed record SelectionResponse(Guid? TestRunId, int Selected);

    [Fact]
    public async Task A_run_asked_to_be_watched_is_not_headless_and_an_ordinary_run_still_is()
    {
        var (tenant, applicationId) = await ApplicationWithTestsAsync();

        var watched = await StartAsync(tenant, applicationId, new { mode = "all", headless = false });
        var ordinary = await StartAsync(tenant, applicationId, new { mode = "all" });

        using var scope = factory.Services.CreateScope();
        using var _ = scope.ServiceProvider.GetRequiredService<ITenantContext>().EnterSystemContext("reading runs in a test");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
        (await db.TestRuns.AsNoTracking().FirstAsync(r => r.Id == watched)).Headless.Should().BeFalse();
        (await db.TestRuns.AsNoTracking().FirstAsync(r => r.Id == ordinary)).Headless.Should().BeTrue("headless stays the default");
    }

    private static async Task<Guid> StartAsync(TestTenant tenant, Guid applicationId, object body)
    {
        var response = await tenant.Client.PostAsJsonAsync($"/api/v1/applications/{applicationId}/runs", body, ApiFactory.Json);
        response.IsSuccessStatusCode.Should().BeTrue(await response.Content.ReadAsStringAsync());
        var result = await response.Content.ReadFromJsonAsync<SelectionResponse>(ApiFactory.Json);
        result!.TestRunId.Should().NotBeNull();
        return result.TestRunId!.Value;
    }

    private async Task<(TestTenant Tenant, Guid ApplicationId)> ApplicationWithTestsAsync()
    {
        var tenant = await factory.NewTenantAsync();
        var project = await (await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Watch", key = $"W{Guid.NewGuid():N}"[..8].ToUpperInvariant(), description = string.Empty
        }, ApiFactory.Json)).Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        var application = await (await tenant.Client.PostAsJsonAsync("/api/v1/applications", new
        {
            projectId = project!.Id, name = "Shop", baseUrl = "https://shop.example.test/", description = string.Empty
        }, ApiFactory.Json)).Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);

        using (var scope = factory.Services.CreateScope())
        {
            using var _ = scope.ServiceProvider.GetRequiredService<ITenantContext>().EnterSystemContext("seeding a discovered page in a test");
            var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
            var page = new ApplicationPageEntity
            {
                OrganizationId = tenant.OrganizationId, ApplicationId = application!.Id,
                Url = "https://shop.example.test/search", NormalizedUrl = "https://shop.example.test/search", Route = "/search",
                Title = "Search", Kind = PageKind.Form, Depth = 0, ElementCount = 2
            };
            db.ApplicationPages.Add(page);
            db.ApplicationElements.AddRange(
                new ApplicationElementEntity
                {
                    OrganizationId = tenant.OrganizationId, ApplicationPageId = page.Id, Kind = ElementKind.TextInput,
                    TagName = "input", AccessibleName = "Search", Label = "Search", TestId = "q", Type = "search",
                    IsVisible = true, CssSelector = "#q", StabilityScore = 90
                },
                new ApplicationElementEntity
                {
                    OrganizationId = tenant.OrganizationId, ApplicationPageId = page.Id, Kind = ElementKind.Button,
                    TagName = "button", AccessibleName = "Go", AriaRole = "button", TestId = "go", IsVisible = true,
                    CssSelector = "#go", StabilityScore = 90
                });
            await db.SaveChangesAsync();
        }
        (await tenant.Client.PostAsJsonAsync("/api/v1/testcases/generate",
            new { applicationId = application.Id, suiteName = "Smoke", maxScenarios = 0 }, ApiFactory.Json))
            .IsSuccessStatusCode.Should().BeTrue();
        return (tenant, application.Id);
    }
}
