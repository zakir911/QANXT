using System.Text.Json;
using Aira.Application.Abstractions;
using Aira.Application.Contracts;
using Aira.Application.Security;
using Aira.Domain.Audit;
using Aira.Domain.Enums;
using Microsoft.Extensions.Logging;

namespace Aira.Infrastructure.Services;

/// <summary>Writes append-only audit records. The audit write is deliberately isolated from
/// the caller's unit of work: a failure to audit is logged at error level but never turns a
/// successful business operation into a failed one, and never the reverse.</summary>
public sealed class AuditLogger : IAuditLogger
{
    private readonly IAiraDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly ICorrelationContext _correlation;
    private readonly IClock _clock;
    private readonly ILogger<AuditLogger> _logger;
    private readonly SecretMasker _masker = new();

    public AuditLogger(IAiraDbContext db, ICurrentUser currentUser, ICorrelationContext correlation,
        IClock clock, ILogger<AuditLogger> logger)
    {
        _db = db;
        _currentUser = currentUser;
        _correlation = correlation;
        _clock = clock;
        _logger = logger;
    }

    public async Task LogAsync(AuditAction action, string entityType, Guid? entityId, string summary,
        object? changes = null, bool succeeded = true, Guid? organizationId = null,
        Guid? projectId = null, Guid? userId = null, string? userEmail = null,
        CancellationToken ct = default)
    {
        try
        {
            var org = organizationId ?? _currentUser.OrganizationId;
            if (org is null)
            {
                _logger.LogWarning("Audit record for {Action} skipped: no organization in context.", action);
                return;
            }

            var entry = new AuditLog
            {
                OrganizationId = org.Value,
                ProjectId = projectId,
                UserId = userId ?? _currentUser.UserId,
                UserEmail = userEmail ?? _currentUser.Email,
                Action = action,
                EntityType = entityType,
                EntityId = entityId,
                Summary = Truncate(_masker.MaskText(summary), 2000),
                ChangesJson = changes is null ? null : _masker.MaskJson(JsonSerializer.Serialize(changes, JsonDefaults.Options)),
                CorrelationId = _correlation.CorrelationId,
                Succeeded = succeeded,
                OccurredAt = _clock.UtcNow
            };

            _db.AuditLogs.Add(entry);
            await _db.SaveChangesAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to write audit record for {Action} on {EntityType} {EntityId}",
                action, entityType, entityId);
        }
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
