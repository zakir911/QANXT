using System.Text.Json;
using Aira.Application.Security;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Security;

/// <summary>Masking is the last line of defence before a secret reaches a log, an artifact,
/// a report or a model prompt, so each pattern it claims to cover is asserted here.</summary>
public class SecretMaskerTests
{
    private readonly SecretMasker _masker = new();

    [Fact]
    public void MaskText_removes_bearer_tokens()
    {
        var result = _masker.MaskText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature");
        result.Should().NotContain("eyJhbGciOiJIUzI1NiJ9");
        result.Should().Contain(SecretMasker.Redacted);
    }

    [Fact]
    public void MaskText_removes_key_value_secrets()
    {
        var result = _masker.MaskText("password=Sup3rSecret! and api_key=abc123def456");
        result.Should().NotContain("Sup3rSecret!");
        result.Should().NotContain("abc123def456");
    }

    [Fact]
    public void MaskText_removes_registered_literals_even_when_no_pattern_matches()
    {
        var masker = new SecretMasker().WithLiteral("hunter2-correct-horse");
        var result = masker.MaskText("The user typed hunter2-correct-horse into the form.");
        result.Should().NotContain("hunter2-correct-horse");
    }

    [Fact]
    public void MaskText_ignores_literals_too_short_to_be_meaningful()
    {
        // Masking a 3-character literal would redact unrelated text everywhere it appears.
        var masker = new SecretMasker().WithLiteral("abc");
        masker.MaskText("abcdefg").Should().Be("abcdefg");
    }

    [Fact]
    public void MaskText_masks_card_numbers_but_keeps_the_last_four()
    {
        var result = _masker.MaskText("Card 4111111111111111 was charged.");
        result.Should().NotContain("4111111111111111");
        result.Should().Contain("1111");
    }

    [Fact]
    public void MaskText_partially_masks_email_addresses()
    {
        var result = _masker.MaskText("Contact alice.smith@example.com for details.");
        result.Should().NotContain("alice.smith@");
        result.Should().Contain("@example.com");
    }

    [Fact]
    public void MaskText_removes_credentials_embedded_in_urls()
    {
        var result = _masker.MaskText("https://admin:s3cret@internal.example.com/api");
        result.Should().NotContain("s3cret");
    }

    [Fact]
    public void MaskText_returns_empty_for_null()
        => _masker.MaskText(null).Should().BeEmpty();

    [Fact]
    public void MaskHeaders_redacts_sensitive_headers_entirely()
    {
        var headers = new Dictionary<string, string>
        {
            ["Authorization"] = "Bearer abc.def.ghi",
            ["Cookie"] = "session=xyz",
            ["Content-Type"] = "application/json"
        };

        var masked = _masker.MaskHeaders(headers);

        masked["Authorization"].Should().Be(SecretMasker.Redacted);
        masked["Cookie"].Should().Be(SecretMasker.Redacted);
        masked["Content-Type"].Should().Be("application/json");
    }

    [Fact]
    public void MaskJson_redacts_by_field_name_at_any_depth()
    {
        const string json = """
        {"user":{"name":"alice","password":"topsecret","tokens":{"accessToken":"abc123"}},"safe":"value"}
        """;

        var masked = _masker.MaskJson(json);

        masked.Should().NotContain("topsecret");
        masked.Should().NotContain("abc123");
        masked.Should().Contain("\"safe\":\"value\"");
    }

    [Fact]
    public void MaskJson_masks_values_inside_arrays()
    {
        const string json = """{"items":[{"apiKey":"sk_live_abcdef1234567890"},{"ok":"fine"}]}""";
        var masked = _masker.MaskJson(json);
        masked.Should().NotContain("sk_live_abcdef1234567890");
        masked.Should().Contain("fine");
    }

    [Fact]
    public void MaskJson_keeps_the_type_of_every_value_it_redacts()
    {
        // Masking hides values; it does not change shapes. The contract check compares
        // masked bodies, so a masker that rewrote a null as a string made a field becoming
        // nullable invisible and would have invented type changes where there were none
        // (BUG-0024).
        const string json = @"{""sortCode"":null,""secret"":42,""pin"":true,""visible"":true,""apiKey"":""sk_live_abc"",""note"":""fine""}";

        using var masked = JsonDocument.Parse(_masker.MaskJson(json));
        var root = masked.RootElement;

        root.GetProperty("sortCode").ValueKind.Should().Be(JsonValueKind.Null);
        root.GetProperty("secret").ValueKind.Should().Be(JsonValueKind.Number);
        root.GetProperty("secret").GetInt32().Should().Be(0);
        root.GetProperty("pin").ValueKind.Should().Be(JsonValueKind.False);
        root.GetProperty("visible").ValueKind.Should().Be(JsonValueKind.True);
        root.GetProperty("apiKey").ValueKind.Should().Be(JsonValueKind.String);
        root.GetProperty("apiKey").GetString().Should().NotContain("sk_live_abc");
        root.GetProperty("note").GetString().Should().Be("fine");
    }

    [Fact]
    public void MaskJson_redacts_everything_inside_a_sensitive_object_while_keeping_its_shape()
    {
        const string json = @"{""credentials"":{""user"":""alice"",""rotations"":7,""active"":true,""expiresAt"":null},""safe"":""value""}";

        using var masked = JsonDocument.Parse(_masker.MaskJson(json));
        var credentials = masked.RootElement.GetProperty("credentials");

        // Every value under a sensitive key is gone, and the structure someone reading the
        // evidence needs is still there.
        credentials.ValueKind.Should().Be(JsonValueKind.Object);
        credentials.GetProperty("user").GetString().Should().NotBe("alice");
        credentials.GetProperty("rotations").GetInt32().Should().Be(0);
        credentials.GetProperty("active").ValueKind.Should().Be(JsonValueKind.False);
        credentials.GetProperty("expiresAt").ValueKind.Should().Be(JsonValueKind.Null);
        masked.RootElement.GetProperty("safe").GetString().Should().Be("value");
    }

    [Fact]
    public void MaskJson_redacts_a_sensitive_field_nested_below_another_sensitive_one()
    {
        const string json = @"{""token"":{""inner"":{""value"":""leaky-value""}}}";
        _masker.MaskJson(json).Should().NotContain("leaky-value");
    }

    [Fact]
    public void MaskJson_falls_back_to_text_masking_for_invalid_json()
    {
        // A truncated body must not escape masking just because it will not parse.
        var masked = _masker.MaskJson("{\"password\":\"leaky-value\"");
        masked.Should().NotContain("leaky-value");
    }

    [Theory]
    [InlineData("Authorization", true)]
    [InlineData("X-Api-Key", true)]
    [InlineData("set-cookie", true)]
    [InlineData("Accept", false)]
    public void IsSensitiveHeader_matches_case_insensitively(string header, bool expected)
        => SecretMasker.IsSensitiveHeader(header).Should().Be(expected);

    [Theory]
    [InlineData("password", true)]
    [InlineData("access_token", true)]
    [InlineData("accessToken", true)]
    [InlineData("card-number", true)]
    [InlineData("username", false)]
    public void IsSensitiveField_normalises_separators(string field, bool expected)
        => SecretMasker.IsSensitiveField(field).Should().Be(expected);
}
