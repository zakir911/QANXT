using System.Text.Json;
using Aira.Api.Authorization;
using Aira.Application.Abstractions;
using Aira.Application.Notifications;
using Aira.Application.Security;
using Aira.Domain.Enums;
using Aira.Domain.Projects;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Aira.Api.Controllers;

public sealed record CreateIntegrationRequest(
    Guid ProjectId, IntegrationKind Kind, string Name,
    /// <summary>Non-sensitive settings: a webhook URL, a channel, the events wanted.</summary>
    Dictionary<string, string>? Settings,
    /// <summary>Encrypted at rest and never returned: a signing secret, a Slack webhook URL.</summary>
    Dictionary<string, string>? Credentials);

public sealed record UpdateIntegrationRequest(
    string? Name, Dictionary<string, string>? Settings,
    Dictionary<string, string>? Credentials, bool? IsEnabled);

/// <summary>
/// Where a project's notifications go.
/// </summary>
/// <remarks>
/// Credentials are write-only: they go in, they are encrypted, and no response ever
/// contains them. A "show me the webhook URL" endpoint would be a way to read a secret with
/// a read permission, which is not a trade worth making for the convenience of not having
/// to paste it again.
/// </remarks>
[Route("api/v1/integrations")]
[RequirePermission(Permissions.IntegrationRead)]
public sealed class IntegrationsController : ApiControllerBase
{
    private readonly IAiraDbContext _db;
    private readonly ISecretProtector _protector;
    private readonly INotificationService _notifications;
    private readonly IAuditLogger _audit;
    private readonly IClock _clock;
    private readonly ICurrentUser _user;

    public IntegrationsController(IAiraDbContext db, ISecretProtector protector,
        INotificationService notifications, IAuditLogger audit, IClock clock, ICurrentUser user)
    {
        _db = db;
        _protector = protector;
        _notifications = notifications;
        _audit = audit;
        _clock = clock;
        _user = user;
    }

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid? projectId, CancellationToken ct)
    {
        var query = _db.Integrations.AsNoTracking();
        if (projectId is not null) query = query.Where(i => i.ProjectId == projectId);

        return Ok(await query.OrderBy(i => i.Name).Select(i => new
        {
            i.Id, i.ProjectId, i.Kind, i.Name, i.IsEnabled, i.SettingsJson, i.LastUsedAt, i.CreatedAt,
            // Whether a credential exists, never what it is. A console needs to show
            // "configured" or "not configured" and nothing more.
            hasCredentials = i.EncryptedCredentials != null
        }).ToListAsync(ct));
    }

    [HttpPost]
    [RequirePermission(Permissions.IntegrationWrite)]
    public async Task<IActionResult> Create([FromBody] CreateIntegrationRequest request, CancellationToken ct)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == request.ProjectId, ct);
        if (project is null) return Problem(Domain.Common.Error.NotFound("The project"));

        var name = (request.Name ?? string.Empty).Trim();
        if (name.Length == 0) return Problem(Domain.Common.Error.Validation("An integration needs a name."));

        if (Misplaced(request.Settings) is { } misplaced) return Problem(misplaced);

        var integration = new Integration
        {
            OrganizationId = project.OrganizationId,
            ProjectId = project.Id,
            Kind = request.Kind,
            Name = name,
            SettingsJson = JsonSerializer.Serialize(request.Settings ?? new()),
            EncryptedCredentials = request.Credentials is { Count: > 0 }
                ? _protector.Protect(JsonSerializer.Serialize(request.Credentials))
                : null,
            IsEnabled = true,
            CreatedByUserId = _user.UserId
        };

        _db.Integrations.Add(integration);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.IntegrationConfigured, nameof(Integration), integration.Id,
            $"{integration.Kind} integration '{integration.Name}' created.",
            projectId: integration.ProjectId, ct: ct);

        return CreatedAtAction(nameof(List), new { projectId = integration.ProjectId },
            new { integration.Id, integration.Kind, integration.Name, integration.IsEnabled });
    }

    [HttpPatch("{id:guid}")]
    [RequirePermission(Permissions.IntegrationWrite)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateIntegrationRequest request, CancellationToken ct)
    {
        var integration = await _db.Integrations.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (integration is null) return Problem(Domain.Common.Error.NotFound("The integration"));

        if (Misplaced(request.Settings) is { } misplaced) return Problem(misplaced);

        if (request.Name?.Trim() is { Length: > 0 } name) integration.Name = name;
        if (request.Settings is not null) integration.SettingsJson = JsonSerializer.Serialize(request.Settings);
        if (request.Credentials is { Count: > 0 })
            integration.EncryptedCredentials = _protector.Protect(JsonSerializer.Serialize(request.Credentials));
        if (request.IsEnabled is { } enabled) integration.IsEnabled = enabled;

        integration.UpdatedByUserId = _user.UserId;
        integration.UpdatedAt = _clock.UtcNow;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.IntegrationConfigured, nameof(Integration), integration.Id,
            $"{integration.Kind} integration '{integration.Name}' updated.",
            projectId: integration.ProjectId, ct: ct);

        return Ok(new { integration.Id, integration.Kind, integration.Name, integration.IsEnabled });
    }

    [HttpDelete("{id:guid}")]
    [RequirePermission(Permissions.IntegrationWrite)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var integration = await _db.Integrations.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (integration is null) return Problem(Domain.Common.Error.NotFound("The integration"));

        _db.Integrations.Remove(integration);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.IntegrationConfigured, nameof(Integration), id,
            $"{integration.Kind} integration '{integration.Name}' deleted.",
            projectId: integration.ProjectId, ct: ct);

        return NoContent();
    }

    /// <summary>Sends a message to this integration now, and says what happened.</summary>
    /// <remarks>
    /// Without it, the first real delivery is the test, and it happens at the moment
    /// somebody needed the message. Requires write permission because it causes an
    /// outbound request somebody else receives.
    /// </remarks>
    [HttpPost("{id:guid}/test")]
    [RequirePermission(Permissions.IntegrationWrite)]
    public async Task<IActionResult> Test(Guid id, CancellationToken ct)
        => FromResult(await _notifications.TestAsync(id, ct));

    /// <summary>What was sent, and whether it arrived.</summary>
    [HttpGet("deliveries")]
    public async Task<IActionResult> Deliveries([FromQuery] Guid? projectId, [FromQuery] Guid? runId,
        [FromQuery] int limit = 50, CancellationToken ct = default)
    {
        var query = _db.NotificationDeliveries.AsNoTracking();
        if (projectId is not null) query = query.Where(d => d.ProjectId == projectId);
        if (runId is not null) query = query.Where(d => d.TestRunId == runId);

        return Ok(await query
            .OrderByDescending(d => d.AttemptedAt)
            .Take(Math.Clamp(limit, 1, 200))
            .Select(d => new
            {
                d.Id, d.ProjectId, d.IntegrationId, d.Event, d.Channel, d.TestRunId,
                d.Title, d.Delivered, d.StatusCode, d.Detail, d.Attempts, d.AttemptedAt
            })
            .ToListAsync(ct));
    }

    /// <summary>
    /// Refuses a credential submitted as a setting.
    /// </summary>
    /// <remarks>
    /// Settings are returned by the list endpoint to anyone with read permission. A signing
    /// secret or a Slack webhook URL put there would be readable by every viewer, and the
    /// mistake is an easy one — the two dictionaries look alike. Refusing is better than
    /// quietly moving it, because the caller has already sent the secret somewhere it did
    /// not intend and should know.
    /// </remarks>
    private static Domain.Common.Error? Misplaced(Dictionary<string, string>? settings)
    {
        if (settings is null) return null;

        var offenders = settings.Keys
            .Where(key => key.Contains("secret", StringComparison.OrdinalIgnoreCase)
                       || key.Contains("token", StringComparison.OrdinalIgnoreCase)
                       || key.Contains("password", StringComparison.OrdinalIgnoreCase)
                       || key.Contains("apikey", StringComparison.OrdinalIgnoreCase)
                       || key.Equals("webhookUrl", StringComparison.OrdinalIgnoreCase))
            .ToArray();

        return offenders.Length == 0
            ? null
            : Domain.Common.Error.Validation(
                $"{string.Join(", ", offenders)} looks like a credential and settings are readable "
                + "by anyone who can view this project. Send it in \"credentials\" instead, where it "
                + "is encrypted and never returned.",
                new Dictionary<string, string[]> { ["settings"] = offenders });
    }
}
