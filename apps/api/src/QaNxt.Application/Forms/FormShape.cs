using System.Security.Cryptography;
using System.Text;

namespace QaNxt.Application.Forms;

/// <summary>The parts of a form a test depends on, reduced to a hash.
///
/// Locators, labels, fields, constraints, options, buttons and dependencies are in it.
/// Default values and visibility at crawl time are not: those change with data, and a form
/// that "changed" every time somebody else's record appeared in it would select every test
/// for every regression run, which is the same as selecting nothing.</summary>
public static class FormShape
{
    public static string Hash(DiscoveredFormModel form)
    {
        var builder = new StringBuilder();
        builder.Append(form.Method).Append('|').Append(form.Action).Append('|').Append(form.IsMultiStep).Append('\n');
        foreach (var field in form.Fields)
        {
            builder.Append(field.Identity).Append('|').Append(field.ControlType).Append('|').Append(field.Required)
                .Append('|').Append(field.Label).Append('|').Append(field.Locator.Describe()).Append('|');
            foreach (var (key, value) in field.Constraints.OrderBy(c => c.Key, StringComparer.Ordinal))
                builder.Append(key).Append('=').Append(value).Append(';');
            builder.Append('|').Append(string.Join(',', field.Options.Select(o => o.Label))).Append('\n');
        }
        foreach (var button in form.Buttons) builder.Append("button|").Append(button.Label).Append('|').Append(button.Role).Append('\n');
        foreach (var dependency in form.Dependencies)
        {
            builder.Append("dep|").Append(dependency.Trigger).Append('=').Append(dependency.TriggerValue)
                .Append('>').Append(string.Join(',', dependency.Shows)).Append('/').Append(string.Join(',', dependency.Hides))
                .Append('/').Append(string.Join(',', dependency.OptionsOf.Keys)).Append('\n');
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(builder.ToString()))).ToLowerInvariant();
    }
}
