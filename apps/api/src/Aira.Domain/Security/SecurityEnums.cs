namespace Aira.Domain.Security;

/// <summary>How much a security request is allowed to disturb the application under test.</summary>
/// <remarks>
/// The ladder is the point: each rung needs something the rung below did not, and the scope
/// has to say yes explicitly. Nothing infers permission from the absence of a prohibition.
/// </remarks>
public enum SecurityRisk
{
    /// <summary>Reads something already being served. A GET of a page the crawler visited,
    /// a response header, a cookie attribute. Runs under a passive scan.</summary>
    Passive = 0,

    /// <summary>Sends input the application did not ask for, but changes no state: a marker
    /// string in a query parameter, a request with a missing token, an OPTIONS probe.
    /// Needs <c>AllowActiveTesting</c>.</summary>
    Active = 1,

    /// <summary>Changes state that can be undone or that only touches synthetic data: a
    /// POST creating a test record, an upload of a harmless file. Needs
    /// <c>AllowActiveTesting</c> and applies only to synthetic fixtures.</summary>
    StateChanging = 2,

    /// <summary>Changes state that cannot be assumed reversible: DELETE, a destructive
    /// database operation, anything that removes data. Needs <c>AllowDestructiveTesting</c>,
    /// which is false by default and cannot be set on a production environment.</summary>
    Destructive = 3
}

/// <summary>Which security tests a scan is permitted to run.</summary>
public enum SecurityProfile
{
    /// <summary>Observation only. Nothing that is not already being served.</summary>
    Passive = 0,
    /// <summary>The ordinary controlled checks.</summary>
    Standard = 1,
    /// <summary>Expanded testing, where the scope has authorized it.</summary>
    Deep = 2,
    /// <summary>Only the tests derived from findings already confirmed on this application.</summary>
    Regression = 3,
    /// <summary>Whatever the caller's own policy names.</summary>
    Custom = 4
}

/// <summary>Why a security request was refused. Recorded rather than reduced to a boolean,
/// because "we did not test that" and "we were not allowed to test that" are different
/// answers and a coverage report has to be able to tell them apart.</summary>
public enum SecurityDenialReason
{
    None = 0,
    ScopeMissing = 1,
    ScopeDisabled = 2,
    DomainNotAllowed = 3,
    PathNotAllowed = 4,
    PathBlocked = 5,
    MethodNotAllowed = 6,
    ActiveTestingNotAllowed = 7,
    DestructiveTestingNotAllowed = 8,
    ProductionNotAuthorized = 9,
    RateLimitExceeded = 10,
    ConcurrencyLimitExceeded = 11,
    ScanDurationExceeded = 12,
    PermissionDenied = 13,
    UrlRefusedByTargetPolicy = 14,
    ProfileDoesNotPermit = 15
}

/// <summary>What a security finding is, in the terms a reader needs before anything else.</summary>
public enum SecurityFindingStatus
{
    /// <summary>Detected, not yet verified. Never reported as a vulnerability.</summary>
    Potential = 0,
    /// <summary>Reproduced independently, with evidence.</summary>
    Confirmed = 1,
    /// <summary>Examined and found not to be a problem.</summary>
    FalsePositive = 2,
    /// <summary>A person has to decide.</summary>
    NeedsReview = 3,
    /// <summary>Confirmed, then a later scan could not reproduce it.</summary>
    Resolved = 4,
    /// <summary>Resolved, then a later scan reproduced it again.</summary>
    Regressed = 5,
    /// <summary>A person judged it acceptable. Requires a reason and is audited.</summary>
    Accepted = 6
}

public enum SecuritySeverity
{
    Informational = 0,
    Low = 1,
    Medium = 2,
    High = 3,
    Critical = 4
}

/// <summary>How much the platform trusts its own detection.</summary>
/// <remarks>
/// Kept separate from severity on purpose. "How bad would this be" and "how sure are we it
/// is real" are independent, and collapsing them into one number is how scanners end up
/// reporting a critical vulnerability they merely suspect.
/// </remarks>
public enum SecurityConfidence
{
    /// <summary>A single indicator, no reproduction.</summary>
    Low = 0,
    /// <summary>Reproduced, or corroborated by a second independent signal.</summary>
    Medium = 1,
    /// <summary>Reproduced with evidence that admits no other reading.</summary>
    High = 2
}
