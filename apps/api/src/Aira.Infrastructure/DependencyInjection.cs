using Aira.Application.Abstractions;
using Aira.Application.Ai;
using Aira.Infrastructure.Ai;
using Aira.Infrastructure.Ai.Providers;
using Aira.Infrastructure.Persistence;
using Aira.Infrastructure.Queue;
using Aira.Infrastructure.Security;
using Aira.Infrastructure.Services;
using Aira.Infrastructure.Storage;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace Aira.Infrastructure;

public static class DependencyInjection
{
    /// <summary>Registers every adapter the application ports need. Composition happens
    /// once, here, so swapping an implementation (S3 for filesystem, Kafka for Redis) is
    /// a one-line change rather than a hunt through the codebase.</summary>
    public static IServiceCollection AddAiraInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<JwtOptions>(configuration.GetSection("Jwt"));
        services.Configure<EncryptionOptions>(configuration.GetSection("Encryption"));
        services.Configure<StorageOptions>(configuration.GetSection("Storage"));
        services.Configure<AiOptions>(configuration.GetSection("Ai"));

        var connectionString = configuration.GetConnectionString("Database")
            ?? throw new InvalidOperationException("ConnectionStrings:Database (DATABASE_URL) is not configured.");

        services.AddDbContext<AiraDbContext>((provider, options) =>
        {
            options.UseNpgsql(connectionString, npgsql =>
            {
                npgsql.MigrationsAssembly(typeof(AiraDbContext).Assembly.FullName);
                // Transient network faults are normal in containerized deployments.
                npgsql.EnableRetryOnFailure(maxRetryCount: 3, maxRetryDelay: TimeSpan.FromSeconds(5), errorCodesToAdd: null);
            });
            if (configuration.GetValue("Database:EnableSensitiveDataLogging", false))
                options.EnableSensitiveDataLogging();

            // Tenant-filtered principals on required navigations are the point of the design:
            // if a User row is filtered out, its role links must disappear with it. EF warns
            // about this pattern generically, so the warning is acknowledged rather than left
            // to obscure genuine model problems.
            options.ConfigureWarnings(w => w.Ignore(
                Microsoft.EntityFrameworkCore.Diagnostics.CoreEventId
                    .PossibleIncorrectRequiredNavigationWithQueryFilterInteractionWarning));
        });

        services.AddScoped<IAiraDbContext>(sp => sp.GetRequiredService<AiraDbContext>());
        services.AddScoped<DatabaseSeeder>();

        services.AddSingleton<IClock, SystemClock>();
        services.AddScoped<ITenantContext, TenantContext>();
        services.AddSingleton<IPasswordHasher, PasswordHasher>();
        services.AddSingleton<ISecretProtector, AesSecretProtector>();
        services.AddSingleton<ITokenService, JwtTokenService>();
        services.AddScoped<IAuditLogger, AuditLogger>();
        services.AddSingleton<IArtifactStore, FileSystemArtifactStore>();

        var redisUrl = configuration.GetConnectionString("Redis") ?? "localhost:6379";
        services.AddSingleton<IConnectionMultiplexer>(sp =>
        {
            var logger = sp.GetRequiredService<ILogger<RedisJobQueue>>();
            var config = ConfigurationOptions.Parse(redisUrl);
            config.AbortOnConnectFail = false;   // let the app start and recover if Redis is slow to come up
            config.ConnectRetry = 5;
            config.ClientName = "aira-api";
            logger.LogInformation("Connecting to Redis at {Endpoint}", redisUrl);
            return ConnectionMultiplexer.Connect(config);
        });
        services.AddSingleton<IJobQueue, RedisJobQueue>();

        // Every provider is registered; the factory decides which one answers a request,
        // and falls back to the local rule engine when a key is missing.
        services.AddHttpClient<OpenAiProvider>();
        services.AddHttpClient<AnthropicProvider>();
        services.AddHttpClient<GeminiProvider>();
        services.AddScoped<ILlmProvider>(sp => sp.GetRequiredService<OpenAiProvider>());
        services.AddScoped<ILlmProvider>(sp => sp.GetRequiredService<AnthropicProvider>());
        services.AddScoped<ILlmProvider>(sp => sp.GetRequiredService<GeminiProvider>());
        services.AddScoped<ILlmProvider, LocalProvider>();
        services.AddScoped<ILlmProviderFactory, LlmProviderFactory>();
        services.AddScoped<IAiBudget, AiBudget>();

        return services;
    }
}
