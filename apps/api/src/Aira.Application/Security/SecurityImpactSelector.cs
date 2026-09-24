using Aira.Domain.Security;

namespace Aira.Application.Security;

/// <summary>One check chosen to run, and why.</summary>
public sealed record SecurityCheckSelection(
    string Check,
    string Surface,
    string Reason,
    bool BecauseOfChange,
    bool BecauseOfOpenFinding);

/// <summary>Which security checks a change calls for, and what that leaves untested.</summary>
public sealed record SecuritySelectionResult(
    IReadOnlyList<SecurityCheckSelection> Selected,
    /// <summary>Everything the surface implies — what the gate reads as "configured".</summary>
    IReadOnlyList<string> ChecksImplied,
    /// <summary>Implied and not selected. Named rather than counted, so a reader can see what
    /// a narrowed run is skipping instead of inferring it from a percentage.</summary>
    IReadOnlyList<string> NotSelected,
    bool IsNarrowed,
    IReadOnlyList<string> Notes,
    string Summary);

/// <summary>
/// Choosing which security checks a change calls for.
/// </summary>
/// <remarks>
/// <para>
/// Narrowing a security scan is genuinely useful — running thirty-two checks on every commit
/// is how a team learns to skip the security job — and it is also the most dangerous thing in
/// this file. A narrowed scan produces fewer findings, and fewer findings look like progress.
/// </para>
/// <para>
/// Two rules stop that. Checks covering a finding that is currently open are selected whatever
/// the change touched, because a check that found something and then stopped running is how a
/// regression hides. And the result reports the full implied set as <em>configured</em>
/// alongside the selected set as <em>executed</em>, so a scan that ran six of thirty-two
/// reaches the gate as six of thirty-two and comes back REVIEW rather than PASS. Narrowing
/// changes what runs; it cannot change what a clean result is allowed to claim.
/// </para>
/// <para>
/// Pure and static, like the attack surface it consumes.
/// </para>
/// </remarks>
public static class SecurityImpactSelector
{
    /// <summary>A finding the selector must keep covering.</summary>
    public sealed record OpenFinding(string Category, string? TestId, SecurityFindingStatus Status);

    /// <summary>Statuses that mean the flaw is still live as far as selection is concerned.</summary>
    private static readonly HashSet<SecurityFindingStatus> StillOpen = new()
    {
        SecurityFindingStatus.Potential,
        SecurityFindingStatus.Confirmed,
        SecurityFindingStatus.NeedsReview,
        SecurityFindingStatus.Regressed
    };

    public static SecuritySelectionResult Select(
        SecurityAttackSurface surface,
        IReadOnlyCollection<string> affectedRoutes,
        IReadOnlyCollection<string> affectedApiPaths,
        bool affectsEverything,
        IReadOnlyCollection<OpenFinding> openFindings)
    {
        var implied = surface.ChecksImplied.ToList();
        var selected = new Dictionary<string, SecurityCheckSelection>(StringComparer.OrdinalIgnoreCase);
        var notes = new List<string>();

        void Choose(string check, string surfaceName, string reason, bool fromChange, bool fromFinding)
        {
            if (selected.TryGetValue(check, out var existing))
            {
                // A check chosen for both reasons keeps both, because "it covers an open
                // finding" survives someone arguing the change did not reach it.
                selected[check] = existing with
                {
                    BecauseOfChange = existing.BecauseOfChange || fromChange,
                    BecauseOfOpenFinding = existing.BecauseOfOpenFinding || fromFinding,
                    Reason = existing.Reason == reason ? existing.Reason : $"{existing.Reason}; {reason}"
                };
                return;
            }
            selected[check] = new SecurityCheckSelection(check, surfaceName, reason, fromChange, fromFinding);
        }

        if (surface.Items.Count == 0)
        {
            notes.Add("The knowledge graph is empty, so no surface implies anything and nothing can be "
                    + "selected by impact. Run discovery, or run the full check set explicitly.");
            return new SecuritySelectionResult(
                Array.Empty<SecurityCheckSelection>(), implied, implied, IsNarrowed: true, notes,
                "Nothing selected: the application has not been discovered.");
        }

        if (affectsEverything)
        {
            foreach (var item in surface.Items)
                foreach (var check in item.RelevantChecks)
                    Choose(check, item.Identifier, "the change affects everything", true, false);

            notes.Add("The change matched a path that affects everything, so every check the surface "
                    + "implies was selected.");
        }
        else
        {
            var routes = Normalise(affectedRoutes);
            var apiPaths = Normalise(affectedApiPaths);

            foreach (var item in surface.Items)
            {
                var identifier = item.Identifier.ToLowerInvariant();
                var matched = item.Kind == SecuritySurfaceKind.Page
                    ? routes.Any(route => Touches(identifier, route))
                    : apiPaths.Any(path => Touches(identifier, path));

                if (!matched) continue;

                foreach (var check in item.RelevantChecks)
                {
                    Choose(check, item.Identifier,
                        $"the change reaches {item.Identifier}", true, false);
                }
            }

            if (selected.Count == 0)
            {
                notes.Add("No discovered surface matched the change. That is not the same as the change "
                        + "being safe: it may touch something discovery never walked.");
            }
        }

        // Checks covering something currently open, whatever the change touched.
        var live = openFindings.Where(f => StillOpen.Contains(f.Status)).ToList();
        foreach (var finding in live)
        {
            var check = finding.TestId;
            if (string.IsNullOrWhiteSpace(check) || !SecurityChecks.All.Contains(check))
            {
                notes.Add($"An open {finding.Category} finding names no known check ('{finding.TestId}'), "
                        + "so nothing could be selected to cover it. It is not being re-tested by this run.");
                continue;
            }

            Choose(check, "an open finding",
                $"a {finding.Category} finding is open and this check is what found it", false, true);
        }

        if (live.Count > 0)
        {
            notes.Add($"{live.Count} open finding(s) kept their own check selected regardless of the "
                    + "change. A check that found something and then stopped running is how a "
                    + "regression hides.");
        }

        var chosen = selected.Values.OrderBy(s => s.Check, StringComparer.Ordinal).ToList();
        var missing = implied.Except(selected.Keys, StringComparer.OrdinalIgnoreCase)
            .OrderBy(c => c, StringComparer.Ordinal).ToList();
        var narrowed = missing.Count > 0;

        if (narrowed)
        {
            notes.Add($"{missing.Count} implied check(s) are not in this selection, so the scan will "
                    + "report as partial coverage and its gate outcome cannot be a pass on that "
                    + "basis alone. Narrowing changes what runs; it does not change what a clean "
                    + "result is allowed to claim.");
        }

        return new SecuritySelectionResult(
            chosen, implied, missing, narrowed, notes,
            Summarise(chosen, implied.Count, missing.Count, live.Count, narrowed));
    }

    private static string Summarise(
        IReadOnlyCollection<SecurityCheckSelection> selected,
        int implied, int missing, int openFindings, bool narrowed)
    {
        if (selected.Count == 0)
        {
            return $"No security check was selected. {implied} check(s) are implied by the discovered "
                 + "surface and none of them matched this change, which says nothing about whether the "
                 + "change is safe.";
        }

        var fromChange = selected.Count(s => s.BecauseOfChange);
        var fromFinding = selected.Count(s => s.BecauseOfOpenFinding && !s.BecauseOfChange);

        var basis = fromFinding > 0
            ? $"{fromChange} because the change reaches them and {fromFinding} because they cover an "
            + "open finding"
            : $"all {fromChange} because the change reaches them";

        return $"{selected.Count} of {implied} implied check(s) selected — {basis}."
             + (narrowed
                ? $" {missing} check(s) are not running, so this scan covers part of the surface and "
                + "its result describes that part."
                : " Every implied check is running.")
             + (openFindings > 0
                ? $" {openFindings} finding(s) are currently open."
                : string.Empty);
    }

    private static List<string> Normalise(IReadOnlyCollection<string> values)
        => values.Where(v => !string.IsNullOrWhiteSpace(v))
                 .Select(v => v.Trim().ToLowerInvariant())
                 .Distinct()
                 .ToList();

    /// <summary>
    /// Whether a changed route or API path reaches a surface item.
    /// </summary>
    /// <remarks>
    /// Compared with the placeholders stripped, so <c>/api/accounts/{id}</c> and
    /// <c>/api/accounts/*</c> and <c>/api/accounts/1</c> are the same endpoint. Matching the
    /// templates literally would miss the case the selector exists for: a change described by
    /// a concrete path against a surface recorded as a template.
    /// </remarks>
    private static bool Touches(string surfaceIdentifier, string changed)
    {
        var a = Strip(surfaceIdentifier);
        var b = Strip(changed);
        if (a.Length == 0 || b.Length == 0) return false;
        return a == b || a.StartsWith(b + "/", StringComparison.Ordinal)
                      || b.StartsWith(a + "/", StringComparison.Ordinal);
    }

    private static string Strip(string value)
    {
        var path = value;
        var scheme = path.IndexOf("://", StringComparison.Ordinal);
        if (scheme >= 0)
        {
            var afterHost = path.IndexOf('/', scheme + 3);
            path = afterHost >= 0 ? path[afterHost..] : "/";
        }
        var query = path.IndexOf('?');
        if (query >= 0) path = path[..query];

        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries)
            .Where(segment => !(segment.StartsWith('{') && segment.EndsWith('}'))
                           && segment != "*"
                           && !segment.All(char.IsDigit))
            .Select(segment => segment.ToLowerInvariant());

        return "/" + string.Join('/', segments);
    }
}
