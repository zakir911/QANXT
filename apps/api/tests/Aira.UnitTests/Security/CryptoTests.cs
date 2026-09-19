using Aira.Infrastructure.Security;
using FluentAssertions;
using Microsoft.Extensions.Options;
using Xunit;

namespace Aira.UnitTests.Security;

public class PasswordHasherTests
{
    private readonly PasswordHasher _hasher = new();

    [Fact]
    public void Hash_then_verify_succeeds()
    {
        var hash = _hasher.Hash("Str0ngPassphrase!2026");
        _hasher.Verify("Str0ngPassphrase!2026", hash).Should().BeTrue();
    }

    [Fact]
    public void Verify_rejects_the_wrong_password()
    {
        var hash = _hasher.Hash("Str0ngPassphrase!2026");
        _hasher.Verify("Str0ngPassphrase!2027", hash).Should().BeFalse();
    }

    [Fact]
    public void Hashes_are_salted_so_equal_passwords_differ()
    {
        _hasher.Hash("same-password-value").Should().NotBe(_hasher.Hash("same-password-value"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-hash")]
    [InlineData("v2.1000.aaaa.bbbb")]
    [InlineData("v1.notanumber.aaaa.bbbb")]
    [InlineData("v1.210000.!!!notbase64!!!.bbbb")]
    public void Verify_returns_false_for_malformed_hashes_instead_of_throwing(string hash)
        => _hasher.Verify("anything", hash).Should().BeFalse();

    [Fact]
    public void NeedsRehash_flags_hashes_below_the_current_iteration_count()
    {
        _hasher.NeedsRehash("v1.1000.AAAA.BBBB").Should().BeTrue();
        _hasher.NeedsRehash(_hasher.Hash("current-policy-password")).Should().BeFalse();
    }
}

public class AesSecretProtectorTests
{
    private static AesSecretProtector Create()
        => new(Options.Create(new EncryptionOptions
        {
            Key = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32))
        }));

    [Fact]
    public void Round_trips_a_secret()
    {
        var protector = Create();
        var cipher = protector.Protect("demo-bank-password");
        cipher.Should().NotContain("demo-bank-password");
        protector.Unprotect(cipher).Should().Be("demo-bank-password");
    }

    [Fact]
    public void Produces_a_different_ciphertext_each_time_because_the_nonce_is_random()
    {
        var protector = Create();
        protector.Protect("same").Should().NotBe(protector.Protect("same"));
    }

    [Fact]
    public void Detects_tampering_rather_than_returning_corrupt_plaintext()
    {
        var protector = Create();
        var cipher = protector.Protect("integrity matters");
        var payload = cipher["v1:".Length..];
        var bytes = Convert.FromBase64String(payload);
        bytes[^1] ^= 0xFF;                       // flip a bit in the ciphertext
        var tampered = "v1:" + Convert.ToBase64String(bytes);

        protector.TryUnprotect(tampered, out _).Should().BeFalse();
    }

    [Fact]
    public void A_secret_cannot_be_read_with_a_different_key()
    {
        var cipher = Create().Protect("cross-key");
        Create().TryUnprotect(cipher, out _).Should().BeFalse();
    }

    [Theory]
    [InlineData("")]
    [InlineData("plaintext")]
    [InlineData("v9:AAAA")]
    public void TryUnprotect_rejects_malformed_input(string value)
        => Create().TryUnprotect(value, out _).Should().BeFalse();

    [Fact]
    public void Refuses_to_start_without_a_key()
    {
        var act = () => new AesSecretProtector(Options.Create(new EncryptionOptions { Key = "" }));
        act.Should().Throw<InvalidOperationException>().WithMessage("*ENCRYPTION_KEY*");
    }

    [Fact]
    public void Refuses_a_key_of_the_wrong_length()
    {
        var act = () => new AesSecretProtector(Options.Create(new EncryptionOptions
        {
            Key = Convert.ToBase64String(new byte[16])
        }));
        act.Should().Throw<InvalidOperationException>().WithMessage("*32 bytes*");
    }
}
