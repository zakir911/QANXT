using System.Security.Cryptography;
using System.Text;
using QaNxt.Application.Abstractions;
using Microsoft.Extensions.Options;

namespace QaNxt.Infrastructure.Security;

public sealed class EncryptionOptions
{
    /// <summary>Base64-encoded 32-byte key. Supplied by configuration (ENCRYPTION_KEY);
    /// the application refuses to start without a valid one outside Development.</summary>
    public string Key { get; set; } = string.Empty;
}

/// <summary>AES-256-GCM. Ciphertext layout is <c>v1:base64(nonce|tag|ciphertext)</c>, which
/// is authenticated (tampering is detected) and versioned (keys and algorithms can rotate).</summary>
public sealed class AesSecretProtector : ISecretProtector
{
    private const string Version = "v1";
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private readonly byte[] _key;

    public AesSecretProtector(IOptions<EncryptionOptions> options)
    {
        var raw = options.Value.Key;
        if (string.IsNullOrWhiteSpace(raw))
            throw new InvalidOperationException("ENCRYPTION_KEY is not configured. Generate one with: openssl rand -base64 32");

        byte[] key;
        try { key = Convert.FromBase64String(raw); }
        catch (FormatException) { throw new InvalidOperationException("ENCRYPTION_KEY must be base64-encoded."); }

        if (key.Length != 32)
            throw new InvalidOperationException($"ENCRYPTION_KEY must decode to 32 bytes, got {key.Length}.");
        _key = key;
    }

    public string Protect(string plaintext)
    {
        ArgumentNullException.ThrowIfNull(plaintext);
        var plain = Encoding.UTF8.GetBytes(plaintext);
        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var cipher = new byte[plain.Length];
        var tag = new byte[TagSize];

        using var aes = new AesGcm(_key, TagSize);
        aes.Encrypt(nonce, plain, cipher, tag);

        var payload = new byte[NonceSize + TagSize + cipher.Length];
        Buffer.BlockCopy(nonce, 0, payload, 0, NonceSize);
        Buffer.BlockCopy(tag, 0, payload, NonceSize, TagSize);
        Buffer.BlockCopy(cipher, 0, payload, NonceSize + TagSize, cipher.Length);
        return $"{Version}:{Convert.ToBase64String(payload)}";
    }

    public string Unprotect(string ciphertext)
    {
        if (!TryUnprotect(ciphertext, out var plaintext))
            throw new CryptographicException("The stored secret could not be decrypted. It may have been tampered with, or the encryption key changed.");
        return plaintext;
    }

    public bool TryUnprotect(string ciphertext, out string plaintext)
    {
        plaintext = string.Empty;
        if (string.IsNullOrWhiteSpace(ciphertext)) return false;

        var separator = ciphertext.IndexOf(':');
        if (separator <= 0 || ciphertext[..separator] != Version) return false;

        byte[] payload;
        try { payload = Convert.FromBase64String(ciphertext[(separator + 1)..]); }
        catch (FormatException) { return false; }
        if (payload.Length < NonceSize + TagSize) return false;

        var nonce = payload.AsSpan(0, NonceSize);
        var tag = payload.AsSpan(NonceSize, TagSize);
        var cipher = payload.AsSpan(NonceSize + TagSize);
        var plain = new byte[cipher.Length];

        try
        {
            using var aes = new AesGcm(_key, TagSize);
            aes.Decrypt(nonce, cipher, tag, plain);
        }
        catch (CryptographicException) { return false; }

        plaintext = Encoding.UTF8.GetString(plain);
        return true;
    }
}
