using Aira.Domain.Common;

namespace Aira.Domain.Security;

/// <summary>
/// One thing AIRA found, or thinks it found.
/// </summary>
/// <remarks>
/// Status and confidence are separate from severity, and all three are separate from each
/// other, because they answer different questions: what state is this finding in, how sure
/// are we it is real, and how bad would it be if it were. Scanners that collapse them report
/// critical vulnerabilities they merely suspect.
///
/// Nothing reaches <see cref="SecurityFindingStatus.Confirmed"/> without reproduction. The
/// default is <see cref="SecurityFindingStatus.Potential"/> and the word "vulnerability" is
/// not used for anything below Confirmed anywhere it is rendered.
/// </remarks>
public class SecurityFinding : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid ApplicationId { get; set; }
    public Guid? SecurityScanId { get; set; }
    public SecurityScan? SecurityScan { get; set; }

    /// <summary>Stable across scans: the same flaw found again updates this row rather than
    /// creating a second one, which is what makes first-seen, last-seen and regression
    /// meaningful.</summary>
    public string Fingerprint { get; set; } = string.Empty;

    public string Reference { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Category { get; set; } = string.Empty;

    /// <summary>The test that produced it, so a reader can go and look at what ran.</summary>
    public string TestId { get; set; } = string.Empty;

    public string? Endpoint { get; set; }
    public string? HttpMethod { get; set; }
    public string? Parameter { get; set; }
    /// <summary>The synthetic identity the finding was observed as. Never a real account.</summary>
    public string? ObservedAsRole { get; set; }

    public SecuritySeverity Severity { get; set; } = SecuritySeverity.Informational;
    public SecurityConfidence Confidence { get; set; } = SecurityConfidence.Low;
    public SecurityFindingStatus Status { get; set; } = SecurityFindingStatus.Potential;

    /// <summary>The factors the severity was computed from, stored so the number can be
    /// recomputed and argued with rather than taken on trust.</summary>
    public string? SeverityFactorsJson { get; set; }

    /// <summary>CWE identifier, when the evidence supports one. Null rather than a guess.</summary>
    public string? Cwe { get; set; }
    /// <summary>Whether the CWE is asserted or merely indicated.</summary>
    public string? CweConfidence { get; set; }

    public string? OwaspApiCategory { get; set; }
    public string? OwaspWebCategory { get; set; }
    /// <summary>The taxonomy edition in force when this was mapped, preserved so a later
    /// edition does not silently rewrite history.</summary>
    public string? OwaspEdition { get; set; }

    public string Description { get; set; } = string.Empty;
    public string Impact { get; set; } = string.Empty;
    public string Remediation { get; set; } = string.Empty;
    /// <summary>How to see it again, in enough detail that somebody else can.</summary>
    public string ReproductionSteps { get; set; } = string.Empty;

    /// <summary>Where the physical evidence lives, relative to the verification root.</summary>
    public string? EvidencePath { get; set; }

    public DateTimeOffset FirstSeenAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }
    /// <summary>Set when a scan that looked for it could not reproduce it.</summary>
    public DateTimeOffset? ResolvedAt { get; set; }
    /// <summary>Set when a resolved finding came back.</summary>
    public DateTimeOffset? RegressedAt { get; set; }

    /// <summary>Why somebody dismissed or accepted it. Required for either, and audited.</summary>
    public string? DispositionNote { get; set; }
    public Guid? DispositionByUserId { get; set; }
    public DateTimeOffset? DispositionAt { get; set; }

    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
}

/// <summary>One execution of the security engine against one application.</summary>
public class SecurityScan : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid ApplicationId { get; set; }
    public Guid? EnvironmentId { get; set; }

    public string Reference { get; set; } = string.Empty;
    public SecurityProfile Profile { get; set; } = SecurityProfile.Passive;
    public string Status { get; set; } = "running";

    /// <summary>Copied from the scope at the moment the scan started, so a report can say
    /// what was authorized then rather than what the scope says now.</summary>
    public string? ScopeSnapshotJson { get; set; }
    public string? AuthorizationNote { get; set; }

    public int RequestsIssued { get; set; }
    public int RequestsBlocked { get; set; }
    public int TestsExecuted { get; set; }
    public int TestsSkipped { get; set; }

    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public int DurationMs { get; set; }

    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }

    public ICollection<SecurityFinding> Findings { get; set; } = new List<SecurityFinding>();
}

/// <summary>A security request the scope guard refused, kept so a scan can say what it did
/// not do and why.</summary>
/// <remarks>
/// Coverage is only meaningful alongside this. "No findings" from a scan that was refused
/// two hundred requests is a different statement from "no findings" from one that issued
/// them all, and a report that cannot tell them apart is misleading in the most dangerous
/// direction.
/// </remarks>
public class SecurityBlockedRequest : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid SecurityScanId { get; set; }
    public string Url { get; set; } = string.Empty;
    public string HttpMethod { get; set; } = string.Empty;
    public SecurityRisk Risk { get; set; }
    public SecurityDenialReason Reason { get; set; }
    public string Explanation { get; set; } = string.Empty;
    public string? TestId { get; set; }
    public Guid? UserId { get; set; }
    public DateTimeOffset OccurredAt { get; set; }
}
