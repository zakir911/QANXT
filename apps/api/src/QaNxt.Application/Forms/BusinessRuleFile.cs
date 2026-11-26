using System.Text.RegularExpressions;

namespace QaNxt.Application.Forms;

/// <summary>One rule as the application's owner wrote it.</summary>
/// <param name="Id">The name on the `rule` line.</param>
/// <param name="Screen">The address the rule is about, from the `on` line.</param>
/// <param name="Means">The owner's own words, for the test's description.</param>
/// <param name="Text">The whole block, passed to the worker unchanged.</param>
public sealed record BusinessRuleBlock(string Id, string Screen, string Means, string Text);

/// <summary>Reads a business rules file far enough to know which screen each rule is about.
///
/// This deliberately stops short of understanding a rule. It splits the file into blocks and
/// reads the `rule`, `on` and `means` lines; the expression after `expect` is carried through
/// as text and parsed in the worker, where the evaluator lives. Two implementations of an
/// expression grammar would drift, and a rule that means one thing to the designer and another
/// to the runner is the worst kind of defect this product could ship: a wrong answer with
/// arithmetic attached.
///
/// A block that names no screen is skipped here rather than reported. The worker is the one
/// that parses, so it is the one that can say what is wrong with a rule and where; a second
/// opinion from a reader that does not understand expressions would only add noise.</summary>
public static class BusinessRuleFile
{
    private static readonly Regex RuleStart = new(@"^rule\s+(\S+)$", RegexOptions.IgnoreCase);
    private static readonly Regex Keyed = new(@"^(on|means|expect|within)\s*:?\s+(.+)$", RegexOptions.IgnoreCase);

    public static IReadOnlyList<BusinessRuleBlock> Blocks(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return Array.Empty<BusinessRuleBlock>();

        var blocks = new List<BusinessRuleBlock>();
        string? id = null;
        var screen = string.Empty;
        var means = string.Empty;
        var hasExpectation = false;
        var lines = new List<string>();

        void Finish()
        {
            if (id is null) return;
            if (screen.Length > 0 && hasExpectation)
                blocks.Add(new BusinessRuleBlock(id, screen, means, string.Join("\n", lines)));
            id = null;
            screen = string.Empty;
            means = string.Empty;
            hasExpectation = false;
            lines = new List<string>();
        }

        foreach (var raw in text.Replace("\r\n", "\n").Split('\n'))
        {
            var line = Regex.Replace(raw, "#.*$", string.Empty).Trim();
            if (line.Length == 0) continue;

            var start = RuleStart.Match(line);
            if (start.Success)
            {
                Finish();
                id = start.Groups[1].Value;
                lines.Add(line);
                continue;
            }

            if (id is null) continue;

            var keyed = Keyed.Match(line);
            if (!keyed.Success) continue;
            lines.Add(line);

            var key = keyed.Groups[1].Value.ToLowerInvariant();
            var value = keyed.Groups[2].Value.Trim();
            if (key == "on") screen = value;
            else if (key == "means") means = value;
            else if (key == "expect") hasExpectation = true;
        }

        Finish();

        // Two rules of one name would produce two tests with the same generation key, and the
        // second would overwrite the first. The worker reports the clash; here the later one is
        // simply not designed, so neither silently replaces the other.
        var seen = new HashSet<string>(StringComparer.Ordinal);
        return blocks.Where(block => seen.Add(block.Id)).ToList();
    }

    /// <summary>How many rules the file holds, and how many `rule` blocks the reader could not
    /// complete because they name no screen or state no expectation.
    ///
    /// A rules file whose every block is incomplete is the one state in which this capability
    /// silently does nothing, so the counts travel with the application's configuration rather
    /// than only appearing in a run report somebody may not read. The worker says what is wrong
    /// with a rule; this only says how many are not usable.</summary>
    public static (int Rules, int Incomplete) Summarise(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return (0, 0);
        var declared = text.Replace("\r\n", "\n").Split('\n')
            .Count(line => RuleStart.IsMatch(Regex.Replace(line, "#.*$", string.Empty).Trim()));
        var usable = Blocks(text).Count;
        return (usable, Math.Max(0, declared - usable));
    }

    /// <summary>Whether a rule written for <paramref name="screen"/> is about <paramref name="route"/>.
    ///
    /// Matches an exact address, or a route template the owner wrote with {id} or :id against the
    /// instances a run actually visits. A template stands aside where some rule names the address
    /// outright: /billing/invoices/{id} is about one invoice, and /billing/invoices/new is the
    /// blank form.</summary>
    public static IReadOnlyList<BusinessRuleBlock> For(IReadOnlyList<BusinessRuleBlock> blocks, string route)
    {
        var wanted = Normalise(route);
        var claimedByName = blocks.Any(block => Normalise(block.Screen) == wanted);

        return blocks.Where(block =>
        {
            var screen = Normalise(block.Screen);
            if (screen == wanted) return true;
            if (claimedByName) return false;
            if (!Regex.IsMatch(screen, @"\{[^}]+\}|/:[a-z0-9_]+", RegexOptions.IgnoreCase)) return false;
            var pattern = Regex.Replace(screen, @"\{[^}]+\}|:[a-z0-9_]+", "[^/]+", RegexOptions.IgnoreCase);
            return Regex.IsMatch(wanted, $"^{pattern}$");
        }).ToList();
    }

    private static string Normalise(string? value)
    {
        var path = (value ?? string.Empty).Trim();

        // Only unwrap a real web address. On Unix, Uri.TryCreate accepts a bare path as an
        // absolute `file:` URI and hands back a percent-encoded AbsolutePath, which turned
        // `/billing/credit-notes/{id}` into `/billing/credit-notes/%7Bid%7D` and stopped every
        // route template matching anything. The tests caught it; nothing else would have.
        if (Uri.TryCreate(path, UriKind.Absolute, out var absolute)
            && (absolute.Scheme == Uri.UriSchemeHttp || absolute.Scheme == Uri.UriSchemeHttps))
        {
            path = Uri.UnescapeDataString(absolute.AbsolutePath);
        }

        path = path.Split('?')[0].Split('#')[0].TrimEnd('/').ToLowerInvariant();
        return path.Length == 0 ? "/" : path;
    }
}
