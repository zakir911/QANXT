using QaNxt.Application.Abstractions;
using QaNxt.Domain.Audit;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Application.Audit;

/// <param name="Action">One action, when you already know which one you are looking for.</param>
/// <param name="EntityType">The kind of thing acted on, e.g. <c>Schedule</c>.</param>
/// <param name="EntityId">One specific thing's whole history.</param>
/// <param name="CorrelationId">Everything one request did, which is how a log line becomes a story.</param>
/// <param name="UserEmail">Everything one person did.</param>
/// <param name="Succeeded">Failures only, which is the query a security review actually runs.</param>
public sealed record AuditQuery(
    AuditAction? Action = null,
    string? EntityType = null,
    Guid? EntityId = null,
    string? CorrelationId = null,
    string? UserEmail = null,
    Guid? ProjectId = null,
    bool? Succeeded = null,
    DateTimeOffset? From = null,
    DateTimeOffset? To = null,
    int Limit = 50,
    int Offset = 0);

public sealed record AuditEntry(
    Guid Id, Guid OrganizationId, Guid? ProjectId, Guid? UserId, string? UserEmail,
    AuditAction Action, string EntityType, Guid? EntityId, string Summary,
    string? ChangesJson, string? IpAddress, string? UserAgent, string? CorrelationId,
    bool Succeeded, DateTimeOffset OccurredAt);

/// <param name="Total">Matching records ignoring paging, so a reader knows what they are not seeing.</param>
public sealed record AuditPage(IReadOnlyList<AuditEntry> Entries, int Total, int Limit, int Offset);

public interface IAuditQueryService
{
    Task<AuditPage> QueryAsync(AuditQuery query, CancellationToken ct = default);
}

/// <summary>
/// Reading the audit trail.
/// </summary>
/// <remarks>
/// The writes have always been correct. Nothing read them: no endpoint, no command, no
/// screen, and the <c>audit:read</c> permission was defined and granted to project
/// administrators without a single endpoint requiring it (BUG-0034). A governance record
/// nobody can retrieve is a control in name only, and the gap was invisible from the code,
/// because every call site looked right.
///
/// Read-only by construction. There is no update or delete here and none is planned: the
/// application's database role holds INSERT and SELECT on the table, so append-only is a
/// property of the deployment rather than a convention this class is trusted to keep.
///
/// Tenant scoping is not done here either. <see cref="AuditLog"/> is <c>ITenantOwned</c>, so
/// the context's global query filter constrains every query to the caller's organization
/// before this code sees a row. Re-filtering by hand would add a second place for the rule
/// to be wrong.
/// </remarks>
public sealed class AuditQueryService : IAuditQueryService
{
    /// <summary>Most records one page may return, however large a limit is asked for.</summary>
    public const int MaxLimit = 200;

    private readonly IQaNxtDbContext _db;
    public AuditQueryService(IQaNxtDbContext db) => _db = db;

    public async Task<AuditPage> QueryAsync(AuditQuery query, CancellationToken ct = default)
    {
        var limit = Math.Clamp(query.Limit, 1, MaxLimit);
        var offset = Math.Max(query.Offset, 0);

        var rows = _db.AuditLogs.AsNoTracking();

        if (query.Action is not null) rows = rows.Where(e => e.Action == query.Action);
        if (query.EntityId is not null) rows = rows.Where(e => e.EntityId == query.EntityId);
        if (query.ProjectId is not null) rows = rows.Where(e => e.ProjectId == query.ProjectId);
        if (query.Succeeded is not null) rows = rows.Where(e => e.Succeeded == query.Succeeded);
        if (query.From is not null) rows = rows.Where(e => e.OccurredAt >= query.From);
        if (query.To is not null) rows = rows.Where(e => e.OccurredAt <= query.To);

        if (!string.IsNullOrWhiteSpace(query.EntityType))
        {
            var entityType = query.EntityType.Trim();
            rows = rows.Where(e => e.EntityType == entityType);
        }

        if (!string.IsNullOrWhiteSpace(query.CorrelationId))
        {
            var correlationId = query.CorrelationId.Trim();
            rows = rows.Where(e => e.CorrelationId == correlationId);
        }

        if (!string.IsNullOrWhiteSpace(query.UserEmail))
        {
            // Matched exactly rather than by prefix: a partial match over an email column
            // turns a review endpoint into a way to enumerate an organization's users.
            var email = query.UserEmail.Trim();
            rows = rows.Where(e => e.UserEmail == email);
        }

        // Counted before paging, so "50 of 3,214" is possible. A page that cannot say how
        // much it is not showing invites the reader to assume it is showing everything.
        var total = await rows.CountAsync(ct).ConfigureAwait(false);

        // Newest first, tie-broken on id: two records written in the same tick otherwise come
        // back in whatever order the database chose, and pages then overlap or skip rows.
        var entries = await rows
            .OrderByDescending(e => e.OccurredAt).ThenByDescending(e => e.Id)
            .Skip(offset).Take(limit)
            .Select(e => new AuditEntry(
                e.Id, e.OrganizationId, e.ProjectId, e.UserId, e.UserEmail,
                e.Action, e.EntityType, e.EntityId, e.Summary,
                e.ChangesJson, e.IpAddress, e.UserAgent, e.CorrelationId,
                e.Succeeded, e.OccurredAt))
            .ToListAsync(ct).ConfigureAwait(false);

        return new AuditPage(entries, total, limit, offset);
    }
}
