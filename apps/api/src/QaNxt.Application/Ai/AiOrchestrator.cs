using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using QaNxt.Application.Security;
using QaNxt.Domain.Ai;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Application.Ai;

public sealed record AiCallOptions
{
    public required AiRequestKind Kind { get; init; }
    public required string SchemaName { get; init; }
    public required string SystemPrompt { get; init; }
    public required string UserPrompt { get; init; }
    /// <summary>Machine-readable facts the request is about. Model providers see it as
    /// context; the local provider derives its entire answer from it.</summary>
    public required object Context { get; init; }
    public Guid? ProjectId { get; init; }
    public LlmProviderKind? PreferredProvider { get; init; }
    public string? Model { get; init; }
    public int MaxTokens { get; init; } = 4000;
    public double Temperature { get; init; } = 0.2;
    /// <summary>Set false for requests whose answer should never be reused, such as an
    /// insight over a moving window.</summary>
    public bool AllowCache { get; init; } = true;
}

/// <summary>The single path through which the platform talks to a model.
///
/// Everything that must happen on every AI call happens here exactly once: provider
/// selection and fallback, prompt assembly with untrusted content enveloped, budget
/// enforcement, caching, schema validation, and accounting. Callers get a typed result or
/// a typed failure — never a raw string to parse hopefully.</summary>
public interface IAiOrchestrator
{
    Task<AiResult<T>> ExecuteAsync<T>(AiCallOptions options, CancellationToken ct = default) where T : class;
    IReadOnlyList<LlmProviderStatus> DescribeProviders();
}

public sealed class AiOrchestrator : IAiOrchestrator
{
    private readonly ILlmProviderFactory _providers;
    private readonly ISchemaValidator _validator;
    private readonly IQaNxtDbContext _db;
    private readonly IClock _clock;
    private readonly ICurrentUser _currentUser;
    private readonly ITenantContext _tenant;
    private readonly ICorrelationContext _correlation;
    private readonly SecretMasker _masker;
    private readonly IAiBudget _budget;
    private readonly ILogger<AiOrchestrator> _logger;

    public AiOrchestrator(ILlmProviderFactory providers, ISchemaValidator validator, IQaNxtDbContext db,
        IClock clock, ICurrentUser currentUser, ITenantContext tenant, ICorrelationContext correlation,
        SecretMasker masker, IAiBudget budget, ILogger<AiOrchestrator> logger)
    {
        _providers = providers;
        _validator = validator;
        _db = db;
        _clock = clock;
        _currentUser = currentUser;
        _tenant = tenant;
        _correlation = correlation;
        _masker = masker;
        _budget = budget;
        _logger = logger;
    }

    public IReadOnlyList<LlmProviderStatus> DescribeProviders() => _providers.Describe();

    public async Task<AiResult<T>> ExecuteAsync<T>(AiCallOptions options, CancellationToken ct = default) where T : class
    {
        var organizationId = _currentUser.OrganizationId ?? _tenant.OrganizationId;
        if (organizationId is null)
            return AiResult<T>.Failure(Guid.Empty, LlmProviderKind.Local, string.Empty,
                AiRequestStatus.Failed, "No organization is in context for this AI request.");

        var provider = _providers.Resolve(options.PreferredProvider ?? LlmProviderKind.Local);
        var model = options.Model ?? provider.DefaultModel;

        // The context block is appended to the user prompt, so a model has the same facts
        // the local rule engine works from — and the local provider has a parseable input.
        var contextJson = JsonSerializer.Serialize(options.Context, JsonDefaults.Options);
        var userPrompt = $"{options.UserPrompt}\n\n{LocalProviderMarkers.ContextOpen}\n{contextJson}\n{LocalProviderMarkers.ContextClose}";

        var systemPrompt = $"{options.SystemPrompt}\n\n{PromptBuilder.UntrustedContentDirective}";
        var promptHash = Hash(provider.Kind, model, options.SchemaName, systemPrompt, userPrompt);

        // The cache exists to avoid paying twice for the same model call. The local provider
        // is not a model call: it is a deterministic rule engine, it costs nothing, and it
        // answers in milliseconds. Serving it from cache buys nothing and costs correctness.
        //
        // The key carries the provider's model string, and the local provider's is a
        // constant — qanxt-rules-v1 — so changing the rules does not change the key. An
        // upgraded rule engine therefore went on serving the old rules' output to every
        // organization that had already asked, for the whole 168-hour window: a generator
        // fix shipped, and the console kept producing the pre-fix test cases.
        if (options.AllowCache && provider.Kind != LlmProviderKind.Local)
        {
            var cached = await TryReadCacheAsync<T>(organizationId.Value, promptHash, provider.Kind, model, ct);
            if (cached is not null) return cached;
        }

        var budgetCheck = await _budget.CanSpendAsync(organizationId.Value, provider.Kind, ct);
        if (!budgetCheck.Allowed)
        {
            var blocked = await RecordAsync(organizationId.Value, options, provider.Kind, model, promptHash,
                systemPrompt, userPrompt, AiRequestStatus.BudgetExceeded, budgetCheck.Reason, null, 0, 0, ct);
            return AiResult<T>.Failure(blocked, provider.Kind, model, AiRequestStatus.BudgetExceeded, budgetCheck.Reason);
        }

        LlmResponse response;
        try
        {
            response = await provider.CompleteAsync(new LlmRequest
            {
                Messages = new[] { LlmMessage.System(systemPrompt), LlmMessage.User(userPrompt) },
                SchemaName = options.SchemaName,
                JsonSchema = AiSchemaCatalog.For(options.SchemaName),
                MaxTokens = options.MaxTokens,
                Temperature = options.Temperature,
                Model = model
            }, ct);
        }
        catch (Exception ex)
        {
            var message = _masker.MaskText(ex.Message);
            _logger.LogError(ex, "The {Provider} provider failed for a {Kind} request", provider.Kind, options.Kind);
            var failedId = await RecordAsync(organizationId.Value, options, provider.Kind, model, promptHash,
                systemPrompt, userPrompt, AiRequestStatus.Failed, message, null, 0, 0, ct);
            return AiResult<T>.Failure(failedId, provider.Kind, model, AiRequestStatus.Failed, message);
        }

        var extracted = _validator.ExtractJson(response.Content);
        var validation = _validator.Validate(extracted, options.SchemaName);

        if (!validation.IsValid)
        {
            // Rejected outright. A response that does not fit its schema is not evidence of
            // anything, and acting on the parts that happen to parse is how a hijacked or
            // hallucinating model gets to influence a test suite.
            var errors = string.Join("; ", validation.Errors.Take(5));
            _logger.LogWarning("A {Provider} response failed schema validation for {Schema}: {Errors}",
                provider.Kind, options.SchemaName, errors);

            var rejectedId = await RecordAsync(organizationId.Value, options, provider.Kind, model, promptHash,
                systemPrompt, userPrompt, AiRequestStatus.SchemaRejected, errors, response, 0,
                provider.EstimateCostUsd(model, response.Usage), ct, rawContent: extracted, schemaErrors: errors);

            // Whose fault it is changes what the reader should do about it. A hosted model
            // producing an off-schema response is the model misbehaving and retrying may
            // help. The built-in rule engine failing its own schema is a defect in this
            // product, and telling the user "the model's response" sends them looking for an
            // API key they do not need. A user hit exactly this: the local planner returned
            // an empty plan and the message blamed a model that was never involved.
            var message = provider.Kind == LlmProviderKind.Local
                ? $"QA NXT's built-in rules produced a result that does not satisfy the "
                  + $"{options.SchemaName} schema, so it was rejected rather than used: {errors}. "
                  + "This is a defect in QA NXT, not a problem with your application or a "
                  + "missing model provider. The reference below identifies the request."
                : $"The model's response did not satisfy the {options.SchemaName} schema: {errors}";

            return AiResult<T>.Failure(rejectedId, provider.Kind, model, AiRequestStatus.SchemaRejected,
                message);
        }

        T? value;
        try
        {
            value = JsonSerializer.Deserialize<T>(extracted, JsonDefaults.Options);
        }
        catch (JsonException ex)
        {
            validation.Document?.Dispose();
            var rejectedId = await RecordAsync(organizationId.Value, options, provider.Kind, model, promptHash,
                systemPrompt, userPrompt, AiRequestStatus.SchemaRejected, ex.Message, response, 0, 0, ct);
            return AiResult<T>.Failure(rejectedId, provider.Kind, model, AiRequestStatus.SchemaRejected, ex.Message);
        }
        finally
        {
            validation.Document?.Dispose();
        }

        if (value is null)
        {
            var rejectedId = await RecordAsync(organizationId.Value, options, provider.Kind, model, promptHash,
                systemPrompt, userPrompt, AiRequestStatus.SchemaRejected, "The response deserialized to null.",
                response, 0, 0, ct);
            return AiResult<T>.Failure(rejectedId, provider.Kind, model, AiRequestStatus.SchemaRejected,
                "The response deserialized to null.");
        }

        var cost = provider.EstimateCostUsd(model, response.Usage);
        var requestId = await RecordAsync(organizationId.Value, options, provider.Kind, model, promptHash,
            systemPrompt, userPrompt, AiRequestStatus.Succeeded, null, response, response.LatencyMs, cost, ct,
            rawContent: response.Content, structuredJson: extracted);

        _logger.LogInformation(
            "AI {Kind} answered by {Provider}/{Model} in {Ms}ms ({Tokens} tokens, ${Cost})",
            options.Kind, provider.Kind, model, response.LatencyMs, response.Usage.TotalTokens, cost);

        return AiResult<T>.Success(value, requestId, provider.Kind, model, response.Usage, cost, fromCache: false);
    }

    /// <summary>Returns a previous schema-valid answer to an identical prompt. Generation
    /// and analysis are deterministic by design (temperature is low), so re-asking the same
    /// question of the same evidence is spend without benefit.</summary>
    private async Task<AiResult<T>?> TryReadCacheAsync<T>(Guid organizationId, string promptHash,
        LlmProviderKind provider, string model, CancellationToken ct) where T : class
    {
        var cutoff = _clock.UtcNow.AddHours(-168);
        var hit = await _db.AiRequests
            .Where(r => r.OrganizationId == organizationId
                     && r.PromptHash == promptHash
                     && r.Status == AiRequestStatus.Succeeded
                     && r.CreatedAt >= cutoff)
            .OrderByDescending(r => r.CreatedAt)
            .Select(r => new { r.Id, r.Provider, r.Model, Structured = r.Response!.StructuredJson })
            .FirstOrDefaultAsync(ct);

        if (hit?.Structured is null) return null;

        try
        {
            var value = JsonSerializer.Deserialize<T>(hit.Structured, JsonDefaults.Options);
            if (value is null) return null;
            _logger.LogInformation("Reusing a cached AI response for prompt {Hash}", promptHash[..12]);
            return AiResult<T>.Success(value, hit.Id, hit.Provider, hit.Model, new LlmUsage(0, 0), 0m, fromCache: true);
        }
        catch (JsonException)
        {
            // A cached payload that no longer deserializes means the contract changed; the
            // right response is to re-ask, not to fail.
            return null;
        }
    }

    private async Task<Guid> RecordAsync(
        Guid organizationId, AiCallOptions options, LlmProviderKind provider, string model, string promptHash,
        string systemPrompt, string userPrompt, AiRequestStatus status, string? error, LlmResponse? response,
        int latencyMs, decimal cost, CancellationToken ct,
        string? rawContent = null, string? structuredJson = null, string? schemaErrors = null)
    {
        var request = new AiRequest
        {
            OrganizationId = organizationId,
            ProjectId = options.ProjectId,
            UserId = _currentUser.UserId,
            Kind = options.Kind,
            Provider = provider,
            Model = model,
            Status = status,
            PromptHash = promptHash,
            // Prompts are stored masked and truncated: they are an audit record, not a copy
            // of the customer's application.
            SystemPromptExcerpt = Truncate(_masker.MaskText(systemPrompt), 8000),
            UserPromptExcerpt = Truncate(_masker.MaskText(userPrompt), 16000),
            ResponseSchemaName = options.SchemaName,
            PromptTokens = response?.Usage.PromptTokens ?? 0,
            CompletionTokens = response?.Usage.CompletionTokens ?? 0,
            TotalTokens = response?.Usage.TotalTokens ?? 0,
            LatencyMs = response?.LatencyMs ?? latencyMs,
            EstimatedCostUsd = cost,
            ErrorMessage = error is null ? null : Truncate(error, 4000),
            CorrelationId = _correlation.CorrelationId,
            CreatedAt = _clock.UtcNow
        };

        _db.AiRequests.Add(request);

        if (rawContent is not null || structuredJson is not null)
        {
            _db.AiResponses.Add(new AiResponse
            {
                OrganizationId = organizationId,
                AiRequestId = request.Id,
                RawContent = Truncate(_masker.MaskText(rawContent ?? string.Empty), 200_000),
                StructuredJson = structuredJson is null ? null : _masker.MaskJson(structuredJson),
                SchemaValid = status == AiRequestStatus.Succeeded,
                SchemaErrors = schemaErrors is null ? null : Truncate(schemaErrors, 8000),
                FinishReason = response?.FinishReason,
                CreatedAt = _clock.UtcNow
            });
        }

        await _db.SaveChangesAsync(ct);
        return request.Id;
    }

    private static string Hash(LlmProviderKind provider, string model, string schema, string system, string user)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{provider}|{model}|{schema}|{system}|{user}"));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}

/// <summary>Markers shared with the local provider. Defined here so the application layer
/// does not have to reference an infrastructure type to build a prompt.</summary>
public static class LocalProviderMarkers
{
    public const string ContextOpen = "<generation_context>";
    public const string ContextClose = "</generation_context>";
}

public sealed record BudgetDecision(bool Allowed, string Reason);

/// <summary>Enforces spend limits before a paid call is made.</summary>
public interface IAiBudget
{
    Task<BudgetDecision> CanSpendAsync(Guid organizationId, LlmProviderKind provider, CancellationToken ct = default);
    Task<decimal> GetMonthToDateSpendAsync(Guid organizationId, CancellationToken ct = default);
}
