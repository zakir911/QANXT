using QaNxt.Application.Abstractions;
using QaNxt.Application.Agent;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Api.Services;

/// <summary>Picks up queued agent passes and runs them.
///
/// Agent passes are long — they wait on a crawl and then on a test run — so they cannot be
/// held open on the request that started them. This claims one at a time and runs it to
/// completion. One at a time is deliberate: an agent competes with real users for the same
/// browser workers, and a platform that starves interactive runs to do speculative work has
/// its priorities backwards.
///
/// On startup, any pass left Running by a restart is marked failed rather than resumed. The
/// loop is not idempotent part-way through — it would generate a second set of tests — and
/// a truthful failure is better than a duplicate.</summary>
public sealed class AgentRunnerService : BackgroundService
{
    private static readonly TimeSpan Idle = TimeSpan.FromSeconds(5);

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<AgentRunnerService> _logger;

    public AgentRunnerService(IServiceScopeFactory scopes, ILogger<AgentRunnerService> logger)
    {
        _scopes = scopes;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await ReleaseAbandonedRunsAsync(stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var claimed = await ClaimNextAsync(stoppingToken);
                if (claimed is null)
                {
                    await Task.Delay(Idle, stoppingToken);
                    continue;
                }

                using var scope = _scopes.CreateScope();
                var loop = scope.ServiceProvider.GetRequiredService<IAgentLoop>();
                await loop.RunAsync(claimed.Value, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception)
            {
                // A failure here must not take the loop down; the next pass may be fine.
                _logger.LogError(exception, "The agent runner hit an unexpected error");
                await Task.Delay(Idle, stoppingToken);
            }
        }
    }

    private async Task<Guid?> ClaimNextAsync(CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenant.EnterSystemContext("agent runner claiming a queued pass");

        var db = scope.ServiceProvider.GetRequiredService<IQaNxtDbContext>();
        return await db.AgentRuns
            .Where(r => r.Status == AgentRunStatus.Queued)
            .OrderBy(r => r.CreatedAt)
            .Select(r => (Guid?)r.Id)
            .FirstOrDefaultAsync(ct);
    }

    private async Task ReleaseAbandonedRunsAsync(CancellationToken ct)
    {
        try
        {
            using var scope = _scopes.CreateScope();
            var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
            using var _ = tenant.EnterSystemContext("agent runner startup reconciliation");

            var db = scope.ServiceProvider.GetRequiredService<IQaNxtDbContext>();
            var clock = scope.ServiceProvider.GetRequiredService<IClock>();

            var abandoned = await db.AgentRuns
                .Where(r => r.Status == AgentRunStatus.Running)
                .ToListAsync(ct);

            foreach (var run in abandoned)
            {
                run.Status = AgentRunStatus.Failed;
                run.CompletedAt = clock.UtcNow;
                run.StopReason = "The platform restarted while this pass was running.";
                run.ErrorMessage = "Interrupted by a restart. Start a new pass rather than resuming this one: "
                    + "part-way through, the loop would generate a second set of tests.";
            }

            if (abandoned.Count > 0)
            {
                await db.SaveChangesAsync(ct);
                _logger.LogWarning("Marked {Count} agent run(s) as failed after a restart", abandoned.Count);
            }
        }
        catch (Exception exception)
        {
            _logger.LogError(exception, "Could not reconcile abandoned agent runs at startup");
        }
    }
}
