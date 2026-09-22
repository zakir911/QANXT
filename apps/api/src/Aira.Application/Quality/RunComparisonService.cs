using Aira.Application.Abstractions;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Quality;

/// <summary>What happened to one test between two runs.</summary>
public enum TestMovement
{
    /// <summary>Failing now, passing before. The list a release decision is made from.</summary>
    NewlyFailing = 0,

    /// <summary>Passing now, failing before. Evidence that a fix worked.</summary>
    Fixed = 1,

    /// <summary>Failing in both. Known, and not a reason to block this release specifically.</summary>
    StillFailing = 2,

    /// <summary>Passing in both.</summary>
    StillPassing = 3,

    /// <summary>In this run and not the previous one.</summary>
    Added = 4,

    /// <summary>In the previous run and not this one.</summary>
    Removed = 5
}

public sealed record TestComparison(
    Guid TestCaseId, string Reference, string Name, string? Suite,
    TestMovement Movement,
    string? CurrentStatus, string? PreviousStatus,
    int CurrentDurationMs, int PreviousDurationMs,
    string? ErrorMessage, string? FailureCategory);

public sealed record RunSide(
    Guid Id, string Name, string Status, DateTimeOffset? CompletedAt,
    int Total, int Passed, int Failed, int Blocked, int Healed, int Flaky,
    int DurationMs, string? CommitSha, string? Branch, string? EnvironmentKey,
    bool? QualityGatePassed);

public sealed record RunComparison(
    RunSide Current, RunSide Previous,
    IReadOnlyList<TestComparison> Tests,
    IReadOnlyDictionary<TestMovement, int> Counts,
    /// <summary>True when nothing moved in either direction.</summary>
    bool Unchanged,
    /// <summary>A sentence a person can read without opening the table.</summary>
    string Summary);

public interface IRunComparisonService
{
    /// <summary>
    /// What changed between two runs.
    /// </summary>
    /// <remarks>
    /// The comparison is by test case, not by position: runs select different tests and a
    /// positional diff would report every test as moved the moment a selection changed.
    /// </remarks>
    Task<Result<RunComparison>> CompareAsync(Guid currentRunId, Guid? previousRunId, CancellationToken ct = default);

    /// <summary>
    /// A release's quality, across every run that tested it.
    /// </summary>
    /// <remarks>
    /// Keyed on the application build reference a pipeline passes with <c>--app-build</c>,
    /// because "the release" is a build, not a date range: a release tested across three
    /// days and four runs is one thing to decide about.
    /// </remarks>
    Task<Result<ReleaseQualityReport>> ReleaseAsync(Guid projectId, string buildRef, CancellationToken ct = default);
}

public sealed record ReleaseQualityReport(
    Guid ProjectId, string ProjectName, string BuildRef,
    int RunCount, DateTimeOffset? FirstRunAt, DateTimeOffset? LastRunAt,
    int TestsCovered, int Passed, int Failed, int Blocked, int Healed, int Flaky,
    decimal PassRatePercent,
    /// <summary>Tests that failed in the latest run for this build.</summary>
    IReadOnlyList<TestComparison> OutstandingFailures,
    /// <summary>Tests that passed at some point and failed at another, within this build.</summary>
    IReadOnlyList<TestComparison> Unstable,
    int BreakingContractChanges,
    int PotentiallyBreakingContractChanges,
    /// <summary>The previous build this was compared against, when one was found.</summary>
    string? ComparedWith,
    RunComparison? Comparison,
    string Summary);

/// <summary>
/// Run-over-run and release-over-release comparison.
/// </summary>
/// <remarks>
/// <para>
/// A single run answers "is it broken now". A release decision needs "what changed", and
/// those are different questions: twelve tests failing is not a reason to stop a release if
/// the same twelve failed last week and somebody already knows why. What stops a release is
/// a test that used to pass.
/// </para>
/// <para>
/// Everything here is computed from stored executions. Nothing is estimated and nothing is
/// filled in: where a comparison cannot be made — no previous run, no build reference —
/// the report says so rather than reporting zeros that read as an assurance.
/// </para>
/// </remarks>
public sealed class RunComparisonService : IRunComparisonService
{
    private readonly IAiraDbContext _db;
    private readonly ILogger<RunComparisonService> _logger;

    public RunComparisonService(IAiraDbContext db, ILogger<RunComparisonService> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<Result<RunComparison>> CompareAsync(Guid currentRunId, Guid? previousRunId,
        CancellationToken ct = default)
    {
        var current = await _db.TestRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == currentRunId, ct);
        if (current is null) return Error.NotFound("The run");

        var previous = previousRunId is null
            ? await PreviousAsync(current, ct)
            : await _db.TestRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == previousRunId, ct);

        if (previous is null)
        {
            return Error.Validation(
                "There is no earlier finished run in this project to compare against. A first run "
                + "has nothing to have changed from.");
        }

        if (previous.Id == current.Id)
            return Error.Validation("A run cannot be compared with itself.");

        var comparison = await BuildAsync(current, previous, ct);
        return Result<RunComparison>.Success(comparison);
    }

    public async Task<Result<ReleaseQualityReport>> ReleaseAsync(Guid projectId, string buildRef,
        CancellationToken ct = default)
    {
        var project = await _db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == projectId, ct);
        if (project is null) return Error.NotFound("The project");

        var reference = (buildRef ?? string.Empty).Trim();
        if (reference.Length == 0)
            return Error.Validation("A build reference is required. Pipelines set it with --app-build.");

        var runs = await _db.TestRuns.AsNoTracking()
            .Where(r => r.ProjectId == projectId && r.ApplicationBuildRef == reference && r.CompletedAt != null)
            .OrderBy(r => r.CompletedAt)
            .ToListAsync(ct);

        if (runs.Count == 0)
        {
            // Said rather than answered with zeros. "No runs tested this build" and "this
            // build passed everything" look identical in a table of counts.
            return Error.NotFound($"Any finished run for build '{reference}' in this project");
        }

        var runIds = runs.Select(r => r.Id).ToList();
        var executions = await LoadAsync(runIds, ct);

        var latest = runs[^1];
        var latestExecutions = executions.Where(e => e.RunId == latest.Id).ToList();

        // Covered across the whole build, because a release tested by four runs covers the
        // union of what they ran, not whatever the last one happened to select.
        var covered = executions.Select(e => e.TestCaseId).Distinct().Count();

        var outstanding = latestExecutions
            .Where(e => IsFailure(e.Status))
            .Select(e => Describe(e, null, TestMovement.StillFailing))
            .OrderBy(test => test.Reference)
            .ToList();

        // A test that passed in one run of this build and failed in another. Worth its own
        // list: it is neither a clean pass nor a clean failure, and shipping on the strength
        // of whichever run happened to be last is how an intermittent defect reaches
        // production.
        var unstable = executions
            .GroupBy(e => e.TestCaseId)
            .Where(group => group.Any(e => IsFailure(e.Status)) && group.Any(e => IsPass(e.Status)))
            .Select(group => Describe(group.Last(), null, TestMovement.StillFailing))
            .OrderBy(test => test.Reference)
            .ToList();

        var passed = latestExecutions.Count(e => IsPass(e.Status));
        var failed = latestExecutions.Count(e => IsFailure(e.Status));
        var finished = passed + failed;

        // Compared against the most recent run of the build before this one, so the report
        // answers "what changed in this release" and not only "what is broken".
        var earlier = await _db.TestRuns.AsNoTracking()
            .Where(r => r.ProjectId == projectId && r.CompletedAt != null
                     && r.ApplicationBuildRef != null && r.ApplicationBuildRef != reference
                     && r.CompletedAt < latest.CompletedAt)
            .OrderByDescending(r => r.CompletedAt)
            .FirstOrDefaultAsync(ct);

        var comparison = earlier is null ? null : await BuildAsync(latest, earlier, ct);

        var summary = Describe(reference, runs.Count, outstanding.Count, unstable.Count, comparison);

        return Result<ReleaseQualityReport>.Success(new ReleaseQualityReport(
            projectId, project.Name, reference,
            runs.Count, runs[0].CompletedAt, latest.CompletedAt,
            covered, passed, failed,
            latestExecutions.Count(e => e.Status == ExecutionStatus.Blocked),
            latestExecutions.Count(e => e.Status == ExecutionStatus.Healed),
            latestExecutions.Count(e => e.Status == ExecutionStatus.Flaky),
            finished == 0 ? 0m : Math.Round(passed * 100m / finished, 1),
            outstanding, unstable,
            latest.ContractBreakingChangeCount, latest.ContractPotentiallyBreakingChangeCount,
            earlier?.ApplicationBuildRef, comparison, summary));
    }

    // -----------------------------------------------------------------------

    private sealed record Row(
        Guid RunId, Guid TestCaseId, string Reference, string Name, string? Suite,
        ExecutionStatus Status, int DurationMs, string? ErrorMessage, DateTimeOffset? CompletedAt);

    private async Task<List<Row>> LoadAsync(List<Guid> runIds, CancellationToken ct)
        => await _db.TestExecutions.AsNoTracking()
            .Where(e => runIds.Contains(e.TestRunId))
            .OrderBy(e => e.CompletedAt)
            .Select(e => new Row(
                e.TestRunId, e.TestCaseId, e.TestCase!.Reference, e.TestCase.Name,
                e.TestCase.TestSuite!.Name, e.Status, e.DurationMs, e.ErrorMessage, e.CompletedAt))
            .ToListAsync(ct);

    /// <summary>The most recent finished run in the same project before this one.</summary>
    /// <remarks>
    /// Scoped to the project and to finished runs. A run still in progress has counts that
    /// will change, and comparing against it would report movements that unmake themselves.
    /// </remarks>
    private async Task<Domain.Testing.TestRun?> PreviousAsync(Domain.Testing.TestRun current, CancellationToken ct)
        => await _db.TestRuns.AsNoTracking()
            .Where(r => r.ProjectId == current.ProjectId
                     && r.Id != current.Id
                     && r.CompletedAt != null
                     && r.CompletedAt < (current.CompletedAt ?? DateTimeOffset.MaxValue))
            .OrderByDescending(r => r.CompletedAt)
            .FirstOrDefaultAsync(ct);

    private async Task<RunComparison> BuildAsync(Domain.Testing.TestRun current,
        Domain.Testing.TestRun previous, CancellationToken ct)
    {
        var rows = await LoadAsync([current.Id, previous.Id], ct);

        // Keyed by test case, not by position: runs select different tests, and a
        // positional diff would report everything as moved the moment a selection changed.
        var currentByTest = rows.Where(r => r.RunId == current.Id)
            .GroupBy(r => r.TestCaseId).ToDictionary(g => g.Key, g => g.Last());
        var previousByTest = rows.Where(r => r.RunId == previous.Id)
            .GroupBy(r => r.TestCaseId).ToDictionary(g => g.Key, g => g.Last());

        var tests = new List<TestComparison>();

        foreach (var (testCaseId, row) in currentByTest)
        {
            previousByTest.TryGetValue(testCaseId, out var before);

            var movement = before is null
                ? TestMovement.Added
                : IsFailure(row.Status) && IsPass(before.Status) ? TestMovement.NewlyFailing
                : IsPass(row.Status) && IsFailure(before.Status) ? TestMovement.Fixed
                : IsFailure(row.Status) ? TestMovement.StillFailing
                : TestMovement.StillPassing;

            tests.Add(Describe(row, before, movement));
        }

        foreach (var (testCaseId, before) in previousByTest)
        {
            if (currentByTest.ContainsKey(testCaseId)) continue;
            // Ran last time and not this time. Not a failure, and worth showing: a test
            // that quietly stopped being selected is coverage nobody decided to drop.
            tests.Add(new TestComparison(
                testCaseId, before.Reference, before.Name, before.Suite, TestMovement.Removed,
                null, before.Status.ToString(), 0, before.DurationMs, null, null));
        }

        var counts = Enum.GetValues<TestMovement>()
            .ToDictionary(movement => movement, movement => tests.Count(t => t.Movement == movement));

        var unchanged = counts[TestMovement.NewlyFailing] == 0
            && counts[TestMovement.Fixed] == 0
            && counts[TestMovement.Added] == 0
            && counts[TestMovement.Removed] == 0;

        var failureCategories = await CategoriesAsync(current.Id, ct);
        tests = tests
            .Select(test => failureCategories.TryGetValue(test.TestCaseId, out var category)
                ? test with { FailureCategory = category }
                : test)
            // Newly failing first: it is the list a release decision is made from.
            .OrderBy(test => (int)test.Movement)
            .ThenBy(test => test.Reference)
            .ToList();

        return new RunComparison(
            Side(current), Side(previous), tests, counts, unchanged,
            Summarise(counts, unchanged));
    }

    private async Task<Dictionary<Guid, string>> CategoriesAsync(Guid runId, CancellationToken ct)
    {
        var rows = await _db.Failures.AsNoTracking()
            .Where(f => f.TestExecutionId != null
                     && _db.TestExecutions.Any(e => e.Id == f.TestExecutionId && e.TestRunId == runId))
            .Select(f => new
            {
                TestCaseId = _db.TestExecutions
                    .Where(e => e.Id == f.TestExecutionId).Select(e => e.TestCaseId).FirstOrDefault(),
                f.Category
            })
            .ToListAsync(ct);

        return rows
            .Where(row => row.TestCaseId != Guid.Empty)
            .GroupBy(row => row.TestCaseId)
            .ToDictionary(group => group.Key, group => group.First().Category.ToString());
    }

    private static TestComparison Describe(Row current, Row? previous, TestMovement movement) => new(
        current.TestCaseId, current.Reference, current.Name, current.Suite, movement,
        current.Status.ToString(), previous?.Status.ToString(),
        current.DurationMs, previous?.DurationMs ?? 0,
        current.ErrorMessage, null);

    private static RunSide Side(Domain.Testing.TestRun run) => new(
        run.Id, run.Name, run.Status.ToString(), run.CompletedAt,
        run.TotalCount, run.PassedCount, run.FailedCount, run.BlockedCount,
        run.HealedCount, run.FlakyCount, run.DurationMs,
        run.CiCommitSha, run.CiBranch, null, run.QualityGatePassed);

    /// <summary>
    /// The comparison in a sentence.
    /// </summary>
    /// <remarks>
    /// Leads with what is new, because that is what a release decision turns on. Twelve
    /// tests failing is not a reason to stop a release if the same twelve failed last week
    /// and somebody already knows why; one test that used to pass is.
    /// </remarks>
    private static string Summarise(IReadOnlyDictionary<TestMovement, int> counts, bool unchanged)
    {
        if (unchanged)
        {
            return counts[TestMovement.StillFailing] > 0
                ? $"Nothing changed. {counts[TestMovement.StillFailing]} test(s) are still failing, "
                  + "as they were before."
                : "Nothing changed, and nothing is failing.";
        }

        var parts = new List<string>();
        if (counts[TestMovement.NewlyFailing] > 0)
            parts.Add($"{counts[TestMovement.NewlyFailing]} test(s) that used to pass now fail");
        if (counts[TestMovement.Fixed] > 0)
            parts.Add($"{counts[TestMovement.Fixed]} that used to fail now pass");
        if (counts[TestMovement.StillFailing] > 0)
            parts.Add($"{counts[TestMovement.StillFailing]} were already failing");
        if (counts[TestMovement.Added] > 0)
            parts.Add($"{counts[TestMovement.Added]} ran that did not run before");
        if (counts[TestMovement.Removed] > 0)
            parts.Add($"{counts[TestMovement.Removed]} that ran before did not run this time");

        return $"{string.Join(", ", parts)}.";
    }

    private static string Describe(string buildRef, int runs, int outstanding, int unstable,
        RunComparison? comparison)
    {
        var parts = new List<string>
        {
            $"Build {buildRef} was tested by {runs} run(s)."
        };

        parts.Add(outstanding == 0
            ? "Nothing is failing in the most recent one."
            : $"{outstanding} test(s) are failing in the most recent one.");

        if (unstable > 0)
        {
            // Called out because it is the finding people skip: a test that passed once and
            // failed once within the same build is not covered by either headline.
            parts.Add($"{unstable} test(s) both passed and failed within this build, so the "
                + "result depends on which run you look at.");
        }

        if (comparison is null)
        {
            // Stated, not omitted: a report with no comparison section could be read as
            // "nothing changed".
            parts.Add("There is no earlier build to compare against, so nothing here says what changed.");
        }
        else
        {
            parts.Add($"Against {comparison.Previous.Name}: {comparison.Summary}");
        }

        return string.Join(" ", parts);
    }

    private static bool IsFailure(ExecutionStatus status)
        => status is ExecutionStatus.Failed or ExecutionStatus.Error;

    private static bool IsPass(ExecutionStatus status)
        => status is ExecutionStatus.Passed or ExecutionStatus.Healed or ExecutionStatus.Flaky;
}
