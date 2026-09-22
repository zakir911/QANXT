using Aira.Application.Abstractions;
using Aira.Application.Notifications;
using Aira.Application.Scheduling;
using Aira.Application.Testing;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Aira.Api.Services;

/// <summary>
/// Fires schedules. The "continuous" in continuous quality.
/// </summary>
/// <remarks>
/// <para>
/// A pipeline covers what changed. A schedule covers what did not: the regression that
/// finds a dependency that rotted, a certificate that expired, a third party that changed
/// under you. Nobody commits on the night any of those break, so nothing triggers.
/// </para>
/// <para>
/// <b>Two instances must not both fire the same schedule.</b> Claiming is a compare-and-swap
/// on <c>NextRunAt</c>: each instance moves it forward with a conditional update and only
/// the one whose update affected a row proceeds. It needs no lock, no leader election and
/// no extra table, and it is correct under any number of instances because the database
/// serialises the two updates itself. Without it, a two-instance deployment runs every
/// nightly regression twice and reports every difference between the two as instability.
/// </para>
/// <para>
/// <b>Missed occurrences are skipped, not replayed.</b> The next fire time is computed from
/// now, not from the time that was missed. An API that was down for a day comes back and
/// runs the nightly regression once, rather than queueing twenty-four hourly runs at once
/// and burying whatever was actually wrong.
/// </para>
/// </remarks>
public sealed class ScheduleRunnerService : BackgroundService
{
    /// <summary>
    /// How often to look for due schedules.
    /// </summary>
    /// <remarks>
    /// Schedules have a resolution of one minute, so a sweep twice a minute means a
    /// schedule fires within thirty seconds of its time. Sweeping faster would cost a query
    /// per instance for accuracy nobody asked for; slower would make "0 2 * * *" mean
    /// "shortly after two", which is fine until somebody is correlating a run against a
    /// deployment window.
    /// </remarks>
    private static readonly TimeSpan SweepInterval = TimeSpan.FromSeconds(30);

    private readonly IServiceScopeFactory _scopes;
    private readonly IConfiguration _configuration;
    private readonly ILogger<ScheduleRunnerService> _logger;

    public ScheduleRunnerService(IServiceScopeFactory scopes, IConfiguration configuration,
        ILogger<ScheduleRunnerService> logger)
    {
        _scopes = scopes;
        _configuration = configuration;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_configuration.GetValue("Scheduling:Enabled", true))
        {
            // Off in environments that share a database with a real one, so a developer's
            // machine cannot start runs against somebody else's project overnight.
            _logger.LogInformation("Scheduled runs are disabled by configuration.");
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SweepAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception)
            {
                // One bad sweep must not stop every schedule for ever.
                _logger.LogError(exception, "The schedule sweep failed");
            }

            await Task.Delay(SweepInterval, stoppingToken);
        }
    }

    private async Task SweepAsync(CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenant.EnterSystemContext("firing due schedules");

        var db = scope.ServiceProvider.GetRequiredService<IAiraDbContext>();
        var clock = scope.ServiceProvider.GetRequiredService<IClock>();
        var runs = scope.ServiceProvider.GetRequiredService<ITestRunService>();
        var audit = scope.ServiceProvider.GetRequiredService<IAuditLogger>();

        var now = clock.UtcNow;

        var due = await db.Schedules
            .Where(s => s.IsEnabled && s.NextRunAt != null && s.NextRunAt <= now)
            .OrderBy(s => s.NextRunAt)
            .Take(50)
            .ToListAsync(ct);

        foreach (var schedule in due)
        {
            var claimedAt = schedule.NextRunAt;

            if (!CronExpression.TryParse(schedule.CronExpression, out var cron, out var problem))
            {
                // Stored expressions are validated on the way in, so this means the row was
                // edited outside AIRA or a parser rule changed. Either way it will never
                // fire correctly, and leaving it enabled means sweeping it for ever.
                await DisableAsync(db, audit, schedule,
                    $"Its cron expression is no longer valid: {problem}", ct);
                continue;
            }

            var zone = Zone(schedule.TimeZone);
            var next = cron!.NextOccurrence(now, zone);
            if (next is null)
            {
                await DisableAsync(db, audit, schedule,
                    $"\"{schedule.CronExpression}\" has no further occurrences.", ct);
                continue;
            }

            // The claim. Only the instance whose update changes a row goes on to start a
            // run; every other instance sees zero rows and moves to the next schedule.
            var claimed = await db.Schedules
                .Where(s => s.Id == schedule.Id && s.NextRunAt == claimedAt && s.IsEnabled)
                // UTC for the same reason as everywhere else it is stored: timestamptz
                // takes an instant, and the evaluator returns a local offset. (BUG-0029.)
                .ExecuteUpdateAsync(set => set.SetProperty(s => s.NextRunAt, next.Value.ToUniversalTime()), ct);

            if (claimed == 0)
            {
                _logger.LogDebug("Schedule {ScheduleId} was claimed by another instance", schedule.Id);
                continue;
            }

            await FireAsync(db, runs, audit, clock, schedule, ct);
        }
    }

    private async Task FireAsync(IAiraDbContext db, ITestRunService runs, IAuditLogger audit,
        IClock clock, Domain.Projects.Schedule schedule, CancellationToken ct)
    {
        try
        {
            var testCaseIds = await SelectAsync(db, schedule, ct);

            if (testCaseIds.Length == 0)
            {
                // Not a failure of the platform, and not something to keep retrying every
                // minute. Recorded so that "the nightly run stopped happening" has an
                // answer other than silence.
                _logger.LogWarning(
                    "Schedule {ScheduleId} '{Name}' matched no tests and started nothing",
                    schedule.Id, schedule.Name);
                await RecordFailureAsync(db, audit, schedule, "it matched no tests", ct);
                return;
            }

            var started = await runs.StartAsync(new StartTestRunRequest(
                ProjectId: schedule.ProjectId,
                TestSuiteId: null,
                TestCaseIds: testCaseIds,
                EnvironmentId: schedule.EnvironmentId,
                Browser: schedule.Browser,
                Headless: true,
                Parallelism: null,
                MaxRetries: null,
                Name: $"{schedule.Name} — {clock.UtcNow:yyyy-MM-dd HH:mm} UTC",
                Trigger: RunTrigger.Scheduled,
                Ci: null), ct);

            if (started.IsFailure)
            {
                await RecordFailureAsync(db, audit, schedule, started.Error!.Message, ct);
                return;
            }

            var row = await db.Schedules.FirstAsync(s => s.Id == schedule.Id, ct);
            row.LastRunAt = clock.UtcNow;
            row.LastRunId = started.Value!.Id;
            row.ConsecutiveFailureCount = 0;
            await db.SaveChangesAsync(ct);

            await audit.LogAsync(AuditAction.ScheduleFired, nameof(Domain.Projects.Schedule), schedule.Id,
                $"Schedule '{schedule.Name}' started run {started.Value.Id} with "
                + $"{testCaseIds.Length} test(s). Next run {row.NextRunAt:u}.",
                projectId: schedule.ProjectId, ct: ct);

            _logger.LogInformation(
                "Schedule {ScheduleId} '{Name}' started run {RunId} with {Count} test(s)",
                schedule.Id, schedule.Name, started.Value.Id, testCaseIds.Length);
        }
        catch (Exception exception)
        {
            _logger.LogError(exception, "Schedule {ScheduleId} could not start a run", schedule.Id);
            await RecordFailureAsync(db, audit, schedule, exception.Message, ct);
        }
    }

    /// <summary>The tests a schedule covers: its suite, its tags, or the whole project.</summary>
    private static async Task<Guid[]> SelectAsync(IAiraDbContext db, Domain.Projects.Schedule schedule,
        CancellationToken ct)
    {
        var query = db.TestCases.Where(t => t.ProjectId == schedule.ProjectId && t.IsEnabled);
        if (schedule.TestSuiteId is not null) query = query.Where(t => t.TestSuiteId == schedule.TestSuiteId);

        var candidates = await query
            .OrderBy(t => t.Priority).ThenBy(t => t.Reference)
            .Select(t => new { t.Id, t.Tags })
            .ToListAsync(ct);

        var tags = (schedule.IncludeTags ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(tag => tag.ToLowerInvariant())
            .ToHashSet();

        if (tags.Count == 0) return candidates.Select(c => c.Id).ToArray();

        // Matched in memory rather than with a LIKE, so that a tag named "api" does not
        // select every test tagged "apiv2".
        return candidates
            .Where(candidate => (candidate.Tags ?? string.Empty)
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Any(tag => tags.Contains(tag.ToLowerInvariant())))
            .Select(candidate => candidate.Id)
            .ToArray();
    }

    /// <summary>
    /// Counts a failure, and turns the schedule off once there have been enough of them.
    /// </summary>
    /// <remarks>
    /// A schedule pointed at a deleted application fails every hour for ever, and each
    /// failure is a log line nobody reads. Disabling it after three turns an endless drip
    /// into one thing to fix, and the reason is stored on the row so the console can say
    /// what happened rather than just showing it as off.
    /// </remarks>
    private async Task RecordFailureAsync(IAiraDbContext db, IAuditLogger audit,
        Domain.Projects.Schedule schedule, string reason, CancellationToken ct)
    {
        var row = await db.Schedules.FirstOrDefaultAsync(s => s.Id == schedule.Id, ct);
        if (row is null) return;

        row.ConsecutiveFailureCount++;

        if (row.ConsecutiveFailureCount >= ScheduleService.FailuresBeforeDisabling)
        {
            row.IsEnabled = false;
            row.DisabledReason =
                $"Disabled after {row.ConsecutiveFailureCount} consecutive failures. Last reason: {reason}";
            await db.SaveChangesAsync(ct);

            await audit.LogAsync(AuditAction.ScheduleDisabledAutomatically,
                nameof(Domain.Projects.Schedule), schedule.Id, row.DisabledReason,
                succeeded: false, projectId: schedule.ProjectId, ct: ct);

            _logger.LogError("Schedule {ScheduleId} '{Name}' disabled itself: {Reason}",
                schedule.Id, schedule.Name, row.DisabledReason);

            // The one case where silence is the worst outcome: the nightly has stopped, and
            // the only signal is its absence. Nobody notices an absence.
            await NotifyDisabledAsync(db, schedule, row.DisabledReason!, ct);
            return;
        }

        await db.SaveChangesAsync(ct);
        _logger.LogWarning("Schedule {ScheduleId} '{Name}' failed to start a run ({Count}/{Limit}): {Reason}",
            schedule.Id, schedule.Name, row.ConsecutiveFailureCount,
            ScheduleService.FailuresBeforeDisabling, reason);
    }

    private async Task DisableAsync(IAiraDbContext db, IAuditLogger audit,
        Domain.Projects.Schedule schedule, string reason, CancellationToken ct)
    {
        var row = await db.Schedules.FirstOrDefaultAsync(s => s.Id == schedule.Id, ct);
        if (row is null) return;

        row.IsEnabled = false;
        row.DisabledReason = reason;
        await db.SaveChangesAsync(ct);

        await audit.LogAsync(AuditAction.ScheduleDisabledAutomatically,
            nameof(Domain.Projects.Schedule), schedule.Id, reason,
            succeeded: false, projectId: schedule.ProjectId, ct: ct);

        _logger.LogError("Schedule {ScheduleId} '{Name}' disabled: {Reason}",
            schedule.Id, schedule.Name, reason);

        await NotifyDisabledAsync(db, schedule, reason, ct);
    }

    /// <summary>Tells the project that one of its schedules has stopped running.</summary>
    private async Task NotifyDisabledAsync(IAiraDbContext db, Domain.Projects.Schedule schedule,
        string reason, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var tenant = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        using var _ = tenant.EnterSystemContext("notifying that a schedule disabled itself");

        var notifications = scope.ServiceProvider.GetRequiredService<INotificationService>();
        var scoped = scope.ServiceProvider.GetRequiredService<IAiraDbContext>();

        var project = await scoped.Projects
            .Where(p => p.Id == schedule.ProjectId)
            .Select(p => p.Name)
            .FirstOrDefaultAsync(ct) ?? "Unknown project";

        await notifications.NotifyAsync(new NotificationMessage(
            NotificationEventKind.ScheduleDisabled,
            $"Schedule '{schedule.Name}' has stopped running",
            reason + " Nothing scheduled will run for it until somebody re-enables it.",
            schedule.ProjectId, project,
            Facts: new Dictionary<string, object?>
            {
                ["schedule"] = schedule.Name,
                ["cron"] = schedule.CronExpression,
                ["timeZone"] = schedule.TimeZone
            }), ct);
    }

    private static TimeZoneInfo Zone(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.Utc; }
        catch (InvalidTimeZoneException) { return TimeZoneInfo.Utc; }
    }
}
