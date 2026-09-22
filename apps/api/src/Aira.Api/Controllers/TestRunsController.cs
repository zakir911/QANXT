using Aira.Api.Authorization;
using Aira.Application.Abstractions;
using Aira.Application.Contracts;
using Aira.Application.Quality;
using Aira.Application.Security;
using Aira.Application.Testing;
using Aira.Domain.Common;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Aira.Api.Controllers;

/// <summary>Starting runs and reading what they produced.</summary>
[RequirePermission(Permissions.ExecutionRead)]
public sealed class TestRunsController : ApiControllerBase
{
    private readonly ITestRunService _runs;
    private readonly IQualityGateEvaluator _gates;
    private readonly IAiraDbContext _db;

    public TestRunsController(ITestRunService runs, IQualityGateEvaluator gates, IAiraDbContext db)
    {
        _runs = runs;
        _gates = gates;
        _db = db;
    }

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid? projectId, [FromQuery] int limit = 25, CancellationToken ct = default)
        => Ok(await _runs.ListAsync(projectId, limit, ct));

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct) => FromResult(await _runs.GetAsync(id, ct));

    /// <summary>Queues a run. Returns immediately; progress arrives over the executions hub.</summary>
    [HttpPost]
    [RequirePermission(Permissions.ExecutionRun)]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    public async Task<IActionResult> Start([FromBody] StartTestRunRequest request, CancellationToken ct)
    {
        var result = await _runs.StartAsync(request, ct);
        return FromResult(result, summary => AcceptedAtAction(nameof(Get), new { id = summary.Id }, summary));
    }

    [HttpPost("{id:guid}/cancel")]
    [RequirePermission(Permissions.ExecutionCancel)]
    public async Task<IActionResult> Cancel(Guid id, CancellationToken ct) => FromResult(await _runs.CancelAsync(id, ct));

    /// <summary>The executions in a run, with their verdicts.</summary>
    [HttpGet("{id:guid}/executions")]
    public async Task<IActionResult> GetExecutions(Guid id, CancellationToken ct)
        => Ok(await _db.TestExecutions
            .Where(e => e.TestRunId == id)
            .OrderBy(e => e.TestCase!.Reference)
            .Select(e => new
            {
                e.Id, e.TestCaseId, reference = e.TestCase!.Reference, name = e.TestCase.Name,
                // The suite is what a CI report groups by, so it travels with the verdict.
                suite = e.TestCase.TestSuite!.Name,
                status = e.Status, e.StartedAt, e.CompletedAt, e.DurationMs, e.Attempt,
                e.StepsTotal, e.StepsPassed, e.StepsFailed, e.StepsHealed,
                e.ConsoleErrorCount, e.NetworkErrorCount, e.ErrorMessage, e.WorkerId,
                browser = e.Browser, e.BrowserVersion, e.CorrelationId,
                priority = e.TestCase.Priority
            })
            .ToListAsync(ct));

    /// <summary>The evaluated quality gate for a run, rule by rule.</summary>
    [HttpGet("{id:guid}/quality-gate")]
    public async Task<IActionResult> GetQualityGate(Guid id, CancellationToken ct)
    {
        if (!await _db.TestRuns.AnyAsync(r => r.Id == id, ct)) return Problem(Error.NotFound("The test run"));
        return Ok(await _gates.EvaluateAsync(id, ct));
    }
}

/// <summary>One execution in detail: every action, its evidence and its diagnosis.</summary>
[Route("api/v1/executions")]
[RequirePermission(Permissions.ExecutionRead)]
public sealed class ExecutionsController : ApiControllerBase
{
    private readonly IAiraDbContext _db;
    public ExecutionsController(IAiraDbContext db) => _db = db;

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var execution = await _db.TestExecutions
            .Include(e => e.TestCase)
            .FirstOrDefaultAsync(e => e.Id == id, ct);
        if (execution is null) return Problem(Error.NotFound("The execution"));

        var actions = await _db.TestActions
            .Where(a => a.TestExecutionId == id)
            .OrderBy(a => a.Order)
            .Select(a => new
            {
                a.Id, a.Order, action = a.Action, a.Description, status = a.Status,
                a.StartedAt, a.DurationMs, a.Url, a.MaskedValue, a.WasHealed, a.HealingConfidence,
                a.ErrorMessage,
                locatorUsed = LocatorDescriptor.FromJson(a.LocatorUsedJson),
                locatorDescription = LocatorDescriptor.FromJson(a.LocatorUsedJson) != null
                    ? LocatorDescriptor.FromJson(a.LocatorUsedJson)!.Describe() : null,
                a.LocatorAlternativesJson
            })
            .ToListAsync(ct);

        var artifacts = await _db.Artifacts
            .Where(a => a.TestExecutionId == id)
            .Select(a => new { a.Id, kind = a.Kind, a.Name, a.ContentType, a.SizeBytes, a.IsMasked, a.TestActionId })
            .ToListAsync(ct);

        var failure = await _db.Failures
            .Where(f => f.TestExecutionId == id)
            .Include(f => f.Analysis)
            .Select(f => new
            {
                f.Id, category = f.Category, f.CategoryConfidence, f.RawMessage, f.Signature,
                f.IsNewFailure, f.IsRegression, f.OccurrenceCount, f.FirstSeenAt, f.LastSeenAt,
                analysis = f.Analysis == null ? null : new
                {
                    f.Analysis.Summary, f.Analysis.LikelyCause, f.Analysis.Evidence,
                    f.Analysis.SuggestedAction, category = f.Analysis.Category, f.Analysis.Confidence,
                    f.Analysis.IsLikelyApplicationDefect, f.Analysis.IsHealable,
                    f.Analysis.ProducedByAi, provider = f.Analysis.Provider, f.Analysis.Model,
                    f.Analysis.EvidenceRefsJson
                }
            })
            .FirstOrDefaultAsync(ct);

        // The API calls each step made, beside the step that made them. This is what the
        // correlation the diagnosis reads looks like to a person: a failing step and the
        // request underneath it, in one place rather than in two lists sharing a timestamp.
        var apiCalls = await _db.NetworkEvents
            .Where(e => e.TestExecutionId == id && e.TestActionId != null)
            .Where(e => e.ResourceType == "xhr" || e.ResourceType == "fetch" || e.ResourceType == "apiTest")
            .OrderBy(e => e.OccurredAt)
            .Select(e => new
            {
                e.Id, e.Method, e.Url, e.StatusCode, e.DurationMs, e.IsFailed, e.FailureText,
                e.ResourceType, e.TestActionId,
                actionOrder = _db.TestActions.Where(a => a.Id == e.TestActionId)
                    .Select(a => (int?)a.Order).FirstOrDefault()
            })
            .Take(500)
            .ToListAsync(ct);

        var healingEvents = await _db.HealingEvents
            .Where(h => h.TestExecutionId == id)
            .Select(h => new
            {
                h.Id, h.TestStepId, h.Confidence, outcome = h.Outcome, h.OutcomeVerified, h.Reason,
                original = h.OriginalLocatorJson, healed = h.HealedLocatorJson, h.ScoreBreakdownJson
            })
            .ToListAsync(ct);

        return Ok(new
        {
            execution.Id, execution.TestRunId, execution.TestCaseId,
            reference = execution.TestCase!.Reference, name = execution.TestCase.Name,
            objective = execution.TestCase.Objective, expectedResults = execution.TestCase.ExpectedResults,
            status = execution.Status, execution.StartedAt, execution.CompletedAt, execution.DurationMs,
            execution.Attempt, execution.TestCaseVersion, browser = execution.Browser,
            execution.BrowserVersion, execution.WorkerId, execution.CorrelationId,
            execution.StepsTotal, execution.StepsPassed, execution.StepsFailed, execution.StepsHealed,
            execution.ConsoleErrorCount, execution.NetworkErrorCount,
            execution.ErrorMessage, execution.ErrorStack,
            actions, artifacts, apiCalls, failure, healingEvents
        });
    }

    [HttpGet("{id:guid}/console")]
    public async Task<IActionResult> GetConsole(Guid id, CancellationToken ct)
        => Ok(await _db.ConsoleEvents
            .Where(e => e.TestExecutionId == id)
            .OrderBy(e => e.OccurredAt)
            .Select(e => new
            {
                e.Id, e.Level, e.Message, e.StackTrace, e.Url, e.OccurredAt,
                e.TestActionId,
                // The step number, not only its id: a reader of the log needs to know which
                // step this happened during without a second lookup.
                actionOrder = _db.TestActions.Where(a => a.Id == e.TestActionId).Select(a => (int?)a.Order).FirstOrDefault()
            })
            .ToListAsync(ct));

    [HttpGet("{id:guid}/network")]
    public async Task<IActionResult> GetNetwork(Guid id, CancellationToken ct)
        => Ok(await _db.NetworkEvents
            .Where(e => e.TestExecutionId == id)
            .OrderBy(e => e.OccurredAt)
            .Select(e => new
            {
                e.Id, e.Method, e.Url, e.ResourceType, e.StatusCode, e.DurationMs,
                e.RequestSizeBytes, e.ResponseSizeBytes, e.IsFailed, e.FailureText, e.OccurredAt,
                e.RequestHeadersJson, e.ResponseHeadersJson, e.RequestBodyExcerpt, e.ResponseBodyExcerpt,
                e.TestActionId,
                actionOrder = _db.TestActions.Where(a => a.Id == e.TestActionId).Select(a => (int?)a.Order).FirstOrDefault()
            })
            .ToListAsync(ct));
}
