using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Applications;

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
    public int MaxCrawlDepth { get; set; } = 3;
    public int MaxPages { get; set; } = 50;
    public int MaxActions { get; set; } = 400;
    public int ExplorationTimeoutSeconds { get; set; } = 600;
    public bool RespectRobotsTxt { get; set; } = true;

    // ---- Authentication -----------------------------------------------------
    public AuthenticationStrategy AuthStrategy { get; set; } = AuthenticationStrategy.None;
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
