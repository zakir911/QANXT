using QaNxt.Application.Abstractions;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Application.Identity;

public sealed record InviteUserRequest(string Email, string DisplayName, SystemRole Role);

public sealed record UpdateUserRequest(string? DisplayName, SystemRole? Role, UserStatus? Status);

public sealed record UserSummary(
    Guid Id, string Email, string DisplayName, UserStatus Status,
    IReadOnlyCollection<string> Roles, DateTimeOffset CreatedAt, DateTimeOffset? LastLoginAt,
    bool IsLockedOut);

/// <summary>What an invitation produces. The one-time password is returned exactly once,
/// here, and never stored in a readable form or written to a log.</summary>
public sealed record InvitedUser(UserSummary User, string TemporaryPassword, string HandoverNote);

public interface IUserService
{
    Task<IReadOnlyList<UserSummary>> ListAsync(CancellationToken ct = default);
    Task<Result<InvitedUser>> InviteAsync(InviteUserRequest request, CancellationToken ct = default);
    Task<Result<UserSummary>> UpdateAsync(Guid id, UpdateUserRequest request, CancellationToken ct = default);
    Task<Result<InvitedUser>> ResetPasswordAsync(Guid id, CancellationToken ct = default);
}

/// <summary>Managing the people in an organization.
///
/// Registration creates an organization's first administrator; without this, that is the
/// only account it can ever have, and a seven-role permission matrix that can only describe
/// one person is decoration.
///
/// There is no mail transport in this platform, so an invitation cannot send anything. It
/// returns a generated one-time password to the administrator who created it, once, to be
/// handed over out of band. That is stated plainly rather than hidden behind a word like
/// "invite" that implies an email nobody sent.</summary>
public sealed class UserService : IUserService
{
    /// <summary>Long enough that a generated password is not worth attacking, and made of
    /// characters that survive being copied out of a terminal and into a browser.</summary>
    private const int TemporaryPasswordBytes = 24;

    private readonly IQaNxtDbContext _db;
    private readonly IPasswordHasher _hasher;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly ILogger<UserService> _logger;

    public UserService(IQaNxtDbContext db, IPasswordHasher hasher, ICurrentUser currentUser,
        IClock clock, IAuditLogger audit, ILogger<UserService> logger)
    {
        _db = db;
        _hasher = hasher;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
        _logger = logger;
    }

    public async Task<IReadOnlyList<UserSummary>> ListAsync(CancellationToken ct = default)
    {
        var now = _clock.UtcNow;

        // The tenant filter on Users is what scopes this; there is deliberately no
        // organization predicate to forget.
        var users = await _db.Users.AsNoTracking()
            .OrderBy(u => u.DisplayName)
            .Select(u => new
            {
                u.Id, u.Email, u.DisplayName, u.Status, u.CreatedAt, u.LastLoginAt, u.LockedUntil,
                Roles = _db.UserRoles.Where(ur => ur.UserId == u.Id)
                    .Join(_db.Roles, ur => ur.RoleId, r => r.Id, (_, r) => r.Name)
                    .ToList()
            })
            .ToListAsync(ct);

        return users.Select(u => new UserSummary(
            u.Id, u.Email, u.DisplayName, u.Status, u.Roles, u.CreatedAt, u.LastLoginAt,
            u.LockedUntil > now)).ToList();
    }

    public async Task<Result<InvitedUser>> InviteAsync(InviteUserRequest request, CancellationToken ct = default)
    {
        var organizationId = _currentUser.OrganizationId;
        if (organizationId is null) return Error.Unauthorized();

        if (Validate(request) is { } invalid) return Result<InvitedUser>.Failure(invalid);

        var normalizedEmail = request.Email.Trim().ToLowerInvariant();
        if (await _db.Users.AnyAsync(u => u.NormalizedEmail == normalizedEmail, ct))
        {
            return Error.Conflict("email_taken", "Someone with that email is already in this organization.");
        }

        var role = await FindRoleAsync(request.Role, ct);
        if (role is null)
        {
            return Error.Validation($"The role '{request.Role}' does not exist in this deployment.");
        }

        var temporaryPassword = GeneratePassword();
        var now = _clock.UtcNow;

        var user = new User
        {
            OrganizationId = organizationId.Value,
            Email = request.Email.Trim(),
            NormalizedEmail = normalizedEmail,
            DisplayName = request.DisplayName.Trim(),
            PasswordHash = _hasher.Hash(temporaryPassword),
            // Invited rather than Active: the distinction records that nobody has signed in
            // as this account yet, which matters when auditing who did what.
            Status = UserStatus.Invited,
            CreatedAt = now
        };

        _db.Users.Add(user);
        await _db.SaveChangesAsync(ct);

        _db.UserRoles.Add(new UserRole { UserId = user.Id, RoleId = role.Id, AssignedAt = now });
        await _db.SaveChangesAsync(ct);

        // The password is never in the audit entry, and the masker would strip it anyway.
        await _audit.LogAsync(AuditAction.UserCreated, nameof(User), user.Id,
            $"Invited {user.Email} as {role.Name}.", ct: ct);

        _logger.LogInformation("User {UserId} invited as {Role}", user.Id, role.Name);

        return Result<InvitedUser>.Success(new InvitedUser(
            new UserSummary(user.Id, user.Email, user.DisplayName, user.Status,
                new[] { role.Name }, user.CreatedAt, null, false),
            temporaryPassword,
            "This password is shown once and cannot be retrieved again. Send it to them over a "
            + "channel you trust, and have them change it after signing in. If it is lost, reset "
            + "the account rather than looking for it."));
    }

    public async Task<Result<UserSummary>> UpdateAsync(Guid id, UpdateUserRequest request, CancellationToken ct = default)
    {
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Error.NotFound("The user");

        var changes = new List<string>();

        if (!string.IsNullOrWhiteSpace(request.DisplayName) && request.DisplayName.Trim() != user.DisplayName)
        {
            changes.Add($"name '{user.DisplayName}' to '{request.DisplayName.Trim()}'");
            user.DisplayName = request.DisplayName.Trim();
        }

        if (request.Status is { } status && status != user.Status)
        {
            if (user.Id == _currentUser.UserId && status != UserStatus.Active)
            {
                // Locking yourself out of the only administrator account is unrecoverable
                // without database access, so it is refused rather than confirmed.
                return Error.Validation("You cannot disable your own account.");
            }

            if (await WouldRemoveLastAdministratorAsync(user, status, null, ct))
            {
                return Error.Validation(
                    "This is the only active administrator. Promote someone else first, or the "
                    + "organization would have nobody who can manage it.");
            }

            changes.Add($"status {user.Status} to {status}");
            user.Status = status;

            // Disabling has to take effect now, not when the current token happens to
            // expire; rotating the stamp invalidates every session this account holds.
            if (status is UserStatus.Disabled or UserStatus.Suspended)
            {
                user.SecurityStamp = Guid.NewGuid().ToString("N");
                await RevokeRefreshTokensAsync(user.Id, ct);
            }
        }

        if (request.Role is { } requestedRole)
        {
            var role = await FindRoleAsync(requestedRole, ct);
            if (role is null) return Error.Validation($"The role '{requestedRole}' does not exist.");

            var existing = await _db.UserRoles.Where(ur => ur.UserId == user.Id).ToListAsync(ct);
            if (existing.Count != 1 || existing[0].RoleId != role.Id)
            {
                if (await WouldRemoveLastAdministratorAsync(user, null, requestedRole, ct))
                {
                    return Error.Validation(
                        "This is the only active administrator. Promote someone else first.");
                }

                _db.UserRoles.RemoveRange(existing);
                _db.UserRoles.Add(new UserRole { UserId = user.Id, RoleId = role.Id, AssignedAt = _clock.UtcNow });
                changes.Add($"role to {role.Name}");

                // A changed role changes what every existing token claims, so those tokens
                // have to stop being accepted.
                user.SecurityStamp = Guid.NewGuid().ToString("N");
                await RevokeRefreshTokensAsync(user.Id, ct);
            }
        }

        if (changes.Count == 0)
        {
            return Result<UserSummary>.Success(await SummariseAsync(user, ct));
        }

        user.UpdatedAt = _clock.UtcNow;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(
            request.Role is not null ? AuditAction.RoleChanged : AuditAction.UserUpdated,
            nameof(User), user.Id,
            $"Changed {user.Email}: {string.Join("; ", changes)}.", ct: ct);

        return Result<UserSummary>.Success(await SummariseAsync(user, ct));
    }

    public async Task<Result<InvitedUser>> ResetPasswordAsync(Guid id, CancellationToken ct = default)
    {
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
        if (user is null) return Result<InvitedUser>.Failure(Error.NotFound("The user"));

        var temporaryPassword = GeneratePassword();
        user.PasswordHash = _hasher.Hash(temporaryPassword);
        // A reset exists because an account may be compromised, so every session it holds
        // has to end with it.
        user.SecurityStamp = Guid.NewGuid().ToString("N");
        user.FailedLoginAttempts = 0;
        user.LockedUntil = null;
        user.UpdatedAt = _clock.UtcNow;

        await RevokeRefreshTokensAsync(user.Id, ct);
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.UserUpdated, nameof(User), user.Id,
            $"Reset the password for {user.Email} and ended its sessions.", ct: ct);

        return Result<InvitedUser>.Success(new InvitedUser(
            await SummariseAsync(user, ct),
            temporaryPassword,
            "Every session this account held has been ended. The password is shown once; send it "
            + "over a channel you trust."));
    }

    private async Task RevokeRefreshTokensAsync(Guid userId, CancellationToken ct)
    {
        var tokens = await _db.RefreshTokens
            .Where(t => t.UserId == userId && t.RevokedAt == null)
            .ToListAsync(ct);

        foreach (var token in tokens)
        {
            token.RevokedAt = _clock.UtcNow;
            token.RevokedReason = "The account was changed by an administrator.";
        }
    }

    /// <summary>An organization with no administrator cannot be administered, and nothing in
    /// the product can fix that from the outside.</summary>
    private async Task<bool> WouldRemoveLastAdministratorAsync(
        User user, UserStatus? newStatus, SystemRole? newRole, CancellationToken ct)
    {
        var adminRoleIds = await _db.Roles
            .Where(r => r.SystemRole == SystemRole.OrganizationAdmin || r.SystemRole == SystemRole.SuperAdmin)
            .Select(r => r.Id)
            .ToListAsync(ct);

        var isAdmin = await _db.UserRoles
            .AnyAsync(ur => ur.UserId == user.Id && adminRoleIds.Contains(ur.RoleId), ct);
        if (!isAdmin) return false;

        var staysAdmin = newRole is null or SystemRole.OrganizationAdmin or SystemRole.SuperAdmin;
        var staysActive = newStatus is null or UserStatus.Active;
        if (staysAdmin && staysActive) return false;

        var otherActiveAdmins = await _db.Users
            .Where(u => u.Id != user.Id && u.Status == UserStatus.Active)
            .Join(_db.UserRoles, u => u.Id, ur => ur.UserId, (u, ur) => ur.RoleId)
            .CountAsync(roleId => adminRoleIds.Contains(roleId), ct);

        return otherActiveAdmins == 0;
    }

    private async Task<Role?> FindRoleAsync(SystemRole role, CancellationToken ct)
        => await _db.Roles.FirstOrDefaultAsync(r => r.IsBuiltIn && r.SystemRole == role, ct);

    private async Task<UserSummary> SummariseAsync(User user, CancellationToken ct)
    {
        var roles = await _db.UserRoles
            .Where(ur => ur.UserId == user.Id)
            .Join(_db.Roles, ur => ur.RoleId, r => r.Id, (_, r) => r.Name)
            .ToListAsync(ct);

        return new UserSummary(user.Id, user.Email, user.DisplayName, user.Status, roles,
            user.CreatedAt, user.LastLoginAt, user.LockedUntil > _clock.UtcNow);
    }

    private static Error? Validate(InviteUserRequest request)
    {
        var errors = new Dictionary<string, string[]>();

        var email = request.Email?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(email))
            errors["email"] = new[] { "An email address is required." };
        else if (!email.Contains('@', StringComparison.Ordinal) || email.Length > 320)
            errors["email"] = new[] { "That does not look like an email address." };

        if (string.IsNullOrWhiteSpace(request.DisplayName))
            errors["displayName"] = new[] { "A name is required." };
        else if (request.DisplayName.Trim().Length > 200)
            errors["displayName"] = new[] { "The name must be 200 characters or fewer." };

        if (!Enum.IsDefined(request.Role))
            errors["role"] = new[] { "That is not a role this platform has." };
        else if (request.Role == SystemRole.SuperAdmin)
            errors["role"] = new[] { "SuperAdmin cannot be granted through an invitation." };

        return errors.Count == 0 ? null : Error.Validation("The invitation is not valid.", errors);
    }

    /// <summary>A URL-safe random password. Generated rather than chosen, because a password
    /// an administrator invents for somebody else tends to be one they reuse.</summary>
    private static string GeneratePassword()
        => Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(TemporaryPasswordBytes))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
}
