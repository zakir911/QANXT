namespace Aira.Infrastructure.Ai;

public sealed class AiOptions
{
    /// <summary>openai | anthropic | gemini | local. Used when a project has no preference.</summary>
    public string DefaultProvider { get; set; } = "local";
    public bool CacheEnabled { get; set; } = true;
    public int MaxTokensPerRequest { get; set; } = 8000;
    /// <summary>0 disables budget enforcement for the deployment; an organization's own
    /// budget still applies.</summary>
    public decimal MonthlyBudgetUsd { get; set; }
    /// <summary>How long a schema-valid response is reused for an identical prompt.</summary>
    public int CacheTtlHours { get; set; } = 168;
    public int RequestTimeoutSeconds { get; set; } = 120;

    public ProviderOptions OpenAi { get; set; } = new() { BaseUrl = "https://api.openai.com/v1", Model = "gpt-4.1" };
    public ProviderOptions Anthropic { get; set; } = new() { BaseUrl = "https://api.anthropic.com", Model = "claude-sonnet-4-5" };
    public ProviderOptions Gemini { get; set; } = new() { BaseUrl = "https://generativelanguage.googleapis.com", Model = "gemini-2.0-flash" };
}

public sealed class ProviderOptions
{
    public string ApiKey { get; set; } = string.Empty;
    public string BaseUrl { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    /// <summary>USD per million tokens, used for cost estimates and budget enforcement.
    /// Configurable because published prices change and self-hosted endpoints differ.</summary>
    public decimal InputCostPerMillionTokens { get; set; }
    public decimal OutputCostPerMillionTokens { get; set; }
}
