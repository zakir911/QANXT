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

    /// <summary>Why this scan has no result, when it has none. Null on a scan that reported.</summary>
    /// <remarks>
    /// A scan the platform gave up on still has to say so in words. "Abandoned" as a bare status
    /// reads as a shrug, and whoever opens it needs to know that the reason lies with the worker
    /// rather than with the application it was pointed at.
    /// </remarks>
    public string? ErrorMessage { get; set; }

    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }

    public ICollection<SecurityFinding> Findings { get; set; } = new List<SecurityFinding>();
}

/// <summary>
/// What one scan reported about one finding.
/// </summary>
/// <remarks>
/// <para>
/// A finding is a flaw, which outlives the scans that see it: it is fingerprinted per
/// application so the same flaw found again updates one row rather than multiplying. That
/// makes the finding table a record of the present, and it cannot also be the record of what
/// a particular scan reported.
/// </para>
/// <para>
/// Without this table, "the findings of scan X" has to be read as "findings whose last
/// sighting was scan X" — so the moment a second scan sees the same flaw, the first scan's
/// stored result empties out and reads as a clean run. That is the single most dangerous way
/// for a security record to be wrong, and it happens silently and with age.
/// </para>
/// <para>
/// Severity and confidence are copied here as that scan reported them. The finding row carries
/// the latest assessment, which is the right answer to "how bad is this now" and the wrong
/// answer to "what did that scan say" — a flaw reassessed from Medium to Critical must not
/// retroactively make an old report say Critical.
/// </para>
/// </remarks>
public class SecurityScanFinding : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid SecurityScanId { get; set; }
    public SecurityScan? SecurityScan { get; set; }
    public Guid SecurityFindingId { get; set; }
    public SecurityFinding? SecurityFinding { get; set; }

    /// <summary>As this scan reported them, not as the finding stands now.</summary>
    public SecuritySeverity Severity { get; set; } = SecuritySeverity.Informational;
    public SecurityConfidence Confidence { get; set; } = SecurityConfidence.Low;

    /// <summary>True when this scan was the first to see it.</summary>
    public bool WasNew { get; set; }
    /// <summary>True when this scan saw something return that had been resolved.</summary>
    public bool WasRegression { get; set; }

    public DateTimeOffset ReportedAt { get; set; }
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
