using System.Text.Json;

namespace QaNxt.Infrastructure.Ai.Providers;

/// <summary>
/// Test design driven by the controls on a page, rather than by what the page was classified as.
///
/// The planner's original generators were keyed on page kind: a login page got credential
/// coverage, a form got required-field coverage, a list got filter coverage, and everything
/// else got a single "it loads" check. That left most of a real application with one
/// scenario per page, and a page whose kind-specific generator could not find the exact
/// controls it wanted got the load check too — so an application could produce one test in
/// total and look like the feature was broken.
///
/// A control is testable because of what it is, not because of what the page around it was
/// called. A required text input deserves a required-field test on a dashboard exactly as
/// much as on a form. These rules read the discovered elements and apply the checks an
/// experienced tester would apply by hand, with the semantics taken from the field's own
/// label: a field called "Email" gets format tests, one called "Amount" gets numeric
/// boundaries, one called "Password" gets password rules.
///
/// Everything here is deterministic. No model is consulted, and the same inventory produces
/// the same tests every time.
/// </summary>
internal static class LocalElementRules
{
    /// <summary>What a field appears to hold, inferred from its type and its label.</summary>
    internal enum FieldSemantic
    {
        Text, Email, Password, Phone, Number, Amount, Date, Search, Url, Upload, Postcode
    }

    /// <summary>
    /// The semantic dictionary. Ordered: the first match wins, so the more specific terms
    /// come before the general ones — "email address" must not be classified as text, and
    /// "date of birth" must not be caught by "of".
    /// </summary>
    private static readonly (FieldSemantic Semantic, string[] Terms)[] SemanticTerms =
    {
        (FieldSemantic.Email, new[] { "email", "e-mail", "mail address" }),
        (FieldSemantic.Password, new[] { "password", "passcode", "pin" }),
        (FieldSemantic.Phone, new[] { "phone", "mobile", "telephone", "contact number", "msisdn" }),
        (FieldSemantic.Amount, new[] { "amount", "price", "cost", "total", "balance", "salary", "fee" }),
        (FieldSemantic.Postcode, new[] { "postcode", "postal code", "zip", "pincode", "pin code" }),
        (FieldSemantic.Url, new[] { "url", "website", "link", "endpoint", "callback" }),
        (FieldSemantic.Search, new[] { "search", "filter", "query", "find" }),
        (FieldSemantic.Date, new[] { "date", "dob", "birthday", "expiry", "valid from", "valid to" }),
        (FieldSemantic.Number, new[] { "quantity", "count", "number of", "age", "percent" })
    };

    /// <summary>Classifies a field from its input type first, then its label.
    ///
    /// Type before label because the type is a fact the browser reported and the label is a
    /// string somebody wrote. An input of type=email is an email field whatever it is
    /// called.</summary>
    public static FieldSemantic SemanticOf(JsonElement element)
    {
        var type = (LocalJson.String(element, "type") ?? string.Empty).ToLowerInvariant();
        var kind = (LocalJson.String(element, "kind") ?? string.Empty).ToLowerInvariant();

        if (type == "email") return FieldSemantic.Email;
        if (type == "password" || kind == "passwordinput") return FieldSemantic.Password;
        if (type == "tel") return FieldSemantic.Phone;
        if (type == "url") return FieldSemantic.Url;
        if (type == "search") return FieldSemantic.Search;
        if (type == "date" || type == "datetime-local" || kind == "dateinput") return FieldSemantic.Date;
        if (type == "file" || kind == "fileinput") return FieldSemantic.Upload;
        if (type == "number" || kind == "numberinput") return FieldSemantic.Number;

        var haystack = Haystack(element);
        foreach (var (semantic, terms) in SemanticTerms)
        {
            if (terms.Any(term => haystack.Contains(term, StringComparison.Ordinal))) return semantic;
        }

        return FieldSemantic.Text;
    }

    /// <summary>
    /// The invalid values worth trying against a field, with what each one is checking.
    ///
    /// Deliberately small and specific per semantic. A list of thirty near-identical bad
    /// strings produces a suite nobody reads; these are the ones that actually distinguish a
    /// validated field from an unvalidated one.
    /// </summary>
    public static IReadOnlyList<(string Value, string Checking)> InvalidValuesFor(FieldSemantic semantic)
        => semantic switch
        {
            FieldSemantic.Email => new[]
            {
                ("plainaddress", "a value with no @ at all"),
                ("missing@domain", "a domain with no dot"),
                ("spaced address@example.test", "an address containing a space")
            },
            FieldSemantic.Phone => new[]
            {
                ("abcdefghij", "letters where digits are expected"),
                ("12", "a number far too short to be callable")
            },
            FieldSemantic.Amount => new[]
            {
                ("-1", "a negative amount"),
                ("abc", "letters in a numeric field"),
                ("1.234", "more decimal places than a currency has")
            },
            FieldSemantic.Number => new[]
            {
                ("-1", "a negative value"),
                ("abc", "letters in a numeric field")
            },
            FieldSemantic.Date => new[]
            {
                ("31/02/2026", "a day that does not exist in that month"),
                ("not-a-date", "text in a date field")
            },
            FieldSemantic.Url => new[]
            {
                ("example", "a value with no scheme or host"),
                ("javascript:alert(1)", "a scheme that is not http or https")
            },
            FieldSemantic.Postcode => new[]
            {
                ("!!!", "punctuation only")
            },
            FieldSemantic.Password => Array.Empty<(string, string)>(),
            _ => Array.Empty<(string, string)>()
        };

    /// <summary>Boundary values worth trying, as (value, description).</summary>
    public static IReadOnlyList<(string Value, string Checking)> BoundaryValuesFor(FieldSemantic semantic)
        => semantic switch
        {
            FieldSemantic.Amount => new[]
            {
                ("0", "zero, which many amount fields should refuse"),
                ("0.01", "the smallest payable amount"),
                ("99999999.99", "an amount large enough to find a field or column limit")
            },
            FieldSemantic.Number => new[]
            {
                ("0", "zero"),
                ("999999", "a value large enough to find a limit")
            },
            FieldSemantic.Date => new[]
            {
                ("1900-01-01", "a date far in the past"),
                ("2999-12-31", "a date far in the future")
            },
            FieldSemantic.Password => new[]
            {
                ("a", "a single character, which a password policy should refuse")
            },
            _ => new[]
            {
                (new string('A', 256), "256 characters, past the length most columns allow")
            }
        };

    /// <summary>A value that should be accepted, so a negative test has a positive control.</summary>
    public static string ValidValueFor(FieldSemantic semantic) => semantic switch
    {
        FieldSemantic.Email => "qanxt.test@example.test",
        FieldSemantic.Password => "${secret:app_password}",
        FieldSemantic.Phone => "+44 20 7946 0000",
        FieldSemantic.Amount => "10.00",
        FieldSemantic.Number => "7",
        FieldSemantic.Date => DateTime.UtcNow.ToString("yyyy-MM-dd"),
        FieldSemantic.Url => "https://example.test/callback",
        FieldSemantic.Postcode => "SW1A 1AA",
        FieldSemantic.Search => "QA NXT",
        _ => "QA NXT test value"
    };

    /// <summary>Whether a field is worth generating validation tests for at all.
    ///
    /// A read-only or hidden control is not a validation surface, and a search box is tested
    /// by what it returns rather than by what it refuses.</summary>
    public static bool IsValidationSurface(JsonElement element)
    {
        var kind = (LocalJson.String(element, "kind") ?? string.Empty).ToLowerInvariant();
        return kind is "textinput" or "passwordinput" or "numberinput" or "dateinput"
                    or "textarea" or "fileinput";
    }

    private static string Haystack(JsonElement element)
        => string.Join(' ', new[]
        {
            LocalJson.String(element, "label"),
            LocalJson.String(element, "accessibleName"),
            LocalJson.String(element, "placeholder"),
            LocalJson.String(element, "name"),
            LocalJson.String(element, "testId")
        }.Where(v => !string.IsNullOrEmpty(v))).ToLowerInvariant();
}
