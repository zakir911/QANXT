using System.Net;
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

/// <summary>Generation has to produce test cases that are actually saved.
///
/// Three gates stand between the rules engine and a row in the database: the test_plan
/// schema, the browser worker's action vocabulary, and BrowserActionValidator, which
/// TestGenerationService runs over every step and which drops the whole scenario when one
/// step fails. Unit tests over the planner satisfied the first two and a user still saw
/// "Generated 0 test case(s)" with all eight dropped.
///
/// This goes through the real service and counts what is persisted, because that is the
/// only number the user sees.</summary>
[Collection(ApiCollection.Name)]
public class GenerationEndToEndTests(ApiFactory factory)
{
    private async Task<(TestTenant Tenant, Guid ProjectId, Guid ApplicationId)> DiscoveredApplicationAsync()
    {
        var tenant = await factory.NewTenantAsync();

        var projectResponse = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Generation",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);
        var project = await projectResponse.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);

        var appResponse = await tenant.Client.PostAsJsonAsync("/api/v1/applications", new
        {
            projectId = project!.Id,
            name = "IdentitySense Admin",
            baseUrl = "https://admin.example.test/",
            description = "Created by an integration test",
            authStrategy = "formLogin"
        }, ApiFactory.Json);
        appResponse.StatusCode.Should().Be(HttpStatusCode.Created);
        var application = await appResponse.Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);

        // The page the user actually had: one login screen with a handful of controls.
        using (var scope = factory.Services.CreateScope())
        {
            var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
            using var _ = tenantContext.EnterSystemContext("seeding a discovered page in a test");
            var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();

            var page = new ApplicationPageEntity
            {
                OrganizationId = tenant.OrganizationId,
                ApplicationId = application!.Id,
                Url = "https://admin.example.test/IDSenseAdmin/login",
                NormalizedUrl = "https://admin.example.test/idsenseadmin/login",
                Route = "/IDSenseAdmin/login",
                Title = "IdentitySense Admin Dashboard | ID Verification SDK",
                Kind = PageKind.Login,
                Depth = 0,
                RequiresAuthentication = false,
                ElementCount = 3
            };
            db.ApplicationPages.Add(page);

            db.ApplicationElements.AddRange(
                new ApplicationElementEntity
                {
                    OrganizationId = tenant.OrganizationId, ApplicationPageId = page.Id,
                    Kind = ElementKind.TextInput, TagName = "input", AccessibleName = "Enter your username",
                    Label = "Enter your username", TestId = "username", Type = "text",
                    IsRequired = true, IsVisible = true, CssSelector = "#username", StabilityScore = 90
                },
                new ApplicationElementEntity
                {
                    OrganizationId = tenant.OrganizationId, ApplicationPageId = page.Id,
                    Kind = ElementKind.PasswordInput, TagName = "input", AccessibleName = "Password",
                    Label = "Password", TestId = "password", Type = "password",
                    IsRequired = true, IsVisible = true, CssSelector = "#password", StabilityScore = 90
                },
                new ApplicationElementEntity
                {
                    OrganizationId = tenant.OrganizationId, ApplicationPageId = page.Id,
                    Kind = ElementKind.Button, TagName = "button", AccessibleName = "Proceed",
                    AriaRole = "button", TestId = "proceed", IsVisible = true,
                    CssSelector = "#proceed", StabilityScore = 90
                });

            await db.SaveChangesAsync();
        }

        return (tenant, project.Id, application!.Id);
    }

    /// <summary>Mirrors GeneratedTestSummary. Names matter: a record whose properties do
    /// not match binds to zero and makes a working generation look like a failed one, which
    /// is exactly what this test first reported.</summary>
    private sealed record GenerationResponse(
        Guid TestSuiteId, string TestSuiteName, int CasesCreated, int StepsCreated,
        string PlanSummary, List<string> Warnings);

    [Fact]
    public async Task Generating_from_one_login_page_persists_real_test_cases()
    {
        var (tenant, projectId, applicationId) = await DiscoveredApplicationAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/testcases/generate", new
        {
            applicationId,
            suiteName = "Regression",
            requirement = (string?)null,
            maxScenarios = 0
        }, ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var result = await response.Content.ReadFromJsonAsync<GenerationResponse>(ApiFactory.Json);

        // "Generated 0 test case(s)" was the whole defect.
        result!.CasesCreated.Should().BeGreaterThan(5,
            "a login page with two required fields and a button is worth more than a load check");
        result.StepsCreated.Should().BeGreaterThan(0, "zero steps means every scenario was dropped");

        result.Warnings.Should().NotContain(w => w.Contains("could not run"),
            "a dropped scenario means the engine produced something the service refuses: "
            + string.Join(" | ", result.Warnings));

        // And they are really in the database, not only in the response.
        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("counting test cases in a test");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();

        var cases = await db.TestCases.CountAsync(t => t.ProjectId == projectId);
        cases.Should().Be(result.CasesCreated);

        var steps = await db.TestSteps.CountAsync();
        steps.Should().BeGreaterThan(0);
    }

    [Fact]
    public async Task The_generated_cases_cover_more_than_the_page_loading()
    {
        var (tenant, projectId, applicationId) = await DiscoveredApplicationAsync();

        await tenant.Client.PostAsJsonAsync("/api/v1/testcases/generate", new
        {
            applicationId, suiteName = "Regression", requirement = (string?)null, maxScenarios = 0
        }, ApiFactory.Json);

        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("reading test cases in a test");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();

        var names = await db.TestCases.Where(t => t.ProjectId == projectId)
            .Select(t => t.Name).ToListAsync();

        // The user's screenshot: every case identically named "… loads".
        names.Distinct().Count().Should().Be(names.Count, "duplicate names are unusable in a suite");
        names.Should().Contain(n => n.Contains("required"));
        names.Should().Contain(n => n.Contains("accessibility"));
    }

    [Fact]
    public async Task A_caller_supplied_limit_is_still_honoured()
    {
        var (tenant, _, applicationId) = await DiscoveredApplicationAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/testcases/generate", new
        {
            applicationId, suiteName = "Small", requirement = (string?)null, maxScenarios = 3
        }, ApiFactory.Json);

        var result = await response.Content.ReadFromJsonAsync<GenerationResponse>(ApiFactory.Json);

        // Removing the default limit must not remove the ability to ask for one.
        result!.CasesCreated.Should().BeLessThanOrEqualTo(3);
        result.Warnings.Should().Contain(w => w.Contains("limit of 3"));
    }

    private sealed record AppIdResponse(Guid Id);
}
