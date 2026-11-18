using System.Text.Json;
using System.Text.RegularExpressions;

namespace QaNxt.Infrastructure.Ai.Providers;

/// <summary>
/// Narrows a discovered application model to the screens a requirement is about.
///
/// ## Why this exists
///
/// Eleven requirements were submitted against one 137-screen application and the built-in
/// planner returned eleven suites of 193 cases each — 2123 cases, 186 of them distinct, the
/// rest copies. "Book a shipment and track it to delivery" and "Raise a credit note against
/// a settled invoice" produced the same tests, because the planner read the requirement only
/// to quote it back in the summary line and then swept every page regardless. A team writing
/// requirements and getting identical output each time is paying for the same suite eleven
/// times and cannot tell which cases belong to which requirement.
///
/// ## What this does, and what it cannot do
///
/// It matches words, and that is all it does. There is no model here — this is the planner
/// that runs when no model provider is configured — so a requirement is reduced to its
/// significant terms and a page is kept when its route or title carries one of them. That
/// catches "credit note" → /billing/credit-notes and misses a requirement phrased entirely
/// in domain language that appears nowhere in the application's own wording. The summary says
/// which pages were selected and on which terms, so the scoping is visible and arguable
/// rather than silent, and a requirement that matches nothing produces a full sweep that says
/// it is a full sweep.
///
/// ## The global-navigation trap
///
/// The obvious implementation — match requirement terms against every element on the page —
/// selects every page in the application. A back-office application puts the same sidebar on
/// all 137 screens, so the labels "Shipments", "Billing" and "Customs" are present on every
/// one of them and any domain word matches everything. So matching is on route and title
/// first, and element labels are consulted only as a fallback and only for labels that are
/// NOT chrome, where chrome means a label appearing on more than half the discovered pages.
/// </summary>
internal static class LocalRequirementScope
{
    /// <summary>Words carrying no signal about which screen a requirement concerns. Kept
    /// short and generic deliberately: a longer list starts discarding domain words.</summary>
    private static readonly HashSet<string> Stopwords = new(StringComparer.OrdinalIgnoreCase)
    {
        "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "given",
        "should", "must", "shall", "can", "will", "able", "they", "their", "them", "there",
        "are", "was", "were", "has", "have", "had", "been", "being", "its", "not", "but",
        "all", "any", "each", "some", "only", "also", "than", "them", "user", "users",
        "system", "application", "page", "screen", "test", "tests", "verify", "ensure",
        "check", "make", "sure", "does", "doing", "done", "via", "per", "out", "off",
        "who", "what", "which", "where", "while", "after", "before", "once", "upon"
    };

    private sealed record Scored(JsonElement Page, int Score, List<string> On);

    /// <summary>
    /// The outcome of scoping, carrying enough to explain itself in the plan summary.
    /// </summary>
    /// <param name="Pages">The pages to generate from, in discovery order.</param>
    /// <param name="Note">A sentence for the summary, or null when no requirement was given.</param>
    internal sealed record Result(List<JsonElement> Pages, string? Note);

    public static Result Apply(string? requirement, List<JsonElement> pages)
    {
        if (string.IsNullOrWhiteSpace(requirement) || pages.Count == 0)
            return new Result(pages, null);

        var terms = Terms(requirement);
        if (terms.Count == 0)
        {
            return new Result(pages,
                $"The requirement carried no term specific enough to match a screen, so all "
                + $"{pages.Count} discovered page(s) were tested rather than a subset.");
        }

        // Pass one: route and title only. Chrome cannot reach these.
        var scored = pages
            .Select(page => Score(page, terms, includeElements: false))
            .Where(entry => entry.Score > 0)
            .ToList();

        var matchedOn = "route or title";

        // Pass two: non-chrome element labels, for a requirement phrased in terms of the
        // controls rather than the screens.
        if (scored.Count == 0)
        {
            var chrome = ChromeLabels(pages);
            scored = pages
                .Select(page => Score(page, terms, includeElements: true, chrome))
                .Where(entry => entry.Score > 0)
                .ToList();
            matchedOn = "a control label";
        }

        if (scored.Count == 0)
        {
            return new Result(pages,
                $"Nothing in the requirement matched any discovered screen or control, so this "
                + $"is a full sweep of all {pages.Count} page(s) and the requirement did not "
                + $"narrow it. Terms looked for: {string.Join(", ", terms.Take(12))}.");
        }

        // Discovery order, not score order: a suite that reads in the order a person walks
        // the application is easier to review than one ranked by a number they cannot see.
        var keep = scored.Select(entry => entry.Page).ToList();
        var byIndex = pages.Where(page => keep.Any(k => ReferenceEquals(k, page))
                                       || keep.Any(k => Route(k) == Route(page))).ToList();

        var hitTerms = scored.SelectMany(entry => entry.On).Distinct().OrderBy(t => t).ToList();
        var routes = string.Join(", ", byIndex.Select(Route).Take(10));

        return new Result(byIndex,
            $"Scoped to {byIndex.Count} of {pages.Count} discovered page(s) whose {matchedOn} "
            + $"carries a term from the requirement ({string.Join(", ", hitTerms.Take(10))}): "
            + routes + (byIndex.Count > 10 ? ", …" : string.Empty)
            + $". The other {pages.Count - byIndex.Count} page(s) were not tested for this "
            + $"requirement. Matching is on words, not meaning — this planner has no model — "
            + $"so a requirement phrased in language the application does not use will scope "
            + $"wrongly, and the terms above are there to be checked.");
    }

    private static Scored Score(JsonElement page, IReadOnlyCollection<string> terms,
        bool includeElements, HashSet<string>? chrome = null)
    {
        var haystack = $"{Route(page)} {LocalJson.String(page, "title")}";

        if (includeElements)
        {
            foreach (var element in LocalJson.Array(page, "elements"))
            {
                var label = LocalJson.String(element, "label")
                            ?? LocalJson.String(element, "accessibleName");
                if (string.IsNullOrWhiteSpace(label)) continue;
                if (chrome is not null && chrome.Contains(Normalise(label))) continue;
                haystack += " " + label;
            }
        }

        var words = Tokenise(haystack);
        var hit = terms.Where(term => words.Contains(term)).ToList();
        return new Scored(page, hit.Count, hit);
    }

    /// <summary>Labels appearing on more than half the discovered pages: a sidebar, a
    /// masthead, a footer. Matching on these selects the whole application.</summary>
    private static HashSet<string> ChromeLabels(List<JsonElement> pages)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var page in pages)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var element in LocalJson.Array(page, "elements"))
            {
                var label = LocalJson.String(element, "label")
                            ?? LocalJson.String(element, "accessibleName");
                if (string.IsNullOrWhiteSpace(label)) continue;
                seen.Add(Normalise(label));
            }
            foreach (var label in seen) counts[label] = counts.GetValueOrDefault(label) + 1;
        }

        var threshold = pages.Count / 2;
        return counts.Where(entry => entry.Value > threshold)
                     .Select(entry => entry.Key)
                     .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>The requirement's significant terms, singular and plural both accepted so
    /// "shipments" in a requirement matches a /shipment/ route.</summary>
    internal static List<string> Terms(string requirement)
    {
        var terms = new List<string>();
        foreach (var word in Tokenise(requirement))
        {
            if (word.Length < 3 || Stopwords.Contains(word)) continue;
            if (!terms.Contains(word)) terms.Add(word);
            var singular = Singular(word);
            if (singular != word && singular.Length >= 3 && !terms.Contains(singular))
                terms.Add(singular);
        }
        return terms;
    }

    /// <summary>Tokens of a string, with each token's singular form alongside it, so a
    /// route /shipments matches the requirement term "shipment" and the reverse.</summary>
    private static HashSet<string> Tokenise(string text)
    {
        var tokens = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match match in Regex.Matches(text.ToLowerInvariant(), "[a-z0-9]+"))
        {
            tokens.Add(match.Value);
            tokens.Add(Singular(match.Value));
        }
        return tokens;
    }

    /// <summary>Enough stemming for English plurals in screen names. Not a stemmer: cutting
    /// further ("shipping" → "ship") starts matching unrelated screens.</summary>
    private static string Singular(string word)
    {
        if (word.EndsWith("ies", StringComparison.Ordinal) && word.Length > 4)
            return word[..^3] + "y";
        if (word.EndsWith("ses", StringComparison.Ordinal) && word.Length > 4) return word[..^2];
        if (word.EndsWith("s", StringComparison.Ordinal)
            && !word.EndsWith("ss", StringComparison.Ordinal) && word.Length > 3)
            return word[..^1];
        return word;
    }

    private static string Route(JsonElement page)
        => LocalJson.String(page, "route") ?? LocalJson.String(page, "url") ?? "/";

    private static string Normalise(string label)
        => Regex.Replace(label.Trim().ToLowerInvariant(), @"\s+", " ");
}
