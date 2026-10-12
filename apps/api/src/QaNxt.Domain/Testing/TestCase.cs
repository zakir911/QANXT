using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Testing;

/// <summary>An executable test. Every field the product promises on a generated test
/// (objective, preconditions, data, expected results, priority, risk, tags) is first-class,
/// not buried in free text.</summary>
public class TestCase : BaseEntity, ITenantOwned, IAuditable, ISoftDeletable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid TestSuiteId { get; set; }
    public TestSuite? TestSuite { get; set; }
    public Guid? ApplicationId { get; set; }
    public Guid? JourneyId { get; set; }

    /// <summary>Human-facing stable identifier, e.g. "TC-LOGIN-004".</summary>
    public string Reference { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Objective { get; set; } = string.Empty;
    public string Preconditions { get; set; } = string.Empty;
    public string ExpectedResults { get; set; } = string.Empty;

    /// <summary>Whether this test drives a UI, calls an API, or both. An API test is a
    /// test case like any other — same suites, runs, evidence and gates — but a run needs
    /// to count API failures separately, and a regression selector needs to know which
    /// tests need no browser.</summary>
    public TestCaseKind Kind { get; set; } = TestCaseKind.Ui;

    public TestPriority Priority { get; set; } = TestPriority.Medium;
    public RiskLevel Risk { get; set; } = RiskLevel.Medium;
    public string Tags { get; set; } = string.Empty;
    public TestCaseSource Source { get; set; } = TestCaseSource.Manual;
    public bool IsEnabled { get; set; } = true;

    /// <summary>Set when the case was AI-generated, so provenance is auditable.</summary>
    public Guid? GeneratedByAiRequestId { get; set; }
    /// <summary>Natural-language requirement this case traces back to.</summary>
    public string? RequirementReference { get; set; }

    public Guid? TestDataSetId { get; set; }
    public TestDataSet? TestDataSet { get; set; }

    /// <summary>Bumped whenever steps change; executions record the version they ran.</summary>
    public int Version { get; set; } = 1;

    // ---- Taxonomy and form coverage -------------------------------------------
    /// <summary>The QA category this test's oracle checks. Null for tests written before
    /// the taxonomy existed, which coverage counts as uncategorised rather than guessing.</summary>
    public TestCategory? Category { get; set; }
    /// <summary>The technique within the category, e.g. "boundary:max+1" or "required:each".</summary>
    public string? Technique { get; set; }
    public TestCaseLifecycle Lifecycle { get; set; } = TestCaseLifecycle.Active;
    public AutomationStatus AutomationStatus { get; set; } = AutomationStatus.Automated;
    /// <summary>The discovered form this test exercises, when it exercises one.</summary>
    public Guid? ApplicationFormId { get; set; }
    /// <summary>The field the test is about, when it is about one field.</summary>
    public string? FieldKey { get; set; }
    /// <summary>What this test covers, as coverage keys: form, field, rule, boundary, state.</summary>
    public string? CoverageKeysJson { get; set; }
    /// <summary>The inputs the test uses, for a reviewer. The steps carry the same values.</summary>
    public string? TestDataJson { get; set; }
    public string? EvidenceRequirements { get; set; }
    /// <summary>A generated test's stable identity. Regenerating updates the test with the
    /// same key rather than adding a duplicate, so its history survives re-discovery.</summary>
    public string? GenerationKey { get; set; }
    /// <summary>The defect this regression test was made from.</summary>
    public Guid? SourceDefectId { get; set; }

    // ---- Rolling quality statistics (maintained by the execution pipeline) ----
    public int ExecutionCount { get; set; }
    public int PassCount { get; set; }
    public int FailCount { get; set; }
    public int HealCount { get; set; }
    /// <summary>0-100 measure of result instability over the recent window.</summary>
    public int FlakinessScore { get; set; }
    public DateTimeOffset? LastExecutedAt { get; set; }
    public ExecutionStatus? LastStatus { get; set; }
    public int AverageDurationMs { get; set; }

    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }

    public ICollection<TestStep> Steps { get; set; } = new List<TestStep>();
}
