using System.Text.Json;

namespace Aira.Infrastructure.Ai.Providers;

/// <summary>Scores discovered journeys by how much it would matter if they broke.
///
/// Risk here is a weighted sum of observable properties rather than a judgement call:
/// what the journey touches (money, credentials, personal data), how deep into the
/// application it goes, how much of the application it exercises, and how it has behaved
/// historically. Every score comes with the reasons that produced it, so a QA lead can
/// disagree with it on the evidence rather than on a vibe.</summary>
internal static class LocalRiskAssessor
{
    /// <summary>Route fragments that signal a journey with real consequences.</summary>
    private static readonly (string Term, int Weight, string Reason)[] Signals =
    {
        ("payment", 30, "handles payments"),
        ("transfer", 30, "moves money"),
        ("checkout", 28, "completes a purchase"),
        ("login", 25, "controls access to the application"),
        ("signin", 25, "controls access to the application"),
        ("auth", 22, "handles authentication"),
        ("password", 22, "changes credentials"),
        ("account", 18, "exposes account data"),
        ("statement", 15, "produces financial records"),
        ("transaction", 15, "exposes transaction history"),
        ("profile", 12, "holds personal data"),
        ("settings", 10, "changes configuration"),
        ("admin", 25, "grants administrative capability"),
        ("delete", 20, "destroys data"),
        ("export", 12, "extracts data from the application")
    };

    public static string Assess(JsonElement context)
    {
        var pages = LocalJson.Array(context, "pages").ToList();
        var assessments = new List<object>();

        foreach (var page in pages)
        {
            var route = LocalJson.String(page, "route") ?? "/";
            var title = LocalJson.String(page, "title") ?? route;
            var kind = LocalJson.String(page, "kind") ?? "unknown";
            var depth = LocalJson.Int(page, "depth");
            var elementCount = LocalJson.Int(page, "elementCount");
            var requiresAuth = LocalJson.Bool(page, "requiresAuthentication");
            var consoleErrors = LocalJson.Int(page, "consoleErrorCount");
            var failureCount = LocalJson.Int(page, "recentFailureCount");

            var score = 20;                       // every real journey carries some risk
            var reasons = new List<string>();

            var haystack = $"{route} {title}".ToLowerInvariant();
            foreach (var (term, weight, reason) in Signals)
            {
                if (!haystack.Contains(term, StringComparison.Ordinal)) continue;
                score += weight;
                reasons.Add($"it {reason}");
                break;                            // one business signal is enough; they overlap
            }

            if (requiresAuth) { score += 8; reasons.Add("it sits behind authentication"); }
            if (kind == "form") { score += 10; reasons.Add("it accepts input, so validation matters"); }
            if (kind == "dashboard") { score += 8; reasons.Add("it is a landing page customers see first"); }
            if (depth == 0) { score += 6; reasons.Add("it is an entry point"); }
            if (elementCount >= 15) { score += 5; reasons.Add($"it is interaction-heavy ({elementCount} controls)"); }
            if (consoleErrors > 0) { score += 10; reasons.Add($"it already logs {consoleErrors} console error(s)"); }
            if (failureCount > 0) { score += Math.Min(20, failureCount * 5); reasons.Add($"it has failed {failureCount} time(s) recently"); }

            score = Math.Clamp(score, 0, 100);
            var level = score >= 75 ? "critical" : score >= 55 ? "high" : score >= 35 ? "medium" : "low";

            assessments.Add(new
            {
                name = $"{title} journey",
                riskScore = score,
                risk = level,
                rationale = reasons.Count > 0
                    ? $"Scored {score}/100 because {string.Join(", and ", reasons)}."
                    : $"Scored {score}/100: no elevated-risk signals were observed on this page.",
                pages = new[] { route }
            });
        }

        var ranked = assessments
            .OrderByDescending(a => (int)a.GetType().GetProperty("riskScore")!.GetValue(a)!)
            .Take(20)
            .ToList();

        return LocalJson.Serialize(new { journeys = ranked });
    }
}
