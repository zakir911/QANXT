using Aira.Application.Ai;
using Aira.Domain.Enums;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Aira.Infrastructure.Ai;

/// <summary>Chooses the provider for a request.
///
/// Fallback is explicit and logged rather than silent: if a project asks for OpenAI and no
/// key is configured, the request is served by the local rule engine and every record of it
/// says so. A user is never left believing a frontier model reviewed their application when
/// it did not.</summary>
public sealed class LlmProviderFactory : ILlmProviderFactory
{
    private readonly IReadOnlyDictionary<LlmProviderKind, ILlmProvider> _providers;
    private readonly AiOptions _options;
    private readonly ILogger<LlmProviderFactory> _logger;

    public LlmProviderFactory(IEnumerable<ILlmProvider> providers, IOptions<AiOptions> options, ILogger<LlmProviderFactory> logger)
    {
        _providers = providers.ToDictionary(p => p.Kind);
        _options = options.Value;
        _logger = logger;
    }

    public ILlmProvider Resolve(LlmProviderKind preferred)
    {
        if (_providers.TryGetValue(preferred, out var provider) && provider.IsConfigured) return provider;

        if (preferred != LlmProviderKind.Local)
        {
            _logger.LogWarning(
                "The {Preferred} provider is not configured; falling back to the deterministic local provider. " +
                "Results will be rule-based and are labelled as such.", preferred);
        }

        var fallbackKind = ParseKind(_options.DefaultProvider);
        if (fallbackKind != preferred
            && _providers.TryGetValue(fallbackKind, out var fallback)
            && fallback.IsConfigured)
        {
            return fallback;
        }

        return _providers[LlmProviderKind.Local];
    }

    public IReadOnlyList<LlmProviderStatus> Describe() => new List<LlmProviderStatus>
    {
        Describe(LlmProviderKind.OpenAi, "OpenAI (and OpenAI-compatible endpoints)", "Set OPENAI_API_KEY to enable."),
        Describe(LlmProviderKind.Anthropic, "Anthropic", "Set ANTHROPIC_API_KEY to enable."),
        Describe(LlmProviderKind.Gemini, "Google Gemini", "Set GEMINI_API_KEY to enable."),
        Describe(LlmProviderKind.Local, "AIRA built-in rules",
            "Always available. Deterministic, offline, and labelled as locally generated wherever its output appears.")
    };

    private LlmProviderStatus Describe(LlmProviderKind kind, string name, string notes)
    {
        var provider = _providers.GetValueOrDefault(kind);
        return new LlmProviderStatus(kind, name, provider?.IsConfigured ?? false, provider?.DefaultModel ?? string.Empty, notes);
    }

    private static LlmProviderKind ParseKind(string value) => value.ToLowerInvariant() switch
    {
        "openai" => LlmProviderKind.OpenAi,
        "anthropic" => LlmProviderKind.Anthropic,
        "gemini" => LlmProviderKind.Gemini,
        _ => LlmProviderKind.Local
    };
}

/// <summary>Enforces the monthly AI spend ceiling.
///
/// Checked before each paid call rather than reconciled afterwards, because the point of a
/// budget is to prevent the spend, not to report it. Local calls are always allowed: they
/// cost nothing, and a platform that stops working when a budget is reached is worse than
/// one that degrades to its deterministic engine.</summary>
public sealed class AiBudget : IAiBudget
{
    private readonly Aira.Application.Abstractions.IAiraDbContext _db;
    private readonly Aira.Application.Abstractions.IClock _clock;
    private readonly AiOptions _options;
    private readonly ILogger<AiBudget> _logger;

    public AiBudget(Aira.Application.Abstractions.IAiraDbContext db, Aira.Application.Abstractions.IClock clock,
        IOptions<AiOptions> options, ILogger<AiBudget> logger)
    {
        _db = db;
        _clock = clock;
        _options = options.Value;
        _logger = logger;
    }

    public async Task<BudgetDecision> CanSpendAsync(Guid organizationId, LlmProviderKind provider, CancellationToken ct = default)
    {
        if (provider == LlmProviderKind.Local) return new BudgetDecision(true, string.Empty);

        var organization = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions
            .FirstOrDefaultAsync(_db.Organizations.Where(o => o.Id == organizationId), ct);

        // An organization's own limit takes precedence; the deployment limit is the ceiling.
        var limit = organization?.MonthlyAiBudgetUsd ?? 0m;
        if (limit <= 0) limit = _options.MonthlyBudgetUsd;
        if (limit <= 0) return new BudgetDecision(true, string.Empty);

        var spent = await GetMonthToDateSpendAsync(organizationId, ct);
        if (spent < limit) return new BudgetDecision(true, string.Empty);

        _logger.LogWarning("Organization {OrganizationId} has reached its monthly AI budget (${Spent} of ${Limit})",
            organizationId, spent, limit);

        return new BudgetDecision(false,
            $"The monthly AI budget of ${limit:F2} has been reached (${spent:F2} spent). " +
            "Raise the budget, or continue with the deterministic local provider.");
    }

    public async Task<decimal> GetMonthToDateSpendAsync(Guid organizationId, CancellationToken ct = default)
    {
        var now = _clock.UtcNow;
        var monthStart = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero);

        return await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.SumAsync(
            _db.AiRequests.Where(r => r.OrganizationId == organizationId && r.CreatedAt >= monthStart),
            r => r.EstimatedCostUsd, ct);
    }
}
