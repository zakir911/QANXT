using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Applications;

/// <summary>A web application under test, together with how to reach it and how far
/// discovery may roam. The allowlist is the primary SSRF control.</summary>
public class Application : BaseEntity, ITenantOwned, IAuditable, ISoftDeletable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Projects.Project? Project { get; set; }

    public string Name { get; set; } = string.Empty;
    public string BaseUrl { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;

    // ---- Crawl boundary -----------------------------------------------------
    /// <summary>Comma-separated hostnames discovery and execution may visit. The base URL's
    /// host is always included. Anything else is refused before a request is made.</summary>
    public string AllowedDomains { get; set; } = string.Empty;
    /// <summary>Comma-separated URL path prefixes that must never be visited (logout, delete, …).</summary>
    public string ExcludedPaths { get; set; } = "/logout,/signout,/delete";

    /// <summary>Routes or absolute URLs to explore in addition to the base URL.
    ///
    /// Discovery can only reach what is linked from where it starts. An application whose
    /// navigation is a client-side router exposes no links to follow, so a crawl of it
    /// finds the landing page and stops however large the budget is. The person who owns
    /// the application knows its routes; this is how they say so, and it needs no clicking
    /// and no guessing.
    ///
    /// Comma or newline separated. Each entry still passes the URL guard, the exclusion
    /// list and robots.txt, exactly as a followed link would.</summary>
    public string SeedUrls { get; set; } = string.Empty;

    /// <summary>Whether discovery reads /sitemap.xml to find routes nothing links to.
    ///
    /// On by default: a sitemap is a list the application publishes about itself, reading
    /// it is a plain GET, and an application that offers one is asking to be crawled from
    /// it.</summary>
    public bool UseSitemap { get; set; } = true;
    public int MaxCrawlDepth { get; set; } = 3;
    public int MaxPages { get; set; } = 50;
    public int MaxActions { get; set; } = 400;
    public int ExplorationTimeoutSeconds { get; set; } = 600;
    public bool RespectRobotsTxt { get; set; } = true;

    // ---- Authentication -----------------------------------------------------
    public AuthenticationStrategy AuthStrategy { get; set; } = AuthenticationStrategy.None;

    /// <summary>How discovery finds pages nothing links to: <c>links</c>, <c>navigation</c>
    /// or <c>interactive</c>.
    ///
    /// Defaults to <c>links</c>, which is what discovery always did. Anything else means the
    /// crawler clicks controls on a running application, and that is a decision somebody has
    /// to make per application rather than inherit.</summary>
    public string InteractionMode { get; set; } = "links";

    /// <summary>Whether the crawler may click controls that look like they change data.
    ///
    /// Off, and meant to stay off anywhere real. The crawler cannot know what a button does
    /// before pressing it, so this is the one thing it must never infer.</summary>
    public bool AllowStateChangingClicks { get; set; }
    public string? LoginUrl { get; set; }
    /// <summary>Declarative login description (selectors/labels for the username, password and
    /// submit controls, plus a success signal). Never contains the credentials themselves.</summary>
    public string? LoginFlowJson { get; set; }
    /// <summary>AES-256-GCM protected credential bundle. Decrypted only inside the worker
    /// dispatch path, never returned to a client and never sent to an LLM.</summary>
    public string? EncryptedCredentials { get; set; }

    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }

    public ICollection<ApplicationPage> Pages { get; set; } = new List<ApplicationPage>();
    public ICollection<DiscoveryRun> DiscoveryRuns { get; set; } = new List<DiscoveryRun>();
    public ICollection<Journey> Journeys { get; set; } = new List<Journey>();
    public ICollection<ApiEndpoint> ApiEndpoints { get; set; } = new List<ApiEndpoint>();
}
