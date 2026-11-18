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
        // The grace period is counted on top of the run's OWN budget, not instead of it.
        //
        // This swept on a fixed fifteen minutes regardless of what the run was allowed to
        // take. An application configured with a 900-second exploration budget — fifteen
        // minutes, and the budget is settable up to two hours — therefore had its crawls
        // marked Failed at the exact moment they were legitimately finishing. Observed on a
        // 137-screen application: the crawl mapped 152 pages, uploaded its artifacts, and
        // the completion callback then landed on a run the reaper had already declared
        // stranded, with an error message telling the reader to go and look at a worker that
        // had done nothing wrong.
        //
        // Three earlier runs with the same budget survived only because their completion
        // beat the next one-minute sweep. A reaper whose verdict depends on who wins a race
        // with the thing it is judging is not a reaper.
        //
        // The default budget is 600 seconds, under the default grace, which is why this sat
        // here unnoticed: every untouched configuration hides it.
        //
        // Queued is included deliberately. A run queued with no worker running at all never
        // gets a StartedAt, so keying only on StartedAt would leave it queued for ever. The
        // fallback to CreatedAt is what catches that case.
        //
        // The database filter uses the smallest threshold any run could have, so nothing
        // stranded is missed; each candidate is then judged against its own budget. Done in
        // two steps because the per-row arithmetic does not translate, and a coarse filter
        // that over-selects is cheap where one that under-selects would leave runs stuck.
        var coarseCutoff = clock.UtcNow - grace;

        var candidates = await db.DiscoveryRuns
            .Where(r => (r.Status == DiscoveryStatus.Running || r.Status == DiscoveryStatus.Queued)
                     && (r.StartedAt != null ? r.StartedAt < coarseCutoff : r.CreatedAt < coarseCutoff))
            .ToListAsync(ct);

        var stranded = candidates.Where(r => r.IsStranded(clock.UtcNow, grace)).ToList();

        if (stranded.Count == 0) return;

        foreach (var run in stranded)
        {
            var started = run.StartedAt is not null;
            run.Status = DiscoveryStatus.Failed;
            run.CompletedAt = clock.UtcNow;
            // Said plainly, and said to be a platform problem, because whoever reads it should
            // not go looking for a defect in the application they were crawling.
            run.ErrorMessage = started
                ? $"No worker reported on this discovery run for over {grace.TotalMinutes:0} minutes "
                  + $"beyond its own {run.TimeoutSeconds}-second exploration budget. "
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
