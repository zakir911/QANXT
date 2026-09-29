using QaNxt.Application.Abstractions;
using QaNxt.Application.Ai;
using QaNxt.Domain.Enums;
using QaNxt.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace QaNxt.IntegrationTests;

/// <summary>
/// What the answer cache is allowed to serve.
///
/// <para>
/// The cache exists to avoid paying a model twice for the same question. That justification
/// does not reach the local provider: it is a deterministic rule engine, it costs nothing,
/// and it answers in milliseconds. Caching it bought nothing and cost correctness, because
/// the cache key carries the provider's model string and the local one is a constant,
/// <c>qanxt-rules-v1</c>. Changing the rules therefore did not change the key.
/// </para>
/// <para>
/// The consequence was not theoretical. A fix to the test generator shipped, and the console
/// went on producing the pre-fix test cases for every organization that had already
/// generated from the same application — for the whole 168-hour window. The API said so in
/// its own log, "Reusing a cached AI response", and the fix looked like it had done nothing.
/// </para>
/// <para>
/// A cache hit returns before the request is recorded, so the number of stored AI requests
/// is what distinguishes the two behaviours: one row means the second call was served from
/// cache, two means the engine ran again.
/// </para>
/// </summary>
[Collection(ApiCollection.Name)]
public class AiCacheTests(ApiFactory factory)
{
    /// <summary>A question the local rule engine answers from the context alone, with no
    /// discovery, executions or other fixtures behind it.</summary>
    private static AiCallOptions Ask() => new()
    {
        Kind = AiRequestKind.QualityInsight,
        SchemaName = AiSchemaCatalog.QualityInsight,
        SystemPrompt = "Answer from the counted facts.",
        UserPrompt = "Which tests are most unstable?",
        Context = new { question = "Which tests are most unstable?", totals = new { executions = 0 } },
        PreferredProvider = LlmProviderKind.Local,
        // The point of the test: the caller asks for caching and the orchestrator declines,
        // because of which provider answers.
        AllowCache = true
    };

    private async Task<int> AskTwiceAndCountRequestsAsync(TestTenant tenant)
    {
        using var scope = factory.Services.CreateScope();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        tenantContext.SetOrganization(tenant.OrganizationId);

        var orchestrator = scope.ServiceProvider.GetRequiredService<IAiOrchestrator>();
        var first = await orchestrator.ExecuteAsync<GeneratedQualityInsight>(Ask());
        var second = await orchestrator.ExecuteAsync<GeneratedQualityInsight>(Ask());

        first.IsSuccess.Should().BeTrue("the local provider answers this without any fixtures");
        second.IsSuccess.Should().BeTrue();

        using var _ = tenantContext.EnterSystemContext("integration test inspection");
        var db = scope.ServiceProvider.GetRequiredService<QaNxtDbContext>();
        return await db.AiRequests.AsNoTracking()
            .CountAsync(r => r.OrganizationId == tenant.OrganizationId
                          && r.Provider == LlmProviderKind.Local
                          && r.Status == AiRequestStatus.Succeeded);
    }

    [Fact]
    public async Task The_local_rule_engine_is_asked_again_rather_than_replayed_from_cache()
    {
        var tenant = await factory.NewTenantAsync();

        var recorded = await AskTwiceAndCountRequestsAsync(tenant);

        recorded.Should().Be(2,
            "an identical question put to the local provider twice must reach it twice; one "
            + "recorded request would mean the second was replayed, and a rules change would "
            + "be invisible until the cached row expired");
    }

    [Fact]
    public async Task The_second_answer_is_not_labelled_as_coming_from_cache()
    {
        var tenant = await factory.NewTenantAsync();

        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<ITenantContext>().SetOrganization(tenant.OrganizationId);
        var orchestrator = scope.ServiceProvider.GetRequiredService<IAiOrchestrator>();

        await orchestrator.ExecuteAsync<GeneratedQualityInsight>(Ask());
        var second = await orchestrator.ExecuteAsync<GeneratedQualityInsight>(Ask());

        second.FromCache.Should().BeFalse();
    }
}
