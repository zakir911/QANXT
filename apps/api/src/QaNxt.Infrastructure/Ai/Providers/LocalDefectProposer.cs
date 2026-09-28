using System.Text.Json;

namespace QaNxt.Infrastructure.Ai.Providers;

/// <summary>Drafts a defect report from a failure and its analysis.
///
/// The draft is assembled from recorded facts only — the steps that ran, the expectation
/// that was not met, the evidence collected. Severity follows the test's own declared
/// priority, because the team that wrote the test already expressed how much the journey
/// matters. Nothing here is auto-filed: a proposal always waits for a human.</summary>
internal static class LocalDefectProposer
{
    public static string Propose(JsonElement context)
    {
        var testCaseName = LocalJson.String(context, "testCaseName") ?? "A test";
        var summary = LocalJson.String(context, "analysisSummary") ?? "The test failed.";
        var cause = LocalJson.String(context, "analysisLikelyCause") ?? string.Empty;
        var evidence = LocalJson.String(context, "analysisEvidence") ?? string.Empty;
        var expected = LocalJson.String(context, "expectedResults") ?? "The journey completes as described by the test case.";
        var priority = LocalJson.String(context, "priority") ?? "medium";
        var confidence = LocalJson.Int(context, "analysisConfidence", 50);
        var applicationBuild = LocalJson.String(context, "applicationBuildRef");
        var environment = LocalJson.String(context, "environment");

        var steps = LocalJson.Array(context, "steps")
            .Select((step, index) => $"{index + 1}. {LocalJson.String(step, "description")}"
                + (LocalJson.String(step, "status") == "failed" ? "   <- failed here" : string.Empty))
            .ToList();

        var severity = priority switch
        {
            "critical" => "critical",
            "high" => "major",
            "low" => "minor",
            _ => "major"
        };

        var contextLines = new List<string>();
        if (!string.IsNullOrEmpty(environment)) contextLines.Add($"Environment: {environment}");
        if (!string.IsNullOrEmpty(applicationBuild)) contextLines.Add($"Application build: {applicationBuild}");

        var description = string.Join("\n\n", new[]
        {
            summary,
            string.IsNullOrEmpty(cause) ? null : $"Likely cause: {cause}",
            contextLines.Count > 0 ? string.Join("\n", contextLines) : null,
            "Raised from an automated execution. The evidence referenced below is attached to that execution."
        }.Where(part => !string.IsNullOrEmpty(part))!);

        return LocalJson.Serialize(new
        {
            title = Truncate($"{testCaseName}: {summary}", 200),
            description = Truncate(description, 4000),
            stepsToReproduce = Truncate(steps.Count > 0
                ? string.Join("\n", steps)
                : "See the recorded actions on the linked execution.", 4000),
            expectedBehaviour = Truncate(expected, 2000),
            actualBehaviour = Truncate(string.IsNullOrEmpty(evidence) ? summary : evidence, 2000),
            severity,
            confidence
        });
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
