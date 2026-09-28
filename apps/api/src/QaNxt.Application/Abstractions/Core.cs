using QaNxt.Domain.Enums;

namespace QaNxt.Application.Abstractions;

/// <summary>Time is a dependency so that expiry, retention and scheduling are testable.</summary>
public interface IClock
{
    DateTimeOffset UtcNow { get; }
}

/// <summary>The tenant the current unit of work belongs to. Bound by middleware from the
/// caller's token, or set explicitly (and audibly) by system jobs.</summary>
public interface ITenantContext
{
    Guid? OrganizationId { get; }
    bool IsSystemContext { get; }
    void SetOrganization(Guid organizationId);
    /// <summary>Elevates to a cross-tenant context for a background job. Every caller of this
    /// is expected to be a system job, and the elevation is logged.</summary>
    IDisposable EnterSystemContext(string reason);
}

/// <summary>The authenticated principal, projected into the shape use cases need.</summary>
public interface ICurrentUser
{
    Guid? UserId { get; }
    Guid? OrganizationId { get; }
    string? Email { get; }
    bool IsAuthenticated { get; }
    IReadOnlySet<string> Permissions { get; }
    bool HasPermission(string permission);
    string? CorrelationId { get; }
}

/// <summary>Correlation identifiers attached to every log line and forwarded to workers.</summary>
public interface ICorrelationContext
{
    string CorrelationId { get; }
    string? RequestId { get; }
}
