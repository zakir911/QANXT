using System.Text.Json;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using QaNxt.Application.Security;
using QaNxt.Domain.Audit;
using QaNxt.Domain.Enums;
using Microsoft.Extensions.Logging;

namespace QaNxt.Infrastructure.Services;

/// <summary>Writes append-only audit records. The audit write is deliberately isolated from
/// the caller's unit of work: a failure to audit is logged at error level but never turns a
/// successful business operation into a failed one, and never the reverse.</summary>
public sealed class AuditLogger : IAuditLogger
{
    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly ITenantContext _tenant;
    private readonly ICorrelationContext _correlation;
    private readonly IClock _clock;
    private readonly ILogger<AuditLogger> _logger;
    private readonly SecretMasker _masker = new();

    public AuditLogger(IQaNxtDbContext db, ICurrentUser currentUser, ITenantContext tenant,
        ICorrelationContext correlation, IClock clock, ILogger<AuditLogger> logger)
    {
        _db = db;
        _currentUser = currentUser;
        _tenant = tenant;
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
            // Three sources, narrowest first: what the caller named, the signed-in user, and
            // the tenant the work is being done for.
            //
            // The last one is what makes this work outside a request. Most callers name
            // neither, because most callers run inside one and the user carries the answer —
            // but a background sweep has no user, and every audit entry written from one was
            // being logged as a warning and dropped. Which is the worst possible failure for an
            // audit trail: the act happens, and the only record that it happened is the record
            // that says nothing was recorded.
            var org = organizationId ?? _currentUser.OrganizationId ?? _tenant.OrganizationId;
            if (org is null)
            {
                // Now genuinely no answer: no caller, no user, no tenant. Louder than before,
                // because with three sources this means something is wrong rather than that a
                // background job simply has no session.
                _logger.LogError(
                    "Audit record for {Action} on {EntityType} {EntityId} was dropped: no "
                    + "organization could be determined from the caller, the user or the tenant "
                    + "context. The act was performed and is not in the trail.",
                    action, entityType, entityId);
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
