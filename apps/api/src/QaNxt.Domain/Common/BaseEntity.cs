namespace QaNxt.Domain.Common;

/// <summary>Base for every persisted entity. Identifiers are GUIDs so that
/// workers and the control plane can mint ids without a round trip.</summary>
public abstract class BaseEntity
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? UpdatedAt { get; set; }
}

/// <summary>Marks an entity as belonging to exactly one tenant (organization).
/// The DbContext applies a global query filter and a write-time guard to every
/// implementation, so isolation does not depend on callers remembering a filter.</summary>
public interface ITenantOwned
{
    Guid OrganizationId { get; set; }
}

/// <summary>Records who last touched an entity, for audit trails.</summary>
public interface IAuditable
{
    Guid? CreatedByUserId { get; set; }
    Guid? UpdatedByUserId { get; set; }
}

/// <summary>Entities that are soft-deleted rather than removed, so that historical
/// runs keep referring to something meaningful.</summary>
public interface ISoftDeletable
{
    DateTimeOffset? DeletedAt { get; set; }
}
