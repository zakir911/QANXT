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

/// <summary>A worker can replace a callback token that expired while its job sat in the
/// queue — and cannot use that to reopen work that has finished.
///
/// <para>This exists because of run accddf2b. It designed 5,887 tests; the fleet worked
/// through about forty a minute; and every job's callback token was minted at run start
/// with a two-hour life. Two hours in, 1,116 executions had still not been attempted, and
/// every callback they made from then on was refused. They were not slow, or broken, or
/// unlucky: their credential had been stamped before the work was scheduled, and queue
/// time depends on how big the suite is and how big the fleet is — neither of which the
/// control plane knows when it stamps it. No constant is the right constant, so the
/// credential has to be obtainable when the work starts.</para></summary>
[Collection(ApiCollection.Name)]
public class WorkerTokenExchangeTests(ApiFactory factory)
{
    private sealed record Renewed(string Token, DateTimeOffset ExpiresAt);
    private sealed record AppIdResponse(Guid Id);
    private sealed record RunResponse(Guid Id);
    private sealed record Refusal(string Code, string Title, int Status);

    [Fact]
    public async Task A_queued_execution_can_be_given_a_fresh_token_and_report_with_it()
    {
        var (organizationId, executionId) = await QueuedExecutionAsync();

        var renewed = await RenewAsync(executionId, "execution", ApiFactory.WorkerToken);
        renewed.StatusCode.Should().Be(HttpStatusCode.OK, await renewed.Content.ReadAsStringAsync());

        var issued = await renewed.Content.ReadFromJsonAsync<Renewed>(ApiFactory.Json);
        issued!.Token.Should().NotBeNullOrWhiteSpace();
        issued.ExpiresAt.Should().BeAfter(DateTimeOffset.UtcNow);

        // The point of the exchange is not that a token comes back, it is that the token
        // works on the endpoint the job was refused at.
        using var worker = factory.NewClient();
        worker.DefaultRequestHeaders.Authorization = new("Bearer", issued.Token);
        var started = await worker.PostAsJsonAsync(
            $"/api/v1/worker/executions/{executionId}/started", new { workerId = "worker-test" }, ApiFactory.Json);

        started.StatusCode.Should().Be(HttpStatusCode.NoContent, await started.Content.ReadAsStringAsync());

        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("reading the execution back in a test");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
        var execution = await db.TestExecutions.AsNoTracking().FirstAsync(e => e.Id == executionId);
        execution.Status.Should().Be(ExecutionStatus.Running);
        execution.OrganizationId.Should().Be(organizationId);
    }

    [Fact]
    public async Task A_finished_execution_is_not_renewable()
    {
        // The security property. If a secret leaks, it must not be a way to rewrite a run
        // that is already closed, so the exchange tracks the job's state, not the clock.
        var (_, executionId) = await QueuedExecutionAsync(ExecutionStatus.Passed);

        var renewed = await RenewAsync(executionId, "execution", ApiFactory.WorkerToken);

        renewed.StatusCode.Should().Be(HttpStatusCode.NotFound, await renewed.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task The_wrong_secret_is_refused()
    {
        var (_, executionId) = await QueuedExecutionAsync();

        var renewed = await RenewAsync(executionId, "execution", "not-the-fleet-secret");

        renewed.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task No_secret_at_all_is_refused()
    {
        var (_, executionId) = await QueuedExecutionAsync();

        using var client = factory.NewClient();
        var renewed = await client.PostAsJsonAsync(
            $"/api/v1/worker/jobs/{executionId}/token", new { scope = "execution" }, ApiFactory.Json);

        renewed.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_job_that_does_not_exist_is_refused_the_same_way_a_finished_one_is()
    {
        // Deliberately indistinguishable: the exchange should not become a way to find out
        // which run ids exist.
        var missing = await RenewAsync(Guid.NewGuid(), "execution", ApiFactory.WorkerToken);
        var (_, finished) = await QueuedExecutionAsync(ExecutionStatus.Failed);
        var closed = await RenewAsync(finished, "execution", ApiFactory.WorkerToken);

        missing.StatusCode.Should().Be(HttpStatusCode.NotFound);
        closed.StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Everything but the correlation id, which is per-request and should differ.
        static async Task<string?> TitleOf(HttpResponseMessage response)
            => (await response.Content.ReadFromJsonAsync<Refusal>(ApiFactory.Json))?.Title;

        (await TitleOf(missing)).Should().Be(await TitleOf(closed));
    }

    [Fact]
    public async Task A_token_is_issued_for_the_scope_asked_for_and_no_other()
    {
        var (_, executionId) = await QueuedExecutionAsync();

        // The execution exists, but not as a discovery run, so a discovery token for it is
        // not something the exchange will mint.
        var wrongScope = await RenewAsync(executionId, "discovery", ApiFactory.WorkerToken);
        wrongScope.StatusCode.Should().Be(HttpStatusCode.NotFound);

        var nonsense = await RenewAsync(executionId, "anything-at-all", ApiFactory.WorkerToken);
        nonsense.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task A_renewed_token_cannot_act_on_another_job()
    {
        var (_, mine) = await QueuedExecutionAsync();
        var (_, theirs) = await QueuedExecutionAsync();

        var issued = await (await RenewAsync(mine, "execution", ApiFactory.WorkerToken))
            .Content.ReadFromJsonAsync<Renewed>(ApiFactory.Json);

        using var worker = factory.NewClient();
        worker.DefaultRequestHeaders.Authorization = new("Bearer", issued!.Token);
        var crossed = await worker.PostAsJsonAsync(
            $"/api/v1/worker/executions/{theirs}/started", new { workerId = "worker-test" }, ApiFactory.Json);

        crossed.StatusCode.Should().Be(HttpStatusCode.Forbidden,
            "a renewed token is scoped exactly as narrowly as the one it replaces");
    }

    private async Task<HttpResponseMessage> RenewAsync(Guid jobId, string scope, string secret)
    {
        using var client = factory.NewClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/worker/jobs/{jobId}/token")
        {
            Content = JsonContent.Create(new { scope }, options: ApiFactory.Json)
        };
        request.Headers.Add("X-Worker-Secret", secret);
        return await client.SendAsync(request);
    }

    /// <summary>An execution sitting in the state the defect left 1,116 of them in: queued,
    /// never attempted, and holding a credential that is no longer any use.
    ///
    /// Built through the real run path rather than inserted, so the row has the run and the
    /// test case the schema requires and the exchange reads a genuine execution.</summary>
    private async Task<(Guid OrganizationId, Guid ExecutionId)> QueuedExecutionAsync(
        ExecutionStatus? settleAs = null)
    {
        var tenant = await factory.NewTenantAsync();
        var project = await (await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Exchange", key = $"X{Guid.NewGuid():N}"[..8].ToUpperInvariant(), description = string.Empty
        }, ApiFactory.Json)).Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);
        var application = await (await tenant.Client.PostAsJsonAsync("/api/v1/applications", new
        {
            projectId = project!.Id, name = "Shop", baseUrl = "https://shop.example.test/", description = string.Empty
        }, ApiFactory.Json)).Content.ReadFromJsonAsync<AppIdResponse>(ApiFactory.Json);

        await SeedPageAsync(tenant, application!.Id);
        (await tenant.Client.PostAsJsonAsync("/api/v1/testcases/generate",
            new { applicationId = application.Id, suiteName = "Smoke", maxScenarios = 0 }, ApiFactory.Json))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        List<Guid> caseIds;
        using (var reading = factory.Services.CreateScope())
        {
            var tenantContext = reading.ServiceProvider.GetRequiredService<ITenantContext>();
            using var _ = tenantContext.EnterSystemContext("reading test cases in a test");
            var db = reading.ServiceProvider.GetRequiredService<QaNxtDbContext>();
            caseIds = await db.TestCases.Where(t => t.ProjectId == project.Id).Select(t => t.Id).Take(1).ToListAsync();
        }
        caseIds.Should().NotBeEmpty("the exchange needs a real execution to act on");

        var run = await (await tenant.Client.PostAsJsonAsync("/api/v1/testruns",
            new { projectId = project.Id, testCaseIds = caseIds, name = "Exchange" }, ApiFactory.Json))
            .Content.ReadFromJsonAsync<RunResponse>(ApiFactory.Json);

        using var scope = factory.Services.CreateScope();
        var context = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var __ = context.EnterSystemContext("settling an execution in a test");
        var write = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
        var execution = await write.TestExecutions.FirstAsync(e => e.TestRunId == run!.Id);

        if (settleAs is not null)
        {
            execution.Status = settleAs.Value;
            execution.CompletedAt = DateTimeOffset.UtcNow;
        }
        else
        {
            // The defect's state exactly: queued, with no worker having touched it.
            execution.Status = ExecutionStatus.Queued;
            execution.CompletedAt = null;
        }
        await write.SaveChangesAsync();

        return (tenant.OrganizationId, execution.Id);
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
            Url = "https://shop.example.test/search", NormalizedUrl = "https://shop.example.test/search",
            Route = "/search", Title = "Search", Kind = PageKind.Form, Depth = 0, ElementCount = 2
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
}
