using Aira.Domain.Enums;

namespace Aira.Application.Security;

/// <summary>The complete capability vocabulary. Endpoints reference these constants;
/// nothing authorizes on a role name, so adding a custom role never requires a code change.</summary>
public static class Permissions
{
    public const string OrganizationRead = "organization:read";
    public const string OrganizationWrite = "organization:write";
    public const string UserRead = "user:read";
    public const string UserWrite = "user:write";
    public const string RoleWrite = "role:write";

    public const string ProjectRead = "project:read";
    public const string ProjectWrite = "project:write";
    public const string ProjectDelete = "project:delete";

    public const string ApplicationRead = "application:read";
    public const string ApplicationWrite = "application:write";
    public const string DiscoveryRun = "discovery:run";

    public const string TestRead = "test:read";
    public const string TestWrite = "test:write";
    public const string TestDelete = "test:delete";
    public const string TestGenerate = "test:generate";

    public const string ExecutionRead = "execution:read";
    public const string ExecutionRun = "execution:run";
    public const string ExecutionCancel = "execution:cancel";
    /// <summary>Required, in addition to a project opt-in, before executeScript is allowed.</summary>
    public const string ExecutionScript = "execution:script";

    public const string ArtifactRead = "artifact:read";
    public const string FailureRead = "failure:read";

    public const string HealingRead = "healing:read";
    public const string HealingApprove = "healing:approve";

    public const string DefectRead = "defect:read";
    public const string DefectWrite = "defect:write";

    public const string IntegrationRead = "integration:read";
    public const string IntegrationWrite = "integration:write";
    public const string SecretWrite = "secret:write";
    public const string QualityGateWrite = "qualitygate:write";

    public const string AiUse = "ai:use";
    public const string AgentRun = "agent:run";
    public const string AuditRead = "audit:read";
    public const string DashboardRead = "dashboard:read";

    public static IReadOnlyList<(string Name, string Category, string Description)> All { get; } = new List<(string, string, string)>
    {
        (OrganizationRead, "Organization", "View organization settings"),
        (OrganizationWrite, "Organization", "Change organization settings"),
        (UserRead, "Organization", "View users"),
        (UserWrite, "Organization", "Invite, update and disable users"),
        (RoleWrite, "Organization", "Assign roles"),
        (ProjectRead, "Project", "View projects"),
        (ProjectWrite, "Project", "Create and update projects"),
        (ProjectDelete, "Project", "Delete projects"),
        (ApplicationRead, "Application", "View applications and the knowledge graph"),
        (ApplicationWrite, "Application", "Create and update applications"),
        (DiscoveryRun, "Application", "Start application discovery"),
        (TestRead, "Testing", "View suites, cases and steps"),
        (TestWrite, "Testing", "Create and edit tests"),
        (TestDelete, "Testing", "Delete tests"),
        (TestGenerate, "Testing", "Generate tests with AI"),
        (ExecutionRead, "Execution", "View runs and executions"),
        (ExecutionRun, "Execution", "Start test runs"),
        (ExecutionCancel, "Execution", "Cancel running executions"),
        (ExecutionScript, "Execution", "Permit executeScript actions"),
        (ArtifactRead, "Evidence", "View and download evidence"),
        (FailureRead, "Evidence", "View failures and analyses"),
        (HealingRead, "Healing", "View healing proposals"),
        (HealingApprove, "Healing", "Approve or reject healing proposals"),
        (DefectRead, "Defects", "View defects"),
        (DefectWrite, "Defects", "Create and update defects"),
        (IntegrationRead, "Integrations", "View integrations"),
        (IntegrationWrite, "Integrations", "Configure integrations"),
        (SecretWrite, "Security", "Configure credentials and secrets"),
        (QualityGateWrite, "Quality", "Configure quality gates"),
        (AiUse, "AI", "Use AI features"),
        (AgentRun, "AI", "Run the autonomous agent"),
        (AuditRead, "Security", "Read the audit log"),
        (DashboardRead, "Quality", "View dashboards and reports")
    };
}

/// <summary>Which capabilities each built-in role carries. Kept in one place so the
/// matrix can be reviewed as a whole and asserted in tests.</summary>
public static class RolePermissionMatrix
{
    private static readonly string[] ViewerSet =
    {
        Permissions.ProjectRead, Permissions.ApplicationRead, Permissions.TestRead,
        Permissions.ExecutionRead, Permissions.ArtifactRead, Permissions.FailureRead,
        Permissions.HealingRead, Permissions.DefectRead, Permissions.DashboardRead
    };

    private static readonly string[] DeveloperSet = ViewerSet
        .Concat(new[] { Permissions.DefectWrite, Permissions.ExecutionRun, Permissions.IntegrationRead }).ToArray();

    private static readonly string[] QaEngineerSet = DeveloperSet
        .Concat(new[]
        {
            Permissions.TestWrite, Permissions.TestGenerate, Permissions.ExecutionCancel,
            Permissions.DiscoveryRun, Permissions.AiUse
        }).ToArray();

    private static readonly string[] QaLeadSet = QaEngineerSet
        .Concat(new[]
        {
            Permissions.TestDelete, Permissions.HealingApprove, Permissions.ApplicationWrite,
            Permissions.QualityGateWrite, Permissions.AgentRun, Permissions.UserRead
        }).ToArray();

    private static readonly string[] ProjectAdminSet = QaLeadSet
        .Concat(new[]
        {
            Permissions.ProjectWrite, Permissions.IntegrationWrite, Permissions.SecretWrite,
            Permissions.ExecutionScript, Permissions.AuditRead
        }).ToArray();

    private static readonly string[] OrganizationAdminSet = ProjectAdminSet
        .Concat(new[]
        {
            Permissions.OrganizationRead, Permissions.OrganizationWrite, Permissions.UserWrite,
            Permissions.RoleWrite, Permissions.ProjectDelete
        }).ToArray();

    public static IReadOnlyCollection<string> For(SystemRole role) => role switch
    {
        SystemRole.SuperAdmin => Permissions.All.Select(p => p.Name).ToArray(),
        SystemRole.OrganizationAdmin => OrganizationAdminSet.Distinct().ToArray(),
        SystemRole.ProjectAdmin => ProjectAdminSet.Distinct().ToArray(),
        SystemRole.QaLead => QaLeadSet.Distinct().ToArray(),
        SystemRole.QaEngineer => QaEngineerSet.Distinct().ToArray(),
        SystemRole.Developer => DeveloperSet.Distinct().ToArray(),
        SystemRole.Viewer => ViewerSet.Distinct().ToArray(),
        _ => Array.Empty<string>()
    };

    public static string DescriptionOf(SystemRole role) => role switch
    {
        SystemRole.SuperAdmin => "Platform operator. Every capability, across every organization.",
        SystemRole.OrganizationAdmin => "Owns an organization: users, roles, projects and billing-relevant settings.",
        SystemRole.ProjectAdmin => "Owns a project: configuration, integrations, secrets and quality gates.",
        SystemRole.QaLead => "Leads quality for a project: approves healing, owns suites and the agent.",
        SystemRole.QaEngineer => "Authors and runs tests, uses AI generation, starts discovery.",
        SystemRole.Developer => "Runs tests and works defects; cannot change test definitions.",
        SystemRole.Viewer => "Read-only access to results, evidence and dashboards.",
        _ => string.Empty
    };
}
