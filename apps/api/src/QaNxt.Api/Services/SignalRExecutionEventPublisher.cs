using QaNxt.Api.Hubs;
using QaNxt.Application.Abstractions;
using Microsoft.AspNetCore.SignalR;

namespace QaNxt.Api.Services;

/// <summary>Pushes live events to the console over SignalR. Every group is namespaced by
/// tenant, so a subscription can never surface another organization's run.</summary>
public sealed class SignalRExecutionEventPublisher : IExecutionEventPublisher
{
    private readonly IHubContext<ExecutionHub> _hub;
    private readonly ILogger<SignalRExecutionEventPublisher> _logger;

    public SignalRExecutionEventPublisher(IHubContext<ExecutionHub> hub, ILogger<SignalRExecutionEventPublisher> logger)
    {
        _hub = hub;
        _logger = logger;
    }

    public async Task PublishAsync(Guid organizationId, ExecutionEvent @event, CancellationToken ct = default)
    {
        try
        {
            var group = @event.ExecutionId is null
                ? ExecutionHub.RunGroup(organizationId, @event.RunId)
                : ExecutionHub.ExecutionGroup(organizationId, @event.ExecutionId.Value);

            await _hub.Clients.Group(group).SendAsync("executionEvent", new
            {
                type = @event.Type,
                runId = @event.RunId,
                executionId = @event.ExecutionId,
                payload = @event.Payload,
                occurredAt = @event.OccurredAt
            }, ct);

            // The run group also receives execution-scoped events so a dashboard watching a
            // whole run does not have to subscribe to each execution individually.
            if (@event.ExecutionId is not null)
            {
                await _hub.Clients.Group(ExecutionHub.RunGroup(organizationId, @event.RunId))
                    .SendAsync("executionEvent", new
                    {
                        type = @event.Type,
                        runId = @event.RunId,
                        executionId = @event.ExecutionId,
                        payload = @event.Payload,
                        occurredAt = @event.OccurredAt
                    }, ct);
            }
        }
        catch (Exception ex)
        {
            // Live updates are a convenience. Losing one must never fail the work that
            // produced it, so this is logged rather than propagated.
            _logger.LogWarning(ex, "Could not publish the {EventType} event for run {RunId}", @event.Type, @event.RunId);
        }
    }
}
