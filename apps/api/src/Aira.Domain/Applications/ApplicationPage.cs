using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Applications;

/// <summary>A node in the application knowledge graph. Identity is the normalized URL,
/// so re-running discovery updates a page rather than duplicating it.</summary>
public class ApplicationPage : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ApplicationId { get; set; }
    public Application? Application { get; set; }
    public Guid? DiscoveryRunId { get; set; }

    public string Url { get; set; } = string.Empty;
    /// <summary>Query values and numeric path ids replaced by placeholders so that
    /// /accounts/1 and /accounts/2 collapse to one page node.</summary>
    public string NormalizedUrl { get; set; } = string.Empty;
    public string Route { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public PageKind Kind { get; set; } = PageKind.Unknown;

    public int Depth { get; set; }
    public Guid? ParentPageId { get; set; }
    public ApplicationPage? ParentPage { get; set; }

    public bool RequiresAuthentication { get; set; }
    public int? HttpStatus { get; set; }
    public int LoadTimeMs { get; set; }
    public int ElementCount { get; set; }
    public int ConsoleErrorCount { get; set; }

    /// <summary>Storage key of the page screenshot in the artifact store.</summary>
    public string? ScreenshotArtifactKey { get; set; }
    /// <summary>Storage key of the captured DOM snapshot (masked).</summary>
    public string? DomArtifactKey { get; set; }
    /// <summary>Storage key of the captured accessibility tree.</summary>
    public string? AccessibilityArtifactKey { get; set; }
    /// <summary>Condensed visible text used for semantic matching and AI context (masked, truncated).</summary>
    public string? VisibleTextExcerpt { get; set; }

    public DateTimeOffset LastSeenAt { get; set; }

    public ICollection<ApplicationElement> Elements { get; set; } = new List<ApplicationElement>();
    public ICollection<PageTransition> OutgoingTransitions { get; set; } = new List<PageTransition>();
}

/// <summary>A directed edge in the knowledge graph: performing an action on one page
/// leads to another page.</summary>
public class PageTransition : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ApplicationId { get; set; }
    public Guid FromPageId { get; set; }
    public ApplicationPage? FromPage { get; set; }
    public Guid ToPageId { get; set; }
    public ApplicationPage? ToPage { get; set; }
    public Guid? TriggerElementId { get; set; }
    public BrowserActionType Action { get; set; } = BrowserActionType.Click;
    public int TimesObserved { get; set; } = 1;
}
