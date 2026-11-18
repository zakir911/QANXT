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


    /// <summary>
    /// Whether the browser will let a test type this value into this control at all.
    ///
    /// A native constrained input does not hold arbitrary text. Playwright's fill() throws
    /// on `<input type="date">` given "not-a-date" ("Malformed value") and on
    /// `<input type="number">` given "abc" ("Cannot type text into input[type=number]").
    /// Neither is a statement about the application: the browser refused before the
    /// application ever saw the value.
    ///
    /// Generated tests that do this report as FAILURES, indistinguishable in a run summary
    /// from a real defect. A run against a 137-screen application produced 28 failures, of
    /// which 10 were exactly this — eight dates and two numbers — and a team reading that
    /// summary goes looking for ten bugs that do not exist.
    ///
    /// So the value is checked against what the control can physically hold, and a value
    /// the browser would refuse is never put in a test. Where that empties a set, the
    /// honest outcome is fewer tests rather than tests that cannot run: a native date
    /// input enforces its own format, so there is no format for the application to reject.
    /// </summary>
    public static bool BrowserWillAccept(string? htmlType, string value) =>
        (htmlType ?? string.Empty).ToLowerInvariant() switch
        {
            "number" or "range" => System.Text.RegularExpressions.Regex.IsMatch(value, @"^-?\d+(\.\d+)?$"),
            // The shape is not enough: 2026-02-31 is well-formed and still refused, because
            // February has no 31st. Parsing it is the only honest check.
            "date" => DateOnly.TryParseExact(value, "yyyy-MM-dd",
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out _),
            "datetime-local" => System.Text.RegularExpressions.Regex.IsMatch(value, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"),
            "month" => System.Text.RegularExpressions.Regex.IsMatch(value, @"^\d{4}-\d{2}$"),
            "week" => System.Text.RegularExpressions.Regex.IsMatch(value, @"^\d{4}-W\d{2}$"),
            "time" => System.Text.RegularExpressions.Regex.IsMatch(value, @"^\d{2}:\d{2}"),
            "color" => System.Text.RegularExpressions.Regex.IsMatch(value, @"^#[0-9a-fA-F]{6}$"),
            _ => true
        };

    /// <summary>The html type attribute, lowercased, or empty.</summary>
    public static string HtmlTypeOf(JsonElement element)
        => (LocalJson.String(element, "type") ?? string.Empty).ToLowerInvariant();

    /// <summary>Invalid values this particular control can actually be given.</summary>
    public static IReadOnlyList<(string Value, string Checking)> InvalidValuesFor(JsonElement element)
    {
        var htmlType = HtmlTypeOf(element);
        return InvalidValuesFor(SemanticOf(element))
            .Where(candidate => BrowserWillAccept(htmlType, candidate.Value))
            .ToList();
    }

    /// <summary>Boundary values this particular control can actually be given.</summary>
    public static IReadOnlyList<(string Value, string Checking)> BoundaryValuesFor(JsonElement element)
    {
        var htmlType = HtmlTypeOf(element);
        return BoundaryValuesFor(SemanticOf(element))
            .Where(candidate => BrowserWillAccept(htmlType, candidate.Value))
            .ToList();
    }

    /// <summary>One option of a select, as discovery captured it.</summary>
    public sealed record SelectOption(string Value, string Label);

    /// <summary>
    /// The first option worth choosing, skipping the placeholder.
    ///
    /// Almost every select in a real application opens with "Choose a customer" or an
    /// empty value, and choosing that is choosing nothing. The first option carrying a
    /// non-empty value is the first real choice.
    ///
    /// Returns null when discovery captured no options. A test that guesses an option
    /// value fails for its own reasons, which is worse than not writing it: the run
    /// reports a defect that is really the test tool missing information.
    /// </summary>
    public static SelectOption? FirstRealOption(JsonElement element)
    {
        foreach (var option in LocalJson.Array(element, "options"))
        {
            var value = LocalJson.String(option, "value");
            if (string.IsNullOrWhiteSpace(value)) continue;
            var label = LocalJson.String(option, "label");
            return new SelectOption(value, string.IsNullOrWhiteSpace(label) ? value : label);
        }
        return null;
    }

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
        var isField = kind is "textinput" or "passwordinput" or "numberinput" or "dateinput"
                           or "textarea" or "fileinput";
        if (!isField) return false;

        // The comment above has always said a read-only control is not a validation
        // surface. The code did not check, so a readonly field got the full battery and
        // every one of those tests failed on a fill timeout — the control never accepts
        // input, from a test or from a person. Two of the 28 failures in the measured run
        // were one readonly field.
        if (LocalJson.Bool(element, "isReadOnly")) return false;
        // Likewise disabled: nothing can be typed into it, so nothing can be validated.
        if (LocalJson.Has(element, "isEnabled") && !LocalJson.Bool(element, "isEnabled")) return false;

        return true;
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
