using QaNxt.Domain.Common;

namespace QaNxt.Domain.Identity;

/// <summary>Stored as a SHA-256 hash: a database leak must not yield usable tokens.
/// Rotation is enforced — using a token marks it replaced, and reuse of a replaced
/// token revokes the whole chain.</summary>
public class RefreshToken : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid UserId { get; set; }
    public User? User { get; set; }

    public string TokenHash { get; set; } = string.Empty;
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public string? RevokedReason { get; set; }
    public Guid? ReplacedByTokenId { get; set; }
    public string? CreatedByIp { get; set; }
    public string? UserAgent { get; set; }

    public bool IsActive(DateTimeOffset now) => RevokedAt is null && now < ExpiresAt;
}
