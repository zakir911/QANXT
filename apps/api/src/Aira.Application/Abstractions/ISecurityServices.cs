using Aira.Domain.Enums;
using Aira.Domain.Identity;

namespace Aira.Application.Abstractions;

/// <summary>Authenticated symmetric encryption for stored secrets (AES-256-GCM).
/// Ciphertexts are self-describing so keys can be rotated.</summary>
public interface ISecretProtector
{
    string Protect(string plaintext);
    string Unprotect(string ciphertext);
    bool TryUnprotect(string ciphertext, out string plaintext);
}

public interface IPasswordHasher
{
    string Hash(string password);
    bool Verify(string password, string hash);
    /// <summary>True when the stored hash used weaker parameters than the current policy.</summary>
    bool NeedsRehash(string hash);
}

public sealed record IssuedTokens(string AccessToken, DateTimeOffset AccessTokenExpiresAt,
    string RefreshToken, DateTimeOffset RefreshTokenExpiresAt);

public interface ITokenService
{
    IssuedTokens Issue(User user, IReadOnlyCollection<string> permissions, IReadOnlyCollection<string> roles);
    string HashRefreshToken(string refreshToken);
    /// <summary>Mints a scoped token for a browser worker, limited to one execution or
    /// discovery run and to the worker callback endpoints.</summary>
    string IssueWorkerToken(Guid organizationId, Guid jobId, string scope, TimeSpan lifetime);
}

/// <summary>Writes append-only audit records. Failures to audit are logged loudly but
/// never swallow the caller's operation result.</summary>
public interface IAuditLogger
{
    Task LogAsync(AuditAction action, string entityType, Guid? entityId, string summary,
        object? changes = null, bool succeeded = true, Guid? organizationId = null,
        Guid? projectId = null, Guid? userId = null, string? userEmail = null,
        CancellationToken ct = default);
}
