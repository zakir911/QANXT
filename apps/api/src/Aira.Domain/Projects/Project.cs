using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Projects;

public class Project : BaseEntity, ITenantOwned, IAuditable, ISoftDeletable
{
    public Guid OrganizationId { get; set; }
    public Identity.Organization? Organization { get; set; }

    public string Name { get; set; } = string.Empty;
    public string Key { get; set; } = string.Empty;          // short, unique per org; used by the CLI
    public string Description { get; set; } = string.Empty;

    // ---- Execution defaults -------------------------------------------------
    public BrowserType DefaultBrowser { get; set; } = BrowserType.Chromium;
    public int DefaultRetries { get; set; } = 1;
    public int MaxParallelExecutions { get; set; } = 2;
    public int DefaultActionTimeoutMs { get; set; } = 15000;
    public bool CaptureVideo { get; set; } = true;
    public bool CaptureTrace { get; set; } = true;
    public bool CaptureHar { get; set; } = true;

    // ---- Self-healing policy ------------------------------------------------
    public HealingPolicy HealingPolicy { get; set; } = HealingPolicy.Suggest;
    /// <summary>0-100. Candidates scoring below this are never used, whatever the policy.</summary>
    public int HealingConfidenceThreshold { get; set; } = 85;

    /// <summary>What the quality gate does about a test that only passed because a locator
    /// was repaired. Defaults to PassWithWarning: a healed run is a pass, and it is never
    /// silent about it.</summary>
    public SelfHealingGatePolicy SelfHealingGatePolicy { get; set; } = SelfHealingGatePolicy.PassWithWarning;

    // ---- AI configuration ---------------------------------------------------
    public LlmProviderKind AiProvider { get; set; } = LlmProviderKind.Local;
    public string? AiModel { get; set; }
    public bool AiEnabled { get; set; } = true;

    // ---- Safety -------------------------------------------------------------
    /// <summary>Scripting is off unless a project deliberately turns it on.</summary>
    public bool AllowScriptExecution { get; set; }

    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }

    public ICollection<Applications.Application> Applications { get; set; } = new List<Applications.Application>();
    public ICollection<Environment> Environments { get; set; } = new List<Environment>();
    public ICollection<Testing.TestSuite> TestSuites { get; set; } = new List<Testing.TestSuite>();
    public ICollection<QualityGateRule> QualityGateRules { get; set; } = new List<QualityGateRule>();
    public ICollection<Identity.ProjectMember> Members { get; set; } = new List<Identity.ProjectMember>();
}
