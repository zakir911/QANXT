using System.Text.Json;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace QaNxt.Infrastructure.Queue;

/// <summary>Redis Streams implementation of <see cref="IJobQueue"/>. Consumer groups give
/// competing consumers, explicit acknowledgement and recovery of jobs whose worker died.
/// Delivery is at-least-once, so handlers must be idempotent.</summary>
public sealed class RedisJobQueue : IJobQueue
{
    private const string PayloadField = "payload";
    private const string TypeField = "type";
    private const string EnqueuedField = "enqueuedAt";

    private readonly IConnectionMultiplexer _redis;
    private readonly ILogger<RedisJobQueue> _logger;

    public RedisJobQueue(IConnectionMultiplexer redis, ILogger<RedisJobQueue> logger)
    {
        _redis = redis;
        _logger = logger;
    }

    public async Task<string> EnqueueAsync(string queue, string type, object payload, CancellationToken ct = default)
    {
        var db = _redis.GetDatabase();
        var json = JsonSerializer.Serialize(payload, JsonDefaults.Options);
        var id = await db.StreamAddAsync(queue, new NameValueEntry[]
        {
            new(TypeField, type),
            new(PayloadField, json),
            new(EnqueuedField, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
        }).ConfigureAwait(false);

        _logger.LogInformation("Enqueued {Type} to {Queue} as {JobId}", type, queue, id);
        return id.ToString();
    }

    public async Task<IReadOnlyList<QueuedJob>> DequeueAsync(string queue, string consumerGroup, string consumer,
        int maxCount, TimeSpan blockFor, CancellationToken ct = default)
    {
        var db = _redis.GetDatabase();
        await EnsureGroupAsync(db, queue, consumerGroup).ConfigureAwait(false);

        var entries = await db.StreamReadGroupAsync(queue, consumerGroup, consumer, ">", maxCount).ConfigureAwait(false);
        return entries.Select(Map).Where(j => j is not null).Select(j => j!).ToList();
    }

    public async Task AcknowledgeAsync(string queue, string consumerGroup, string jobId, CancellationToken ct = default)
    {
        var db = _redis.GetDatabase();
        await db.StreamAcknowledgeAsync(queue, consumerGroup, jobId).ConfigureAwait(false);
        // Acknowledged entries are removed so the stream does not grow without bound; the
        // durable record of what happened lives in PostgreSQL, not in Redis.
        await db.StreamDeleteAsync(queue, new RedisValue[] { jobId }).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<QueuedJob>> ReclaimStaleAsync(string queue, string consumerGroup, string consumer,
        TimeSpan minIdle, int maxCount, CancellationToken ct = default)
    {
        var db = _redis.GetDatabase();
        await EnsureGroupAsync(db, queue, consumerGroup).ConfigureAwait(false);

        var pending = await db.StreamPendingMessagesAsync(queue, consumerGroup, maxCount, RedisValue.Null).ConfigureAwait(false);
        var stale = pending.Where(p => p.IdleTimeInMilliseconds >= minIdle.TotalMilliseconds)
                           .Select(p => p.MessageId).ToArray();
        if (stale.Length == 0) return Array.Empty<QueuedJob>();

        _logger.LogWarning("Reclaiming {Count} stale jobs from {Queue} for {Consumer}", stale.Length, queue, consumer);
        var claimed = await db.StreamClaimAsync(queue, consumerGroup, consumer, (long)minIdle.TotalMilliseconds, stale).ConfigureAwait(false);
        return claimed.Select(Map).Where(j => j is not null).Select(j => j!).ToList();
    }

    public async Task<long> GetDepthAsync(string queue, CancellationToken ct = default)
    {
        var db = _redis.GetDatabase();
        if (!await db.KeyExistsAsync(queue).ConfigureAwait(false)) return 0;
        return await db.StreamLengthAsync(queue).ConfigureAwait(false);
    }

    private async Task EnsureGroupAsync(IDatabase db, string queue, string group)
    {
        try
        {
            // "$" would skip everything already queued; "0-0" makes a new group pick up the backlog.
            await db.StreamCreateConsumerGroupAsync(queue, group, "0-0", createStream: true).ConfigureAwait(false);
        }
        catch (RedisServerException ex) when (ex.Message.Contains("BUSYGROUP", StringComparison.Ordinal))
        {
            // The group already exists, which is the normal case.
        }
    }

    private static QueuedJob? Map(StreamEntry entry)
    {
        if (entry.Values.Length == 0) return null;
        var type = entry.Values.FirstOrDefault(v => v.Name == TypeField).Value.ToString();
        var payload = entry.Values.FirstOrDefault(v => v.Name == PayloadField).Value.ToString();
        var enqueuedRaw = entry.Values.FirstOrDefault(v => v.Name == EnqueuedField).Value;
        var enqueued = enqueuedRaw.HasValue && long.TryParse(enqueuedRaw!, out var ms)
            ? DateTimeOffset.FromUnixTimeMilliseconds(ms)
            : DateTimeOffset.UtcNow;
        return new QueuedJob(entry.Id.ToString(), type, payload, enqueued, 1);
    }
}
