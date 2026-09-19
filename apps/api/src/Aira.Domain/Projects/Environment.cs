using Aira.Domain.Common;

namespace Aira.Domain.Projects;

/// <summary>A deployment of the application under test (QA, staging, …). Environment
/// variables are stored as an encrypted JSON blob when they hold secrets.</summary>
public class Environment : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Project? Project { get; set; }

    public string Name { get; set; } = string.Empty;
    public string BaseUrl { get; set; } = string.Empty;
    public bool IsProduction { get; set; }
    /// <summary>Production environments refuse destructive test data operations by default.</summary>
    public bool AllowDestructiveTests { get; set; }
    public string? VariablesJson { get; set; }
    public string? EncryptedSecretsJson { get; set; }
}
