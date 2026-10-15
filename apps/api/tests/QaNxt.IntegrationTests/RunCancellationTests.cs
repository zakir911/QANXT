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

/// <summary>A cancelled run stays cancelled. Its executions were marked cancelled, but their
/// jobs were still queued, and a worker that picked one up later set it running again — so a
/// cancelled run carried on testing, and a stopped verification left hundreds of tests to
/// land in the next one.</summary>
[Collection(ApiCollection.Name)]
public class RunCancellationTests(ApiFactory factory)
{
    private sealed record AppIdResponse(Guid Id);
    private sealed record RunResponse(Guid Id);
    private sealed record ExecutionRow(Guid Id, string Status);

    [Fact]
    public async Task A_run_whose_tests_all_finished_is_completed_even_if_its_last_report_missed_it()
    {
        var (tenant, runId) = await StartedRunAsync();
        // Every execution finished, as when the last two report at the same moment and each
        // sees the other still running: the run itself was never completed.
        using (var scope = factory.Services.CreateScope())
        {
            var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
            using var _ = tenantContext.EnterSystemContext("simulating a missed completion in a test");
            var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
            foreach (var execution in await db.TestExecutions.Where(e => e.TestRunId == runId).ToListAsync())
            {
                execution.Status = ExecutionStatus.Passed;
                execution.CompletedAt = DateTimeOffset.UtcNow;
            }
            await db.SaveChangesAsync();
            (await db.TestRuns.AsNoTracking().FirstAsync(r => r.Id == runId)).CompletedAt.Should().BeNull("this is the stuck state");

            var ingest = scope.ServiceProvider.GetRequiredService<QaNxt.Application.Testing.IExecutionIngestService>();
            await ingest.ReconcileRunAsync(runId);
            var run = await db.TestRuns.AsNoTracking().FirstAsync(r => r.Id == runId);
            run.CompletedAt.Should().NotBeNull("a run whose tests have all finished is finished");
            run.Status.Should().Be(ExecutionStatus.Passed);
            run.PassedCount.Should().BeGreaterThan(0);
        }
    }

    private sealed record SelectionResponse(Guid? TestRunId, int Selected, Guid? SecurityScanId, string? SecurityNote);

    [Fact]
    public async Task Asking_for_a_security_scan_without_an_authorised_scope_still_runs_the_tests_and_says_why()
    {
        var tenant = await factory.NewTenantAsync();
        var project = await (await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Security", key = $"S{Guid.NewGuid():N}"[..8].ToUpperInvariant(), description = string.Empty
        }, ApiFactory.Json)).Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        var application = await (await tenant.Client.PostAsJsonAsync("/api/v1/applications", new
        {
            projectId = project!.Id, name = "Shop", baseUrl = "https://shop.example.test/", description = string.Empty
        }, ApiFactory.Json)).Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);
        await SeedPageAsync(tenant, application!.Id);
        await tenant.Client.PostAsJsonAsync("/api/v1/testcases/generate", new { applicationId = application.Id, suiteName = "Smoke", maxScenarios = 0 }, ApiFactory.Json);

        var response = await tenant.Client.PostAsJsonAsync($"/api/v1/applications/{application.Id}/runs",
            new { mode = "all", includeSecurity = true, securityProfile = "standard" }, ApiFactory.Json);
        response.IsSuccessStatusCode.Should().BeTrue(await response.Content.ReadAsStringAsync());
        var result = await response.Content.ReadFromJsonAsync<SelectionResponse>(ApiFactory.Json);

        result!.TestRunId.Should().NotBeNull("the tests run whether or not the scan can");
        result.SecurityScanId.Should().BeNull("no scope was authorised, so no scan may start");
        result.SecurityNote.Should().Contain("did not start", "the person must learn why there are no security findings");
    }

    private async Task<(TestTenant Tenant, Guid RunId)> StartedRunAsync()
    {
        var tenant = await factory.NewTenantAsync();
        var project = await (await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Reconcile", key = $"R{Guid.NewGuid():N}"[..8].ToUpperInvariant(), description = string.Empty
        }, ApiFactory.Json)).Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        var application = await (await tenant.Client.PostAsJsonAsync("/api/v1/applications", new
        {
            projectId = project!.Id, name = "Shop", baseUrl = "https://shop.example.test/", description = string.Empty
        }, ApiFactory.Json)).Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);
        await SeedPageAsync(tenant, application!.Id);
        (await tenant.Client.PostAsJsonAsync("/api/v1/testcases/generate", new { applicationId = application.Id, suiteName = "Smoke", maxScenarios = 0 }, ApiFactory.Json))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        List<Guid> ids;
        using (var scope = factory.Services.CreateScope())
        {
            var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
            using var _ = tenantContext.EnterSystemContext("reading test cases in a test");
            var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
            ids = await db.TestCases.Where(t => t.ProjectId == project.Id).Select(t => t.Id).Take(2).ToListAsync();
        }
        var started = await tenant.Client.PostAsJsonAsync("/api/v1/testruns", new { projectId = project.Id, testCaseIds = ids, name = "Reconcile" }, ApiFactory.Json);
        var run = await started.Content.ReadFromJsonAsync<RunResponse>(ApiFactory.Json);
        return (tenant, run!.Id);
    }

    private async Task SeedPageAsync(TestTenant tenant, Guid applicationId)
    {
        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("seeding a discovered page in a test");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
        var page = new ApplicationPageEntity
        {
            OrganizationId = tenant.OrganizationId, ApplicationId = applicationId,
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

    [Fact]
    public async Task A_worker_cannot_start_an_execution_of_a_cancelled_run()
    {
        var tenant = await factory.NewTenantAsync();
        var project = await (await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Cancellation", key = $"C{Guid.NewGuid():N}"[..8].ToUpperInvariant(), description = string.Empty
        }, ApiFactory.Json)).Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        var application = await (await tenant.Client.PostAsJsonAsync("/api/v1/applications", new
        {
            projectId = project!.Id, name = "Shop", baseUrl = "https://shop.example.test/", description = string.Empty
        }, ApiFactory.Json)).Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);

        using (var scope = factory.Services.CreateScope())
        {
            var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
            using var _ = tenantContext.EnterSystemContext("seeding a discovered page in a test");
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

        (await tenant.Client.PostAsJsonAsync("/api/v1/testcases/generate", new { applicationId = application!.Id, suiteName = "Smoke", maxScenarios = 0 }, ApiFactory.Json))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        List<Guid> testCaseIds;
        using (var scope = factory.Services.CreateScope())
        {
            var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
            using var _ = tenantContext.EnterSystemContext("reading test cases in a test");
            var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
            testCaseIds = await db.TestCases.Where(t => t.ProjectId == project.Id).Select(t => t.Id).Take(2).ToListAsync();
        }
        testCaseIds.Should().NotBeEmpty();

        var started = await tenant.Client.PostAsJsonAsync("/api/v1/testruns", new { projectId = project.Id, testCaseIds, name = "To be cancelled" }, ApiFactory.Json);
        started.StatusCode.Should().Be(HttpStatusCode.Accepted);
        var run = await started.Content.ReadFromJsonAsync<RunResponse>(ApiFactory.Json);

        (await tenant.Client.PostAsync($"/api/v1/testruns/{run!.Id}/cancel", null)).IsSuccessStatusCode.Should().BeTrue();
        var executions = await tenant.Client.GetFromJsonAsync<List<ExecutionRow>>($"/api/v1/testruns/{run.Id}/executions", ApiFactory.Json);
        executions.Should().NotBeEmpty().And.OnlyContain(e => e.Status.Equals("cancelled", StringComparison.OrdinalIgnoreCase));

        // A worker reaches the job after the cancellation, as it does when the queue is long.
        var execution = executions![0];
        var worker = factory.WorkerClient(tenant.OrganizationId, execution.Id, "execution");
        var response = await worker.PostAsJsonAsync($"/api/v1/worker/executions/{execution.Id}/started", new { workerId = "worker-1" }, ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.Conflict, "the worker must learn it has nothing to run");
        var after = await tenant.Client.GetFromJsonAsync<List<ExecutionRow>>($"/api/v1/testruns/{run.Id}/executions", ApiFactory.Json);
        after!.Single(e => e.Id == execution.Id).Status.Should().BeEquivalentTo("cancelled", "a cancelled execution must not start running again");
    }
}
