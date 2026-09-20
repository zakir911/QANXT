namespace Aira.Api.Configuration;

/// <summary>Maps the flat environment variables documented in .env.example onto the
/// hierarchical configuration the application binds. Keeping the mapping in one place means
/// the documented variable names and the code cannot drift apart.</summary>
public static class EnvironmentConfiguration
{
    public static void AddAiraEnvironmentMapping(this ConfigurationManager configuration)
    {
        var map = new Dictionary<string, string>
        {
            ["DATABASE_URL"] = "ConnectionStrings:Database",
            ["REDIS_URL"] = "ConnectionStrings:Redis",
            ["JWT_SECRET"] = "Jwt:Secret",
            ["JWT_ISSUER"] = "Jwt:Issuer",
            ["JWT_AUDIENCE"] = "Jwt:Audience",
            ["JWT_ACCESS_TOKEN_MINUTES"] = "Jwt:AccessTokenMinutes",
            ["JWT_REFRESH_TOKEN_DAYS"] = "Jwt:RefreshTokenDays",
            ["ENCRYPTION_KEY"] = "Encryption:Key",
            ["WORKER_TOKEN"] = "Security:WorkerToken",
            ["STORAGE_PROVIDER"] = "Storage:Provider",
            ["STORAGE_ROOT"] = "Storage:Root",
            ["STORAGE_BUCKET"] = "Storage:Bucket",
            ["ARTIFACT_RETENTION_DAYS"] = "Storage:RetentionDays",
            ["PRODUCT_NAME"] = "Product:Name",
            ["PRODUCT_TAGLINE"] = "Product:Tagline",
            ["AI_DEFAULT_PROVIDER"] = "Ai:DefaultProvider",
            ["AI_CACHE_ENABLED"] = "Ai:CacheEnabled",
            ["AI_MAX_TOKENS_PER_REQUEST"] = "Ai:MaxTokensPerRequest",
            ["AI_MONTHLY_BUDGET_USD"] = "Ai:MonthlyBudgetUsd",
            ["OPENAI_API_KEY"] = "Ai:OpenAi:ApiKey",
            ["OPENAI_BASE_URL"] = "Ai:OpenAi:BaseUrl",
            ["OPENAI_MODEL"] = "Ai:OpenAi:Model",
            ["ANTHROPIC_API_KEY"] = "Ai:Anthropic:ApiKey",
            ["ANTHROPIC_BASE_URL"] = "Ai:Anthropic:BaseUrl",
            ["ANTHROPIC_MODEL"] = "Ai:Anthropic:Model",
            ["GEMINI_API_KEY"] = "Ai:Gemini:ApiKey",
            ["GEMINI_BASE_URL"] = "Ai:Gemini:BaseUrl",
            ["GEMINI_MODEL"] = "Ai:Gemini:Model",
            ["LOG_LEVEL"] = "Logging:MinimumLevel",
            ["RATE_LIMIT_PERMIT_PER_MINUTE"] = "Security:RateLimitPermitPerMinute",
            ["AUTH_RATE_LIMIT_PERMIT_PER_MINUTE"] = "Security:AuthRateLimitPermitPerMinute",
            ["ALLOW_PRIVATE_NETWORK_TARGETS"] = "Security:AllowPrivateNetworkTargets"
        };

        var overrides = new Dictionary<string, string?>();
        foreach (var (variable, path) in map)
        {
            var value = System.Environment.GetEnvironmentVariable(variable);
            if (!string.IsNullOrWhiteSpace(value)) overrides[path] = value;
        }

        var corsOrigins = System.Environment.GetEnvironmentVariable("CORS_ORIGINS");
        if (!string.IsNullOrWhiteSpace(corsOrigins))
        {
            var origins = corsOrigins.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            for (var i = 0; i < origins.Length; i++) overrides[$"Security:CorsOrigins:{i}"] = origins[i];
        }

        var allowlist = System.Environment.GetEnvironmentVariable("GLOBAL_TARGET_ALLOWLIST");
        if (!string.IsNullOrWhiteSpace(allowlist))
        {
            var hosts = allowlist.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            for (var i = 0; i < hosts.Length; i++) overrides[$"Security:GlobalTargetAllowlist:{i}"] = hosts[i];
        }

        if (overrides.Count > 0) configuration.AddInMemoryCollection(overrides);
    }
}
