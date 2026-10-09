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

        if (stranded.Count == 0) return;

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

        // Any run whose executions have all finished must now be completed, or the caller is
        // still waiting on a run whose work is over.
        var runIds = stranded.Select(e => e.TestRunId).Distinct().ToList();
        var runs = await db.TestRuns.Where(r => runIds.Contains(r.Id)).ToListAsync(ct);

        foreach (var run in runs)
        {
            var executions = await db.TestExecutions
                .Where(e => e.TestRunId == run.Id)
                .Select(e => e.Status)
                .ToListAsync(ct);

            var unfinished = executions.Count(s => s is ExecutionStatus.Running or ExecutionStatus.Queued
                                                       or ExecutionStatus.Pending);
            if (unfinished > 0) continue;

            // There is no separate error counter on a run; a stranded execution is counted
            // as blocked, which is what it is — the test never got to produce a verdict.
            run.BlockedCount = executions.Count(s => s == ExecutionStatus.Error
                                                  || s == ExecutionStatus.Blocked);
            run.Status = ExecutionStatus.Error;
            run.CompletedAt = clock.UtcNow;
            run.DurationMs = run.StartedAt is null
                ? 0
                : (int)(clock.UtcNow - run.StartedAt.Value).TotalMilliseconds;
        }

        await db.SaveChangesAsync(ct);
        _logger.LogWarning("Ended {Count} stranded execution(s) across {Runs} run(s)",
            stranded.Count, runs.Count);
    }
}
