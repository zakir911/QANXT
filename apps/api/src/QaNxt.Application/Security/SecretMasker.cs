using System.Text.Json;
using System.Text.RegularExpressions;

namespace QaNxt.Application.Security;

/// <summary>Removes secrets and personally identifiable data from anything that will be
/// persisted, logged, rendered or sent to a model. Masking runs in the worker at capture
/// time and again server-side; both passes use this same implementation so behaviour
/// cannot drift between them.</summary>
public sealed partial class SecretMasker
{
    public const string Redacted = "***REDACTED***";

    /// <summary>Header names whose values are always removed, regardless of content.</summary>
    private static readonly HashSet<string> SensitiveHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key",
        "x-auth-token", "x-csrf-token", "x-xsrf-token", "authentication", "x-access-token",
        "x-refresh-token", "x-session-id", "x-amz-security-token"
    };

    /// <summary>JSON/form field names whose values are always removed.</summary>
    private static readonly HashSet<string> SensitiveFields = new(StringComparer.OrdinalIgnoreCase)
    {
        "password", "passwd", "pwd", "newpassword", "currentpassword", "confirmpassword",
        "secret", "clientsecret", "apikey", "api_key", "accesstoken", "access_token",
        "refreshtoken", "refresh_token", "idtoken", "id_token", "token", "sessionid",
        "session_id", "privatekey", "private_key", "authorization", "credential", "credentials",
        "pin", "cvv", "cvc", "cardnumber", "card_number", "accountnumber", "account_number",
        "ssn", "socialsecuritynumber", "nationalid", "taxid", "iban", "sortcode"
    };

    private readonly List<string> _literalSecrets = new();

    /// <summary>Registers a known secret value (e.g. the password this run will type) so it
    /// is removed wherever it appears, including places no pattern would catch.</summary>
    public SecretMasker WithLiteral(string? secret)
    {
        if (!string.IsNullOrWhiteSpace(secret) && secret!.Length >= 4) _literalSecrets.Add(secret);
        return this;
    }

    public SecretMasker WithLiterals(IEnumerable<string?> secrets)
    {
        foreach (var s in secrets) WithLiteral(s);
        return this;
    }

    public static bool IsSensitiveHeader(string headerName) => SensitiveHeaders.Contains(headerName);
    public static bool IsSensitiveField(string fieldName) => SensitiveFields.Contains(fieldName.Replace("-", "").Replace("_", ""));

    /// <summary>Masks free text: registered literals first, then structural patterns.</summary>
    public string MaskText(string? input)
    {
        if (string.IsNullOrEmpty(input)) return input ?? string.Empty;
        var text = input!;

        foreach (var literal in _literalSecrets)
            text = text.Replace(literal, Redacted, StringComparison.Ordinal);

        text = BearerPattern().Replace(text, $"Bearer {Redacted}");
        text = BasicAuthPattern().Replace(text, $"Basic {Redacted}");
        text = KeyValuePattern().Replace(text, m => $"{m.Groups[1].Value}{m.Groups[2].Value}{Redacted}");
        text = JwtPattern().Replace(text, Redacted);
        text = ApiKeyLikePattern().Replace(text, Redacted);
        text = PanPattern().Replace(text, m => MaskPan(m.Value));
        text = EmailPattern().Replace(text, m => MaskEmail(m.Value));
        text = UrlCredentialPattern().Replace(text, m => $"{m.Groups[1].Value}{Redacted}@");
        return text;
    }

    /// <summary>Masks a header collection, removing sensitive names outright and masking
    /// the remaining values in case a secret leaked into an innocuous header.</summary>
    public IDictionary<string, string> MaskHeaders(IDictionary<string, string> headers)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (key, value) in headers)
            result[key] = IsSensitiveHeader(key) ? Redacted : MaskText(value);
        return result;
    }

    /// <summary>Walks a JSON document and masks by field name as well as by value pattern.
    /// Invalid JSON falls back to text masking so nothing escapes unmasked.</summary>
    public string MaskJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return json ?? string.Empty;
        try
        {
            using var doc = JsonDocument.Parse(json!);
            var buffer = new System.IO.MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                WriteMasked(doc.RootElement, writer, propertyName: null);
            }
            return System.Text.Encoding.UTF8.GetString(buffer.ToArray());
        }
        catch (JsonException)
        {
            return MaskText(json);
        }
    }

    /// <summary>Writes a masked copy of a JSON document.
    ///
    /// Masking hides values; it does not change shapes. A redacted string stays a string, a
    /// redacted number stays a number, a null stays null, and a sensitive object keeps its
    /// structure with every value inside it redacted.
    ///
    /// That distinction is not cosmetic. Masked evidence is what the contract check
    /// compares, so a masker that rewrote <c>"sortCode": null</c> as a string made a field
    /// becoming nullable invisible, and would equally have invented a type change where
    /// there was none (BUG-0024). It is also simply more honest evidence: a report saying a
    /// balance was <c>"***REDACTED***"</c> when the API returned a number misdescribes the
    /// response.</summary>
    private void WriteMasked(JsonElement element, Utf8JsonWriter writer, string? propertyName, bool forceRedact = false)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject())
                {
                    writer.WritePropertyName(property.Name);
                    // Once inside a sensitive subtree, everything below is redacted too:
                    // a field is not made safe by being nested under one that is not.
                    WriteMasked(property.Value, writer, property.Name,
                        forceRedact || IsSensitiveField(property.Name));
                }
                writer.WriteEndObject();
                break;

            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray())
                    WriteMasked(item, writer, propertyName, forceRedact);
                writer.WriteEndArray();
                break;

            case JsonValueKind.String:
                writer.WriteStringValue(forceRedact ? Redacted : MaskText(element.GetString()));
                break;

            case JsonValueKind.Number:
                // Zero rather than a string. The value is gone either way; only one of the
                // two keeps the response's shape readable.
                if (forceRedact) writer.WriteNumberValue(0);
                else element.WriteTo(writer);
                break;

            case JsonValueKind.True:
            case JsonValueKind.False:
                if (forceRedact) writer.WriteBooleanValue(false);
                else element.WriteTo(writer);
                break;

            case JsonValueKind.Null:
                // A null holds no secret, so there is nothing to redact — and rewriting it
                // as a string would say the field had a value when it did not.
                writer.WriteNullValue();
                break;

            default:
                element.WriteTo(writer);
                break;
        }
    }

    private static string MaskPan(string pan)
    {
        var digits = new string(pan.Where(char.IsDigit).ToArray());
        return digits.Length < 8 ? Redacted : $"{new string('*', digits.Length - 4)}{digits[^4..]}";
    }

    private static string MaskEmail(string email)
    {
        var at = email.IndexOf('@');
        if (at <= 0) return Redacted;
        var local = email[..at];
        var visible = local.Length <= 2 ? local[..1] : local[..2];
        return $"{visible}***{email[at..]}";
    }

    [GeneratedRegex(@"Bearer\s+[A-Za-z0-9\-._~+/]+=*", RegexOptions.IgnoreCase)] private static partial Regex BearerPattern();
    [GeneratedRegex(@"Basic\s+[A-Za-z0-9+/]+=*", RegexOptions.IgnoreCase)] private static partial Regex BasicAuthPattern();
    // Matches key=value, key: value and JSON "key": "value" -- including a body that was
    // truncated mid-JSON and will therefore never parse.
    [GeneratedRegex(@"(?i)\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)([""']?\s*[:=]\s*[""']?)([^\s""',;&}]+)")] private static partial Regex KeyValuePattern();
    [GeneratedRegex(@"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b")] private static partial Regex JwtPattern();
    [GeneratedRegex(@"\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b")] private static partial Regex ApiKeyLikePattern();
    [GeneratedRegex(@"\b(?:\d[ -]*?){13,19}\b")] private static partial Regex PanPattern();
    [GeneratedRegex(@"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")] private static partial Regex EmailPattern();
    [GeneratedRegex(@"(\b[a-z][a-z0-9+.\-]*://)[^\s/:@]+:[^\s/@]+@")] private static partial Regex UrlCredentialPattern();
}
