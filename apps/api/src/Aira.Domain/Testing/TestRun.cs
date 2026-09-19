using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Testing;

/// <summary>One invocation of a suite (or an ad-hoc selection) against one environment.</summary>
public class TestRun : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid? TestSuiteId { get; set; }
    public Guid? EnvironmentId { get; set; }

    public string Name { get; set; } = string.Empty;
    public RunTrigger Trigger { get; set; } = RunTrigger.Manual;
    public BrowserType Browser { get; set; } = BrowserType.Chromium;
    public bool Headless { get; set; } = true;
    public int Parallelism { get; set; } = 1;
    public int MaxRetries { get; set; } = 1;
    public ExecutionStatus Status { get; set; } = ExecutionStatus.Queued;

    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public int DurationMs { get; set; }

    public int TotalCount { get; set; }
    public int PassedCount { get; set; }
    public int FailedCount { get; set; }
    public int SkippedCount { get; set; }
    public int BlockedCount { get; set; }
    public int HealedCount { get; set; }
    public int FlakyCount { get; set; }

    /// <summary>Null until the run completes and the gates are evaluated.</summary>
    public bool? QualityGatePassed { get; set; }
    public string? QualityGateSummaryJson { get; set; }

    // ---- CI/CD provenance ----------------------------------------------------
    public string? CiProvider { get; set; }
    public string? CiBuildId { get; set; }
    public string? CiCommitSha { get; set; }
    public string? CiBranch { get; set; }
    /// <summary>Build identifier of the application under test, used for change correlation.</summary>
    public string? ApplicationBuildRef { get; set; }

    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }

    public ICollection<TestExecution> Executions { get; set; } = new List<TestExecution>();
}
