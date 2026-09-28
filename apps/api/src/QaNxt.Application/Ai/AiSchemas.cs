using System.Text.Json.Serialization;
using QaNxt.Domain.Enums;

namespace QaNxt.Application.Ai;

/// <summary>The structured shapes models must produce.
///
/// Free-form prose from a model is not something the platform can execute, audit or trust.
/// Every generation task therefore declares a schema; the response is validated against it
/// and rejected if it does not fit. These records are the C# side of that contract, and
/// <see cref="AiSchemaCatalog"/> holds the JSON Schema sent to the provider.</summary>

public sealed record GeneratedTestPlan
{
    [JsonPropertyName("summary")] public string Summary { get; init; } = string.Empty;
    [JsonPropertyName("scenarios")] public List<GeneratedScenario> Scenarios { get; init; } = new();
}

public sealed record GeneratedScenario
{
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    [JsonPropertyName("objective")] public string Objective { get; init; } = string.Empty;
    [JsonPropertyName("category")] public string Category { get; init; } = "positive";
    [JsonPropertyName("priority")] public TestPriority Priority { get; init; } = TestPriority.Medium;
    [JsonPropertyName("risk")] public RiskLevel Risk { get; init; } = RiskLevel.Medium;
    [JsonPropertyName("preconditions")] public string Preconditions { get; init; } = string.Empty;
    [JsonPropertyName("expectedResults")] public string ExpectedResults { get; init; } = string.Empty;
    [JsonPropertyName("tags")] public List<string> Tags { get; init; } = new();
    [JsonPropertyName("steps")] public List<GeneratedStep> Steps { get; init; } = new();
    [JsonPropertyName("testData")] public Dictionary<string, string> TestData { get; init; } = new();
}

public sealed record GeneratedStep
{
    [JsonPropertyName("description")] public string Description { get; init; } = string.Empty;
    [JsonPropertyName("action")] public BrowserActionType Action { get; init; }
    [JsonPropertyName("target")] public Contracts.LocatorDescriptor? Target { get; init; }
    [JsonPropertyName("value")] public string? Value { get; init; }
    [JsonPropertyName("url")] public string? Url { get; init; }
    [JsonPropertyName("expected")] public string? Expected { get; init; }
    [JsonPropertyName("attribute")] public string? Attribute { get; init; }
    [JsonPropertyName("assertions")] public List<GeneratedAssertion> Assertions { get; init; } = new();
}

public sealed record GeneratedAssertion
{
    [JsonPropertyName("type")] public AssertionType Type { get; init; }
    [JsonPropertyName("target")] public Contracts.LocatorDescriptor? Target { get; init; }
    [JsonPropertyName("expected")] public string? Expected { get; init; }
    [JsonPropertyName("attribute")] public string? Attribute { get; init; }
    [JsonPropertyName("description")] public string Description { get; init; } = string.Empty;
}

public sealed record GeneratedFailureAnalysis
{
    [JsonPropertyName("summary")] public string Summary { get; init; } = string.Empty;
    [JsonPropertyName("likelyCause")] public string LikelyCause { get; init; } = string.Empty;
    [JsonPropertyName("evidence")] public string Evidence { get; init; } = string.Empty;
    [JsonPropertyName("suggestedAction")] public string SuggestedAction { get; init; } = string.Empty;
    [JsonPropertyName("category")] public FailureCategory Category { get; init; }
    [JsonPropertyName("confidence")] public int Confidence { get; init; }
    [JsonPropertyName("isLikelyApplicationDefect")] public bool IsLikelyApplicationDefect { get; init; }
    [JsonPropertyName("isHealable")] public bool IsHealable { get; init; }
    /// <summary>Set by the model when the captured page content tried to influence it.
    /// Surfaced to the user rather than silently discarded.</summary>
    [JsonPropertyName("suspiciousContentObserved")] public string? SuspiciousContentObserved { get; init; }
}

public sealed record GeneratedDefectProposal
{
    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;
    [JsonPropertyName("description")] public string Description { get; init; } = string.Empty;
    [JsonPropertyName("stepsToReproduce")] public string StepsToReproduce { get; init; } = string.Empty;
    [JsonPropertyName("expectedBehaviour")] public string ExpectedBehaviour { get; init; } = string.Empty;
    [JsonPropertyName("actualBehaviour")] public string ActualBehaviour { get; init; } = string.Empty;
    [JsonPropertyName("severity")] public DefectSeverity Severity { get; init; } = DefectSeverity.Major;
    [JsonPropertyName("confidence")] public int Confidence { get; init; }
}

public sealed record GeneratedJourneyRisk
{
    [JsonPropertyName("journeys")] public List<JourneyRiskAssessment> Journeys { get; init; } = new();
}

public sealed record JourneyRiskAssessment
{
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    [JsonPropertyName("riskScore")] public int RiskScore { get; init; }
    [JsonPropertyName("risk")] public RiskLevel Risk { get; init; } = RiskLevel.Medium;
    [JsonPropertyName("rationale")] public string Rationale { get; init; } = string.Empty;
    [JsonPropertyName("pages")] public List<string> Pages { get; init; } = new();
}

public sealed record GeneratedQualityInsight
{
    [JsonPropertyName("answer")] public string Answer { get; init; } = string.Empty;
    [JsonPropertyName("findings")] public List<InsightFinding> Findings { get; init; } = new();
    /// <summary>Set when the available evidence does not support a confident answer.
    /// The platform reports this rather than inventing one.</summary>
    [JsonPropertyName("insufficientEvidence")] public bool InsufficientEvidence { get; init; }
}

public sealed record InsightFinding
{
    [JsonPropertyName("statement")] public string Statement { get; init; } = string.Empty;
    [JsonPropertyName("evidenceRefs")] public List<string> EvidenceRefs { get; init; } = new();
    [JsonPropertyName("confidence")] public int Confidence { get; init; }
}
