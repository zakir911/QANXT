namespace QaNxt.Application.Ai;

/// <summary>JSON Schemas sent to providers and used to validate their responses.
///
/// The schemas are strict — <c>additionalProperties: false</c>, closed enums, required
/// fields — because that strictness is what makes a model's output safe to act on. A
/// response that invents a field or an action verb fails validation and is rejected
/// rather than partially applied.</summary>
/// <remarks>
/// The scenarios array's maxItems is a guard on the size of a single response, not a limit
/// on how many tests an application may have. It was 40, which silently truncated the
/// deterministic engine and made a forty-page application look fully covered by forty
/// tests. The caller's own budget is the limit that should apply, and it is applied in
/// TestGenerationService where the user set it.
/// </remarks>
public static class AiSchemaCatalog
{
    public const string TestPlan = "test_plan";
    public const string FailureAnalysis = "failure_analysis";
    public const string DefectProposal = "defect_proposal";
    public const string JourneyRisk = "journey_risk";
    public const string QualityInsight = "quality_insight";

    private const string LocatorSchema = """
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["strategy", "value"],
      "properties": {
        "strategy": { "type": "string", "enum": ["role","testId","label","placeholder","text","altText","title","css","xpath"] },
        "value": { "type": "string", "maxLength": 512 },
        "name": { "type": "string", "maxLength": 200 },
        "exact": { "type": "boolean" },
        "nth": { "type": "integer", "minimum": 0 }
      }
    }
    """;

    private const string AssertionSchema = """
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "description"],
      "properties": {
        "type": { "type": "string", "enum": ["textEquals","textContains","visible","hidden","urlEquals","urlContains","valueEquals","countEquals","attributeEquals","enabled","disabled","httpStatusEquals","noConsoleErrors"] },
        "target": LOCATOR,
        "expected": { "type": "string", "maxLength": 2000 },
        "attribute": { "type": "string", "maxLength": 100 },
        "description": { "type": "string", "maxLength": 500 }
      }
    }
    """;

    public static string For(string schemaName) => schemaName switch
    {
        TestPlan => TestPlanSchema(),
        FailureAnalysis => FailureAnalysisSchema,
        DefectProposal => DefectProposalSchema,
        JourneyRisk => JourneyRiskSchema,
        QualityInsight => QualityInsightSchema,
        _ => throw new ArgumentOutOfRangeException(nameof(schemaName), schemaName, "Unknown response schema.")
    };

    private static string TestPlanSchema() => $$"""
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["summary", "scenarios"],
      "properties": {
        "summary": { "type": "string", "maxLength": 2000 },
        "scenarios": {
          "type": "array",
          "minItems": 1,
          "maxItems": 500,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["name", "objective", "category", "priority", "risk", "steps"],
            "properties": {
              "name": { "type": "string", "maxLength": 200 },
              "objective": { "type": "string", "maxLength": 1000 },
              "category": { "type": "string", "enum": ["positive","negative","boundary","validation","security","session","errorHandling","accessibility","visual","compatibility"] },
              "priority": { "type": "string", "enum": ["critical","high","medium","low"] },
              "risk": { "type": "string", "enum": ["critical","high","medium","low"] },
              "preconditions": { "type": "string", "maxLength": 1000 },
              "expectedResults": { "type": "string", "maxLength": 2000 },
              "tags": { "type": "array", "items": { "type": "string", "maxLength": 40 }, "maxItems": 10 },
              "testData": { "type": "object", "additionalProperties": { "type": "string", "maxLength": 500 } },
              "steps": {
                "type": "array",
                "minItems": 1,
                "maxItems": 40,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["description", "action"],
                  "properties": {
                    "description": { "type": "string", "maxLength": 500 },
                    "action": { "type": "string", "enum": ["navigate","click","doubleClick","fill","select","check","uncheck","hover","press","upload","download","wait","screenshot","scroll","checkAccessibility","checkVisual","assertText","assertVisible","assertHidden","assertUrl","assertValue","assertCount","assertAttribute","assertEnabled","assertDisabled"] },
                    "target": {{LocatorSchema}},
                    "value": { "type": "string", "maxLength": 2000 },
                    "url": { "type": "string", "maxLength": 2048 },
                    "expected": { "type": "string", "maxLength": 2000 },
                    "attribute": { "type": "string", "maxLength": 100 },
                    "assertions": { "type": "array", "maxItems": 10, "items": {{AssertionSchema.Replace("LOCATOR", LocatorSchema)}} }
                  }
                }
              }
            }
          }
        }
      }
    }
    """;

    private const string FailureAnalysisSchema = """
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["summary", "likelyCause", "evidence", "suggestedAction", "category", "confidence"],
      "properties": {
        "summary": { "type": "string", "maxLength": 500 },
        "likelyCause": { "type": "string", "maxLength": 2000 },
        "evidence": { "type": "string", "maxLength": 4000 },
        "suggestedAction": { "type": "string", "maxLength": 2000 },
        "category": { "type": "string", "enum": ["unknown","applicationDefect","testDefect","environmentDefect","locatorChange","timingIssue","networkIssue","authenticationIssue","dataIssue","thirdPartyDependency"] },
        "confidence": { "type": "integer", "minimum": 0, "maximum": 100 },
        "isLikelyApplicationDefect": { "type": "boolean" },
        "isHealable": { "type": "boolean" },
        "suspiciousContentObserved": { "type": "string", "maxLength": 1000 }
      }
    }
    """;

    private const string DefectProposalSchema = """
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["title", "description", "stepsToReproduce", "expectedBehaviour", "actualBehaviour", "severity", "confidence"],
      "properties": {
        "title": { "type": "string", "maxLength": 200 },
        "description": { "type": "string", "maxLength": 4000 },
        "stepsToReproduce": { "type": "string", "maxLength": 4000 },
        "expectedBehaviour": { "type": "string", "maxLength": 2000 },
        "actualBehaviour": { "type": "string", "maxLength": 2000 },
        "severity": { "type": "string", "enum": ["blocker","critical","major","minor","trivial"] },
        "confidence": { "type": "integer", "minimum": 0, "maximum": 100 }
      }
    }
    """;

    private const string JourneyRiskSchema = """
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["journeys"],
      "properties": {
        "journeys": {
          "type": "array", "minItems": 1, "maxItems": 20,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["name", "riskScore", "risk", "rationale", "pages"],
            "properties": {
              "name": { "type": "string", "maxLength": 200 },
              "riskScore": { "type": "integer", "minimum": 0, "maximum": 100 },
              "risk": { "type": "string", "enum": ["critical","high","medium","low"] },
              "rationale": { "type": "string", "maxLength": 1500 },
              "pages": { "type": "array", "items": { "type": "string", "maxLength": 512 }, "maxItems": 20 }
            }
          }
        }
      }
    }
    """;

    private const string QualityInsightSchema = """
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["answer", "findings"],
      "properties": {
        "answer": { "type": "string", "maxLength": 3000 },
        "insufficientEvidence": { "type": "boolean" },
        "findings": {
          "type": "array", "maxItems": 20,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["statement", "evidenceRefs", "confidence"],
            "properties": {
              "statement": { "type": "string", "maxLength": 1000 },
              "evidenceRefs": { "type": "array", "items": { "type": "string", "maxLength": 200 }, "maxItems": 20 },
              "confidence": { "type": "integer", "minimum": 0, "maximum": 100 }
            }
          }
        }
      }
    }
    """;
}
