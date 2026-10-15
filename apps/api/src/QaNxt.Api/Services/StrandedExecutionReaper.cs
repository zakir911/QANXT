using QaNxt.Application.Abstractions;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Api.Services;

/// <summary>Finishes executions that no worker is going to finish.
///
/// A worker claims an execution, marks it running, and reports back when it is done. If it
/// dies, loses its network, or drops the job for any other reason, that row stays `Running`
/// for ever — and so does its run. Nothing else reconciles it: the queue's own reclaim
/// only covers messages still pending in the stream, and a job the worker released after
/// its callbacks failed is not one of those.
///
/// The cost of not doing this is not a tidiness problem. A caller waiting on a run — a CI
/// pipeline, the CLI, someone watching the console — waits until its own timeout, and the
/// platform shows work in progress that will never progress. A verdict of "failed, because
/// the worker stopped reporting" is worth far more than silence.
///
/// Security scans and discovery runs are reconciled the same way, each by its own sweep.</summary>
public sealed class StrandedExecutionReaper : BackgroundService
{
    private static readonly TimeSpan SweepInterval = TimeSpan.FromMinutes(1);

    private readonly IServiceScopeFactory _scopes;
    private readonly IConfiguration _configuration;
    private readonly ILogger<StrandedExecutionReaper> _logger;

    public StrandedExecutionReaper(IServiceScopeFactory scopes, IConfiguration configuration,
        ILogger<StrandedExecutionReaper> logger)
    {
        _scopes = scopes;
        _configuration = configuration;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Generous by default: long enough that a slow execution on a busy worker is never
        // mistaken for a dead one, short enough that nobody waits half an hour for a verdict.
        var graceMinutes = _configuration.GetValue("Execution:StrandedAfterMinutes", 10);
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
                _logger.LogError(exception, "The stranded-execution sweep failed");
            }

            await Task.Delay(SweepInterval, stoppingToken);
        }
    }

    private async Task SweepAsync(TimeSpan grace, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenant.EnterSystemContext("reconciling executions no worker is finishing");

        var db = scope.ServiceProvider.GetRequiredService<IQaNxtDbContext>();
        var clock = scope.ServiceProvider.GetRequiredService<IClock>();
        var cutoff = clock.UtcNow - grace;

        var stranded = await db.TestExecutions
            .Where(e => (e.Status == ExecutionStatus.Running || e.Status == ExecutionStatus.Queued)
                     && e.StartedAt != null && e.StartedAt < cutoff)
            .ToListAsync(ct);

        if (stranded.Count > 0) await EndStrandedAsync(db, clock, stranded, grace, ct);

        await EndUnclaimedAsync(db, clock, ct);

        // Last, the runs themselves. A run is finished by whichever execution reports last,
        // but when the last two report at the same moment each can still see the other as
        // running, and then neither finishes it: every test done, the run "running" for ever.
        // Any unfinished run whose executions have all finished is finished here, the same
        // way the last report would have.
        var ingest = scope.ServiceProvider.GetRequiredService<QaNxt.Application.Testing.IExecutionIngestService>();
        var settled = clock.UtcNow - TimeSpan.FromMinutes(1);
        var done = await db.TestRuns
            .Where(r => r.CompletedAt == null && r.CreatedAt < settled
                     && !db.TestExecutions.Any(e => e.TestRunId == r.Id
                         && (e.Status == ExecutionStatus.Running || e.Status == ExecutionStatus.Queued || e.Status == ExecutionStatus.Pending)))
            .Select(r => r.Id).ToListAsync(ct);
        foreach (var runId in done)
        {
            await ingest.ReconcileRunAsync(runId, ct);
            _logger.LogWarning("Run {RunId} had finished every execution but was never completed; completed it now", runId);
        }
    }

    /// <summary>Ends executions no worker ever picked up. A queued execution has no start
    /// time, so the stranded sweep never saw it: with the worker stopped, or its queue lost,
    /// the run sat "queued" or "running" for ever. Judged by the run, not the execution — a
    /// big run legitimately keeps tests queued for a long time, but not while nothing in it
    /// has started or finished for this long.</summary>
    private async Task EndUnclaimedAsync(IQaNxtDbContext db, IClock clock, CancellationToken ct)
    {
        var quiet = TimeSpan.FromMinutes(Math.Clamp(_configuration.GetValue("Execution:UnclaimedAfterMinutes", 20), 5, 480));
        var cutoff = clock.UtcNow - quiet;
        var candidates = await db.TestRuns
            .Where(r => r.CompletedAt == null && r.CreatedAt < cutoff
                     && db.TestExecutions.Any(e => e.TestRunId == r.Id && (e.Status == ExecutionStatus.Queued || e.Status == ExecutionStatus.Pending)))
            .Select(r => new
            {
                r.Id,
                LastActivity = db.TestExecutions.Where(e => e.TestRunId == r.Id)
                    .Max(e => (DateTimeOffset?)(e.CompletedAt ?? e.StartedAt)) ?? r.StartedAt ?? r.CreatedAt
            })
            .ToListAsync(ct);
        var idle = candidates.Where(c => c.LastActivity < cutoff).Select(c => c.Id).ToList();
        if (idle.Count == 0) return;

        var unclaimed = await db.TestExecutions
            .Where(e => idle.Contains(e.TestRunId) && (e.Status == ExecutionStatus.Queued || e.Status == ExecutionStatus.Pending))
            .ToListAsync(ct);
        foreach (var execution in unclaimed)
        {
            execution.Status = ExecutionStatus.Blocked;
            execution.CompletedAt = clock.UtcNow;
            execution.ErrorMessage =
                $"No worker picked this test up, and nothing in its run had moved for {quiet.TotalMinutes:0} minutes. "
                + "Check that a browser worker is running (its logs, or `make worker`) and run the test again. "
                + "It never ran, so it says nothing about the application.";
        }
        await db.SaveChangesAsync(ct);
        _logger.LogWarning("Ended {Count} execution(s) no worker picked up, across {Runs} idle run(s)", unclaimed.Count, idle.Count);
    }

    private async Task EndStrandedAsync(IQaNxtDbContext db, IClock clock, List<Domain.Testing.TestExecution> stranded, TimeSpan grace, CancellationToken ct)
    {
        foreach (var execution in stranded)
        {
            execution.Status = ExecutionStatus.Error;
            execution.CompletedAt = clock.UtcNow;
            execution.DurationMs = execution.StartedAt is null
                ? 0
                : (int)(clock.UtcNow - execution.StartedAt.Value).TotalMilliseconds;
            // Said plainly, because this is not an application defect and whoever reads it
            // should not go looking for one.
            execution.ErrorMessage =
                $"No worker reported on this execution for over {grace.TotalMinutes:0} minutes. "
                + "It was claimed by a worker that stopped responding, so the platform has ended it "
                + "rather than leaving the run unfinished. This is a platform or infrastructure "
                + "problem, not a failure of the application under test.";

            _logger.LogWarning(
                "Execution {ExecutionId} was stranded by worker {WorkerId} and has been ended",
                execution.Id, execution.WorkerId);
        }

        await db.SaveChangesAsync(ct);
        _logger.LogWarning("Ended {Count} stranded execution(s)", stranded.Count);
    }
}
