using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Identity;

public class User : BaseEntity, ITenantOwned, ISoftDeletable
{
    public Guid OrganizationId { get; set; }
    public Organization? Organization { get; set; }

    public string Email { get; set; } = string.Empty;
    /// <summary>Lower-cased email, unique per organization; used for lookup so that
    /// case differences cannot create duplicate accounts.</summary>
    public string NormalizedEmail { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;

    /// <summary>PBKDF2-HMAC-SHA256 hash. Never a reversible encryption of the password.</summary>
    public string PasswordHash { get; set; } = string.Empty;
    public UserStatus Status { get; set; } = UserStatus.Active;
    public DateTimeOffset? LastLoginAt { get; set; }
    public int FailedLoginAttempts { get; set; }
    public DateTimeOffset? LockedUntil { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }

    /// <summary>Invalidates every issued access token when bumped (password change, role change).</summary>
    public string SecurityStamp { get; set; } = Guid.NewGuid().ToString("N");

    public ICollection<UserRole> UserRoles { get; set; } = new List<UserRole>();
    public ICollection<ProjectMember> ProjectMemberships { get; set; } = new List<ProjectMember>();
    public ICollection<RefreshToken> RefreshTokens { get; set; } = new List<RefreshToken>();
}
