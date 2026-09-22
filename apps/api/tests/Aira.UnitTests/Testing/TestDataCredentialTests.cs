using Aira.Application.Testing;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Testing;

/// <summary>
/// Which field names must hold a secret reference rather than a literal.
/// </summary>
/// <remarks>
/// A data set is readable by anyone who can read the project and is exported in plain text
/// by the CLI, so a literal password in one is a password in a repository. The guard has to
/// be right in both directions: missing one is a leak, and refusing a shipping address
/// teaches people to route around the guard, which is worse than not having it.
/// </remarks>
public class TestDataCredentialTests
{
    [Theory]
    [InlineData("password")]
    [InlineData("Password")]
    [InlineData("userPassword")]
    [InlineData("passwordHint")]
    [InlineData("user_password")]
    [InlineData("apiKey")]
    [InlineData("api_key")]
    [InlineData("apikey")]
    [InlineData("authToken")]
    [InlineData("accessToken")]
    [InlineData("clientSecret")]
    [InlineData("client_secret")]
    [InlineData("privateKey")]
    [InlineData("sessionId")]
    [InlineData("pin")]
    [InlineData("userPin")]
    [InlineData("otp")]
    [InlineData("cookie")]
    [InlineData("credential")]
    public void A_credential_field_is_recognised(string key)
        => TestDataService.LooksLikeCredential(key).Should().BeTrue();

    [Theory]
    [InlineData("shippingAddress")]      // contains "pin"
    [InlineData("shipping_address")]
    [InlineData("authorName")]           // contains "auth"
    [InlineData("author")]
    [InlineData("compassBearing")]
    [InlineData("customerEmail")]
    [InlineData("orderReference")]
    [InlineData("accountNumber")]
    [InlineData("tokenizer")]            // contains "token"
    [InlineData("pinboardUrl")]          // starts with "pin"
    [InlineData("keyword")]              // contains "key"
    [InlineData("bookingDate")]
    public void An_ordinary_field_is_not_mistaken_for_one(string key)
    {
        // Every one of these would be a false positive under substring matching, and a
        // guard that refuses "shippingAddress" is a guard people learn to work around.
        TestDataService.LooksLikeCredential(key).Should().BeFalse();
    }

    [Fact]
    public void An_empty_key_is_not_a_credential()
        => TestDataService.LooksLikeCredential("").Should().BeFalse();
}
