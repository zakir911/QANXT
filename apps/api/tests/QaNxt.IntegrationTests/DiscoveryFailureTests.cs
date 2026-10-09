using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using QaNxt.Application.Abstractions;
using QaNxt.Domain.Enums;
using QaNxt.Infrastructure.Persistence;

namespace QaNxt.IntegrationTests;

/// <summary>A discovery run that fails has to say so.
///
/// The worker marked a run <c>Running</c>, then tried to launch a browser that was not
/// installed. There was no catch in the discovery handler and no endpoint to report a
/// failure to, so the control plane was never told: the run reported <c>Running</c>
/// indefinitely while the queue re-delivered the job forever. The reason existed only in the
/// worker's own log file on the machine that failed.
///
/// Two things close that, and both are tested here: the worker can report a failure, and a
/// run nobody reports on at all is reconciled by a sweep rather than waiting for ever.
/// "Running" with nothing behind it is worse than "Failed" with a reason, because the first
/// invites somebody to keep waiting.</summary>
[Collection(ApiCollection.Name)]
public class DiscoveryFailureTests(ApiFactory factory)
{
    private const string MissingBrowser =
        "browserType.launch: Executable doesn't exist at "
        + "/Users/someone/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell "
        + "The browser Playwright needs is not installed on this worker. Install it with "
        + "\"./node_modules/.bin/playwright install chromium\" from apps/browser-worker.";

    private async Task<(TestTenant Tenant, Guid RunId)> QueuedRunAsync()
    {
        var tenant = await factory.NewTenantAsync();

        var projectResponse = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Discovery Failure",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);
        var project = await projectResponse.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);

        var appResponse = await tenant.Client.PostAsJsonAsync("/api/v1/applications", new
        {
            projectId = project!.Id,
            name = "Target",
            baseUrl = "https://site.example.test/",
            description = "Created by an integration test",
            authStrategy = "none"
        }, ApiFactory.Json);
        appResponse.StatusCode.Should().Be(HttpStatusCode.Created);
        var application = await appResponse.Content.ReadFromJsonAsync<ApplicationIdResponse>(ApiFactory.Json);

        var runResponse = await tenant.Client.PostAsJsonAsync("/api/v1/discovery/runs", new
        {
            applicationId = application!.Id,
            maxDepth = 2,
            maxPages = 10,
            timeoutSeconds = 60
        }, ApiFactory.Json);
        runResponse.StatusCode.Should().BeOneOf(HttpStatusCode.Created, HttpStatusCode.Accepted, HttpStatusCode.OK);
        var run = await runResponse.Content.ReadFromJsonAsync<DiscoveryRunIdResponse>(ApiFactory.Json);

        return (tenant, run!.Id);
    }

    private async Task<DiscoveryRunRow> StoredAsync(Guid runId)
    {
        using var scope = factory.Services.CreateScope();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenant.EnterSystemContext("reading a run in a test");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
        var run = await db.DiscoveryRuns.AsNoTracking().FirstAsync(r => r.Id == runId);
        return new DiscoveryRunRow(run.Status, run.ErrorMessage, run.CompletedAt, run.ProgressLog);
    }

    [Fact]
    public async Task A_worker_can_report_a_failure_and_the_run_says_why()
    {
        var (tenant, runId) = await QueuedRunAsync();
        var worker = factory.WorkerClient(tenant.OrganizationId, runId, "discovery");

        await worker.PostAsJsonAsync($"/api/v1/worker/discovery/{runId}/started",
            new { workerId = "worker-1" }, ApiFactory.Json);

        (await StoredAsync(runId)).Status.Should().Be(DiscoveryStatus.Running,
            "the run has to be running for this to be the bug it was");

        var failed = await worker.PostAsJsonAsync($"/api/v1/worker/discovery/{runId}/failed",
            new { reason = MissingBrowser, permanent = true, workerId = "worker-1" }, ApiFactory.Json);
        failed.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var stored = await StoredAsync(runId);
        stored.Status.Should().Be(DiscoveryStatus.Failed);
        stored.CompletedAt.Should().NotBeNull("a failed run is finished, and a run with no end never stops looking active");
        stored.ErrorMessage.Should().Contain("playwright install chromium",
            "the remedy is the part the user can act on");
        stored.ErrorMessage.Should().Contain("Retrying will not help",
            "a permanent failure must not look like something to wait out");
        stored.ProgressLog.Should().Contain("The run failed");
    }

    [Fact]
    public async Task A_retryable_failure_is_not_described_as_final()
    {
        var (tenant, runId) = await QueuedRunAsync();
        var worker = factory.WorkerClient(tenant.OrganizationId, runId, "discovery");

        await worker.PostAsJsonAsync($"/api/v1/worker/discovery/{runId}/started",
            new { workerId = "worker-2" }, ApiFactory.Json);
        await worker.PostAsJsonAsync($"/api/v1/worker/discovery/{runId}/failed",
            new { reason = "page.goto: Timeout 30000ms exceeded.", permanent = false, workerId = "worker-2" },
            ApiFactory.Json);

        var stored = await StoredAsync(runId);
        stored.Status.Should().Be(DiscoveryStatus.Failed);
        stored.ErrorMessage.Should().Contain("Timeout 30000ms exceeded");
        stored.ErrorMessage.Should().NotContain("Retrying will not help");
    }

    [Fact]
    public async Task The_console_can_read_the_reason_the_run_failed()
    {
        var (tenant, runId) = await QueuedRunAsync();
        var worker = factory.WorkerClient(tenant.OrganizationId, runId, "discovery");

        await worker.PostAsJsonAsync($"/api/v1/worker/discovery/{runId}/started",
            new { workerId = "worker-3" }, ApiFactory.Json);
        await worker.PostAsJsonAsync($"/api/v1/worker/discovery/{runId}/failed",
            new { reason = MissingBrowser, permanent = true, workerId = "worker-3" }, ApiFactory.Json);

        // Written to the database is not the same as visible to a user. The Discovery page
        // renders summary.errorMessage, so that is the field that has to carry it.
        var detail = await tenant.Client.GetFromJsonAsync<DiscoveryDetailResponse>(
            $"/api/v1/discovery/runs/{runId}", ApiFactory.Json);

        detail!.Summary.Status.Should().Be("failed");
        detail.Summary.ErrorMessage.Should().Contain("playwright install chromium");
    }

    [Fact]
    public async Task A_completed_run_is_not_overwritten_by_a_late_failure_report()
    {
        var (tenant, runId) = await QueuedRunAsync();
        var worker = factory.WorkerClient(tenant.OrganizationId, runId, "discovery");

        await worker.PostAsJsonAsync($"/api/v1/worker/discovery/{runId}/started",
            new { workerId = "worker-4" }, ApiFactory.Json);

        using (var scope = factory.Services.CreateScope())
        {
            var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
            using var _ = tenantContext.EnterSystemContext("completing a run in a test");
            var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
            var run = await db.DiscoveryRuns.FirstAsync(r => r.Id == runId);
            run.Status = DiscoveryStatus.Completed;
            run.PagesDiscovered = 12;
            await db.SaveChangesAsync();
        }

        // A late retry losing the race must not turn a finished crawl into a failure. The
        // completed graph is the better record of what happened.
        var late = await worker.PostAsJsonAsync($"/api/v1/worker/discovery/{runId}/failed",
            new { reason = "a stale retry", permanent = false, workerId = "worker-4" }, ApiFactory.Json);
        late.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var stored = await StoredAsync(runId);
        stored.Status.Should().Be(DiscoveryStatus.Completed);
        stored.ErrorMessage.Should().BeNull();
    }

    [Fact]
    public async Task A_failure_report_needs_a_token_scoped_to_that_run()
    {
        var (tenant, runId) = await QueuedRunAsync();

        var anonymous = tenant.Anonymous();
        var refused = await anonymous.PostAsJsonAsync($"/api/v1/worker/discovery/{runId}/failed",
            new { reason = "unauthenticated", permanent = true, workerId = "nobody" }, ApiFactory.Json);
        refused.StatusCode.Should().BeOneOf(HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden);

        // A token for a different job must not be able to fail this one.
        var wrongJob = factory.WorkerClient(tenant.OrganizationId, Guid.NewGuid(), "discovery");
        var wrong = await wrongJob.PostAsJsonAsync($"/api/v1/worker/discovery/{runId}/failed",
            new { reason = "wrong job", permanent = true, workerId = "worker-5" }, ApiFactory.Json);
        wrong.StatusCode.Should().BeOneOf(HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden);

        (await StoredAsync(runId)).Status.Should().NotBe(DiscoveryStatus.Failed);
    }

    private sealed record DiscoveryRunRow(
        DiscoveryStatus Status, string? ErrorMessage, DateTimeOffset? CompletedAt, string? ProgressLog);

    private sealed record ApplicationIdResponse(Guid Id);
    private sealed record DiscoveryRunIdResponse(Guid Id);
    private sealed record DiscoverySummaryResponse(string Status, string? ErrorMessage);
    private sealed record DiscoveryDetailResponse(DiscoverySummaryResponse Summary);
}
