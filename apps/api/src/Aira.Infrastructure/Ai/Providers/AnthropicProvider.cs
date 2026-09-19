using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using Aira.Application.Ai;
using Aira.Application.Contracts;
using Aira.Domain.Enums;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Aira.Infrastructure.Ai.Providers;

/// <summary>Anthropic Messages API.
///
/// Anthropic separates the system prompt from the conversation and has no JSON-schema
/// response mode, so the schema is stated in the prompt and enforced by the platform's own
/// validator on receipt — which is where enforcement has to live regardless of provider.</summary>
public sealed class AnthropicProvider : ILlmProvider
{
    private const string ApiVersion = "2023-06-01";

    private readonly HttpClient _http;
    private readonly ProviderOptions _options;
    private readonly ILogger<AnthropicProvider> _logger;

    public AnthropicProvider(HttpClient http, IOptions<AiOptions> options, ILogger<AnthropicProvider> logger)
    {
        _options = options.Value.Anthropic;
        _logger = logger;
        _http = http;
        _http.Timeout = TimeSpan.FromSeconds(options.Value.RequestTimeoutSeconds);
        if (!string.IsNullOrWhiteSpace(_options.BaseUrl)) _http.BaseAddress = new Uri(_options.BaseUrl.TrimEnd('/') + "/");
        if (!string.IsNullOrWhiteSpace(_options.ApiKey))
        {
            _http.DefaultRequestHeaders.Add("x-api-key", _options.ApiKey);
            _http.DefaultRequestHeaders.Add("anthropic-version", ApiVersion);
        }
    }

    public LlmProviderKind Kind => LlmProviderKind.Anthropic;
    public string DefaultModel => _options.Model;
    public bool IsConfigured => !string.IsNullOrWhiteSpace(_options.ApiKey);

    public async Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct = default)
    {
        if (!IsConfigured) throw new InvalidOperationException("The Anthropic provider is not configured (ANTHROPIC_API_KEY is not set).");

        var model = request.Model ?? _options.Model;
        var stopwatch = Stopwatch.StartNew();

        var systemPrompt = string.Join("\n\n", request.Messages.Where(m => m.Role == "system").Select(m => m.Content));
        var conversation = request.Messages
            .Where(m => m.Role != "system")
            .Select(m => new { role = m.Role == "assistant" ? "assistant" : "user", content = m.Content })
            .ToList();

        var body = new
        {
            model,
            max_tokens = request.MaxTokens,
            temperature = request.Temperature,
            system = $"{systemPrompt}\n\nRespond with a single JSON object matching this schema, and nothing else:\n{request.JsonSchema}",
            messages = conversation
        };

        using var response = await _http.PostAsJsonAsync("v1/messages", body, JsonDefaults.Options, ct);
        var payload = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            _logger.LogError("Anthropic returned {Status}: {Body}", (int)response.StatusCode, Trim(payload));
            throw new HttpRequestException($"Anthropic returned {(int)response.StatusCode}: {Trim(payload)}");
        }

        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;

        // Content is a list of blocks; the text blocks concatenated are the response.
        var content = string.Concat(root.GetProperty("content").EnumerateArray()
            .Where(block => block.TryGetProperty("type", out var type) && type.GetString() == "text")
            .Select(block => block.GetProperty("text").GetString() ?? string.Empty));

        var finishReason = root.TryGetProperty("stop_reason", out var stop) ? stop.GetString() : null;
        var usage = root.TryGetProperty("usage", out var usageElement)
            ? new LlmUsage(
                usageElement.TryGetProperty("input_tokens", out var i) ? i.GetInt32() : 0,
                usageElement.TryGetProperty("output_tokens", out var o) ? o.GetInt32() : 0)
            : new LlmUsage(0, 0);

        return new LlmResponse(content, usage, model, finishReason, (int)stopwatch.ElapsedMilliseconds);
    }

    public decimal EstimateCostUsd(string model, LlmUsage usage)
        => usage.PromptTokens / 1_000_000m * _options.InputCostPerMillionTokens
         + usage.CompletionTokens / 1_000_000m * _options.OutputCostPerMillionTokens;

    private static string Trim(string value) => value.Length <= 500 ? value : value[..500];
}
