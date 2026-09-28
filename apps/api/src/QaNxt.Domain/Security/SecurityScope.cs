using QaNxt.Domain.Common;

namespace QaNxt.Domain.Security;

/// <summary>
/// What an application has authorized QA NXT to do to it.
/// </summary>
/// <remarks>
/// Every field here is a permission, not a preference, and the defaults are the refusing
/// ones. An application with no scope row is not testable: absence is read as "nobody has
/// authorized this", never as "no restrictions apply". That is the one design decision in
/// this file that the rest depends on.
///
/// It is deliberately separate from <see cref="Applications.Application"/>'s crawl settings.
/// Those bound a crawl for politeness and cost; this bounds what the platform is permitted
/// to attempt, and the two should not be edited by the same person for the same reasons.
/// </remarks>
public class SecurityScope : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ApplicationId { get; set; }
    public Applications.Application? Application { get; set; }

    /// <summary>False disables all security testing for this application. Default false:
    /// a scope row that exists but has not been turned on authorizes nothing.</summary>
    public bool Enabled { get; set; }

    /// <summary>Hosts the security engine may address for web requests. Comma separated.
    /// Empty means none — not "any".</summary>
    public string AllowedDomains { get; set; } = string.Empty;

    /// <summary>Hosts the security engine may address for API requests, when the API is
    /// served from somewhere other than the application. Empty falls back to
    /// <see cref="AllowedDomains"/>.</summary>
    public string AllowedApiDomains { get; set; } = string.Empty;

    /// <summary>Path patterns the engine may touch, comma separated, <c>*</c> matching a
    /// trailing segment: <c>/login,/dashboard,/api/*</c>. Empty means every path under an
    /// allowed domain, which is a deliberate convenience for a lab and should be narrowed
    /// for anything real.</summary>
    public string AllowedPaths { get; set; } = string.Empty;

    /// <summary>Paths the engine must never touch, whatever else allows them. Checked after
    /// <see cref="AllowedPaths"/> and wins over it.</summary>
    public string BlockedPaths { get; set; } = string.Empty;

    /// <summary>The environment this scope authorizes. A scan asking for a different one is
    /// refused rather than silently retargeted.</summary>
    public Guid? EnvironmentId { get; set; }
    public Projects.Environment? Environment { get; set; }

    public int MaxRequestsPerSecond { get; set; } = 5;
    public int MaxConcurrentRequests { get; set; } = 2;
    public int MaxScanDurationMinutes { get; set; } = 30;

    /// <summary>Whether the engine may send input the application did not ask for. False
    /// leaves only passive observation.</summary>
    public bool AllowActiveTesting { get; set; }

    /// <summary>Whether the engine may attempt something it cannot assume is reversible.
    /// Cannot be true while <see cref="AllowProduction"/> is true.</summary>
    public bool AllowDestructiveTesting { get; set; }

    /// <summary>Whether this scope authorizes testing a production environment at all.
    /// False by default, and even true only permits the passive profile unless active
    /// testing is separately authorized.</summary>
    public bool AllowProduction { get; set; }

    /// <summary>Who authorized this, in their own words. Required to enable the scope, and
    /// carried into the audit record and every report the scope produces — a scan nobody
    /// can point at a written authorization for is one nobody should have run.</summary>
    public string? AuthorizationNote { get; set; }
    public Guid? AuthorizedByUserId { get; set; }
    public DateTimeOffset? AuthorizedAt { get; set; }

    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
}
