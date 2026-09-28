namespace QaNxt.Application.Abstractions;

/// <summary>A queued unit of work handed to the execution plane.</summary>
public sealed record QueuedJob(string Id, string Type, string PayloadJson, DateTimeOffset EnqueuedAt, int DeliveryCount);

/// <summary>Transport-agnostic job queue. The Redis Streams adapter gives at-least-once
/// delivery with consumer groups; RabbitMQ/Kafka/Service Bus can replace it without
/// touching any caller. Handlers must therefore be idempotent.</summary>
public interface IJobQueue
{
    /// <summary>Publishes a job and returns the transport's message id.</summary>
    Task<string> EnqueueAsync(string queue, string type, object payload, CancellationToken ct = default);

    /// <summary>Reads up to <paramref name="maxCount"/> jobs for a consumer group member.</summary>
    Task<IReadOnlyList<QueuedJob>> DequeueAsync(string queue, string consumerGroup, string consumer,
        int maxCount, TimeSpan blockFor, CancellationToken ct = default);

    Task AcknowledgeAsync(string queue, string consumerGroup, string jobId, CancellationToken ct = default);

    /// <summary>Reclaims jobs whose consumer died without acknowledging.</summary>
    Task<IReadOnlyList<QueuedJob>> ReclaimStaleAsync(string queue, string consumerGroup, string consumer,
        TimeSpan minIdle, int maxCount, CancellationToken ct = default);

    Task<long> GetDepthAsync(string queue, CancellationToken ct = default);
}

public static class QueueNames
{
    public const string Discovery = "qanxt:discovery";
    public const string Execution = "qanxt:execution";
    public const string Agent = "qanxt:agent";

    /// <summary>Security scans get their own queue rather than sharing execution's. They are
    /// different work with different latencies, and a long scan sitting behind a test run a
    /// pipeline is waiting on — or the reverse — is the kind of coupling nobody diagnoses.</summary>
    public const string Security = "qanxt:security";
}
