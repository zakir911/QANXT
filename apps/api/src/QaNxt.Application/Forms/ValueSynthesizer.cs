using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace QaNxt.Application.Forms;

/// <summary>Produces values for a field from what the field declares about itself.
///
/// A valid value has to satisfy every declared constraint at once — a username with a
/// minimum length, a maximum length and a pattern — or the "valid submission" a whole family
/// of tests is built on is not valid, and every one of them fails for the wrong reason. So
/// values are generated against the constraints and then checked against them, and when no
/// value can be shown to satisfy them the answer is "cannot", with the reason, rather than a
/// guess.</summary>
public static class ValueSynthesizer
{
    public sealed record Synthesis(string? Value, string? Reason)
    {
        public bool Ok => Value is not null;
        public static Synthesis Of(string value) => new(value, null);
        public static Synthesis Cannot(string reason) => new(null, reason);
    }

    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;

    public static bool IsTextLike(FormFieldModel field) => field.ControlType is
        "text" or "search" or "textarea" or "email" or "url" or "tel" or "password" or "richtext"
        or "cardNumber" or "numericText" or "decimal" or "otp" or "autocomplete";

    public static bool IsFreeText(FormFieldModel field) => field.ControlType is
        "text" or "search" or "textarea" or "richtext" or "autocomplete";

    public static bool IsNumeric(FormFieldModel field) => field.ControlType is "number" or "range";

    public static bool IsDateLike(FormFieldModel field) => field.ControlType is "date" or "month" or "time" or "datetime" or "week";

    /// <summary>A value the field should accept. <paramref name="variant"/> asks for a
    /// different valid value where one exists, for the equivalence tests.</summary>
    public static Synthesis Valid(FormFieldModel field, int variant = 0)
    {
        if (IsNumeric(field)) return ValidNumber(field, variant);
        switch (field.ControlType)
        {
            case "date": return ValidDate(field, variant);
            case "month": return ValidMonth(field, variant);
            case "week": return Synthesis.Of(variant == 0 ? "2026-W20" : "2026-W30");
            case "time": return Synthesis.Of(variant == 0 ? "09:30" : "14:15");
            case "datetime": return Synthesis.Of(variant == 0 ? "2026-06-15T09:30" : "2026-07-01T14:15");
            case "color": return Synthesis.Of(variant == 0 ? "#3366cc" : "#22aa55");
        }

        var preferred = field.ControlType switch
        {
            "email" => variant == 0 ? "qa.nxt@example.test" : "second.user@example.test",
            "url" => variant == 0 ? "https://example.test/qa" : "http://example.test/other",
            "tel" => variant == 0 ? "+442079460000" : "02079460001",
            "password" => variant == 0 ? "QaNxt-Passw0rd!" : "Second-Passw0rd#",
            "cardNumber" => "4111111111111111",
            "otp" => "123456",
            "numericText" => variant == 0 ? "1234" : "5678",
            "decimal" => variant == 0 ? "12.50" : "7.25",
            "textarea" => variant == 0 ? "QA NXT test notes" : "Another note from QA NXT",
            _ => variant == 0 ? "QA NXT test" : "Second value"
        };
        return FitText(field, preferred, variant);
    }

    /// <summary>Fits a preferred text value to the field's length limits and pattern.</summary>
    private static Synthesis FitText(FormFieldModel field, string preferred, int variant)
    {
        var (min, max) = LengthLimits(field);
        var pattern = field.Constraint("pattern");

        var candidates = new List<string> { preferred };
        if (pattern is not null)
        {
            var generated = PatternGenerator.Generate(pattern, min, max, variant);
            if (generated is not null) candidates.Insert(0, generated);
        }

        foreach (var candidate in candidates)
        {
            var fitted = Pad(candidate, min, max);
            if (fitted is not null && Satisfies(field, fitted)) return Synthesis.Of(fitted);
        }

        return pattern is not null
            ? Synthesis.Cannot($"No value could be produced that matches its pattern \"{pattern}\" within its length limits.")
            : Synthesis.Cannot("Its length limits leave no room for a value.");
    }

    private static string? Pad(string value, int? min, int? max)
    {
        var result = value;
        if (max is not null && result.Length > max) result = result[..max.Value];
        if (min is not null && result.Length < min)
        {
            var fill = result.Length > 0 ? result[^1] : 'a';
            result = result + new string(char.IsLetterOrDigit(fill) ? fill : 'a', min.Value - result.Length);
        }
        return result.Length == 0 ? null : result;
    }

    /// <summary>A value of exactly <paramref name="length"/> characters that still satisfies
    /// the field's pattern, for length boundaries. Null when no such value exists.</summary>
    public static string? OfLength(FormFieldModel field, int length)
    {
        if (length <= 0) return null;
        var pattern = field.Constraint("pattern");
        if (pattern is not null)
        {
            var generated = PatternGenerator.Generate(pattern, length, length, 0);
            if (generated is not null && generated.Length == length && MatchesPattern(pattern, generated)) return generated;
        }
        foreach (var fill in new[] { 'a', 'A', '0', 'x' })
        {
            var candidate = field.ControlType == "email"
                ? EmailOfLength(length)
                : new string(fill, length);
            if (candidate is null) return null;
            if (pattern is null || MatchesPattern(pattern, candidate))
            {
                if (field.ControlType != "email" || candidate.Length == length) return candidate;
            }
        }
        return null;
    }

    private static string? EmailOfLength(int length)
    {
        const string domain = "@example.test";
        return length <= domain.Length + 1 ? null : new string('a', length - domain.Length) + domain;
    }

    public static (int? Min, int? Max) LengthLimits(FormFieldModel field)
    {
        int? Parse(string name) => int.TryParse(field.Constraint(name), NumberStyles.Integer, Invariant, out var v) && v >= 0 ? v : null;
        return (Parse("minlength"), Parse("maxlength"));
    }

    /// <summary>Whether a value meets everything the field declares that a value can meet.</summary>
    public static bool Satisfies(FormFieldModel field, string value)
    {
        var (min, max) = LengthLimits(field);
        if (min is not null && value.Length < min) return false;
        if (max is not null && value.Length > max) return false;
        var pattern = field.Constraint("pattern");
        if (pattern is not null && !MatchesPattern(pattern, value)) return false;
        if (field.ControlType == "email" && !Regex.IsMatch(value, @"^[^@\s]+@[^@\s]+\.[^@\s]+$")) return false;
        return true;
    }

    /// <summary>An HTML pattern matches the whole value, so it is anchored here. A pattern
    /// .NET cannot parse is reported as not matching, which makes generation say "cannot"
    /// rather than produce a value nobody checked.</summary>
    public static bool MatchesPattern(string pattern, string value)
    {
        try { return Regex.IsMatch(value, $"^(?:{pattern})$", RegexOptions.None, TimeSpan.FromMilliseconds(200)); }
        catch (ArgumentException) { return false; }
        catch (RegexMatchTimeoutException) { return false; }
    }

    /// <summary>Values that break the field's pattern, each with what it checks.</summary>
    public static IEnumerable<(string Value, string What)> PatternViolations(FormFieldModel field)
    {
        var pattern = field.Constraint("pattern");
        if (pattern is null) yield break;
        var valid = Valid(field);
        if (!valid.Ok) yield break;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var (min, max) = LengthLimits(field);

        foreach (var bad in new[] { '!', 'Z', 'a', '0', ' ', 'é', '_' })
        {
            var candidate = bad + valid.Value![1..];
            if (candidate.Trim().Length == 0 || MatchesPattern(pattern, candidate) || !seen.Add(candidate)) continue;
            if (min is not null && candidate.Length < min || max is not null && candidate.Length > max) continue;
            yield return (candidate, $"a character its pattern does not allow (\"{bad}\")");
            break;
        }

        // Too short or too long for the pattern itself, where its quantifiers say so and the
        // declared length limits would not already refuse it.
        var shorter = valid.Value![..^1];
        if (shorter.Length > 0 && !MatchesPattern(pattern, shorter) && (min is null || shorter.Length >= min) && seen.Add(shorter))
            yield return (shorter, "one character fewer than its pattern requires");
        var longer = valid.Value + valid.Value[^1];
        if (!MatchesPattern(pattern, longer) && (max is null || longer.Length <= max) && seen.Add(longer))
            yield return (longer, "one character more than its pattern allows");
    }

    // ---- Numbers ---------------------------------------------------------------

    public sealed record NumericLimits(decimal? Min, decimal? Max, decimal? Step, int Decimals)
    {
        /// <summary>The smallest difference that matters for this field: its step, else 1.</summary>
        public decimal Delta => Step is > 0 ? Step.Value : 1m;
        public string Format(decimal value) => value.ToString(Decimals > 0 ? "0." + new string('0', Decimals) : "0", Invariant);

        /// <summary>Whether a value lands on the step grid that starts at the minimum.</summary>
        public bool OnStep(decimal value)
        {
            if (Step is not > 0) return true;
            var basis = Min ?? 0m;
            var steps = (value - basis) / Step.Value;
            return steps == decimal.Truncate(steps);
        }
    }

    public static NumericLimits NumericLimitsOf(FormFieldModel field)
    {
        decimal? Parse(string name) => decimal.TryParse(field.Constraint(name), NumberStyles.Float, Invariant, out var v) ? v : null;
        var stepText = field.Constraint("step");
        var step = stepText is null or "any" ? (decimal?)null : Parse("step");
        var decimals = new[] { stepText, field.Constraint("min"), field.Constraint("max") }
            .Where(t => t is not null && t != "any" && t.Contains('.'))
            .Select(t => t!.Length - t.IndexOf('.') - 1)
            .DefaultIfEmpty(0).Max();
        return new NumericLimits(Parse("min"), Parse("max"), step, decimals);
    }

    private static Synthesis ValidNumber(FormFieldModel field, int variant)
    {
        var limits = NumericLimitsOf(field);
        var delta = limits.Delta;
        decimal value;
        if (limits.Min is not null && limits.Max is not null)
        {
            var span = (limits.Max.Value - limits.Min.Value) / delta;
            var steps = decimal.Floor(span / (variant == 0 ? 2 : 3));
            value = limits.Min.Value + steps * delta;
        }
        else if (limits.Min is not null) value = limits.Min.Value + delta * (variant + 1);
        else if (limits.Max is not null) value = limits.Max.Value - delta * (variant + 1);
        else value = variant == 0 ? 5 : 7;

        if (!limits.OnStep(value)) return Synthesis.Cannot("No value inside its range lands on its step.");
        if (limits.Min is not null && value < limits.Min || limits.Max is not null && value > limits.Max)
            return Synthesis.Cannot("Its range is empty.");
        return Synthesis.Of(limits.Format(value));
    }

    // ---- Dates -----------------------------------------------------------------

    private static Synthesis ValidDate(FormFieldModel field, int variant)
    {
        var min = ParseDate(field.Constraint("min"));
        var max = ParseDate(field.Constraint("max"));
        var value = (min, max) switch
        {
            ({ } a, { } b) => a.AddDays((b.DayNumber - a.DayNumber) / (variant == 0 ? 2 : 3)),
            ({ } a, null) => a.AddDays(30 + variant),
            (null, { } b) => b.AddDays(-30 - variant),
            _ => new DateOnly(2026, 6, 15).AddDays(variant)
        };
        return Synthesis.Of(value.ToString("yyyy-MM-dd", Invariant));
    }

    private static Synthesis ValidMonth(FormFieldModel field, int variant)
    {
        var min = ParseMonth(field.Constraint("min"));
        var max = ParseMonth(field.Constraint("max"));
        var value = (min, max) switch
        {
            ({ } a, { } b) => a.AddMonths(MonthsBetween(a, b) / (variant == 0 ? 2 : 3)),
            ({ } a, null) => a.AddMonths(6 + variant),
            (null, { } b) => b.AddMonths(-6 - variant),
            _ => new DateOnly(2027, 6, 1).AddMonths(variant)
        };
        return Synthesis.Of(value.ToString("yyyy-MM", Invariant));
    }

    public static DateOnly? ParseDate(string? text)
        => DateOnly.TryParseExact(text, "yyyy-MM-dd", Invariant, DateTimeStyles.None, out var d) ? d : null;

    public static DateOnly? ParseMonth(string? text)
        => DateOnly.TryParseExact(text + "-01", "yyyy-MM-dd", Invariant, DateTimeStyles.None, out var d) ? d : null;

    public static int MonthsBetween(DateOnly a, DateOnly b) => (b.Year - a.Year) * 12 + b.Month - a.Month;

    // ---- Uploads ---------------------------------------------------------------

    /// <summary>A small file of a type the field accepts, or the reason there is none.</summary>
    public static Synthesis ValidUpload(FormFieldModel field)
    {
        var extension = AcceptedExtensions(field).FirstOrDefault() ?? "txt";
        return Synthesis.Of(Contracts.UploadFixture.For(extension, 2048));
    }

    public static IReadOnlyList<string> AcceptedExtensions(FormFieldModel field)
    {
        var accept = field.Constraint("accept");
        if (string.IsNullOrWhiteSpace(accept)) return Array.Empty<string>();
        var result = new List<string>();
        foreach (var part in accept.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            if (part.StartsWith('.')) result.Add(part[1..].ToLowerInvariant());
            else if (part.StartsWith("image/")) result.Add(part == "image/*" ? "png" : part[6..].Replace("jpeg", "jpg"));
            else if (part == "application/pdf") result.Add("pdf");
            else if (part is "text/plain" or "text/*") result.Add("txt");
            else if (part == "text/csv") result.Add("csv");
        }
        return result.Where(e => Regex.IsMatch(e, "^[a-z0-9]{1,8}$")).Distinct().ToList();
    }
}

/// <summary>Generates a string from the simple regular expressions HTML patterns are
/// usually written in: character classes, escapes, literals and quantifiers. Alternation,
/// groups and look-arounds are refused rather than half-supported, and every result is
/// checked against the real pattern before it is used.</summary>
public static class PatternGenerator
{
    private sealed record Atom(char[] Choices, int MinCount, int MaxCount);

    public static string? Generate(string pattern, int? minLength, int? maxLength, int variant)
    {
        var atoms = Parse(pattern);
        if (atoms is null || atoms.Count == 0) return null;

        var counts = atoms.Select(a => a.MinCount).ToArray();
        var length = counts.Sum();
        var target = Math.Max(length, minLength ?? 0);
        if (variant > 0 && maxLength is null) target = Math.Max(target, length + 3);

        // Grow the atoms that may grow, first to last, until the target length is reached.
        for (var i = 0; i < atoms.Count && length < target; i++)
        {
            var room = Math.Min(atoms[i].MaxCount, 64) - counts[i];
            var add = Math.Min(room, target - length);
            if (add <= 0) continue;
            counts[i] += add;
            length += add;
        }
        if (maxLength is not null && length > maxLength) return null;
        if (length == 0) return null;

        var builder = new StringBuilder();
        for (var i = 0; i < atoms.Count; i++)
        {
            var choices = atoms[i].Choices;
            for (var n = 0; n < counts[i]; n++)
            {
                builder.Append(choices[(variant + n) % Math.Min(choices.Length, 3)]);
            }
        }
        var result = builder.ToString();
        return ValueSynthesizer.MatchesPattern(pattern, result) ? result : null;
    }

    private static List<Atom>? Parse(string pattern)
    {
        var atoms = new List<Atom>();
        var i = 0;
        if (pattern.StartsWith('^')) i++;
        while (i < pattern.Length)
        {
            var c = pattern[i];
            if (c is '(' or ')' or '|') return null;
            if (c == '$' && i == pattern.Length - 1) break;

            char[]? choices;
            if (c == '[')
            {
                var end = pattern.IndexOf(']', i + 2);
                if (end < 0) return null;
                choices = ParseClass(pattern[(i + 1)..end]);
                i = end + 1;
            }
            else if (c == '\\' && i + 1 < pattern.Length)
            {
                choices = Escape(pattern[i + 1]);
                i += 2;
            }
            else if (c == '.')
            {
                choices = "abc".ToCharArray();
                i++;
            }
            else if (c is '*' or '+' or '?' or '{')
            {
                return null;
            }
            else
            {
                choices = new[] { c };
                i++;
            }
            if (choices is null || choices.Length == 0) return null;

            var (min, max, consumed) = Quantifier(pattern, i);
            if (consumed < 0) return null;
            i += consumed;
            atoms.Add(new Atom(choices, min, max));
        }
        return atoms;
    }

    private static (int Min, int Max, int Consumed) Quantifier(string pattern, int i)
    {
        if (i >= pattern.Length) return (1, 1, 0);
        switch (pattern[i])
        {
            case '*': return (0, 64, 1);
            case '+': return (1, 64, 1);
            case '?': return (0, 1, 1);
            case '{':
                var end = pattern.IndexOf('}', i);
                if (end < 0) return (0, 0, -1);
                var body = pattern[(i + 1)..end].Split(',');
                if (!int.TryParse(body[0], out var min)) return (0, 0, -1);
                var max = body.Length == 1 ? min : string.IsNullOrEmpty(body[1]) ? 64 : int.TryParse(body[1], out var m) ? m : -1;
                if (max < min) return (0, 0, -1);
                return (min, max, end - i + 1);
            default: return (1, 1, 0);
        }
    }

    private static char[]? Escape(char c) => c switch
    {
        'd' => "0123456789".ToCharArray(),
        'w' => "abcXYZ019_".ToCharArray(),
        's' => new[] { ' ' },
        'D' or 'W' or 'S' or 'b' or 'B' => null,
        _ => new[] { c }
    };

    private static char[]? ParseClass(string body)
    {
        var negate = body.StartsWith('^');
        if (negate) body = body[1..];
        var set = new List<char>();
        for (var i = 0; i < body.Length; i++)
        {
            var c = body[i];
            if (c == '\\' && i + 1 < body.Length)
            {
                var escaped = Escape(body[i + 1]);
                if (escaped is null) return null;
                set.AddRange(escaped);
                i++;
                continue;
            }
            if (i + 2 < body.Length && body[i + 1] == '-')
            {
                var to = body[i + 2];
                if (to < c) return null;
                // Prefer letters and digits from the start of the range: they are what a
                // human would type, and they are not special anywhere downstream.
                for (var ch = c; ch <= to && set.Count < 200; ch++) set.Add(ch);
                i += 2;
                continue;
            }
            set.Add(c);
        }
        if (!negate) return set.Distinct().ToArray();
        var allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".Where(ch => !set.Contains(ch)).ToArray();
        return allowed.Length == 0 ? null : allowed;
    }
}
