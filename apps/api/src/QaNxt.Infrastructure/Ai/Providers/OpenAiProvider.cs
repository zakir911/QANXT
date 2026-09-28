using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using QaNxt.Application.Ai;
using QaNxt.Application.Contracts;
using QaNxt.Domain.Enums;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace QaNxt.Infrastructure.Ai.Providers;

/// <summary>OpenAI-compatible chat completions.
///
/// Written against the OpenAI-compatible shape rather than the vendor SDK, so the same
/// adapter serves Azure OpenAI, vLLM, Ollama's compatible endpoint and other gateways by
/// changing only the base URL.</summary>
public sealed class OpenAiProvider : ILlmProvider
{
    private readonly HttpClient _http;
    private readonly ProviderOptions _options;
    private readonly ILogger<OpenAiProvider> _logger;

    public OpenAiProvider(HttpClient http, IOptions<AiOptions> options, ILogger<OpenAiProvider> logger)
    {
        _options = options.Value.OpenAi;
        _logger = logger;
        _http = http;
        _http.Timeout = TimeSpan.FromSeconds(options.Value.RequestTimeoutSeconds);
        if (!string.IsNullOrWhiteSpace(_options.BaseUrl)) _http.BaseAddress = new Uri(_options.BaseUrl.TrimEnd('/') + "/");
        if (!string.IsNullOrWhiteSpace(_options.ApiKey))
            _http.DefaultRequestHeaders.Authorization = new("Bearer", _options.ApiKey);
    }

    public LlmProviderKind Kind => LlmProviderKind.OpenAi;
    public string DefaultModel => _options.Model;
    public bool IsConfigured => !string.IsNullOrWhiteSpace(_options.ApiKey);

    public async Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct = default)
    {
        if (!IsConfigured) throw new InvalidOperationException("The OpenAI provider is not configured (OPENAI_API_KEY is not set).");

        var model = request.Model ?? _options.Model;
        var stopwatch = Stopwatch.StartNew();

        var body = new
        {
            model,
            messages = request.Messages.Select(m => new { role = m.Role, content = m.Content }),
            max_tokens = request.MaxTokens,
            temperature = request.Temperature,
            // Strict structured output: the provider enforces the schema server-side, and
            // the platform validates it again on receipt.
            response_format = new
            {
                type = "json_schema",
                json_schema = new
                {
                    name = request.SchemaName,
                    strict = false,
                    schema = JsonSerializer.Deserialize<JsonElement>(request.JsonSchema)
                }
            }
        };

        using var response = await _http.PostAsJsonAsync("chat/completions", body, JsonDefaults.Options, ct);
        var payload = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            _logger.LogError("OpenAI returned {Status}: {Body}", (int)response.StatusCode, Trim(payload));
            throw new HttpRequestException($"OpenAI returned {(int)response.StatusCode}: {Trim(payload)}");
        }

        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;
        var content = root.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString() ?? string.Empty;
        var finishReason = root.GetProperty("choices")[0].TryGetProperty("finish_reason", out var fr) ? fr.GetString() : null;

        var usage = root.TryGetProperty("usage", out var usageElement)
            ? new LlmUsage(
                usageElement.TryGetProperty("prompt_tokens", out var p) ? p.GetInt32() : 0,
                usageElement.TryGetProperty("completion_tokens", out var c) ? c.GetInt32() : 0)
            : new LlmUsage(0, 0);

        return new LlmResponse(content, usage, model, finishReason, (int)stopwatch.ElapsedMilliseconds);
    }

    public decimal EstimateCostUsd(string model, LlmUsage usage)
        => usage.PromptTokens / 1_000_000m * _options.InputCostPerMillionTokens
         + usage.CompletionTokens / 1_000_000m * _options.OutputCostPerMillionTokens;

    private static string Trim(string value) => value.Length <= 500 ? value : value[..500];
}
