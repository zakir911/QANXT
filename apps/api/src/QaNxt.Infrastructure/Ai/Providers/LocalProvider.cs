using System.Diagnostics;
using System.Text.Json;
using QaNxt.Application.Ai;
using QaNxt.Application.Contracts;
using QaNxt.Domain.Enums;
using Microsoft.Extensions.Logging;

namespace QaNxt.Infrastructure.Ai.Providers;

/// <summary>A deterministic, offline generator used when no model provider is configured.
///
/// This is not a stub and it does not fabricate results. It is a rule engine that reads the
/// machine-readable context the orchestrator attaches to every request — the discovered
/// pages, elements, failure evidence and run statistics — and derives output from it using
/// the same heuristics a QA engineer would apply by hand: a page with a password field
/// deserves credential tests, a form deserves required-field and boundary tests, a
/// "not found" message after a locator failure means the UI changed.
///
/// Everything it produces is labelled as locally generated, so nobody is led to believe a
/// frontier model reviewed their application. It exists so the platform is fully functional
/// without an API key, and so the deterministic-first principle has somewhere to live.</summary>
public sealed class LocalProvider : ILlmProvider
{
    public const string ContextOpen = "<generation_context>";
    public const string ContextClose = "</generation_context>";

    private readonly ILogger<LocalProvider> _logger;

    public LocalProvider(ILogger<LocalProvider> logger) => _logger = logger;

    public LlmProviderKind Kind => LlmProviderKind.Local;
    public string DefaultModel => "qanxt-rules-v1";
    public bool IsConfigured => true;      // always available; that is the point of it

    public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct = default)
    {
        var stopwatch = Stopwatch.StartNew();
        var context = ExtractContext(request);

        var json = request.SchemaName switch
        {
            AiSchemaCatalog.TestPlan => LocalTestPlanner.Generate(context),
            AiSchemaCatalog.FailureAnalysis => LocalFailureAnalyser.Analyse(context),
            AiSchemaCatalog.DefectProposal => LocalDefectProposer.Propose(context),
            AiSchemaCatalog.JourneyRisk => LocalRiskAssessor.Assess(context),
            AiSchemaCatalog.QualityInsight => LocalInsightWriter.Write(context),
            _ => throw new NotSupportedException(
                $"The local provider has no rules for '{request.SchemaName}'. Configure a model provider to use this feature.")
        };

        _logger.LogInformation("Local provider produced a {Schema} response in {Ms}ms", request.SchemaName, stopwatch.ElapsedMilliseconds);

        // Token counts are zero because nothing was tokenised; reporting an estimate here
        // would make local runs indistinguishable from paid ones in the cost report.
        return Task.FromResult(new LlmResponse(json, new LlmUsage(0, 0), DefaultModel, "stop", (int)stopwatch.ElapsedMilliseconds));
    }

    public decimal EstimateCostUsd(string model, LlmUsage usage) => 0m;

    /// <summary>Pulls the structured context block the orchestrator attaches to every
    /// request. Model providers treat it as extra context; this provider treats it as input.</summary>
    private static JsonElement ExtractContext(LlmRequest request)
    {
        foreach (var message in request.Messages.Reverse())
        {
            var start = message.Content.IndexOf(ContextOpen, StringComparison.Ordinal);
            if (start < 0) continue;
            var end = message.Content.IndexOf(ContextClose, start, StringComparison.Ordinal);
            if (end < 0) continue;

            var json = message.Content[(start + ContextOpen.Length)..end].Trim();
            try
            {
                using var document = JsonDocument.Parse(json);
                return document.RootElement.Clone();
            }
            catch (JsonException)
            {
                break;
            }
        }

        throw new InvalidOperationException(
            "The local provider requires a structured generation context; none was supplied.");
    }
}

/// <summary>Helpers shared by the local rule engines.</summary>
internal static class LocalJson
{
    public static string? String(JsonElement element, string property)
        => element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() : null;

    public static int Int(JsonElement element, string property, int fallback = 0)
        => element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32() : fallback;

    public static bool Bool(JsonElement element, string property)
        => element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.True;

    public static IEnumerable<JsonElement> Array(JsonElement element, string property)
        => element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray() : Enumerable.Empty<JsonElement>();

    public static string Serialize(object value) => JsonSerializer.Serialize(value, JsonDefaults.Options);
}
