using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Testing;

public class Assertion : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid TestStepId { get; set; }
    public TestStep? TestStep { get; set; }

    public AssertionType Type { get; set; }
    public string? TargetJson { get; set; }
    public string? ExpectedValue { get; set; }
    public string? AttributeName { get; set; }
    public bool Negate { get; set; }
    public string Description { get; set; } = string.Empty;
    /// <summary>A soft assertion records a failure but lets the case continue.</summary>
    public bool IsSoft { get; set; }
}
