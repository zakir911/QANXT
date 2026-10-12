using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using QaNxt.Application.Abstractions;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Application.Forms;

/// <summary>One category's numbers on one form.
///
/// <c>Status</c> is "covered", "partial", "not-run", "n/a" (nothing in the form calls for it)
/// or "not-selected" (the testing configuration left it out). Only covered, partial and
/// not-run count towards the score; n/a and not-selected never lower it.</summary>
public sealed record CategoryCoverage(
    string Category, string Status, int Generated, int Executed, int Passed, int Failed, int Blocked,
    int OpenGaps, int HumanTasks, int Weight, double? CoveragePercent);

public sealed record FormCoverage(
    Guid FormId, string Name, string Route, string PageUrl, int Fields, int RequiredFields, bool IsMultiStep,
    int Generated, int Executed, int Passed, int Failed, int Blocked, int NotRun,
    double? CoveragePercent, double? PassPercent, int Gaps, int HumanTasks, int HumanTasksOpen, int Findings,
    IReadOnlyList<CategoryCoverage> Categories);

public sealed record DimensionCoverage(string Dimension, int Discovered, int Tested, int Executed, string Detail);

public sealed record GapView(
    Guid Id, Guid? FormId, string? FormName, string? FieldKey, string Category, string Missing, string Reason,
    string RecommendedAction, string Status);

public sealed record SurfaceSummary(
    int DiscoveredPages, int DiscoveredForms, int DiscoveredFields, int DiscoveredEndpoints,
    int TestableTests, int ExecutedTests, int PassedTests, int FailedTests,
    int PartiallyCovered, int HumanRequired, int Unsupported, int UnknownBoundaries, int NotCovered);

public sealed record ApplicationCoverage(
    Guid ApplicationId, string ApplicationName, TestingMode Mode, IReadOnlyList<string> SelectedCategories,
    SurfaceSummary Surface, double? OverallCoveragePercent, double? PassPercent,
    IReadOnlyList<FormCoverage> Forms, IReadOnlyList<DimensionCoverage> Dimensions,
    IReadOnlyList<CategoryCoverage> Categories, IReadOnlyList<GapView> Gaps,
    IReadOnlyDictionary<string, int> HumanTasksByStatus, string Statement);

public interface ICoverageService
{
    Task<Result<ApplicationCoverage>> ForApplicationAsync(Guid applicationId, CancellationToken ct = default);
}

/// <summary>Measures coverage from what actually ran.
///
/// Every number here is counted from stored tests, their latest executions, gaps and tasks.
/// None is estimated. A category's coverage is the share of its tests that have been
/// executed, with each open gap counted as a test that could not be: so a category with
/// ten tests run and two unknown boundaries is at 83%, not 100%. Coverage is not the pass
/// rate — a form whose every test ran and half failed is fully covered and half broken —
/// and the two are reported side by side so neither can stand in for the other.</summary>
public sealed class CoverageService : ICoverageService
{
    private static readonly ExecutionStatus[] Verdicts =
    {
        ExecutionStatus.Passed, ExecutionStatus.Healed, ExecutionStatus.Flaky, ExecutionStatus.Failed,
        ExecutionStatus.Error, ExecutionStatus.TimedOut, ExecutionStatus.Blocked
    };

    private readonly IQaNxtDbContext _db;

    public CoverageService(IQaNxtDbContext db) => _db = db;

    private sealed record TestRow(Guid Id, TestCategory? Category, Guid? FormId, string? FieldKey, string? Keys,
        ExecutionStatus? Status, DateTimeOffset? LastExecutedAt);

    private static bool Executed(TestRow t) => t.LastExecutedAt is not null && t.Status is { } s && Verdicts.Contains(s);
    private static bool Passed(TestRow t) => t.Status is ExecutionStatus.Passed or ExecutionStatus.Healed or ExecutionStatus.Flaky;
    private static bool Failed(TestRow t) => t.Status is ExecutionStatus.Failed or ExecutionStatus.Error or ExecutionStatus.TimedOut;
    private static bool Blocked(TestRow t) => t.Status is ExecutionStatus.Blocked;
    private static bool Uncovered(CoverageGapStatus s) => s is CoverageGapStatus.NotCovered or CoverageGapStatus.PartiallyCovered or CoverageGapStatus.Unknown;

    public async Task<Result<ApplicationCoverage>> ForApplicationAsync(Guid applicationId, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == applicationId, ct);
        if (application is null) return Error.NotFound("The application");
        var profile = TestingProfile.FromJson(application.TestingConfigJson);
        var selected = profile.EffectiveCategories();

        var forms = await _db.ApplicationForms.Where(f => f.ApplicationId == applicationId && f.IsPresent)
            .OrderBy(f => f.Route).ThenBy(f => f.FormKey).ToListAsync(ct);
        var tests = (await _db.TestCases
            .Where(tc => tc.ApplicationId == applicationId && tc.Lifecycle == TestCaseLifecycle.Active)
            .Select(tc => new { tc.Id, tc.Category, tc.ApplicationFormId, tc.FieldKey, tc.CoverageKeysJson, tc.LastStatus, tc.LastExecutedAt })
            .ToListAsync(ct))
            .Select(t => new TestRow(t.Id, t.Category, t.ApplicationFormId, t.FieldKey, t.CoverageKeysJson, t.LastStatus, t.LastExecutedAt))
            .ToList();
        var gaps = await _db.CoverageGaps.Where(g => g.ApplicationId == applicationId).ToListAsync(ct);
        var tasks = await _db.HumanVerificationTasks.Where(t => t.ApplicationId == applicationId)
            .Select(t => new { t.ApplicationFormId, t.Category, t.Status }).ToListAsync(ct);
        var findings = await _db.FormFindings.Where(f => f.ApplicationId == applicationId)
            .GroupBy(f => f.ApplicationFormId).Select(g => new { g.Key, Count = g.Count() }).ToListAsync(ct);
        var pages = await _db.ApplicationPages.CountAsync(p => p.ApplicationId == applicationId, ct);
        var endpoints = await _db.ApiEndpoints.Where(e => e.ApplicationId == applicationId).Select(e => new { e.Method, e.UrlTemplate }).ToListAsync(ct);
        var journeys = await _db.Journeys.CountAsync(j => j.ApplicationId == applicationId, ct);

        var formCoverage = new List<FormCoverage>();
        foreach (var form in forms)
        {
            var formTests = tests.Where(t => t.FormId == form.Id).ToList();
            var formGaps = gaps.Where(g => g.ApplicationFormId == form.Id).ToList();
            var formTasks = tasks.Where(t => t.ApplicationFormId == form.Id).ToList();
            var categories = Enum.GetValues<TestCategory>()
                .Select(c => Category(c, formTests.Where(t => t.Category == c).ToList(), formGaps.Where(g => g.Category == c).ToList(),
                    formTasks.Count(t => t.Category == c), selected.Contains(c), profile.WeightOf(c)))
                .ToList();

            formCoverage.Add(new FormCoverage(form.Id, form.Name, form.Route, form.PageUrl, form.FieldCount, form.RequiredFieldCount, form.IsMultiStep,
                formTests.Count, formTests.Count(Executed), formTests.Count(Passed), formTests.Count(Failed), formTests.Count(Blocked),
                formTests.Count(t => !Executed(t)),
                Score(categories), PassRate(formTests), formGaps.Count, formTasks.Count, formTasks.Count(t => t.Status == HumanTaskStatus.Pending),
                findings.FirstOrDefault(f => f.Key == form.Id)?.Count ?? 0, categories));
        }

        var appCategories = Enum.GetValues<TestCategory>()
            .Select(c => Category(c, tests.Where(t => t.Category == c).ToList(), gaps.Where(g => g.Category == c).ToList(),
                tasks.Count(t => t.Category == c), selected.Contains(c), profile.WeightOf(c)))
            .ToList();

        var keyed = tests.Select(t => (Test: t, Keys: Keys(t.Keys))).ToList();
        (int Tested, int Executed) Count(string prefix)
        {
            var all = keyed.SelectMany(k => k.Keys.Where(key => key.StartsWith(prefix, StringComparison.Ordinal))).ToHashSet();
            var run = keyed.Where(k => Executed(k.Test)).SelectMany(k => k.Keys.Where(key => key.StartsWith(prefix, StringComparison.Ordinal))).ToHashSet();
            return (all.Count, run.Count);
        }

        var models = forms.Select(f => DiscoveredFormModel.FromJson(f.ModelJson)).Where(m => m is not null).ToList();
        var totalFields = forms.Sum(f => f.FieldCount);
        var field = Count("field:");
        var rules = Count("rule:");
        var boundaries = Count("boundary:");
        var api = Count("api:");
        var security = Count("security:");
        var a11y = Count("a11y:");
        var states = Count("state:");
        var viewports = Count("viewport:");
        var browsers = await _db.TestExecutions
            .Where(e => e.TestCase!.ApplicationId == applicationId && e.CompletedAt != null && Verdicts.Contains(e.Status))
            .Select(e => e.Browser).Distinct().ToListAsync(ct);
        var unknownBoundaries = gaps.Count(g => g.Category == TestCategory.Boundary && g.Status == CoverageGapStatus.Unknown);
        var formsWithTests = formCoverage.Count(f => f.Generated > 0);
        var formsExecuted = formCoverage.Count(f => f.Executed > 0);

        var dimensions = new List<DimensionCoverage>
        {
            new("Pages", pages, forms.Select(f => f.ApplicationPageId).Distinct().Count(), formCoverage.Where(f => f.Executed > 0).Select(f => f.PageUrl).Distinct().Count(),
                "Pages discovered; pages with forms that have tests; pages whose form tests have run."),
            new("Forms", forms.Count, formsWithTests, formsExecuted, "Forms discovered; with generated tests; with executed tests."),
            new("Fields", totalFields, field.Tested, field.Executed, "Fields discovered; with at least one test; whose tests have run."),
            new("Validation rules", rules.Tested + gaps.Count(g => g.Category is TestCategory.Validation or TestCategory.Negative or TestCategory.CrossField && Uncovered(g.Status)), rules.Tested, rules.Executed,
                "Rules observable from the page (required, format, pattern, step, cross-field), plus rules that could not be tested."),
            new("Boundaries", boundaries.Tested + unknownBoundaries, boundaries.Tested, boundaries.Executed,
                $"Declared boundaries tested; {unknownBoundaries} boundary(ies) unknown because no limit is declared, and none was invented."),
            new("APIs", endpoints.Count + api.Tested, api.Tested, api.Executed, "Endpoints observed in discovery or as form targets; correlated with a form; exercised by a run."),
            new("Testing types", selected.Count, appCategories.Count(c => c.Generated > 0), appCategories.Count(c => c.Executed > 0), "Categories selected; with generated tests; with executed tests."),
            new("Browsers", profile.Browsers.Count, profile.Browsers.Count, browsers.Count(b => profile.Browsers.Contains(b)),
                $"Browsers configured; executed in: {(browsers.Count == 0 ? "none yet" : string.Join(", ", browsers))}."),
            new("Viewports", profile.Viewports.Count, viewports.Tested, viewports.Executed, $"Viewports configured: {string.Join(", ", profile.Viewports.Select(v => $"{v.Name} {v.Size}"))}."),
            new("Security controls", security.Tested, security.Tested, security.Executed, "Per-form security checks (reflection, anti-forgery, password handling)."),
            new("Accessibility checks", a11y.Tested, a11y.Tested, a11y.Executed, "Automated rules, error association, keyboard order and keyboard submission. Human checks are separate."),
            new("States", states.Tested, states.Tested, states.Executed, "Form and application states the tests drive through."),
            new("Workflows", journeys, tests.Count(t => t.Category == TestCategory.Workflow), tests.Count(t => t.Category == TestCategory.Workflow && Executed(t)),
                "Recorded journeys; workflow tests generated and run.")
        };

        var surface = new SurfaceSummary(pages, forms.Count, totalFields, endpoints.Count,
            tests.Count, tests.Count(Executed), tests.Count(Passed), tests.Count(Failed),
            gaps.Count(g => g.Status == CoverageGapStatus.PartiallyCovered), gaps.Count(g => g.Status == CoverageGapStatus.HumanRequired) + tasks.Count(t => t.Status == HumanTaskStatus.Pending),
            gaps.Count(g => g.Status == CoverageGapStatus.Unsupported), unknownBoundaries, gaps.Count(g => g.Status == CoverageGapStatus.NotCovered));

        var overall = Score(appCategories);
        var statement = forms.Count == 0
            ? "No forms have been discovered, so there is nothing to measure."
            : tests.Count(Executed) == 0
                ? $"{tests.Count} test(s) exist for {forms.Count} form(s) and none has run yet, so coverage is 0%."
                : $"{tests.Count(Executed)} of {tests.Count} active test(s) have run across {formsExecuted} of {forms.Count} form(s). "
                  + $"{surface.PartiallyCovered + surface.NotCovered + unknownBoundaries} gap(s) are counted against coverage; "
                  + $"{surface.HumanRequired} item(s) need a person and {surface.Unsupported} cannot be automated here. "
                  + "Coverage is measured, not claimed: it is not 100% unless every applicable test ran and nothing is open.";

        var formNames = forms.ToDictionary(f => f.Id, f => f.Name);
        return Result<ApplicationCoverage>.Success(new ApplicationCoverage(application.Id, application.Name, profile.Mode,
            selected.Select(TestingProfile.CategoryKey).ToList(), surface, overall, PassRate(tests), formCoverage, dimensions, appCategories,
            gaps.OrderBy(g => g.Status).ThenBy(g => g.Category).Select(g => new GapView(g.Id, g.ApplicationFormId,
                g.ApplicationFormId is { } id && formNames.TryGetValue(id, out var name) ? name : null, g.FieldKey,
                TestingProfile.CategoryKey(g.Category), g.Missing, g.Reason, g.RecommendedAction, StatusKey(g.Status))).ToList(),
            tasks.GroupBy(t => t.Status.ToString().ToLowerInvariant()).ToDictionary(g => g.Key, g => g.Count()),
            statement));
    }

    private static CategoryCoverage Category(TestCategory category, List<TestRow> tests, List<Domain.Testing.CoverageGap> gaps,
        int humanTasks, bool selected, int weight)
    {
        var key = TestingProfile.CategoryKey(category);
        var open = gaps.Count(g => Uncovered(g.Status));
        var executed = tests.Count(Executed);
        if (!selected) return new(key, "not-selected", tests.Count, executed, tests.Count(Passed), tests.Count(Failed), tests.Count(Blocked), open, humanTasks, weight, null);
        if (tests.Count == 0 && open == 0) return new(key, humanTasks > 0 ? "human" : "n/a", 0, 0, 0, 0, 0, 0, humanTasks, weight, null);
        var denominator = tests.Count + open;
        var percent = Math.Round(100.0 * executed / denominator, 1);
        var status = executed == 0 ? "not-run" : percent >= 100 ? "covered" : "partial";
        return new(key, status, tests.Count, executed, tests.Count(Passed), tests.Count(Failed), tests.Count(Blocked), open, humanTasks, weight, percent);
    }

    /// <summary>The weighted mean of the categories that count. Null when none does, so an
    /// empty application reads "not measured" rather than 0% or, worse, 100%.</summary>
    private static double? Score(IReadOnlyList<CategoryCoverage> categories)
    {
        var counted = categories.Where(c => c.CoveragePercent is not null && c.Weight > 0).ToList();
        if (counted.Count == 0) return null;
        var total = counted.Sum(c => c.Weight);
        return Math.Round(counted.Sum(c => c.CoveragePercent!.Value * c.Weight) / total, 1);
    }

    private static double? PassRate(IReadOnlyList<TestRow> tests)
    {
        var executed = tests.Where(Executed).ToList();
        return executed.Count == 0 ? null : Math.Round(100.0 * executed.Count(Passed) / executed.Count, 1);
    }

    private static string StatusKey(CoverageGapStatus status) => status switch
    {
        CoverageGapStatus.PartiallyCovered => "partially-covered",
        CoverageGapStatus.NotCovered => "not-covered",
        CoverageGapStatus.HumanRequired => "human-required",
        CoverageGapStatus.Unsupported => "unsupported",
        _ => "unknown"
    };

    private static IReadOnlyList<string> Keys(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return Array.Empty<string>();
        try { return JsonSerializer.Deserialize<List<string>>(json) ?? new List<string>(); }
        catch (JsonException) { return Array.Empty<string>(); }
    }
}
