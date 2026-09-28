using QaNxt.Application.Abstractions;
using QaNxt.Application.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace QaNxt.Api.Hubs;

/// <summary>Pushes live execution progress to the console. Clients subscribe to a run or a
/// single execution; groups are namespaced by tenant so a subscription cannot be used to
/// observe another organization's run.</summary>
[Authorize]
public sealed class ExecutionHub : Hub
{
    private readonly ICurrentUser _currentUser;
    private readonly ILogger<ExecutionHub> _logger;

    public ExecutionHub(ICurrentUser currentUser, ILogger<ExecutionHub> logger)
    {
        _currentUser = currentUser;
        _logger = logger;
    }

    public static string RunGroup(Guid organizationId, Guid runId) => $"org:{organizationId:N}:run:{runId:N}";
    public static string ExecutionGroup(Guid organizationId, Guid executionId) => $"org:{organizationId:N}:exec:{executionId:N}";

    public async Task SubscribeToRun(Guid runId)
    {
        var org = RequireOrganization();
        await Groups.AddToGroupAsync(Context.ConnectionId, RunGroup(org, runId));
        _logger.LogDebug("Connection {ConnectionId} subscribed to run {RunId}", Context.ConnectionId, runId);
    }

    public async Task UnsubscribeFromRun(Guid runId)
    {
        var org = RequireOrganization();
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, RunGroup(org, runId));
    }

    public async Task SubscribeToExecution(Guid executionId)
    {
        var org = RequireOrganization();
        await Groups.AddToGroupAsync(Context.ConnectionId, ExecutionGroup(org, executionId));
    }

    public async Task UnsubscribeFromExecution(Guid executionId)
    {
        var org = RequireOrganization();
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, ExecutionGroup(org, executionId));
    }

    private Guid RequireOrganization()
    {
        if (!_currentUser.HasPermission(Permissions.ExecutionRead))
            throw new HubException("You do not have permission to watch executions.");

        return _currentUser.OrganizationId
            ?? throw new HubException("The connection is not associated with an organization.");
    }
}
