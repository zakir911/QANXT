using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Applications;

public class DiscoveryRun : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid ApplicationId { get; set; }
    public Application? Application { get; set; }

    public DiscoveryStatus Status { get; set; } = DiscoveryStatus.Queued;
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>Frozen copy of the crawl budget actually used, so a later configuration
    /// change cannot make a historical run unexplainable.</summary>
    public int MaxDepth { get; set; }
    public int MaxPages { get; set; }
    public int TimeoutSeconds { get; set; }
    public BrowserType Browser { get; set; } = BrowserType.Chromium;

    public int PagesDiscovered { get; set; }
    public int ElementsDiscovered { get; set; }
    public int ApiEndpointsDiscovered { get; set; }
    public int JourneysDiscovered { get; set; }
    public int ConsoleErrorCount { get; set; }
    public int PagesBlockedByPolicy { get; set; }

    public string? ErrorMessage { get; set; }
    /// <summary>Human-readable progress log; secrets are masked before it is written.</summary>
    public string? ProgressLog { get; set; }
    public string? WorkerId { get; set; }
    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
}
