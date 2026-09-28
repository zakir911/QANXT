using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Audit;

/// <summary>Append-only record of security- and governance-relevant actions. The API
/// exposes no update or delete path; the database role used by the application is granted
/// INSERT and SELECT only on this table.</summary>
public class AuditLog : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid? ProjectId { get; set; }
    public Guid? UserId { get; set; }
    public string? UserEmail { get; set; }

    public AuditAction Action { get; set; }
    public string EntityType { get; set; } = string.Empty;
    public Guid? EntityId { get; set; }
    public string Summary { get; set; } = string.Empty;
    /// <summary>Before/after values for configuration changes, with secrets redacted.</summary>
    public string? ChangesJson { get; set; }

    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }
    public string? CorrelationId { get; set; }
    public bool Succeeded { get; set; } = true;
    public DateTimeOffset OccurredAt { get; set; }
}
