using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Projects;

public class Integration : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Project? Project { get; set; }

    public IntegrationKind Kind { get; set; }
    public string Name { get; set; } = string.Empty;
    public bool IsEnabled { get; set; } = true;
    /// <summary>Non-sensitive settings (repository, organization, board id, …).</summary>
    public string SettingsJson { get; set; } = "{}";
    /// <summary>AES-256-GCM protected credentials. Never returned by the API.</summary>
    public string? EncryptedCredentials { get; set; }
    public DateTimeOffset? LastUsedAt { get; set; }
    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
}

/// <summary>What a schedule starts when it fires.</summary>
public enum ScheduleKind
{
    /// <summary>A test run, selected by suite and tags. The original and the default.</summary>
    TestRun = 0,

    /// <summary>
    /// A security scan of one application.
    /// </summary>
    /// <remarks>
    /// Runs with nobody's permissions, on purpose. A schedule is a standing instruction rather
    /// than a per-run authorization, and destructive testing and production scanning each need
    /// a person who holds the permission to say so for that run — so an unattended scan refuses
    /// both, by the same check that refuses them to anyone else who does not hold them.
    /// </remarks>
    SecurityScan = 1
}

public class Schedule : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public ScheduleKind Kind { get; set; } = ScheduleKind.TestRun;

    /// <summary>The application to scan. Required for a security schedule, unused otherwise.</summary>
    public Guid? ApplicationId { get; set; }

    public Guid? TestSuiteId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string CronExpression { get; set; } = string.Empty;
    public string TimeZone { get; set; } = "UTC";
    public bool IsEnabled { get; set; } = true;
    public Guid? EnvironmentId { get; set; }
    public BrowserType Browser { get; set; } = BrowserType.Chromium;
    public DateTimeOffset? LastRunAt { get; set; }
    public DateTimeOffset? NextRunAt { get; set; }
    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }

    /// <summary>Only tests carrying one of these tags, comma separated. Empty means all.</summary>
    /// <remarks>
    /// The usual shape of a schedule is "the smoke tests, hourly" and "everything,
    /// nightly", and both are tag selections rather than suites. Suite and tags are
    /// intersected when both are set.
    /// </remarks>
    public string? IncludeTags { get; set; }

    /// <summary>The run this schedule most recently started, so its result is one click away.</summary>
    public Guid? LastRunId { get; set; }

    /// <summary>
    /// How many times in a row starting a run failed.
    /// </summary>
    /// <remarks>
    /// A schedule pointed at a project whose application was deleted fails every hour for
    /// ever, and each failure is a row in the log nobody reads. After enough of them the
    /// schedule disables itself and records why, which turns an endless drip into one
    /// thing to fix.
    /// </remarks>
    public int ConsecutiveFailureCount { get; set; }

    /// <summary>Why the platform disabled this schedule. Null when a person disabled it.</summary>
    public string? DisabledReason { get; set; }
}
