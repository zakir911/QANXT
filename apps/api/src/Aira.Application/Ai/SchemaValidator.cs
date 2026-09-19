using System.Text.Json;
using Json.Schema;

namespace Aira.Application.Ai;

public sealed record SchemaValidationResult(bool IsValid, IReadOnlyList<string> Errors, JsonDocument? Document)
{
    public static SchemaValidationResult Invalid(params string[] errors) => new(false, errors, null);
}

/// <summary>Validates a model's response against the schema it was asked for.
///
/// This is the boundary between "a model said something" and "the platform will act on it".
/// Responses are rejected — not repaired, not partially applied — when they do not fit,
/// because a half-understood test plan is more dangerous than no test plan.</summary>
public interface ISchemaValidator
{
    SchemaValidationResult Validate(string json, string schemaName);
    /// <summary>Extracts the JSON object from a response that may be wrapped in prose or a
    /// code fence. Providers that do not support strict structured output still tend to
    /// wrap valid JSON, and discarding those responses would be needlessly brittle.</summary>
    string ExtractJson(string content);
}

public sealed class SchemaValidator : ISchemaValidator
{
    private readonly Dictionary<string, JsonSchema> _compiled = new(StringComparer.Ordinal);
    private readonly object _lock = new();

    public SchemaValidationResult Validate(string json, string schemaName)
    {
        if (string.IsNullOrWhiteSpace(json))
            return SchemaValidationResult.Invalid("The response was empty.");

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException ex)
        {
            return SchemaValidationResult.Invalid($"The response was not valid JSON: {ex.Message}");
        }

        JsonSchema schema;
        try
        {
            schema = GetSchema(schemaName);
        }
        catch (Exception ex)
        {
            document.Dispose();
            return SchemaValidationResult.Invalid($"The schema '{schemaName}' could not be loaded: {ex.Message}");
        }

        var evaluation = schema.Evaluate(document.RootElement, new EvaluationOptions
        {
            OutputFormat = OutputFormat.List,
            RequireFormatValidation = false
        });

        if (evaluation.IsValid) return new SchemaValidationResult(true, Array.Empty<string>(), document);

        var errors = Flatten(evaluation).Take(20).ToList();
        document.Dispose();
        return new SchemaValidationResult(false,
            errors.Count > 0 ? errors : new List<string> { "The response did not satisfy the schema." }, null);
    }

    public string ExtractJson(string content)
    {
        if (string.IsNullOrWhiteSpace(content)) return string.Empty;
        var text = content.Trim();

        // ```json … ``` is the most common wrapper.
        var fence = text.IndexOf("```", StringComparison.Ordinal);
        if (fence >= 0)
        {
            var start = text.IndexOf('\n', fence);
            var end = text.LastIndexOf("```", StringComparison.Ordinal);
            if (start > 0 && end > start) text = text[(start + 1)..end].Trim();
        }

        // Otherwise take the outermost JSON object.
        var open = text.IndexOf('{');
        var close = text.LastIndexOf('}');
        if (open >= 0 && close > open) text = text[open..(close + 1)];

        return text.Trim();
    }

    private JsonSchema GetSchema(string schemaName)
    {
        lock (_lock)
        {
            if (_compiled.TryGetValue(schemaName, out var cached)) return cached;
            var schema = JsonSchema.FromText(AiSchemaCatalog.For(schemaName));
            _compiled[schemaName] = schema;
            return schema;
        }
    }

    private static IEnumerable<string> Flatten(EvaluationResults results)
    {
        if (results.HasErrors && results.Errors is not null)
        {
            foreach (var (keyword, message) in results.Errors)
                yield return $"{results.InstanceLocation}: {message} ({keyword})";
        }

        foreach (var child in results.Details)
        {
            foreach (var error in Flatten(child)) yield return error;
        }
    }
}
