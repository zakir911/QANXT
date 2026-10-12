using Microsoft.EntityFrameworkCore;
using QaNxt.Application.Abstractions;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Application.Testing;

/// <summary>Which tests to run.
///   all         every active test of the application
///   failed      active tests whose latest execution did not pass
///   impacted    active tests of forms that changed shape since the tests last ran, plus
///               tests that have never run
///   regression  the regression suite: tests made from confirmed defects, and tests tagged regression
///   selection   only the categories and forms given</summary>
public sealed record SelectionRunRequest(
    Guid ApplicationId,
    string Mode,
    TestCategory[]? Categories = null,
    Guid[]? FormIds = null,
    BrowserType? Browser = null,
    Guid? EnvironmentId = null,
    int? Parallelism = null,
    string? Name = null,
    RunTrigger? Trigger = null);

public sealed record SelectionRunResult(Guid? TestRunId, string Mode, int Selected, string Explanation, TestRunSummary? Run);

public interface ISelectionRunService
{
    Task<Result<SelectionRunResult>> StartAsync(SelectionRunRequest request, CancellationToken ct = default);
    Task<Result<SelectionRunResult>> PreviewAsync(SelectionRunRequest request, CancellationToken ct = default);
}

/// <summary>Run all, run failed, run what a change reached, run the regression suite, or run
/// a chosen slice: the same tests, selected differently, executed the same way.</summary>
public sealed class SelectionRunService : ISelectionRunService
{
    private static readonly ExecutionStatus[] NotPassed =
    {
        ExecutionStatus.Failed, ExecutionStatus.Error, ExecutionStatus.TimedOut, ExecutionStatus.Blocked
    };

    private readonly IQaNxtDbContext _db;
    private readonly ITestRunService _runs;

    public SelectionRunService(IQaNxtDbContext db, ITestRunService runs)
    {
        _db = db;
        _runs = runs;
    }

    public Task<Result<SelectionRunResult>> PreviewAsync(SelectionRunRequest request, CancellationToken ct = default)
        => SelectAsync(request, start: false, ct);

    public Task<Result<SelectionRunResult>> StartAsync(SelectionRunRequest request, CancellationToken ct = default)
        => SelectAsync(request, start: true, ct);

    private async Task<Result<SelectionRunResult>> SelectAsync(SelectionRunRequest request, bool start, CancellationToken ct)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == request.ApplicationId, ct);
        if (application is null) return Error.NotFound("The application");

        var active = _db.TestCases.Where(tc => tc.ProjectId == application.ProjectId && tc.Lifecycle == TestCaseLifecycle.Active
            && (tc.ApplicationId == application.Id || tc.ApplicationId == null));
        var mode = (request.Mode ?? "all").Trim().ToLowerInvariant();
        string explanation;
        List<Guid> ids;

        switch (mode)
        {
            case "all":
                ids = await active.Select(tc => tc.Id).ToListAsync(ct);
                explanation = "Every active test of the application.";
                break;
            case "failed":
                ids = await active.Where(tc => tc.LastStatus != null && NotPassed.Contains(tc.LastStatus.Value)).Select(tc => tc.Id).ToListAsync(ct);
                explanation = "Active tests whose latest execution failed, errored, timed out or was blocked.";
                break;
            case "impacted":
            {
                var changed = await _db.ApplicationForms.Where(f => f.ApplicationId == application.Id && f.ChangedAt != null)
                    .Select(f => new { f.Id, f.ChangedAt }).ToListAsync(ct);
                var candidates = await active.Select(tc => new { tc.Id, tc.ApplicationFormId, tc.LastExecutedAt }).ToListAsync(ct);
                ids = candidates.Where(c => c.LastExecutedAt is null
                        || c.ApplicationFormId is { } formId && changed.Any(f => f.Id == formId && f.ChangedAt > c.LastExecutedAt))
                    .Select(c => c.Id).ToList();
                explanation = $"{changed.Count(f => candidates.Any(c => c.ApplicationFormId == f.Id))} form(s) changed since their tests last ran; their tests, and every test that has never run.";
                break;
            }
            case "regression":
                ids = await active.Where(tc => tc.Category == TestCategory.Regression || tc.SourceDefectId != null || tc.Tags.Contains("regression"))
                    .Select(tc => tc.Id).ToListAsync(ct);
                explanation = "The regression suite: tests made from confirmed defects and tests tagged regression.";
                break;
            case "selection":
            {
                var query = active;
                if (request.Categories is { Length: > 0 })
                {
                    var categories = request.Categories.Cast<TestCategory?>().ToArray();
                    query = query.Where(tc => categories.Contains(tc.Category));
                }
                if (request.FormIds is { Length: > 0 }) query = query.Where(tc => tc.ApplicationFormId != null && request.FormIds.Contains(tc.ApplicationFormId.Value));
                ids = await query.Select(tc => tc.Id).ToListAsync(ct);
                explanation = $"Active tests in {(request.Categories is { Length: > 0 } ? string.Join(", ", request.Categories) : "every category")}"
                    + (request.FormIds is { Length: > 0 } ? $" for {request.FormIds.Length} form(s)." : ".");
                break;
            }
            default:
                return Error.Validation("Mode must be one of all, failed, impacted, regression or selection.");
        }

        if (!start || ids.Count == 0)
        {
            return Result<SelectionRunResult>.Success(new SelectionRunResult(null, mode, ids.Count,
                ids.Count == 0 && start ? $"Nothing to run. {explanation}" : explanation, null));
        }

        var run = await _runs.StartAsync(new StartTestRunRequest(
            application.ProjectId, null, ids.ToArray(), request.EnvironmentId, request.Browser, true, request.Parallelism, null,
            request.Name ?? $"{application.Name} — {mode}", request.Trigger ?? RunTrigger.Manual, null), ct);
        if (!run.IsSuccess) return Result<SelectionRunResult>.Failure(run.Error!);
        return Result<SelectionRunResult>.Success(new SelectionRunResult(run.Value!.Id, mode, ids.Count, explanation, run.Value));
    }
}
