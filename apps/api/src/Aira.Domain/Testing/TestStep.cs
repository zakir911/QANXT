using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Testing;

/// <summary>One validated browser action plus its locator history. The target is stored
/// as the platform's locator grammar (a JSON object), never as a raw CSS string only.</summary>
public class TestStep : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid TestCaseId { get; set; }
    public TestCase? TestCase { get; set; }

    public int Order { get; set; }
    public string Description { get; set; } = string.Empty;
    public BrowserActionType Action { get; set; }

    /// <summary>Serialized <c>LocatorDescriptor</c>: strategy + value + fallbacks.</summary>
    public string? TargetJson { get; set; }
    /// <summary>Literal value, or a <c>${secret:name}</c> / <c>${data:field}</c> reference.
    /// Literal credentials are rejected at validation time.</summary>
    public string? Value { get; set; }
    public string? Url { get; set; }
    public int? TimeoutMs { get; set; }
    /// <summary>A failure here blocks the rest of the case rather than merely failing this step.</summary>
    public bool IsCritical { get; set; } = true;
    public bool ContinueOnFailure { get; set; }

    /// <summary>Set when a healing proposal for this step has been approved and applied.</summary>
    public Guid? HealedFromStepVersionId { get; set; }
    public int HealCount { get; set; }

    public ICollection<Assertion> Assertions { get; set; } = new List<Assertion>();
    public ICollection<Diagnosis.LocatorCandidate> LocatorCandidates { get; set; } = new List<Diagnosis.LocatorCandidate>();
}
