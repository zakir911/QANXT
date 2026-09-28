using QaNxt.Application.Abstractions;
using QaNxt.Application.Projects;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Projects;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Application.Scheduling;

public sealed record CreateScheduleRequest(
    Guid ProjectId, string Name, string CronExpression, string? TimeZone,
    Guid? TestSuiteId, string? IncludeTags, Guid? EnvironmentId, BrowserType? Browser,
    /// <summary>What this schedule starts. Defaults to a test run.</summary>
    ScheduleKind Kind = ScheduleKind.TestRun,
    /// <summary>The application to scan. Required when Kind is SecurityScan.</summary>
    Guid? ApplicationId = null);

public sealed record UpdateScheduleRequest(
    string? Name, string? CronExpression, string? TimeZone, Guid? TestSuiteId,
    string? IncludeTags, Guid? EnvironmentId, BrowserType? Browser, bool? IsEnabled);

public sealed record ScheduleSummary(
    Guid Id, Guid ProjectId, ScheduleKind Kind, Guid? ApplicationId,
    string Name, string CronExpression, string TimeZone,
    Guid? TestSuiteId, string? IncludeTags, Guid? EnvironmentId, BrowserType Browser,
    bool IsEnabled, string? DisabledReason, DateTimeOffset? LastRunAt, Guid? LastRunId,
    DateTimeOffset? NextRunAt, int ConsecutiveFailureCount, DateTimeOffset CreatedAt);

public interface IScheduleService
{
    Task<IReadOnlyList<ScheduleSummary>> ListAsync(Guid? projectId, CancellationToken ct = default);
    Task<Result<ScheduleSummary>> GetAsync(Guid id, CancellationToken ct = default);
    Task<Result<ScheduleSummary>> CreateAsync(CreateScheduleRequest request, CancellationToken ct = default);
    Task<Result<ScheduleSummary>> UpdateAsync(Guid id, UpdateScheduleRequest request, CancellationToken ct = default);
    Task<Result> DeleteAsync(Guid id, CancellationToken ct = default);

    /// <summary>The next few times this schedule will fire. For confirming a cron expression
    /// means what whoever typed it thought it meant, before waiting a night to find out.</summary>
    Task<Result<IReadOnlyList<DateTimeOffset>>> PreviewAsync(Guid id, int count, CancellationToken ct = default);
}

/// <summary>
/// Schedules: regression that happens without anybody asking.
/// </summary>
/// <remarks>
/// The entity has existed since the first migration and nothing ever read it — no service,
/// no controller, nothing that evaluated a cron expression. A table of schedules that never
/// fire is worse than no schedules: the console showed them, so they looked armed.
///
/// Validation happens here rather than at the runner, because a schedule that cannot work
/// should be refused at the moment somebody creates it, while they are still looking at it.
/// A cron expression that parses but can never occur — 30 February — is refused for the
/// same reason.
/// </remarks>
public sealed class ScheduleService : IScheduleService
{
    /// <summary>Failures in a row before a schedule turns itself off.</summary>
    /// <remarks>
    /// Three rather than one: a platform restart or a momentarily unreachable queue should
    /// not disable the nightly regression. Three consecutive failures is not bad luck.
    /// </remarks>
    public const int FailuresBeforeDisabling = 3;

    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _user;
    private readonly IEnvironmentService _environments;
    private readonly IAuditLogger _audit;
    private readonly IClock _clock;
    private readonly ILogger<ScheduleService> _logger;

    public ScheduleService(IQaNxtDbContext db, ICurrentUser user, IEnvironmentService environments,
        IAuditLogger audit, IClock clock, ILogger<ScheduleService> logger)
    {
        _db = db;
        _user = user;
        _environments = environments;
        _audit = audit;
        _clock = clock;
        _logger = logger;
    }

    public async Task<IReadOnlyList<ScheduleSummary>> ListAsync(Guid? projectId, CancellationToken ct = default)
    {
        var query = _db.Schedules.AsNoTracking();
        if (projectId is not null) query = query.Where(s => s.ProjectId == projectId);

        return await query
            .OrderBy(s => s.Name)
            .Select(s => Project(s))
            .ToListAsync(ct);
    }

    public async Task<Result<ScheduleSummary>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var schedule = await _db.Schedules.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct);
        return schedule is null ? Error.NotFound("The schedule") : Result<ScheduleSummary>.Success(Project(schedule));
    }

    public async Task<Result<ScheduleSummary>> CreateAsync(CreateScheduleRequest request, CancellationToken ct = default)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == request.ProjectId, ct);
        if (project is null) return Error.NotFound("The project");

        var name = (request.Name ?? string.Empty).Trim();
        if (name.Length == 0) return Error.Validation("A schedule needs a name.");

        var validated = await ValidateAsync(request.CronExpression, request.TimeZone,
            request.TestSuiteId, request.EnvironmentId, request.ProjectId, ct);
        if (validated.IsFailure) return validated.Error!;

        if (request.Kind == ScheduleKind.SecurityScan)
        {
            // Creating a schedule is project:write. Starting a security scan is security:scan,
            // and a schedule that starts one every night is not a smaller act than starting one
            // — it is the same act, repeated, by somebody who will not be watching. Without
            // this, project:write alone would be a route to recurring scans.
            if (!_user.HasPermission(Security.Permissions.SecurityScan))
            {
                return Error.Forbidden(
                    "Scheduling a security scan needs security:scan as well as project:write. A "
                    + "schedule starts the same act as the button does, repeatedly and with "
                    + "nobody present.");
            }

            // A security schedule with nothing to point at is a schedule that fires for ever
            // and starts nothing, which reads in a list exactly like one that is working.
            if (request.ApplicationId is not { } applicationId)
            {
                return Error.Validation(
                    "A security schedule needs the application it should scan.");
            }

            var application = await _db.Applications
                .FirstOrDefaultAsync(a => a.Id == applicationId && a.ProjectId == project.Id, ct);
            if (application is null)
            {
                return Error.Validation(
                    "That application is not in this project, so a schedule here cannot scan it.");
            }

            // Not checked here: whether the application is authorized for security testing. A
            // scope can be written after the schedule and withdrawn before it fires, so the
            // authorization that matters is the one in force at the moment of the scan — which
            // the launcher checks, every time, and refuses.
        }

        var schedule = new Schedule
        {
            OrganizationId = project.OrganizationId,
            ProjectId = project.Id,
            Kind = request.Kind,
            ApplicationId = request.Kind == ScheduleKind.SecurityScan ? request.ApplicationId : null,
            Name = name,
            CronExpression = request.CronExpression.Trim(),
            TimeZone = validated.Value!.TimeZone.Id,
            TestSuiteId = request.TestSuiteId,
            IncludeTags = NormalizeTags(request.IncludeTags),
            EnvironmentId = request.EnvironmentId,
            Browser = request.Browser ?? project.DefaultBrowser,
            IsEnabled = true,
            // Stored as an instant. Npgsql maps DateTimeOffset onto timestamptz, which
            // accepts offset zero only, and the cron evaluator returns the offset in force
            // at that local time — correct for display, refused by the database. The two
            // are the same moment; the conversion just has to be explicit. (BUG-0029.)
            NextRunAt = validated.Value.NextRunAt.ToUniversalTime(),
            CreatedByUserId = _user.UserId
        };

        _db.Schedules.Add(schedule);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ScheduleCreated, nameof(Schedule), schedule.Id,
            $"Schedule '{schedule.Name}' created: {schedule.CronExpression} ({schedule.TimeZone}), "
            + $"first run {schedule.NextRunAt:u}.",
            projectId: schedule.ProjectId, ct: ct);

        return Result<ScheduleSummary>.Success(Project(schedule));
    }

    public async Task<Result<ScheduleSummary>> UpdateAsync(Guid id, UpdateScheduleRequest request, CancellationToken ct = default)
    {
        var schedule = await _db.Schedules.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (schedule is null) return Error.NotFound("The schedule");

        var cron = request.CronExpression?.Trim() ?? schedule.CronExpression;
        var zone = request.TimeZone ?? schedule.TimeZone;
        var suiteId = request.TestSuiteId ?? schedule.TestSuiteId;
        var environmentId = request.EnvironmentId ?? schedule.EnvironmentId;

        var validated = await ValidateAsync(cron, zone, suiteId, environmentId, schedule.ProjectId, ct);
        if (validated.IsFailure) return validated.Error!;

        var timingChanged = cron != schedule.CronExpression || validated.Value!.TimeZone.Id != schedule.TimeZone;

        if (request.Name?.Trim() is { Length: > 0 } name) schedule.Name = name;
        schedule.CronExpression = cron;
        schedule.TimeZone = validated.Value!.TimeZone.Id;
        if (request.TestSuiteId is not null) schedule.TestSuiteId = request.TestSuiteId;
        if (request.IncludeTags is not null) schedule.IncludeTags = NormalizeTags(request.IncludeTags);
        if (request.EnvironmentId is not null) schedule.EnvironmentId = request.EnvironmentId;
        if (request.Browser is not null) schedule.Browser = request.Browser.Value;

        if (request.IsEnabled is { } enabled)
        {
            schedule.IsEnabled = enabled;
            if (enabled)
            {
                // Re-enabling clears both the count and the reason. Keeping either would
                // disable it again after one more failure, or leave the console showing a
                // reason for a schedule that is running.
                schedule.ConsecutiveFailureCount = 0;
                schedule.DisabledReason = null;
            }
        }

        // Recomputed whenever the timing or the enabled state changes, so a schedule never
        // sits with a NextRunAt that belongs to the expression it used to have.
        if (timingChanged || request.IsEnabled == true || schedule.NextRunAt is null)
            schedule.NextRunAt = validated.Value.NextRunAt.ToUniversalTime();

        schedule.UpdatedByUserId = _user.UserId;
        schedule.UpdatedAt = _clock.UtcNow;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ScheduleUpdated, nameof(Schedule), schedule.Id,
            $"Schedule '{schedule.Name}' updated: {schedule.CronExpression} ({schedule.TimeZone}), "
            + $"{(schedule.IsEnabled ? "enabled" : "disabled")}, next run {schedule.NextRunAt:u}.",
            projectId: schedule.ProjectId, ct: ct);

        return Result<ScheduleSummary>.Success(Project(schedule));
    }

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var schedule = await _db.Schedules.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (schedule is null) return Result.Failure(Error.NotFound("The schedule"));

        _db.Schedules.Remove(schedule);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.ScheduleDeleted, nameof(Schedule), id,
            $"Schedule '{schedule.Name}' deleted.", projectId: schedule.ProjectId, ct: ct);
        return Result.Success();
    }

    public async Task<Result<IReadOnlyList<DateTimeOffset>>> PreviewAsync(Guid id, int count, CancellationToken ct = default)
    {
        var schedule = await _db.Schedules.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct);
        if (schedule is null) return Error.NotFound("The schedule");

        if (!CronExpression.TryParse(schedule.CronExpression, out var cron, out var problem))
            return Error.Validation(problem!);

        var zone = ResolveZone(schedule.TimeZone) ?? TimeZoneInfo.Utc;
        // Returned in the schedule's own offset, not UTC. This is read by a person
        // checking that "30 2 * * *" in Europe/London means what they meant, and
        // "2026-06-15T02:30:00+01:00" answers that where the UTC form does not. Stored
        // values are instants; displayed values are local, and the difference is deliberate.
        var occurrences = new List<DateTimeOffset>();
        var cursor = _clock.UtcNow;

        for (var i = 0; i < Math.Clamp(count, 1, 50); i++)
        {
            var next = cron!.NextOccurrence(cursor, zone);
            if (next is null) break;
            occurrences.Add(next.Value);
            cursor = next.Value;
        }

        return Result<IReadOnlyList<DateTimeOffset>>.Success(occurrences);
    }

    // -----------------------------------------------------------------------

    private sealed record Validated(TimeZoneInfo TimeZone, DateTimeOffset NextRunAt);

    /// <summary>
    /// Everything that has to be true before a schedule is worth storing.
    /// </summary>
    /// <remarks>
    /// The environment check is <see cref="IEnvironmentService.EnsureTestableAsync"/>, the
    /// same one a run goes through. Refusing an unauthorized production environment here
    /// rather than at three in the morning is the difference between a message somebody
    /// reads and a message nobody does.
    /// </remarks>
    private async Task<Result<Validated>> ValidateAsync(string? expression, string? timeZone,
        Guid? testSuiteId, Guid? environmentId, Guid projectId, CancellationToken ct)
    {
        if (!CronExpression.TryParse(expression, out var cron, out var problem))
            return Error.Validation(problem!);

        var zone = ResolveZone(timeZone);
        if (zone is null)
        {
            return Error.Validation(
                $"\"{timeZone}\" is not a time zone this platform knows. Use an IANA name such as "
                + "Europe/London or America/New_York, or UTC.");
        }

        var next = cron!.NextOccurrence(_clock.UtcNow, zone);
        if (next is null)
        {
            // Parses, and no date will ever match it. Accepting it would leave a schedule
            // that looks armed in the console and never runs.
            return Error.Validation(
                $"\"{expression}\" is a valid cron expression that can never occur — check the "
                + "day and month together.");
        }

        if (testSuiteId is not null)
        {
            var suiteExists = await _db.TestSuites.AnyAsync(s => s.Id == testSuiteId && s.ProjectId == projectId, ct);
            if (!suiteExists) return Error.NotFound("The test suite");
        }

        if (environmentId is not null)
        {
            var environment = await _db.Environments
                .AnyAsync(e => e.Id == environmentId && e.ProjectId == projectId, ct);
            if (!environment) return Error.NotFound("The environment");

            var testable = await _environments.EnsureTestableAsync(environmentId.Value, ct);
            if (testable.IsFailure) return testable.Error!;
        }

        return Result<Validated>.Success(new Validated(zone, next.Value));
    }

    /// <summary>Accepts an IANA name on any platform, and Windows ids where they work.</summary>
    private static TimeZoneInfo? ResolveZone(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(id.Trim()); }
        catch (TimeZoneNotFoundException) { return null; }
        catch (InvalidTimeZoneException) { return null; }
    }

    private static string? NormalizeTags(string? tags)
    {
        if (string.IsNullOrWhiteSpace(tags)) return null;
        var parts = tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(tag => tag.ToLowerInvariant())
            .Distinct()
            .ToArray();
        return parts.Length == 0 ? null : string.Join(',', parts);
    }

    private static ScheduleSummary Project(Schedule s) => new(
        s.Id, s.ProjectId, s.Kind, s.ApplicationId,
        s.Name, s.CronExpression, s.TimeZone, s.TestSuiteId, s.IncludeTags,
        s.EnvironmentId, s.Browser, s.IsEnabled, s.DisabledReason, s.LastRunAt, s.LastRunId,
        s.NextRunAt, s.ConsecutiveFailureCount, s.CreatedAt);
}
