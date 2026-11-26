using System.Text.Json;
using System.Text.RegularExpressions;
using QaNxt.Application.Forms;

namespace QaNxt.Application.Security;

/// <summary>
/// The request a form declares it sends, as a body a check can actually issue.
///
/// ## Why this exists
///
/// The write checks — anti-forgery, origin validation, read-only enforcement — work by
/// sending the application's own state-changing request twice and varying one thing. That
/// only establishes anything if the request is accepted in the first place, and an empty body
/// is not accepted by any form endpoint that validates its fields. The checks were sending
/// `{}`.
///
/// What that looked like in a report: a POST with no body is refused by the application's own
/// field validation, a server-rendered application refuses by redirecting back to the form,
/// and the check correctly reads that as "the endpoint did not accept the request" and
/// reaches no verdict. Measured on a 137-screen freight application, that is 37 endpoints
/// where both checks returned inconclusive — including a planted missing-token defect on
/// `/warehouse/stock/:id/adjust`, which the same endpoint hands over the moment the request
/// carries `delta` and `reason`.
///
/// ## What is used, and what is not
///
/// The values come from <see cref="ValueSynthesizer"/>, which is what the form test designer
/// fills a happy-path submission with. Nothing is invented here that the product does not
/// already use to fill that form, so a body this builds is a body the engine believes is
/// valid — and when the application disagrees, the check says what it sent and reaches no
/// verdict rather than blaming the application.
///
/// Not carried: a hidden field's value. Discovery records hidden fields by name only, so a
/// server that requires one beyond the token will refuse the request, and the check will say
/// which fields it sent. Not carried either: a file input, which cannot travel in a form body
/// — the upload check covers those addresses separately.
/// </summary>
public static class FormRequestShape
{
    /// <summary>The same notion of a token field the form extractor uses to set
    /// <c>hasCsrfToken</c>, so the two cannot disagree about which field is the token.</summary>
    private static readonly Regex TokenName =
        new(@"csrf|xsrf|_token|authenticity|requestverification|anti.?forgery",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>A body to send, the content type to send it as, and where the token goes.</summary>
    /// <param name="Fields">Field name to value, as the page would submit them, without the
    /// anti-forgery token: a probe that must send the request *without* a token has to be able
    /// to, and a sample carrying one would defeat that.</param>
    /// <param name="TokenField">The hidden field the application reads its token from, where
    /// the form declares one. The control request puts the token here as well as in a header;
    /// the probe puts it in neither.</param>
    /// <param name="ContentType">What the form says it submits as.</param>
    /// <param name="Unfilled">Fields deliberately left out, so a reason can name them.</param>
    public sealed record Shape(
        IReadOnlyDictionary<string, string> Fields,
        string? TokenField,
        string ContentType,
        IReadOnlyList<string> Unfilled);

    /// <summary>The shape a form declares, or null when no value could be produced for a
    /// field the form requires — in which case sending a body would be guessing.</summary>
    public static Shape? Of(DiscoveredFormModel? form)
    {
        if (form is null) return null;

        var tokenField = form.HiddenFieldNames.FirstOrDefault(n => !string.IsNullOrWhiteSpace(n)
                                                                && TokenName.IsMatch(n));
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        var unfilled = new List<string>();

        foreach (var field in form.Fields)
        {
            var name = field.Name;
            // Submitted by name or not at all: a control the browser would not send is not
            // part of the request this is reconstructing.
            if (string.IsNullOrWhiteSpace(name)) continue;
            if (field.Disabled) continue;
            if (tokenField is not null && string.Equals(name, tokenField, StringComparison.Ordinal)) continue;
            if (TokenName.IsMatch(name)) { tokenField ??= name; continue; }

            if (field.ControlType == "file")
            {
                unfilled.Add(name);
                continue;
            }

            // An unchecked optional box is simply not submitted, which is what a browser does
            // and what the form designer's own valid fill does.
            if (field.ControlType is "checkbox" or "switch" && !field.Required && !field.Checked) continue;

            var value = ValueFor(field, fields, form);
            if (value is null)
            {
                if (field.Required) return null;
                unfilled.Add(name);
                continue;
            }
            fields[name] = value;
        }

        if (fields.Count == 0 && tokenField is null) return null;

        var enctype = form.Enctype;
        // A multipart form's non-file fields are read from a urlencoded body by every
        // server-side framework this has been measured against, and the file part is not what
        // these checks are asking about. Sending multipart with a urlencoded body would be a
        // request no browser makes, so the declared type is narrowed rather than echoed.
        var contentType = string.IsNullOrWhiteSpace(enctype)
                          || enctype.Contains("multipart", StringComparison.OrdinalIgnoreCase)
            ? "application/x-www-form-urlencoded"
            : enctype!;

        return new Shape(fields, tokenField, contentType, unfilled);
    }

    /// <summary>The value the page itself would carry, else one the engine believes is
    /// valid.</summary>
    private static string? ValueFor(
        FormFieldModel field, Dictionary<string, string> chosen, DiscoveredFormModel form)
    {
        // What the page already carries is better evidence than anything synthesised: a
        // hidden step marker, a preselected site, a default quantity.
        if (!string.IsNullOrEmpty(field.DefaultValue)) return field.DefaultValue;

        if (field.ControlType is "select" or "multiselect" or "radio")
        {
            var options = field.Options
                .Where(o => !o.Disabled && o.Value.Length > 0)
                .Select(o => o.Value)
                .ToList();
            if (options.Count == 0) return null;

            // Two selects over the same list must not take the same option. A transfer form's
            // "From site" and "To site" are the same list of warehouses, and an application
            // that refuses a transfer from Felixstowe to Felixstowe is right to — but the
            // check would read that correct refusal as "the endpoint did not accept the
            // request" and reach no verdict. The form test designer carries the same rule for
            // the same reason.
            var alreadyUsed = chosen
                .Where(pair => form.Fields.Any(f =>
                    string.Equals(f.Name, pair.Key, StringComparison.Ordinal)
                    && f.ControlType is "select" or "multiselect" or "radio"
                    && DrawsFromTheSameList(f, field)))
                .Select(pair => pair.Value)
                .ToHashSet(StringComparer.Ordinal);

            // Where the list is too short to go round, the first option is taken again: a
            // duplicate is something the application has to cope with anyway, and no body at
            // all is worse than one that may be refused.
            return options.FirstOrDefault(o => !alreadyUsed.Contains(o)) ?? options[0];
        }

        if (field.ControlType is "checkbox" or "switch") return "on";

        if (ValueSynthesizer.IsNumeric(field))
        {
            var ordinary = OrdinaryNumber(field);
            if (ordinary is not null) return ordinary;
        }

        var synthesis = ValueSynthesizer.Valid(field);
        return synthesis.Ok ? synthesis.Value : null;
    }

    /// <summary>
    /// The most ordinary value a numeric field would carry, rather than one that explores its
    /// range.
    ///
    /// <see cref="ValueSynthesizer"/> picks the midpoint of a bounded range, which is the
    /// right choice for a form test: it is far from both boundaries, so a test that uses it is
    /// testing the field rather than its edges. For a request whose only job is to be
    /// *accepted*, it is the wrong choice, because the midpoint of a symmetric range is zero —
    /// and zero is the value business rules exclude more often than any other. A quantity, a
    /// delta, an amount, a count: none of them means anything at zero, and no HTML constraint
    /// can say so.
    ///
    /// Measured on freight's stock adjustment: `min="-100000" max="100000" step="1"` makes the
    /// midpoint exactly 0, the handler answers *"Enter a whole number other than zero"* and
    /// redirects back to the form, and the anti-forgery check correctly reported that the
    /// endpoint had not accepted its request. The body was right in every respect the page
    /// declares and still could not be used.
    ///
    /// So: the smallest ordinary positive value the field's own constraints allow, and the
    /// synthesizer's choice when none of them is in range.
    /// </summary>
    private static string? OrdinaryNumber(FormFieldModel field)
    {
        var limits = ValueSynthesizer.NumericLimitsOf(field);
        foreach (var candidate in new[] { 1m, limits.Delta, 2m, 10m })
        {
            if (candidate == 0m) continue;
            if (limits.Min is not null && candidate < limits.Min) continue;
            if (limits.Max is not null && candidate > limits.Max) continue;
            if (!limits.OnStep(candidate)) continue;
            return limits.Format(candidate);
        }
        return null;
    }

    private static bool DrawsFromTheSameList(FormFieldModel a, FormFieldModel b)
    {
        var left = a.Options.Where(o => o.Value.Length > 0).Select(o => o.Value).ToList();
        var right = b.Options.Where(o => o.Value.Length > 0).Select(o => o.Value).ToList();
        return left.Count > 0 && left.Count == right.Count
            && left.SequenceEqual(right, StringComparer.Ordinal);
    }

    /// <summary>The body as the surface carries it: a JSON object of field names to values,
    /// which is how <c>RequestSampleJson</c> is already stored and read.</summary>
    public static string ToSampleJson(Shape shape) => JsonSerializer.Serialize(shape.Fields);
}
