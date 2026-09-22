using Aira.Application.Abstractions;
using Aira.Application.Contracts;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Quality;

public sealed record ChangeImpactRequest(
    Guid ProjectId,
    Guid? ApplicationId,
    /// <summary>Repository-relative paths, as <c>git diff --name-only</c> reports them.</summary>
    IReadOnlyList<string> ChangedPaths,
    string? CommitSha = null,
    string? Branch = null);

/// <summary>One changed file and what it was found to affect.</summary>
public sealed record PathImpact(
    string Path,
    ImpactKind Kind,
    string Value,
    /// <summary>True when a rule the team wrote produced this, false when AIRA inferred it
    /// from the file's name. The difference matters to anyone deciding whether to trust a
    /// narrowed regression set.</summary>
    bool IsDeclared,
    string Reason);

public sealed record ChangeImpactResult(
    int ChangedPathCount,
    int MatchedPathCount,
    IReadOnlyList<string> UnmatchedPaths,
    IReadOnlyList<string> AffectedRoutes,
    IReadOnlyList<string> AffectedApiPaths,
    IReadOnlyList<string> AffectedTags,
    IReadOnlyList<string> AffectedTestReferences,
    bool AffectsEverything,
    IReadOnlyList<PathImpact> Impacts,
    IReadOnlyList<string> Notes);

public sealed record RegressionSelectionRequest(
    Guid ProjectId,
    Guid? ApplicationId = null,
    IReadOnlyList<string>? ChangedPaths = null,
    RegressionMode Mode = RegressionMode.Impacted,
    int? MaxTests = null,
    /// <summary>Tests scoring below this are left out. Default 40 — the impact weight, so
    /// by default a test is selected when the change reaches it or when its own history
    /// and risk argue loudly enough on their own.</summary>
    int? MinScore = null,
    IReadOnlyList<string>? IncludeTags = null,
    IReadOnlyList<string>? ExcludeTags = null,
    string? CommitSha = null,
    string? Branch = null);

public sealed record RegressionSelection(
    RegressionMode Mode,
    RegressionMode RequestedMode,
    int TotalCandidates,
    int SelectedCount,
    int MinScore,
    ChangeImpactResult? Impact,
    IReadOnlyList<ScoredTest> Selected,
    IReadOnlyList<ScoredTest> Excluded,
    /// <summary>True when an impacted selection could not establish what the change reaches
    /// and ran everything instead.</summary>
    bool FellBackToFull,
    IReadOnlyList<string> Notes);

public interface IRegressionSelectionService
{
    Task<Result<ChangeImpactResult>> AnalyseImpactAsync(ChangeImpactRequest request, CancellationToken ct = default);
    Task<Result<RegressionSelection>> SelectAsync(RegressionSelectionRequest request, CancellationToken ct = default);
}

/// <summary>Decides which tests a change needs, and shows its working.
///
/// The safety property matters more than the optimisation. A selector that narrows wrongly
/// produces a green pipeline that did not run the test which would have caught the defect,
/// and nobody finds out until production — so this one is built to fail towards running
/// more rather than fewer:
///
///  - A change it cannot map to anything runs the whole suite, loudly, rather than
///    returning an empty set that a pipeline would read as success.
///  - A change to a path no rule covers is reported as unmatched, by name, so the gap is
///    visible rather than silently absorbed.
///  - A rule marked <c>Everything</c> exists because a change to shared code genuinely
///    reaches everything, and pretending otherwise is a guess dressed up as an
///    optimisation.
///  - Tests a project always runs are added whatever the change touched.
///
/// Every selected test carries the score's components and the sentence that earned each
/// one. That is not decoration: a team that cannot see why a test was skipped has no way to
/// tell a good selection from a broken one.</summary>
public sealed class RegressionSelectionService : IRegressionSelectionService
{
    /// <summary>The default bar. Equal to the impact weight, so a test the change reaches
    /// is selected on that alone, and a test it does not reach needs a real argument from
    /// its own risk, history and staleness.</summary>
    public const int DefaultMinScore = RegressionScoring.ImpactWeight;

    private readonly IAiraDbContext _db;
    private readonly IClock _clock;
    private readonly ILogger<RegressionSelectionService> _logger;

    public RegressionSelectionService(
        IAiraDbContext db, IClock clock, ILogger<RegressionSelectionService> logger)
    {
        _db = db;
        _clock = clock;
        _logger = logger;
    }

    public async Task<Result<ChangeImpactResult>> AnalyseImpactAsync(
        ChangeImpactRequest request, CancellationToken ct = default)
    {
        if (!await _db.Projects.AnyAsync(p => p.Id == request.ProjectId, ct))
            return Error.NotFound("The project");

        var paths = (request.ChangedPaths ?? Array.Empty<string>())
            .Select(path => path.Trim())
            .Where(path => path.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(5000)
            .ToList();

        var notes = new List<string>();
        if (paths.Count == 0)
        {
            notes.Add("No changed paths were supplied, so nothing could be analysed. "
                + "A selection made from this will run everything rather than nothing.");
        }

        var rules = await _db.ChangeImpactRules
            .Where(r => r.ProjectId == request.ProjectId && r.IsEnabled)
            .ToListAsync(ct);

        // What the application actually has, so an inferred match is against something
        // real rather than against a word that appeared in a file name.
        var applicationId = request.ApplicationId
            ?? await _db.Applications.Where(a => a.ProjectId == request.ProjectId)
                .Select(a => (Guid?)a.Id).FirstOrDefaultAsync(ct);

        var routes = applicationId is null
            ? new List<string>()
            : await _db.ApplicationPages
                .Where(p => p.ApplicationId == applicationId)
                .Select(p => p.Route)
                .Distinct()
                .ToListAsync(ct);

        var apiPaths = applicationId is null
            ? new List<string>()
            : await _db.ApiEndpoints
                .Where(e => e.ApplicationId == applicationId)
                .Select(e => e.UrlTemplate)
                .Distinct()
                .ToListAsync(ct);

        var impacts = new List<PathImpact>();
        var matched = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var path in paths)
        {
            var declared = rules.Where(rule => PathGlob.Matches(rule.PathPattern, path)).ToList();
            foreach (var rule in declared)
            {
                impacts.Add(new PathImpact(
                    path, rule.Kind, rule.Value, IsDeclared: true,
                    $"{path} matches the rule \"{rule.PathPattern}\""
                    + (rule.Notes is null ? "." : $": {rule.Notes}")));
                matched.Add(path);
            }

            if (declared.Count > 0) continue;

            foreach (var inferred in Infer(path, routes, apiPaths))
            {
                impacts.Add(inferred);
                matched.Add(path);
            }
        }

        var unmatched = paths.Where(path => !matched.Contains(path)).ToList();
        if (unmatched.Count > 0)
        {
            notes.Add($"{unmatched.Count} changed path(s) matched no rule and could not be "
                + "mapped to anything the application does. They are listed so the gap is "
                + "visible; add a rule for them, or accept that a narrowed run does not cover them.");
        }

        var inferredCount = impacts.Count(i => !i.IsDeclared);
        if (inferredCount > 0)
        {
            notes.Add($"{inferredCount} mapping(s) were inferred from file and directory names "
                + "rather than declared by a rule. They are marked as such; a rule is the "
                + "difference between what the team says these files touch and what looked similar.");
        }

        var result = new ChangeImpactResult(
            ChangedPathCount: paths.Count,
            MatchedPathCount: matched.Count,
            UnmatchedPaths: unmatched.Take(100).ToList(),
            AffectedRoutes: Values(impacts, ImpactKind.Route),
            AffectedApiPaths: Values(impacts, ImpactKind.ApiEndpoint),
            AffectedTags: Values(impacts, ImpactKind.Tag),
            AffectedTestReferences: Values(impacts, ImpactKind.TestCase),
            AffectsEverything: impacts.Any(i => i.Kind == ImpactKind.Everything),
            Impacts: impacts.Take(500).ToList(),
            Notes: notes);

        if (result.AffectsEverything)
        {
            _logger.LogInformation(
                "Change impact for project {ProjectId}: a rule marks this change as affecting everything.",
                request.ProjectId);
        }

        return Result<ChangeImpactResult>.Success(result);
    }

    public async Task<Result<RegressionSelection>> SelectAsync(
        RegressionSelectionRequest request, CancellationToken ct = default)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == request.ProjectId, ct);
        if (project is null) return Error.NotFound("The project");

        var notes = new List<string>();
        var minScore = Math.Clamp(request.MinScore ?? DefaultMinScore, 0, 100);

        ChangeImpactResult? impact = null;
        var impactSet = ImpactSet.Empty;
        var mode = request.Mode;
        var fellBack = false;

        if (mode == RegressionMode.Impacted)
        {
            var analysed = await AnalyseImpactAsync(new ChangeImpactRequest(
                request.ProjectId, request.ApplicationId,
                request.ChangedPaths ?? Array.Empty<string>(),
                request.CommitSha, request.Branch), ct);

            if (!analysed.IsSuccess) return Result<RegressionSelection>.Failure(analysed.Error!);
            impact = analysed.Value!;
            impactSet = ToImpactSet(impact);

            // The safety property. An empty impact set is not "no tests needed"; it is
            // "AIRA does not know what this change reaches", and the only honest response
            // to that is to run everything and say so.
            if (impactSet.IsEmpty)
            {
                mode = RegressionMode.Full;
                fellBack = true;
                notes.Add("Nothing could be established about what this change reaches, so the "
                    + "whole suite was selected. A narrowed run here would be a guess, and a "
                    + "guess that returns no tests reads as a pass.");
            }
            else if (impactSet.Everything)
            {
                mode = RegressionMode.Full;
                notes.Add("A rule marks this change as affecting everything, so the whole suite "
                    + "was selected.");
            }
        }

        var candidates = await LoadCandidatesAsync(request, ct);
        if (candidates.Count == 0)
        {
            // Not an empty success. "There were no tests" and "the tests passed" are
            // different answers, and a pipeline that conflates them is green for the wrong
            // reason.
            return Error.Validation(
                "No enabled tests matched this selection. A regression run with nothing in it "
                + "would report success without testing anything.");
        }

        var now = _clock.UtcNow;
        var scored = candidates
            .Select(candidate => RegressionScoring.Score(candidate, impactSet, now))
            .OrderByDescending(test => test.Score)
            .ThenBy(test => test.Reference, StringComparer.Ordinal)
            .ToList();

        List<ScoredTest> selected;
        List<ScoredTest> excluded;

        if (mode == RegressionMode.Full)
        {
            selected = scored;
            excluded = new List<ScoredTest>();
        }
        else if (mode == RegressionMode.Smoke)
        {
            selected = scored.Where(IsAlwaysRun).ToList();
            excluded = scored.Except(selected).ToList();
            if (selected.Count == 0)
            {
                return Error.Validation(
                    "This project has no smoke tests. Tag the tests that must run on every "
                    + $"change with one of: {string.Join(", ", RegressionScoring.AlwaysRunTags)}.");
            }
        }
        else
        {
            selected = scored.Where(test => test.Score >= minScore || IsAlwaysRun(test)).ToList();
            excluded = scored.Except(selected).ToList();

            if (selected.Count == 0)
            {
                // The change mapped to something, but nothing scored above the bar. Running
                // nothing is still the wrong answer.
                mode = RegressionMode.Smoke;
                selected = scored.Where(IsAlwaysRun).ToList();
                notes.Add($"No test scored {minScore} or above for this change, so the smoke set "
                    + "was selected instead of nothing.");

                if (selected.Count == 0)
                {
                    mode = RegressionMode.Full;
                    fellBack = true;
                    selected = scored;
                    notes.Add("This project has no smoke tests either, so the whole suite was "
                        + "selected. Tag the tests that must always run.");
                }
                excluded = scored.Except(selected).ToList();
            }
        }

        if (request.MaxTests is { } max && max > 0 && selected.Count > max)
        {
            var dropped = selected.Skip(max).ToList();
            selected = selected.Take(max).ToList();
            excluded = excluded.Concat(dropped).ToList();
            notes.Add($"Capped at {max} test(s); {dropped.Count} that scored above the bar were "
                + "left out. The lowest score included was "
                + $"{selected.LastOrDefault()?.Score ?? 0}, the highest excluded "
                + $"{dropped.FirstOrDefault()?.Score ?? 0}.");
        }

        var impactedCount = selected.Count(test => test.IsImpacted);
        notes.Add($"{selected.Count} of {scored.Count} test(s) selected; {impactedCount} because "
            + "the change reaches them.");

        _logger.LogInformation(
            "Regression selection for project {ProjectId}: {Selected}/{Total} test(s), mode {Mode}"
            + "{FellBack}.",
            request.ProjectId, selected.Count, scored.Count, mode,
            fellBack ? " (fell back from an impacted selection)" : string.Empty);

        return Result<RegressionSelection>.Success(new RegressionSelection(
            mode, request.Mode, scored.Count, selected.Count, minScore, impact,
            selected, excluded.Take(500).ToList(), fellBack, notes));
    }

    /// <summary>Maps a changed path to routes and endpoints by name, when no rule covers it.
    ///
    /// Reported as inferred, never as declared. A file called <c>accounts.service.ts</c>
    /// probably has something to do with <c>/accounts</c>, and "probably" is exactly the
    /// word a team needs to see next to a decision about which tests to skip.</summary>
    private static IEnumerable<PathImpact> Infer(
        string path, IReadOnlyList<string> routes, IReadOnlyList<string> apiPaths)
    {
        var tokens = Tokens(path);
        if (tokens.Count == 0) yield break;

        foreach (var route in routes)
        {
            var routeTokens = Tokens(route);
            if (routeTokens.Count == 0) continue;
            if (!routeTokens.All(tokens.Contains)) continue;

            yield return new PathImpact(
                path, ImpactKind.Route, route, IsDeclared: false,
                $"{path} shares its name with the route {route}. Inferred, not declared.");
        }

        foreach (var apiPath in apiPaths)
        {
            var apiTokens = Tokens(apiPath);
            if (apiTokens.Count == 0) continue;
            if (!apiTokens.All(tokens.Contains)) continue;

            yield return new PathImpact(
                path, ImpactKind.ApiEndpoint, apiPath, IsDeclared: false,
                $"{path} shares its name with the endpoint {apiPath}. Inferred, not declared.");
        }
    }

    /// <summary>The meaningful words in a path or a route.
    ///
    /// Split on separators first, then within each word on camel-case boundaries, so
    /// <c>PaymentsScreen.tsx</c> yields <c>payments</c> and <c>screen</c> as well as the
    /// whole word. Splitting the other way round leaves fragments that still contain
    /// separators — <c>/payments</c> as a single token — and those never match anything,
    /// which is how the inferred mapping quietly found nothing at all.
    ///
    /// Extensions, placeholders and the words every codebase contains are dropped: a match
    /// on "service" or "component" says nothing about what a file affects.</summary>
    private static HashSet<string> Tokens(string value)
    {
        var withoutPlaceholders = System.Text.RegularExpressions.Regex.Replace(value, @"\{[^}]*\}", " ");
        var tokens = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var word in System.Text.RegularExpressions.Regex.Split(withoutPlaceholders, @"[^A-Za-z0-9]+"))
        {
            if (word.Length == 0) continue;

            Add(tokens, word);
            foreach (var part in System.Text.RegularExpressions.Regex.Split(word, @"(?<!^)(?=[A-Z])"))
            {
                Add(tokens, part);
            }
        }

        return tokens;
    }

    private static void Add(HashSet<string> tokens, string word)
    {
        var normalized = word.Trim().ToLowerInvariant();
        if (normalized.Length < 3) return;
        if (Noise.Contains(normalized)) return;
        // A number in a path is a version or an ordinal, never a subject.
        if (normalized.All(char.IsDigit)) return;
        tokens.Add(normalized);
    }

    private static readonly HashSet<string> Noise = new(StringComparer.OrdinalIgnoreCase)
    {
        "src", "app", "apps", "lib", "libs", "test", "tests", "spec", "index", "main",
        "component", "components", "page", "pages", "view", "views", "service", "services",
        "controller", "controllers", "model", "models", "util", "utils", "helper", "helpers",
        "api", "web", "ui", "client", "server", "common", "shared", "core", "tsx", "jsx",
        "ts", "js", "cs", "css", "scss", "html", "json", "module", "modules", "feature",
        "features", "route", "routes", "store", "types", "hooks", "styles"
    };

    private async Task<List<RegressionCandidate>> LoadCandidatesAsync(
        RegressionSelectionRequest request, CancellationToken ct)
    {
        var query = _db.TestCases
            .Where(tc => tc.ProjectId == request.ProjectId && tc.IsEnabled && tc.DeletedAt == null);

        if (request.ApplicationId is not null)
            query = query.Where(tc => tc.ApplicationId == request.ApplicationId);

        var cases = await query
            .Select(tc => new
            {
                tc.Id, tc.Reference, tc.Name, tc.Kind, tc.Priority, tc.Risk, tc.Tags,
                tc.ExecutionCount, tc.FailCount, tc.FlakinessScore, tc.LastStatus, tc.LastExecutedAt
            })
            .ToListAsync(ct);

        if (cases.Count == 0) return new List<RegressionCandidate>();

        var ids = cases.Select(c => c.Id).ToList();

        // What each test touches, read from its steps rather than from a tag: it is what
        // the test does rather than what someone said it does.
        var steps = await _db.TestSteps
            .Where(s => ids.Contains(s.TestCaseId))
            .Select(s => new { s.TestCaseId, s.Url, s.Action, s.ApiRequestJson })
            .ToListAsync(ct);

        var byTest = steps.GroupBy(s => s.TestCaseId).ToDictionary(g => g.Key, g => g.ToList());

        var include = Normalize(request.IncludeTags);
        var exclude = Normalize(request.ExcludeTags);

        var candidates = new List<RegressionCandidate>();
        foreach (var testCase in cases)
        {
            var tags = (testCase.Tags ?? string.Empty)
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();

            if (include.Count > 0 && !tags.Any(include.Contains)) continue;
            if (exclude.Count > 0 && tags.Any(exclude.Contains)) continue;

            var testSteps = byTest.GetValueOrDefault(testCase.Id, new());
            var routes = new List<string>();
            var apiCalls = new List<string>();

            foreach (var step in testSteps)
            {
                if (step.Action == BrowserActionType.ApiRequest && step.ApiRequestJson is not null)
                {
                    var descriptor = ApiRequestValidator.Deserialize(step.ApiRequestJson);
                    if (descriptor is not null) apiCalls.Add(PathOf(descriptor.Path));
                    continue;
                }
                if (!string.IsNullOrWhiteSpace(step.Url)) routes.Add(PathOf(step.Url!));
            }

            candidates.Add(new RegressionCandidate(
                testCase.Id, testCase.Reference, testCase.Name, testCase.Kind,
                testCase.Priority, testCase.Risk, tags,
                routes.Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
                apiCalls.Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
                testCase.ExecutionCount, testCase.FailCount, testCase.FlakinessScore,
                testCase.LastStatus, testCase.LastExecutedAt));
        }

        return candidates;
    }

    private static ImpactSet ToImpactSet(ChangeImpactResult impact) => new(
        new HashSet<string>(impact.AffectedRoutes, StringComparer.OrdinalIgnoreCase),
        new HashSet<string>(impact.AffectedApiPaths, StringComparer.OrdinalIgnoreCase),
        new HashSet<string>(impact.AffectedTags, StringComparer.OrdinalIgnoreCase),
        new HashSet<string>(impact.AffectedTestReferences, StringComparer.OrdinalIgnoreCase),
        impact.AffectsEverything);

    private static bool IsAlwaysRun(ScoredTest test) =>
        test.Components.Single(c => c.Name == "always").Points > 0;

    private static List<string> Values(IEnumerable<PathImpact> impacts, ImpactKind kind) =>
        impacts.Where(i => i.Kind == kind)
            .Select(i => i.Value)
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    private static HashSet<string> Normalize(IReadOnlyList<string>? tags) =>
        new((tags ?? Array.Empty<string>()).Select(t => t.Trim()).Where(t => t.Length > 0),
            StringComparer.OrdinalIgnoreCase);

    /// <summary>Reduces a URL to a comparable path.</summary>
    private static string PathOf(string urlOrPath)
    {
        var value = urlOrPath;
        if (Uri.TryCreate(value, UriKind.Absolute, out var absolute)) value = absolute.AbsolutePath;
        var question = value.IndexOf('?');
        if (question >= 0) value = value[..question];
        value = value.TrimEnd('/');
        return value.Length == 0 ? "/" : value;
    }
}
