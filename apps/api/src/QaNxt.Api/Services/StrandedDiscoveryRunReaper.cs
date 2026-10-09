using QaNxt.Application.Abstractions;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Api.Services;

/// <summary>Ends discovery runs that no worker is going to finish.
///
/// A worker claims a run, marks it <c>Running</c>, and reports when the crawl is done. If it
/// dies, loses the network, or fails before it can report — a browser that will not launch is
/// the common one — that row stays <c>Running</c> for ever. The queue's own reclaim does not
/// cover it: that only moves messages still pending in the stream, and a job whose worker
/// gave up is not one of those.
///
/// The cost is not tidiness. Someone watching the console sees a crawl in progress that will
/// never progress, with no reason given and nothing to act on, which is the same dishonest
/// state as a card reading "last explored just now" for a run that explored nothing. A
/// verdict of "failed, because the worker stopped reporting" is worth far more than a
/// spinner that never stops.
///
/// Executions and security scans have had this for a while. Discovery did not, despite a
/// comment in the execution reaper claiming it did.</summary>
public sealed class StrandedDiscoveryRunReaper : BackgroundService
{
    private static readonly TimeSpan SweepInterval = TimeSpan.FromMinutes(1);

    private readonly IServiceScopeFactory _scopes;
    private readonly IConfiguration _configuration;
    private readonly ILogger<StrandedDiscoveryRunReaper> _logger;

    public StrandedDiscoveryRunReaper(IServiceScopeFactory scopes, IConfiguration configuration,
        ILogger<StrandedDiscoveryRunReaper> logger)
    {
        _scopes = scopes;
        _configuration = configuration;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // A crawl is bounded by its own timeout budget, but that budget is per page and a
        // large site legitimately takes a while. Generous enough that a slow crawl is never
        // mistaken for a dead one, short enough that nobody waits half an hour for a verdict.
        var graceMinutes = _configuration.GetValue("Discovery:StrandedAfterMinutes", 15);
        var grace = TimeSpan.FromMinutes(Math.Clamp(graceMinutes, 2, 240));

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SweepAsync(grace, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception)
            {
                // A failed sweep must not take the reaper down; the next one may succeed.
                _logger.LogError(exception, "The stranded-discovery sweep failed");
            }

            await Task.Delay(SweepInterval, stoppingToken);
        }
    }

    private async Task SweepAsync(TimeSpan grace, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenant.EnterSystemContext("reconciling discovery runs no worker is finishing");

        var db = scope.ServiceProvider.GetRequiredService<IQaNxtDbContext>();
        var clock = scope.ServiceProvider.GetRequiredService<IClock>();
        var cutoff = clock.UtcNow - grace;

        // Queued is included deliberately. A run queued with no worker running at all never
        // gets a StartedAt, so keying only on StartedAt would leave it queued for ever. The
        // fallback to CreatedAt is what catches that case.
        var stranded = await db.DiscoveryRuns
            .Where(r => (r.Status == DiscoveryStatus.Running || r.Status == DiscoveryStatus.Queued)
                     && (r.StartedAt != null ? r.StartedAt < cutoff : r.CreatedAt < cutoff))
            .ToListAsync(ct);

        if (stranded.Count == 0) return;

        foreach (var run in stranded)
        {
            var started = run.StartedAt is not null;
            run.Status = DiscoveryStatus.Failed;
            run.CompletedAt = clock.UtcNow;
            // Said plainly, and said to be a platform problem, because whoever reads it should
            // not go looking for a defect in the application they were crawling.
            run.ErrorMessage = started
                ? $"No worker reported on this discovery run for over {grace.TotalMinutes:0} minutes. "
                  + "It was claimed by a worker that stopped responding, so the platform has ended it "
                  + "rather than leaving it reporting progress it is not making. This is a platform or "
                  + "infrastructure problem, not a failure of the application being crawled. The "
                  + "worker's log says why it stopped."
                : $"This discovery run sat queued for over {grace.TotalMinutes:0} minutes and no worker "
                  + "ever picked it up, so the platform has ended it. Check that a browser worker is "
                  + "running and can reach Redis.";

            _logger.LogWarning(
                "Discovery run {RunId} was stranded by worker {WorkerId} after {Status} and has been ended",
                run.Id, run.WorkerId ?? "(none)", started ? "running" : "queuing");
        }

        await db.SaveChangesAsync(ct);
        _logger.LogWarning("Ended {Count} stranded discovery run(s)", stranded.Count);
    }
}
