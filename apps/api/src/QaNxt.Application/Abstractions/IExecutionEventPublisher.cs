namespace QaNxt.Application.Abstractions;

public sealed record ExecutionEvent(
    string Type,
    Guid RunId,
    Guid? ExecutionId,
    object Payload,
    DateTimeOffset OccurredAt);

/// <summary>Pushes live progress to connected consoles. Defined as a port so the
/// application layer never depends on SignalR, and so a future transport (SSE, websockets
/// behind a gateway) is a swap rather than a rewrite.</summary>
public interface IExecutionEventPublisher
{
    Task PublishAsync(Guid organizationId, ExecutionEvent @event, CancellationToken ct = default);
}

public static class ExecutionEventTypes
{
    public const string RunQueued = "run.queued";
    public const string RunStarted = "run.started";
    public const string RunCompleted = "run.completed";
    public const string ExecutionStarted = "execution.started";
    public const string ExecutionProgress = "execution.progress";
    public const string ExecutionCompleted = "execution.completed";
    public const string ActionCompleted = "action.completed";
    public const string HealingProposed = "healing.proposed";
    public const string DiscoveryProgress = "discovery.progress";
    public const string DiscoveryCompleted = "discovery.completed";
}
