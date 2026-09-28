using System.Net;
using System.Net.Http.Json;
using QaNxt.Application.Agent;
using QaNxt.Infrastructure.Persistence;
using QaNxt.Application.Abstractions;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace QaNxt.IntegrationTests;

/// <summary>The autonomous agent, checked at its edges rather than in the middle.
///
/// What the agent concludes is a judgement and changes as an application does. What it is
/// *allowed* to do must not change at all, and that is what these cover: the bounds cannot
/// be argued past, a pass cannot be started by a session that lacks the permission, and the
/// authority the agent does not have stays absent.</summary>
[Collection(ApiCollection.Name)]
public class AgentTests(ApiFactory factory)
{
    private async Task<(TestTenant Tenant, Guid ProjectId, Guid ApplicationId)> NewApplicationAsync()
    {
        var tenant = await factory.NewTenantAsync();

        var projectResponse = await tenant.Client.PostAsJsonAsync("/api/v1/projects", new
        {
            name = "Retail Banking",
            key = $"K{Guid.NewGuid():N}"[..8].ToUpperInvariant(),
            description = string.Empty
        }, ApiFactory.Json);
        var project = await projectResponse.Content.ReadFromJsonAsync<ProjectResponse>(ApiFactory.Json);

        var applicationResponse = await tenant.Client.PostAsJsonAsync("/api/v1/applications", new
        {
            projectId = project!.Id,
            name = "Demo Bank",
            baseUrl = "https://bank.example.test",
            allowedDomains = "bank.example.test",
            authStrategy = "none"
        }, ApiFactory.Json);
        applicationResponse.StatusCode.Should().Be(HttpStatusCode.Created);
        var application = await applicationResponse.Content.ReadFromJsonAsync<ApplicationResponse>(ApiFactory.Json);

        return (tenant, project.Id, application!.Id);
    }

    private static object Pass(Guid applicationId, object? overrides = null) => new
    {
        applicationId,
        name = "Integration pass",
        explore = false,          // No browser worker runs in this suite.
        execute = false
    };

    [Fact]
    public async Task A_pass_can_be_queued_and_read_back_with_the_bounds_it_was_given()
    {
        var (tenant, _, applicationId) = await NewApplicationAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/agent/runs", new
        {
            applicationId,
            name = "Bounded pass",
            explore = false,
            execute = false,
            maxPages = 7,
            maxTargets = 2,
            maxGeneratedTests = 3,
            timeBudgetSeconds = 60,
            maxAiCostUsd = 0.25m
        }, ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.Accepted);
        var queued = await response.Content.ReadFromJsonAsync<AgentRunSummary>(ApiFactory.Json);

        var detail = await tenant.Client.GetFromJsonAsync<AgentRunDetail>(
            $"/api/v1/agent/runs/{queued!.Id}", ApiFactory.Json);

        detail!.Bounds.MaxPages.Should().Be(7);
        detail.Bounds.MaxTargets.Should().Be(2);
        detail.Bounds.MaxGeneratedTests.Should().Be(3);
        detail.Bounds.TimeBudgetSeconds.Should().Be(60);
        detail.Bounds.MaxAiCostUsd.Should().Be(0.25m);
        detail.Bounds.Explore.Should().BeFalse();
        detail.Bounds.Execute.Should().BeFalse();
    }

    [Fact]
    public async Task Bounds_are_clamped_to_their_ceilings_rather_than_taken_as_given()
    {
        // The point of a bound is that it cannot be argued with. An operator asking for a
        // million pages gets the ceiling, not a million pages and not an error.
        var (tenant, _, applicationId) = await NewApplicationAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/agent/runs", new
        {
            applicationId,
            explore = false,
            execute = false,
            maxPages = 1_000_000,
            maxDepth = 99,
            maxTargets = 5_000,
            maxGeneratedTests = 100_000,
            timeBudgetSeconds = 86_400,
            maxAiCostUsd = 10_000m
        }, ApiFactory.Json);

        var queued = await response.Content.ReadFromJsonAsync<AgentRunSummary>(ApiFactory.Json);
        var detail = await tenant.Client.GetFromJsonAsync<AgentRunDetail>(
            $"/api/v1/agent/runs/{queued!.Id}", ApiFactory.Json);

        detail!.Bounds.MaxPages.Should().Be(AgentDefaults.MaxPagesCeiling);
        detail.Bounds.MaxDepth.Should().Be(AgentDefaults.MaxDepthCeiling);
        detail.Bounds.MaxTargets.Should().Be(AgentDefaults.MaxTargetsCeiling);
        detail.Bounds.MaxGeneratedTests.Should().Be(AgentDefaults.MaxGeneratedTestsCeiling);
        detail.Bounds.TimeBudgetSeconds.Should().Be(AgentDefaults.TimeBudgetSecondsCeiling);
        detail.Bounds.MaxAiCostUsd.Should().Be(AgentDefaults.MaxAiCostUsdCeiling);
    }

    [Fact]
    public async Task A_pass_started_with_no_options_is_still_bounded()
    {
        // An unbounded agent is not a feature. Defaults exist so that the careless path is
        // also the safe one.
        var (tenant, _, applicationId) = await NewApplicationAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/agent/runs",
            new { applicationId, explore = false, execute = false }, ApiFactory.Json);

        var queued = await response.Content.ReadFromJsonAsync<AgentRunSummary>(ApiFactory.Json);
        var detail = await tenant.Client.GetFromJsonAsync<AgentRunDetail>(
            $"/api/v1/agent/runs/{queued!.Id}", ApiFactory.Json);

        detail!.Bounds.MaxPages.Should().BeLessThanOrEqualTo(AgentDefaults.MaxPagesCeiling).And.BePositive();
        detail.Bounds.TimeBudgetSeconds.Should().BeLessThanOrEqualTo(AgentDefaults.TimeBudgetSecondsCeiling).And.BePositive();
        detail.Bounds.MaxGeneratedTests.Should().BeLessThanOrEqualTo(AgentDefaults.MaxGeneratedTestsCeiling).And.BePositive();
        detail.Bounds.MaxAiCostUsd.Should().BeLessThanOrEqualTo(AgentDefaults.MaxAiCostUsdCeiling);
    }

    [Fact]
    public async Task Only_one_pass_at_a_time_runs_against_an_application()
    {
        // Two agents generating tests for the same areas at once duplicate work and race
        // each other's suites.
        var (tenant, _, applicationId) = await NewApplicationAsync();

        var first = await tenant.Client.PostAsJsonAsync("/api/v1/agent/runs", Pass(applicationId), ApiFactory.Json);
        first.StatusCode.Should().Be(HttpStatusCode.Accepted);

        var second = await tenant.Client.PostAsJsonAsync("/api/v1/agent/runs", Pass(applicationId), ApiFactory.Json);

        second.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await second.Content.ReadAsStringAsync()).Should().Contain("already running");
    }

    [Fact]
    public async Task Starting_a_pass_needs_more_than_permission_to_read_tests()
    {
        // An agent explores an application on its own and spends a model budget doing it.
        // Reading its conclusions is not the same decision as letting it loose.
        var (tenant, _, applicationId) = await NewApplicationAsync();
        var reader = await factory.ClientWithPermissionsAsync(tenant, "test:read", "application:read");

        var start = await reader.PostAsJsonAsync("/api/v1/agent/runs", Pass(applicationId), ApiFactory.Json);
        start.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        var list = await reader.GetAsync("/api/v1/agent/runs");
        list.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task A_pass_can_be_cancelled_and_says_who_stopped_it()
    {
        var (tenant, _, applicationId) = await NewApplicationAsync();

        var started = await tenant.Client.PostAsJsonAsync("/api/v1/agent/runs", Pass(applicationId), ApiFactory.Json);
        var queued = await started.Content.ReadFromJsonAsync<AgentRunSummary>(ApiFactory.Json);

        var cancel = await tenant.Client.PostAsync($"/api/v1/agent/runs/{queued!.Id}/cancel", null);
        cancel.StatusCode.Should().BeOneOf(HttpStatusCode.NoContent, HttpStatusCode.OK);

        var detail = await tenant.Client.GetFromJsonAsync<AgentRunDetail>(
            $"/api/v1/agent/runs/{queued.Id}", ApiFactory.Json);

        detail!.Summary.StopReason.Should().Contain("Cancelled");
    }

    [Fact]
    public async Task One_tenant_cannot_read_another_tenants_agent_pass()
    {
        var (alpha, _, applicationId) = await NewApplicationAsync();
        var beta = await factory.NewTenantAsync("Beta");

        var started = await alpha.Client.PostAsJsonAsync("/api/v1/agent/runs", Pass(applicationId), ApiFactory.Json);
        var queued = await started.Content.ReadFromJsonAsync<AgentRunSummary>(ApiFactory.Json);

        var response = await beta.Client.GetAsync($"/api/v1/agent/runs/{queued!.Id}");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_pass_cannot_be_started_for_an_application_that_does_not_exist()
    {
        var tenant = await factory.NewTenantAsync();

        var response = await tenant.Client.PostAsJsonAsync("/api/v1/agent/runs",
            Pass(Guid.NewGuid()), ApiFactory.Json);

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task The_agent_is_given_no_authority_over_gates_defects_or_existing_tests()
    {
        // The narrowness is the design. This asserts it at the only place it can be
        // asserted honestly — the permissions an agent pass is started with do not include
        // the ones that would let it act on what it finds.
        var (tenant, projectId, applicationId) = await NewApplicationAsync();

        var gate = await tenant.Client.PostAsJsonAsync($"/api/v1/quality-gates?projectId={projectId}", new
        {
            name = "Pass rate at least 95%",
            metric = "passRatePercent",
            @operator = "greaterThanOrEqual",
            threshold = 95,
            isBlocking = true
        }, ApiFactory.Json);
        gate.StatusCode.Should().Be(HttpStatusCode.OK);

        var started = await tenant.Client.PostAsJsonAsync("/api/v1/agent/runs", Pass(applicationId), ApiFactory.Json);
        var queued = await started.Content.ReadFromJsonAsync<AgentRunSummary>(ApiFactory.Json);

        // Let the runner pick it up and finish; the pass has nothing to explore or execute.
        await WaitForCompletionAsync(tenant, queued!.Id);

        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenantContext.EnterSystemContext("integration test inspection");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();

        // The gate it could have relaxed is exactly as it was.
        var rules = await db.QualityGateRules.AsNoTracking()
            .Where(r => r.ProjectId == projectId).ToListAsync();
        rules.Should().ContainSingle();
        rules[0].Threshold.Should().Be(95);
        rules[0].IsBlocking.Should().BeTrue();
        rules[0].IsEnabled.Should().BeTrue();

        // It raised no defect: a suspected defect is a proposal for a person.
        (await db.Defects.AsNoTracking().CountAsync(d => d.ProjectId == projectId)).Should().Be(0);

        // And it approved no healing: every healing event is still unreviewed and unapplied.
        (await db.HealingEvents.AsNoTracking()
            .CountAsync(h => h.OrganizationId == tenant.OrganizationId
                          && (h.ReviewedByUserId != null || h.AppliedAt != null)))
            .Should().Be(0);
    }

    [Fact]
    public async Task Every_step_a_pass_took_is_recorded_for_reading_back()
    {
        // Nobody watched this run. Its conclusions are worth nothing if the steps that
        // produced them cannot be read afterwards.
        var (tenant, _, applicationId) = await NewApplicationAsync();

        var started = await tenant.Client.PostAsJsonAsync("/api/v1/agent/runs", Pass(applicationId), ApiFactory.Json);
        var queued = await started.Content.ReadFromJsonAsync<AgentRunSummary>(ApiFactory.Json);

        var detail = await WaitForCompletionAsync(tenant, queued!.Id);

        detail.Steps.Should().NotBeEmpty();
        detail.Steps.Should().BeInAscendingOrder(s => s.Order);
        detail.Steps.Should().OnlyContain(s => !string.IsNullOrWhiteSpace(s.Description));
        // An application with no discovered pages stops early, and says so rather than
        // pretending it did the work.
        detail.Summary.Status.Should().NotBe(Domain.Enums.AgentRunStatus.Running);
    }

    private static async Task<AgentRunDetail> WaitForCompletionAsync(TestTenant tenant, Guid id)
    {
        for (var attempt = 0; attempt < 60; attempt++)
        {
            var detail = await tenant.Client.GetFromJsonAsync<AgentRunDetail>(
                $"/api/v1/agent/runs/{id}", ApiFactory.Json);

            if (detail!.Summary.Status is not (Domain.Enums.AgentRunStatus.Queued or Domain.Enums.AgentRunStatus.Running))
                return detail;

            await Task.Delay(500);
        }

        throw new Xunit.Sdk.XunitException($"Agent run {id} did not finish within 30 seconds.");
    }
}

public sealed record ApplicationResponse(Guid Id, Guid ProjectId, string Name, string BaseUrl);
