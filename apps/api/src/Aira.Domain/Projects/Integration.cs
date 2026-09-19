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

public class Schedule : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
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
}
