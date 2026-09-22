using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Projects;

/// <summary>A deployment of the application under test (QA, staging, …). Environment
/// variables are stored as an encrypted JSON blob when they hold secrets.</summary>
public class Environment : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Project? Project { get; set; }

    public string Name { get; set; } = string.Empty;
    /// <summary>Short, unique within the project; what `--environment` takes.</summary>
    public string Key { get; set; } = string.Empty;
    public EnvironmentKind Kind { get; set; } = EnvironmentKind.Development;

    public string BaseUrl { get; set; } = string.Empty;
    /// <summary>Where the API lives when it is not served from the same origin as the UI.</summary>
    public string? ApiBaseUrl { get; set; }

    public bool IsProduction { get; set; }

    /// <summary>Testing a production environment needs this set deliberately, per
    /// environment, on top of the environment being marked production. Two switches rather
    /// than one, because the cost of getting this wrong is paid by real customers.</summary>
    public bool ProductionTestingAuthorized { get; set; }
    public string? ProductionAuthorizationNote { get; set; }
    public Guid? ProductionAuthorizedByUserId { get; set; }
    public DateTimeOffset? ProductionAuthorizedAt { get; set; }

    /// <summary>Comma-separated hosts this environment may reach, on top of the
    /// application's own allowlist. Narrowing, never widening.</summary>
    public string? AllowedDomains { get; set; }

    /// <summary>Requests per minute AIRA will make of this environment. Zero means the
    /// platform default.</summary>
    public int RateLimitPerMinute { get; set; }

    public bool IsEnabled { get; set; } = true;
    /// <summary>Production environments refuse destructive test data operations by default.</summary>
    public bool AllowDestructiveTests { get; set; }
    public string? VariablesJson { get; set; }
    public string? EncryptedSecretsJson { get; set; }
}
