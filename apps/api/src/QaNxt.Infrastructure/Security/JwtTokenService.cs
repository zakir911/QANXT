using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using QaNxt.Application.Abstractions;
using QaNxt.Domain.Identity;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace QaNxt.Infrastructure.Security;

/// <summary>Issues short-lived access tokens carrying the caller's tenant, permissions and
/// security stamp, plus opaque refresh tokens that are only ever stored as hashes.</summary>
public sealed class JwtTokenService : ITokenService
{
    public const string OrganizationClaim = "org";
    public const string PermissionClaim = "perm";
    public const string SecurityStampClaim = "sstamp";
    public const string TokenKindClaim = "kind";
    public const string WorkerJobClaim = "job";
    public const string WorkerScopeClaim = "wscope";

    private readonly JwtOptions _options;
    private readonly IClock _clock;
    private readonly SigningCredentials _credentials;

    public JwtTokenService(IOptions<JwtOptions> options, IClock clock)
    {
        _options = options.Value;
        _clock = clock;

        if (string.IsNullOrWhiteSpace(_options.Secret) || _options.Secret.Length < JwtOptions.MinimumSecretLength)
            throw new InvalidOperationException(
                $"JWT_SECRET must be at least {JwtOptions.MinimumSecretLength} characters. Generate one with: openssl rand -base64 48");

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_options.Secret));
        _credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
    }

    public IssuedTokens Issue(User user, IReadOnlyCollection<string> permissions, IReadOnlyCollection<string> roles)
    {
        var now = _clock.UtcNow;
        var expires = now.AddMinutes(_options.AccessTokenMinutes);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new(JwtRegisteredClaimNames.Email, user.Email),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            new(ClaimTypes.Name, user.DisplayName),
            new(OrganizationClaim, user.OrganizationId.ToString()),
            new(SecurityStampClaim, user.SecurityStamp),
            new(TokenKindClaim, "user")
        };
        claims.AddRange(roles.Select(r => new Claim(ClaimTypes.Role, r)));
        claims.AddRange(permissions.Select(p => new Claim(PermissionClaim, p)));

        var token = new JwtSecurityToken(
            issuer: _options.Issuer,
            audience: _options.Audience,
            claims: claims,
            notBefore: now.UtcDateTime,
            expires: expires.UtcDateTime,
            signingCredentials: _credentials);

        var accessToken = new JwtSecurityTokenHandler().WriteToken(token);
        var refreshToken = GenerateRefreshToken();

        return new IssuedTokens(accessToken, expires, refreshToken, now.AddDays(_options.RefreshTokenDays));
    }

    /// <summary>A worker token authorizes exactly one job on exactly one set of callback
    /// endpoints, and expires with the job. A stolen worker token is therefore worth very
    /// little: it cannot read tests, browse artifacts or touch another tenant.</summary>
    public string IssueWorkerToken(Guid organizationId, Guid jobId, string scope, TimeSpan lifetime)
    {
        var now = _clock.UtcNow;
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, $"worker:{jobId}"),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            new(OrganizationClaim, organizationId.ToString()),
            new(WorkerJobClaim, jobId.ToString()),
            new(WorkerScopeClaim, scope),
            new(TokenKindClaim, "worker")
        };

        var token = new JwtSecurityToken(
            issuer: _options.Issuer,
            audience: _options.Audience,
            claims: claims,
            notBefore: now.UtcDateTime,
            expires: now.Add(lifetime).UtcDateTime,
            signingCredentials: _credentials);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    public string HashRefreshToken(string refreshToken)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(refreshToken));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static string GenerateRefreshToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(48))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
}
