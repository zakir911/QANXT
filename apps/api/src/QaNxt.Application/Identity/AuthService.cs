using QaNxt.Application.Abstractions;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Application.Identity;

public sealed record RegisterOrganizationRequest(string OrganizationName, string Email, string Password, string DisplayName);
public sealed record LoginRequest(string Email, string Password, string? OrganizationSlug);
public sealed record AuthenticatedUser(Guid UserId, Guid OrganizationId, string Email, string DisplayName,
    IReadOnlyCollection<string> Roles, IReadOnlyCollection<string> Permissions);
public sealed record AuthResult(string AccessToken, DateTimeOffset AccessTokenExpiresAt,
    string RefreshToken, DateTimeOffset RefreshTokenExpiresAt, AuthenticatedUser User);

public interface IAuthService
{
    Task<Result<AuthResult>> RegisterOrganizationAsync(RegisterOrganizationRequest request, string? ip, string? userAgent, CancellationToken ct = default);
    Task<Result<AuthResult>> LoginAsync(LoginRequest request, string? ip, string? userAgent, CancellationToken ct = default);
    Task<Result<AuthResult>> RefreshAsync(string refreshToken, string? ip, string? userAgent, CancellationToken ct = default);
    Task<Result> LogoutAsync(string refreshToken, CancellationToken ct = default);
    Task<Result<AuthenticatedUser>> GetCurrentUserAsync(CancellationToken ct = default);
}

/// <summary>Registration, login, refresh-token rotation and logout.</summary>
public sealed class AuthService : IAuthService
{
    /// <summary>Lock-out policy: enough attempts to survive a typo, few enough to make
    /// online guessing impractical.</summary>
    private const int MaxFailedAttempts = 5;
    private static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(15);
    private const int MinimumPasswordLength = 12;

    private readonly IQaNxtDbContext _db;
    private readonly IPasswordHasher _hasher;
    private readonly ITokenService _tokens;
    private readonly IClock _clock;
    private readonly ITenantContext _tenant;
    private readonly ICurrentUser _currentUser;
    private readonly IAuditLogger _audit;
    private readonly ILogger<AuthService> _logger;

    public AuthService(IQaNxtDbContext db, IPasswordHasher hasher, ITokenService tokens, IClock clock,
        ITenantContext tenant, ICurrentUser currentUser, IAuditLogger audit, ILogger<AuthService> logger)
    {
        _db = db;
        _hasher = hasher;
        _tokens = tokens;
        _clock = clock;
        _tenant = tenant;
        _currentUser = currentUser;
        _audit = audit;
        _logger = logger;
    }

    public async Task<Result<AuthResult>> RegisterOrganizationAsync(RegisterOrganizationRequest request,
        string? ip, string? userAgent, CancellationToken ct = default)
    {
        var validation = ValidateRegistration(request);
        if (validation is not null) return Result<AuthResult>.Failure(validation);

        var slug = Slugify(request.OrganizationName);
        var normalizedEmail = request.Email.Trim().ToLowerInvariant();

        using (_tenant.EnterSystemContext("organization registration"))
        {
            if (await _db.Organizations.AnyAsync(o => o.Slug == slug, ct))
                return Error.Conflict("organization_exists", $"An organization with the identifier '{slug}' already exists.");

            var now = _clock.UtcNow;
            var organization = new Organization { Name = request.OrganizationName.Trim(), Slug = slug, CreatedAt = now };
            _db.Organizations.Add(organization);

            var user = new User
            {
                OrganizationId = organization.Id,
                Email = request.Email.Trim(),
                NormalizedEmail = normalizedEmail,
                DisplayName = request.DisplayName.Trim(),
                PasswordHash = _hasher.Hash(request.Password),
                Status = UserStatus.Active,
                CreatedAt = now
            };
            _db.Users.Add(user);

            // The first user of a new organization owns it.
            var adminRole = await _db.Roles.FirstOrDefaultAsync(r => r.IsBuiltIn && r.SystemRole == SystemRole.OrganizationAdmin, ct);
            if (adminRole is null)
                return Error.Dependency("roles_not_seeded", "Built-in roles are missing. Restart the API so reference data is reconciled.");

            _db.UserRoles.Add(new UserRole { UserId = user.Id, RoleId = adminRole.Id, AssignedAt = now });
            await _db.SaveChangesAsync(ct);

            await _audit.LogAsync(AuditAction.OrganizationCreated, nameof(Organization), organization.Id,
                $"Organization '{organization.Name}' registered by {user.Email}.",
                organizationId: organization.Id, userId: user.Id, userEmail: user.Email, ct: ct);

            _tenant.SetOrganization(organization.Id);
            return await IssueAsync(user, ip, userAgent, ct);
        }
    }

    public async Task<Result<AuthResult>> LoginAsync(LoginRequest request, string? ip, string? userAgent, CancellationToken ct = default)
    {
        var normalizedEmail = request.Email?.Trim().ToLowerInvariant() ?? string.Empty;
        if (string.IsNullOrEmpty(normalizedEmail) || string.IsNullOrEmpty(request.Password))
            return Error.Validation("Email and password are required.");

        using (_tenant.EnterSystemContext("login lookup"))
        {
            var query = _db.Users.Include(u => u.Organization).Where(u => u.NormalizedEmail == normalizedEmail);
            if (!string.IsNullOrWhiteSpace(request.OrganizationSlug))
            {
                var slug = request.OrganizationSlug!.Trim().ToLowerInvariant();
                query = query.Where(u => u.Organization!.Slug == slug);
            }

            var candidates = await query.ToListAsync(ct);

            // The same address can exist in several organizations; without a slug the login
            // is ambiguous and is refused rather than guessed at.
            if (candidates.Count > 1)
                return Error.Validation("This email belongs to more than one organization. Supply the organization identifier.");

            var user = candidates.FirstOrDefault();
            var now = _clock.UtcNow;

            if (user is null)
            {
                // Hash anyway so a missing account and a wrong password take the same time.
                _hasher.Verify(request.Password, "v1.210000.AAAAAAAAAAAAAAAAAAAAAA==.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
                _logger.LogWarning("Login failed for unknown account {Email}", normalizedEmail);
                return Error.Unauthorized("Invalid email or password.");
            }

            if (user.LockedUntil is not null && user.LockedUntil > now)
                return Error.Unauthorized($"This account is locked until {user.LockedUntil:u} after repeated failed sign-in attempts.");

            // Invited is allowed through: it means an administrator created the account and
            // nobody has used it yet. Refusing it would make every invitation a dead end.
            // Suspended and Disabled are refused, and so is a soft-deleted account.
            if (user.Status is not (UserStatus.Active or UserStatus.Invited))
                return Error.Unauthorized("This account is not active.");

            if (!_hasher.Verify(request.Password, user.PasswordHash))
            {
                user.FailedLoginAttempts++;
                if (user.FailedLoginAttempts >= MaxFailedAttempts)
                {
                    user.LockedUntil = now.Add(LockoutDuration);
                    user.FailedLoginAttempts = 0;
                    _logger.LogWarning("Account {UserId} locked after {Max} failed attempts", user.Id, MaxFailedAttempts);
                }
                await _db.SaveChangesAsync(ct);
                await _audit.LogAsync(AuditAction.LoginFailed, nameof(User), user.Id, "Failed sign-in attempt.",
                    succeeded: false, organizationId: user.OrganizationId, userId: user.Id, userEmail: user.Email, ct: ct);
                return Error.Unauthorized("Invalid email or password.");
            }

            user.FailedLoginAttempts = 0;
            user.LockedUntil = null;
            user.LastLoginAt = now;

            // The first successful sign-in is what turns an invitation into an account in
            // use, which is the distinction the audit trail is keeping.
            if (user.Status == UserStatus.Invited) user.Status = UserStatus.Active;

            if (_hasher.NeedsRehash(user.PasswordHash))
            {
                // Silently upgrade the stored hash now that we hold the plaintext.
                user.PasswordHash = _hasher.Hash(request.Password);
                _logger.LogInformation("Upgraded password hash parameters for user {UserId}", user.Id);
            }

            await _db.SaveChangesAsync(ct);
            _tenant.SetOrganization(user.OrganizationId);

            await _audit.LogAsync(AuditAction.Login, nameof(User), user.Id, "Signed in.",
                organizationId: user.OrganizationId, userId: user.Id, userEmail: user.Email, ct: ct);

            return await IssueAsync(user, ip, userAgent, ct);
        }
    }

    public async Task<Result<AuthResult>> RefreshAsync(string refreshToken, string? ip, string? userAgent, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(refreshToken)) return Error.Validation("A refresh token is required.");
        var hash = _tokens.HashRefreshToken(refreshToken);

        using (_tenant.EnterSystemContext("refresh token rotation"))
        {
            var stored = await _db.RefreshTokens
                .Include(t => t.User)
                .FirstOrDefaultAsync(t => t.TokenHash == hash, ct);

            if (stored?.User is null) return Error.Unauthorized("The refresh token is not recognised.");

            var now = _clock.UtcNow;
            if (!stored.IsActive(now))
            {
                // Presenting an already-rotated token means it leaked: revoke the whole family.
                if (stored.RevokedAt is not null)
                {
                    await RevokeDescendantsAsync(stored, "reuse of a rotated refresh token detected", ct);
                    _logger.LogWarning("Refresh token reuse detected for user {UserId}; token family revoked.", stored.UserId);
                }
                return Error.Unauthorized("The refresh token has expired or been revoked.");
            }

            if (stored.User.Status != UserStatus.Active) return Error.Unauthorized("This account is not active.");

            _tenant.SetOrganization(stored.OrganizationId);
            var result = await IssueAsync(stored.User, ip, userAgent, ct);
            if (result.IsFailure) return result;

            stored.RevokedAt = now;
            stored.RevokedReason = "rotated";
            var replacement = await _db.RefreshTokens
                .Where(t => t.UserId == stored.UserId && t.TokenHash == _tokens.HashRefreshToken(result.Value!.RefreshToken))
                .FirstOrDefaultAsync(ct);
            stored.ReplacedByTokenId = replacement?.Id;
            await _db.SaveChangesAsync(ct);

            return result;
        }
    }

    public async Task<Result> LogoutAsync(string refreshToken, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(refreshToken)) return Result.Success();
        var hash = _tokens.HashRefreshToken(refreshToken);

        using (_tenant.EnterSystemContext("logout"))
        {
            var stored = await _db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, ct);
            if (stored is not null && stored.RevokedAt is null)
            {
                stored.RevokedAt = _clock.UtcNow;
                stored.RevokedReason = "signed out";
                await _db.SaveChangesAsync(ct);
                await _audit.LogAsync(AuditAction.Logout, nameof(User), stored.UserId, "Signed out.",
                    organizationId: stored.OrganizationId, userId: stored.UserId, ct: ct);
            }
        }

        return Result.Success();
    }

    public async Task<Result<AuthenticatedUser>> GetCurrentUserAsync(CancellationToken ct = default)
    {
        if (_currentUser.UserId is null) return Error.Unauthorized();

        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == _currentUser.UserId, ct);
        if (user is null) return Error.NotFound("The signed-in user");

        var (roles, permissions) = await ResolveAccessAsync(user, ct);
        return Result<AuthenticatedUser>.Success(new AuthenticatedUser(
            user.Id, user.OrganizationId, user.Email, user.DisplayName, roles, permissions));
    }

    private async Task<Result<AuthResult>> IssueAsync(User user, string? ip, string? userAgent, CancellationToken ct)
    {
        var (roles, permissions) = await ResolveAccessAsync(user, ct);
        var issued = _tokens.Issue(user, permissions, roles);

        _db.RefreshTokens.Add(new RefreshToken
        {
            OrganizationId = user.OrganizationId,
            UserId = user.Id,
            TokenHash = _tokens.HashRefreshToken(issued.RefreshToken),
            ExpiresAt = issued.RefreshTokenExpiresAt,
            CreatedByIp = ip,
            UserAgent = Truncate(userAgent, 400),
            CreatedAt = _clock.UtcNow
        });
        await _db.SaveChangesAsync(ct);

        return Result<AuthResult>.Success(new AuthResult(
            issued.AccessToken, issued.AccessTokenExpiresAt, issued.RefreshToken, issued.RefreshTokenExpiresAt,
            new AuthenticatedUser(user.Id, user.OrganizationId, user.Email, user.DisplayName, roles, permissions)));
    }

    /// <summary>Effective access is the union of organization-wide roles and project-scoped
    /// memberships, expanded to permissions.</summary>
    private async Task<(IReadOnlyCollection<string> Roles, IReadOnlyCollection<string> Permissions)> ResolveAccessAsync(User user, CancellationToken ct)
    {
        var roleIds = await _db.UserRoles.Where(ur => ur.UserId == user.Id).Select(ur => ur.RoleId).ToListAsync(ct);
        var projectRoleIds = await _db.ProjectMembers.Where(pm => pm.UserId == user.Id).Select(pm => pm.RoleId).ToListAsync(ct);
        var allRoleIds = roleIds.Concat(projectRoleIds).Distinct().ToList();

        var roles = await _db.Roles.Where(r => allRoleIds.Contains(r.Id)).Select(r => r.Name).ToListAsync(ct);
        var permissions = await _db.RolePermissions
            .Where(rp => allRoleIds.Contains(rp.RoleId))
            .Select(rp => rp.Permission!.Name)
            .Distinct()
            .ToListAsync(ct);

        return (roles, permissions);
    }

    private async Task RevokeDescendantsAsync(RefreshToken token, string reason, CancellationToken ct)
    {
        var active = await _db.RefreshTokens
            .Where(t => t.UserId == token.UserId && t.RevokedAt == null)
            .ToListAsync(ct);
        var now = _clock.UtcNow;
        foreach (var item in active)
        {
            item.RevokedAt = now;
            item.RevokedReason = reason;
        }
        await _db.SaveChangesAsync(ct);
    }

    private static Error? ValidateRegistration(RegisterOrganizationRequest request)
    {
        var errors = new Dictionary<string, string[]>();
        if (string.IsNullOrWhiteSpace(request.OrganizationName))
            errors["organizationName"] = new[] { "An organization name is required." };
        if (string.IsNullOrWhiteSpace(request.DisplayName))
            errors["displayName"] = new[] { "A display name is required." };
        if (string.IsNullOrWhiteSpace(request.Email) || !request.Email.Contains('@'))
            errors["email"] = new[] { "A valid email address is required." };
        if (string.IsNullOrEmpty(request.Password) || request.Password.Length < MinimumPasswordLength)
            errors["password"] = new[] { $"The password must be at least {MinimumPasswordLength} characters." };
        else if (!request.Password.Any(char.IsDigit) || !request.Password.Any(char.IsLetter))
            errors["password"] = new[] { "The password must contain both letters and digits." };

        return errors.Count == 0 ? null : Error.Validation("The registration details are not valid.", errors);
    }

    private static string Slugify(string value)
    {
        var chars = value.Trim().ToLowerInvariant()
            .Select(c => char.IsLetterOrDigit(c) ? c : '-')
            .ToArray();
        var slug = new string(chars);
        while (slug.Contains("--", StringComparison.Ordinal)) slug = slug.Replace("--", "-", StringComparison.Ordinal);
        slug = slug.Trim('-');
        return slug.Length > 100 ? slug[..100] : slug;
    }

    private static string? Truncate(string? value, int max) =>
        value is null ? null : value.Length <= max ? value : value[..max];
}
