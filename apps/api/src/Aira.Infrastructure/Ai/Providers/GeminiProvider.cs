using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using Aira.Application.Ai;
using Aira.Application.Contracts;
using Aira.Domain.Enums;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Aira.Infrastructure.Ai.Providers;

/// <summary>Google Gemini generateContent.
///
/// Gemini supports a response schema, but a narrower dialect than JSON Schema draft 2020-12
/// (no <c>additionalProperties</c>, no <c>$ref</c>). The schema is therefore stated in the
/// prompt and enforced by the platform's validator, which keeps behaviour identical across
/// providers instead of varying with each one's capabilities.</summary>
public sealed class GeminiProvider : ILlmProvider
{
    private readonly HttpClient _http;
    private readonly ProviderOptions _options;
    private readonly ILogger<GeminiProvider> _logger;

    public GeminiProvider(HttpClient http, IOptions<AiOptions> options, ILogger<GeminiProvider> logger)
    {
        _options = options.Value.Gemini;
        _logger = logger;
        _http = http;
        _http.Timeout = TimeSpan.FromSeconds(options.Value.RequestTimeoutSeconds);
        if (!string.IsNullOrWhiteSpace(_options.BaseUrl)) _http.BaseAddress = new Uri(_options.BaseUrl.TrimEnd('/') + "/");
    }

    public LlmProviderKind Kind => LlmProviderKind.Gemini;
    public string DefaultModel => _options.Model;
    public bool IsConfigured => !string.IsNullOrWhiteSpace(_options.ApiKey);

    public async Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct = default)
    {
        if (!IsConfigured) throw new InvalidOperationException("The Gemini provider is not configured (GEMINI_API_KEY is not set).");

        var model = request.Model ?? _options.Model;
        var stopwatch = Stopwatch.StartNew();

        var systemPrompt = string.Join("\n\n", request.Messages.Where(m => m.Role == "system").Select(m => m.Content));
        var contents = request.Messages
            .Where(m => m.Role != "system")
            .Select(m => new
            {
                role = m.Role == "assistant" ? "model" : "user",
                parts = new[] { new { text = m.Content } }
            })
            .ToList();

        var body = new
        {
            contents,
            systemInstruction = new
            {
                parts = new[]
                {
                    new { text = $"{systemPrompt}\n\nRespond with a single JSON object matching this schema, and nothing else:\n{request.JsonSchema}" }
                }
            },
            generationConfig = new
            {
                temperature = request.Temperature,
                maxOutputTokens = request.MaxTokens,
                responseMimeType = "application/json"
            }
        };

        var url = $"v1beta/models/{model}:generateContent?key={Uri.EscapeDataString(_options.ApiKey)}";
        using var response = await _http.PostAsJsonAsync(url, body, JsonDefaults.Options, ct);
        var payload = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            _logger.LogError("Gemini returned {Status}: {Body}", (int)response.StatusCode, Trim(payload));
            throw new HttpRequestException($"Gemini returned {(int)response.StatusCode}: {Trim(payload)}");
        }

        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;

        var candidate = root.GetProperty("candidates")[0];
        var content = string.Concat(candidate.GetProperty("content").GetProperty("parts").EnumerateArray()
            .Select(part => part.TryGetProperty("text", out var text) ? text.GetString() ?? string.Empty : string.Empty));
        var finishReason = candidate.TryGetProperty("finishReason", out var fr) ? fr.GetString() : null;

        var usage = root.TryGetProperty("usageMetadata", out var usageElement)
            ? new LlmUsage(
                usageElement.TryGetProperty("promptTokenCount", out var p) ? p.GetInt32() : 0,
                usageElement.TryGetProperty("candidatesTokenCount", out var c) ? c.GetInt32() : 0)
            : new LlmUsage(0, 0);

        return new LlmResponse(content, usage, model, finishReason, (int)stopwatch.ElapsedMilliseconds);
    }

    public decimal EstimateCostUsd(string model, LlmUsage usage)
        => usage.PromptTokens / 1_000_000m * _options.InputCostPerMillionTokens
         + usage.CompletionTokens / 1_000_000m * _options.OutputCostPerMillionTokens;

    private static string Trim(string value) => value.Length <= 500 ? value : value[..500];
}
