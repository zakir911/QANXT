using System.Security.Cryptography;
using Aira.Application.Abstractions;
using Microsoft.AspNetCore.Cryptography.KeyDerivation;

namespace Aira.Infrastructure.Security;

/// <summary>PBKDF2-HMAC-SHA256 with a per-password salt. The format is self-describing
/// (<c>v1.iterations.salt.hash</c>) so the iteration count can be raised later and
/// existing hashes upgraded on next successful login.</summary>
public sealed class PasswordHasher : IPasswordHasher
{
    private const int CurrentIterations = 210_000;   // OWASP guidance for PBKDF2-HMAC-SHA256
    private const int SaltBytes = 16;
    private const int HashBytes = 32;

    public string Hash(string password)
    {
        ArgumentException.ThrowIfNullOrEmpty(password);
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = Derive(password, salt, CurrentIterations);
        return $"v1.{CurrentIterations}.{Convert.ToBase64String(salt)}.{Convert.ToBase64String(hash)}";
    }

    public bool Verify(string password, string hash)
    {
        if (string.IsNullOrEmpty(password) || string.IsNullOrEmpty(hash)) return false;
        var parts = hash.Split('.');
        if (parts.Length != 4 || parts[0] != "v1") return false;
        if (!int.TryParse(parts[1], out var iterations) || iterations < 1000) return false;

        byte[] salt, expected;
        try
        {
            salt = Convert.FromBase64String(parts[2]);
            expected = Convert.FromBase64String(parts[3]);
        }
        catch (FormatException) { return false; }

        var actual = Derive(password, salt, iterations);
        // Constant-time comparison: a timing difference here leaks the hash prefix.
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    public bool NeedsRehash(string hash)
    {
        var parts = hash.Split('.');
        return parts.Length != 4 || parts[0] != "v1"
            || !int.TryParse(parts[1], out var iterations) || iterations < CurrentIterations;
    }

    private static byte[] Derive(string password, byte[] salt, int iterations) =>
        KeyDerivation.Pbkdf2(password, salt, KeyDerivationPrf.HMACSHA256, iterations, HashBytes);
}
