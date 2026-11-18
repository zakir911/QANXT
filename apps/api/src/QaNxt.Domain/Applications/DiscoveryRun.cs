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

    /// <summary>
    /// How many clicks the crawl was allowed, frozen like the other three.
    ///
    /// It was the one budget dimension read live from the application instead of recorded
    /// here, and it is the one that binds in navigation mode: a crawl of a 137-screen
    /// application stopped at 69 pages on "the 400-action budget was reached" with 88 of its
    /// 900 seconds still unspent. Nothing on the run said what that budget had been, so the
    /// run could not explain its own outcome — which is the thing freezing the budget exists
    /// to prevent, and the comment saying so was already in DiscoveryService.
    /// </summary>
    public int MaxActions { get; set; }
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

    /// <summary>
    /// Whether this run has been going longer than it was ever allowed to, so nobody is
    /// coming back to finish it.
    ///
    /// The grace period is counted ON TOP OF the run's own budget. The sweep that ends
    /// stranded runs used a fixed fifteen minutes regardless of what the run was allowed to
    /// take, so an application configured with a 900-second exploration budget — fifteen
    /// minutes, and it is settable up to two hours — had its crawls marked Failed at the
    /// moment they were legitimately finishing. Observed on a 137-screen application: the
    /// crawl mapped 152 pages, uploaded its artifacts, and its completion landed on a run
    /// already declared stranded, carrying a message that told the reader to go and look at
    /// a worker which had done nothing wrong. Three earlier runs with the same budget
    /// survived only because their completion beat the next one-minute sweep.
    ///
    /// The default budget is 600 seconds, inside the default grace, which is why every
    /// untouched configuration hides this.
    ///
    /// Queued counts as well as Running: a run queued while no worker exists never gets a
    /// StartedAt, so measuring from CreatedAt is what stops it sitting there for ever.
    /// </summary>
    /// <param name="now">The current time.</param>
    /// <param name="grace">How long past its own budget a run may go before nobody is
    /// expected to come back for it.</param>
    public bool IsStranded(DateTimeOffset now, TimeSpan grace)
    {
        if (Status is not (DiscoveryStatus.Running or DiscoveryStatus.Queued)) return false;
        var allowed = TimeSpan.FromSeconds(Math.Max(0, TimeoutSeconds)) + grace;
        return now - (StartedAt ?? CreatedAt) > allowed;
    }
}
