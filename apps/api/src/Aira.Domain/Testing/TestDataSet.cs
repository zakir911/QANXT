using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Testing;

/// <summary>Named data used by test cases. Credentials are never stored here as literals —
/// they are secret references resolved at dispatch time from encrypted storage.</summary>
public class TestDataSet : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public Guid? EnvironmentId { get; set; }
    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }

    public ICollection<TestDataField> Fields { get; set; } = new List<TestDataField>();
}

public class TestDataField : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid TestDataSetId { get; set; }
    public TestDataSet? TestDataSet { get; set; }

    public string Key { get; set; } = string.Empty;
    public TestDataKind Kind { get; set; } = TestDataKind.Static;
    /// <summary>Literal value for static data; a generator expression for generated data;
    /// a secret name for secret references. Null for secret references with no default.</summary>
    public string? Value { get; set; }
    /// <summary>Generator spec, e.g. {"type":"email","domain":"example.test"}.</summary>
    public string? GeneratorJson { get; set; }
    /// <summary>Seed for deterministic generation, so a run is reproducible.</summary>
    public int? Seed { get; set; }
    public bool IsSensitive { get; set; }
}
