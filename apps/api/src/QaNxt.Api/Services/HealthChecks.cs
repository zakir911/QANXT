using QaNxt.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using StackExchange.Redis;

namespace QaNxt.Api.Services;

/// <summary>Readiness depends on the database being reachable and migrated.</summary>
public sealed class DatabaseHealthCheck : IHealthCheck
{
    private readonly QaNxtDbContext _db;
    public DatabaseHealthCheck(QaNxtDbContext db) => _db = db;

    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        try
        {
            if (!await _db.Database.CanConnectAsync(ct))
                return HealthCheckResult.Unhealthy("The database is not reachable.");

            var pending = await _db.Database.GetPendingMigrationsAsync(ct);
            return pending.Any()
                ? HealthCheckResult.Degraded($"{pending.Count()} migration(s) have not been applied.")
                : HealthCheckResult.Healthy();
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy("The database health check failed.", ex);
        }
    }
}

/// <summary>Redis carries the job queue; without it, runs can be created but never dispatched.</summary>
public sealed class RedisHealthCheck : IHealthCheck
{
    private readonly IConnectionMultiplexer _redis;
    public RedisHealthCheck(IConnectionMultiplexer redis) => _redis = redis;

    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default)
    {
        try
        {
            var latency = await _redis.GetDatabase().PingAsync();
            return latency > TimeSpan.FromSeconds(1)
                ? HealthCheckResult.Degraded($"Redis responded slowly ({latency.TotalMilliseconds:0}ms).")
                : HealthCheckResult.Healthy($"{latency.TotalMilliseconds:0}ms");
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy("Redis is not reachable.", ex);
        }
    }
}
