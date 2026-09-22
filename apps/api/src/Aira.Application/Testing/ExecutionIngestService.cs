using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Aira.Application.Abstractions;
using Aira.Application.Contracts;
using Aira.Application.Diagnosis;
using Aira.Application.Quality;
using Aira.Application.Security;
using Aira.Domain.Common;
using Aira.Domain.Diagnosis;
using Aira.Domain.Enums;
using Aira.Domain.Evidence;
using Aira.Domain.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Testing;

/// <summary>Receives a worker's execution results and turns them into the record.
///
/// Reporting is where honesty is enforced. A failure is recorded as a failure with its
/// engine message intact; a heal is recorded as Healed rather than Passed; a blocked
/// precondition is not dressed up as a product defect. Analysis is added alongside the raw
/// result, never in place of it.</summary>
public interface IExecutionIngestService
{
    Task<Result> MarkRunningAsync(Guid executionId, string workerId, CancellationToken ct = default);
    Task<Result> RecordActionAsync(Guid executionId, ActionResultPayload action, CancellationToken ct = default);
    Task<Result> CompleteAsync(Guid executionId, ExecutionCompletionPayload completion, CancellationToken ct = default);
}

public sealed class ExecutionIngestService : IExecutionIngestService
{
    private readonly IAiraDbContext _db;
    private readonly IClock _clock;
    private readonly SecretMasker _masker;
    private readonly IExecutionEventPublisher _events;
    private readonly IFailureAnalysisService _failureAnalysis;
    private readonly IQualityGateEvaluator _qualityGates;
    private readonly Applications.IApiContractService _contracts;
    private readonly ILogger<ExecutionIngestService> _logger;

    public ExecutionIngestService(IAiraDbContext db, IClock clock, SecretMasker masker,
        IExecutionEventPublisher events, IFailureAnalysisService failureAnalysis,
        IQualityGateEvaluator qualityGates, Applications.IApiContractService contracts,
        ILogger<ExecutionIngestService> logger)
    {
        _db = db;
        _clock = clock;
        _masker = masker;
        _events = events;
        _failureAnalysis = failureAnalysis;
        _qualityGates = qualityGates;
        _contracts = contracts;
        _logger = logger;
    }

    public async Task<Result> MarkRunningAsync(Guid executionId, string workerId, CancellationToken ct = default)
    {
        var execution = await _db.TestExecutions.FirstOrDefaultAsync(e => e.Id == executionId, ct);
        if (execution is null) return Result.Failure(Error.NotFound("The execution"));

        execution.Status = ExecutionStatus.Running;
        execution.StartedAt ??= _clock.UtcNow;
        execution.WorkerId = workerId;

        var run = await _db.TestRuns.FirstOrDefaultAsync(r => r.Id == execution.TestRunId, ct);
        if (run is not null && run.Status == ExecutionStatus.Queued)
        {
            run.Status = ExecutionStatus.Running;
            run.StartedAt ??= _clock.UtcNow;
        }

        await _db.SaveChangesAsync(ct);

        await _events.PublishAsync(execution.OrganizationId, new ExecutionEvent(
            ExecutionEventTypes.ExecutionStarted, execution.TestRunId, execution.Id,
            new { workerId, execution.Browser }, _clock.UtcNow), ct);

        return Result.Success();
    }

    public async Task<Result> RecordActionAsync(Guid executionId, ActionResultPayload action, CancellationToken ct = default)
    {
        var execution = await _db.TestExecutions.FirstOrDefaultAsync(e => e.Id == executionId, ct);
        if (execution is null) return Result.Failure(Error.NotFound("The execution"));

        await UpsertActionAsync(execution, action, ct);
        await _db.SaveChangesAsync(ct);

        // The console renders this as the live step-by-step view.
        await _events.PublishAsync(execution.OrganizationId, new ExecutionEvent(
            ExecutionEventTypes.ActionCompleted, execution.TestRunId, execution.Id,
            new
            {
                action.Order, action.Action, action.Description,
                status = action.Status.ToString(), action.DurationMs, action.Url,
                action.WasHealed, action.HealingConfidence, action.ErrorMessage
            }, _clock.UtcNow), ct);

        return Result.Success();
    }

    public async Task<Result> CompleteAsync(Guid executionId, ExecutionCompletionPayload completion, CancellationToken ct = default)
    {
        var execution = await _db.TestExecutions
            .Include(e => e.TestCase)
            .FirstOrDefaultAsync(e => e.Id == executionId, ct);
        if (execution is null) return Result.Failure(Error.NotFound("The execution"));

        var run = await _db.TestRuns.FirstOrDefaultAsync(r => r.Id == execution.TestRunId, ct);
        if (run is null) return Result.Failure(Error.NotFound("The test run"));

        await _db.InTransactionAsync(async token =>
        {
            execution.Status = completion.Status;
            execution.StartedAt ??= completion.StartedAt;
            execution.CompletedAt = completion.CompletedAt;
            execution.DurationMs = completion.DurationMs;
            execution.BrowserVersion = Truncate(completion.BrowserVersion, 60);
            execution.WorkerId = Truncate(completion.WorkerId, 100);
            execution.StepsTotal = completion.StepsTotal;
            execution.StepsPassed = completion.StepsPassed;
            execution.StepsFailed = completion.StepsFailed;
            execution.StepsHealed = completion.StepsHealed;
            execution.ConsoleErrorCount = completion.ConsoleErrorCount;
            execution.NetworkErrorCount = completion.NetworkErrorCount;
            // The engine's own message, masked but otherwise verbatim. Analysis is added
            // beside it, never substituted for it.
            execution.ErrorMessage = Truncate(_masker.MaskText(completion.ErrorMessage), 4000);
            execution.ErrorStack = Truncate(_masker.MaskText(completion.ErrorStack), 20_000);

            foreach (var action in completion.Actions) await UpsertActionAsync(execution, action, token);
            await _db.SaveChangesAsync(token);

            await RecordArtifactsAsync(execution, completion, token);
            await RecordEventsAsync(execution, completion, token);
            await RecordHealingAsync(execution, run, completion, token);
            await UpdateTestCaseStatisticsAsync(execution, token);
            await _db.SaveChangesAsync(token);
            return true;
        }, ct);

        Failure? failure = null;
        if (completion.Status is ExecutionStatus.Failed or ExecutionStatus.Error)
        {
            failure = await _failureAnalysis.RecordFailureAsync(execution, run, completion, ct);
        }

        await UpdateRunTotalsAsync(run, ct);

        await _events.PublishAsync(execution.OrganizationId, new ExecutionEvent(
            ExecutionEventTypes.ExecutionCompleted, run.Id, execution.Id,
            new
            {
                status = completion.Status.ToString(),
                completion.DurationMs, completion.StepsPassed, completion.StepsFailed, completion.StepsHealed,
                failureId = failure?.Id
            }, _clock.UtcNow), ct);

        _logger.LogInformation("Execution {ExecutionId} completed as {Status} in {Ms}ms",
            execution.Id, completion.Status, completion.DurationMs);

        return Result.Success();
    }

    private async Task UpsertActionAsync(TestExecution execution, ActionResultPayload payload, CancellationToken ct)
    {
        var action = await _db.TestActions
            .FirstOrDefaultAsync(a => a.TestExecutionId == execution.Id && a.Order == payload.Order, ct);

        if (action is null)
        {
            action = new TestAction
            {
                OrganizationId = execution.OrganizationId,
                TestExecutionId = execution.Id,
                Order = payload.Order,
                CreatedAt = _clock.UtcNow
            };
            _db.TestActions.Add(action);
        }

        action.TestStepId = payload.TestStepId;
        action.Action = ParseAction(payload.Action);
        action.Description = Truncate(payload.Description, 1000) ?? string.Empty;
        action.Status = payload.Status;
        action.StartedAt = payload.StartedAt;
        action.DurationMs = payload.DurationMs;
        action.Url = Truncate(payload.Url, 2048);
        action.LocatorUsedJson = payload.LocatorUsed?.ToJson();
        action.LocatorAlternativesJson = payload.LocatorAlternatives is null
            ? null
            : JsonSerializer.Serialize(payload.LocatorAlternatives, JsonDefaults.Options);
        action.MaskedValue = Truncate(payload.MaskedValue, 2000);
        action.WasHealed = payload.WasHealed;
        action.HealingConfidence = payload.HealingConfidence;
        action.ErrorMessage = Truncate(_masker.MaskText(payload.ErrorMessage), 4000);
    }

    private async Task RecordArtifactsAsync(TestExecution execution, ExecutionCompletionPayload completion, CancellationToken ct)
    {
        var actions = await _db.TestActions
            .Where(a => a.TestExecutionId == execution.Id)
            .Select(a => new { a.Id, a.Order })
            .ToListAsync(ct);

        foreach (var payload in completion.Artifacts)
        {
            // A storage key that still looks like a path means the upload never happened;
            // storing it would produce an artifact row pointing at a worker's temp folder.
            if (payload.StorageKey.StartsWith('/') || payload.StorageKey.Contains(".."))
            {
                _logger.LogWarning("Ignoring artifact '{Name}' on execution {ExecutionId}: it was never uploaded.",
                    payload.Name, execution.Id);
                continue;
            }

            _db.Artifacts.Add(new Artifact
            {
                OrganizationId = execution.OrganizationId,
                TestExecutionId = execution.Id,
                TestActionId = payload.ActionOrder is null
                    ? null
                    : actions.FirstOrDefault(a => a.Order == payload.ActionOrder)?.Id,
                Kind = ParseArtifactKind(payload.Kind),
                Name = Truncate(payload.Name, 300) ?? "artifact",
                StorageKey = Truncate(payload.StorageKey, 512) ?? string.Empty,
                ContentType = Truncate(payload.ContentType, 120) ?? "application/octet-stream",
                SizeBytes = payload.SizeBytes,
                Sha256 = Truncate(payload.Sha256, 64) ?? string.Empty,
                IsMasked = payload.IsMasked,
                CreatedAt = _clock.UtcNow
            });
        }
    }

    private async Task RecordEventsAsync(TestExecution execution, ExecutionCompletionPayload completion, CancellationToken ct)
    {
        // Which action each event belongs to.
        //
        // The worker has always reported an action order on console and network events, and
        // the columns to hold the link have always existed — but nothing wrote them, so
        // every stored event was orphaned. Diagnosis could therefore never say "this step
        // failed and here is the request underneath it", which is the single most useful
        // thing the evidence can say.
        var actionsByOrder = await _db.TestActions
            .Where(a => a.TestExecutionId == execution.Id)
            .Select(a => new { a.Id, a.Order })
            .ToDictionaryAsync(a => a.Order, a => a.Id, ct);

        Guid? actionFor(int? order) =>
            order is not null && actionsByOrder.TryGetValue(order.Value, out var id) ? id : null;

        // Bounded: a page in a redirect loop can produce tens of thousands of events, and
        // the first few hundred carry the signal.
        foreach (var console in completion.ConsoleEvents.Take(500))
        {
            _db.ConsoleEvents.Add(new ConsoleEvent
            {
                OrganizationId = execution.OrganizationId,
                TestExecutionId = execution.Id,
                TestActionId = actionFor(console.ActionOrder),
                Level = Truncate(console.Level, 20) ?? "log",
                Message = Truncate(_masker.MaskText(console.Message), 8000) ?? string.Empty,
                StackTrace = Truncate(_masker.MaskText(console.StackTrace), 20_000),
                Url = Truncate(console.Url, 2048),
                OccurredAt = console.OccurredAt,
                CreatedAt = _clock.UtcNow
            });
        }

        foreach (var network in completion.NetworkEvents.Take(1000))
        {
            _db.NetworkEvents.Add(new NetworkEvent
            {
                OrganizationId = execution.OrganizationId,
                TestExecutionId = execution.Id,
                TestActionId = actionFor(network.ActionOrder),
                Method = Truncate(network.Method, 10) ?? "GET",
                Url = Truncate(network.Url, 2048) ?? string.Empty,
                ResourceType = Truncate(network.ResourceType, 40),
                StatusCode = network.StatusCode,
                DurationMs = network.DurationMs,
                RequestSizeBytes = network.RequestSizeBytes,
                ResponseSizeBytes = network.ResponseSizeBytes,
                RequestHeadersJson = network.RequestHeaders is null ? null
                    : _masker.MaskJson(JsonSerializer.Serialize(network.RequestHeaders, JsonDefaults.Options)),
                ResponseHeadersJson = network.ResponseHeaders is null ? null
                    : _masker.MaskJson(JsonSerializer.Serialize(network.ResponseHeaders, JsonDefaults.Options)),
                RequestBodyExcerpt = Truncate(_masker.MaskJson(network.RequestBodyExcerpt ?? string.Empty), 8000),
                ResponseBodyExcerpt = Truncate(_masker.MaskJson(network.ResponseBodyExcerpt ?? string.Empty), 8000),
                IsFailed = network.IsFailed,
                FailureText = Truncate(network.FailureText, 1000),
                OccurredAt = network.OccurredAt,
                CreatedAt = _clock.UtcNow
            });
        }

        await Task.CompletedTask;
    }

    private async Task RecordHealingAsync(
        TestExecution execution, TestRun run, ExecutionCompletionPayload completion, CancellationToken ct)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == run.ProjectId, ct);

        foreach (var payload in completion.HealingEvents)
        {
            var healingEvent = new HealingEvent
            {
                OrganizationId = execution.OrganizationId,
                ProjectId = run.ProjectId,
                TestCaseId = execution.TestCaseId,
                TestStepId = payload.TestStepId,
                TestExecutionId = execution.Id,
                OriginalLocatorJson = payload.OriginalLocator.ToJson(),
                HealedLocatorJson = payload.HealedLocator.ToJson(),
                Reason = Truncate(payload.Reason, 2000) ?? string.Empty,
                Confidence = payload.Confidence,
                ScoreBreakdownJson = JsonSerializer.Serialize(payload.Breakdown, JsonDefaults.Options),
                PolicyAtTime = project?.HealingPolicy ?? HealingPolicy.Suggest,
                // Applied for this run is not the same as applied to the stored test: the
                // worker used the replacement, but the test definition is untouched until
                // a human approves it.
                Outcome = payload.Applied ? HealingOutcome.Applied : HealingOutcome.Proposed,
                OutcomeVerified = payload.OutcomeVerified,
                ApplicationBuildRef = run.ApplicationBuildRef,
                OccurredAt = payload.OccurredAt,
                CreatedAt = _clock.UtcNow
            };
            _db.HealingEvents.Add(healingEvent);

            var step = await _db.TestSteps.FirstOrDefaultAsync(s => s.Id == payload.TestStepId, ct);
            if (step is not null) step.HealCount++;

            await _events.PublishAsync(execution.OrganizationId, new ExecutionEvent(
                ExecutionEventTypes.HealingProposed, run.Id, execution.Id,
                new
                {
                    healingEventId = healingEvent.Id,
                    testStepId = payload.TestStepId,
                    original = payload.OriginalLocator.Describe(),
                    healed = payload.HealedLocator.Describe(),
                    payload.Confidence,
                    payload.Applied
                }, _clock.UtcNow), ct);
        }
    }

    /// <summary>Maintains the rolling statistics the dashboard and the flakiness signal are
    /// built from. Computed on write so a dashboard query never has to scan history.</summary>
    private async Task UpdateTestCaseStatisticsAsync(TestExecution execution, CancellationToken ct)
    {
        var testCase = await _db.TestCases.FirstOrDefaultAsync(tc => tc.Id == execution.TestCaseId, ct);
        if (testCase is null) return;

        testCase.ExecutionCount++;
        testCase.LastExecutedAt = execution.CompletedAt ?? _clock.UtcNow;
        testCase.LastStatus = execution.Status;

        if (execution.Status is ExecutionStatus.Passed or ExecutionStatus.Healed) testCase.PassCount++;
        else if (execution.Status is ExecutionStatus.Failed or ExecutionStatus.Error) testCase.FailCount++;
        if (execution.Status == ExecutionStatus.Healed) testCase.HealCount++;

        testCase.AverageDurationMs = testCase.AverageDurationMs == 0
            ? execution.DurationMs
            : (int)((testCase.AverageDurationMs * 0.7) + (execution.DurationMs * 0.3));

        // Flakiness is how often the verdict changes across recent runs, not how often the
        // test fails: a test that fails consistently is broken, not flaky.
        var recent = await _db.TestExecutions
            .Where(e => e.TestCaseId == testCase.Id && e.CompletedAt != null)
            .OrderByDescending(e => e.CompletedAt)
            .Take(10)
            .Select(e => e.Status)
            .ToListAsync(ct);

        if (recent.Count >= 3)
        {
            var changes = 0;
            for (var i = 1; i < recent.Count; i++)
            {
                if (IsPass(recent[i]) != IsPass(recent[i - 1])) changes++;
            }
            testCase.FlakinessScore = (int)Math.Round(changes * 100.0 / (recent.Count - 1));

            // The bar is deliberately high. One verdict change is what happens when a
            // defect is fixed or introduced, and labelling that "flaky" would train people
            // to ignore the label. A test earns it by oscillating repeatedly: at least five
            // recent runs and a majority of them changing their mind.
            var isSustainedInstability = recent.Count >= 5 && changes >= 3 && testCase.FlakinessScore >= 50;

            // Only a pass is ever relabelled. A failure is never softened into "flaky",
            // because that is exactly how a real defect gets dismissed.
            if (isSustainedInstability && execution.Status == ExecutionStatus.Passed)
                execution.Status = ExecutionStatus.Flaky;
        }
    }

    private async Task UpdateRunTotalsAsync(TestRun run, CancellationToken ct)
    {
        var statuses = await _db.TestExecutions
            .Where(e => e.TestRunId == run.Id)
            .Select(e => new { e.Status, e.DurationMs })
            .ToListAsync(ct);

        // Flaky and healed executions did pass; they are counted in the pass total and
        // also reported separately, so a run's headline number is not misleading.
        run.PassedCount = statuses.Count(s => s.Status is ExecutionStatus.Passed or ExecutionStatus.Flaky);
        run.FailedCount = statuses.Count(s => s.Status is ExecutionStatus.Failed or ExecutionStatus.Error);
        run.SkippedCount = statuses.Count(s => s.Status == ExecutionStatus.Skipped);
        run.BlockedCount = statuses.Count(s => s.Status == ExecutionStatus.Blocked);
        run.HealedCount = statuses.Count(s => s.Status == ExecutionStatus.Healed);
        run.FlakyCount = statuses.Count(s => s.Status == ExecutionStatus.Flaky);

        var finished = statuses.Count(s => s.Status is not (ExecutionStatus.Queued or ExecutionStatus.Pending or ExecutionStatus.Running));
        if (finished < statuses.Count)
        {
            await _db.SaveChangesAsync(ct);
            return;
        }

        run.CompletedAt = _clock.UtcNow;
        run.DurationMs = run.StartedAt is null ? 0 : (int)(run.CompletedAt.Value - run.StartedAt.Value).TotalMilliseconds;
        run.Status = run.FailedCount > 0 ? ExecutionStatus.Failed
            : run.BlockedCount > 0 && run.PassedCount == 0 && run.HealedCount == 0 ? ExecutionStatus.Blocked
            : ExecutionStatus.Passed;

        await _db.SaveChangesAsync(ct);

        // Contract checking happens before the gate, because the gate has a rule about what
        // it finds. It is skipped silently when the application has no baselines: a check
        // with nothing to compare against would record "no breaking changes", and that
        // sentence would be read as an assurance rather than as an absence of information.
        await CheckContractsAsync(run, ct);

        var gate = await _qualityGates.EvaluateAsync(run.Id, ct);
        run.QualityGatePassed = gate.Passed;
        run.QualityGateSummaryJson = JsonSerializer.Serialize(gate, JsonDefaults.Options);
        await _db.SaveChangesAsync(ct);

        await _events.PublishAsync(run.OrganizationId, new ExecutionEvent(
            ExecutionEventTypes.RunCompleted, run.Id, null,
            new
            {
                status = run.Status.ToString(), run.PassedCount, run.FailedCount, run.HealedCount,
                run.FlakyCount, run.BlockedCount, qualityGatePassed = gate.Passed
            }, _clock.UtcNow), ct);

        _logger.LogInformation("Run {RunId} finished: {Passed} passed, {Failed} failed, {Healed} healed; gate {Gate}",
            run.Id, run.PassedCount, run.FailedCount, run.HealedCount, gate.Passed ? "passed" : "failed");
    }

    /// <summary>Compares the responses this run observed against the stored contract
    /// baselines, and records on the run that it did.
    ///
    /// A failure here never fails the run. The contract check is an observation about the
    /// application's interface; if it cannot be made, the right outcome is that the run
    /// says so, not that a working release is reported as broken.</summary>
    private async Task CheckContractsAsync(TestRun run, CancellationToken ct)
    {
        try
        {
            var applicationIds = await _db.TestExecutions
                .Where(e => e.TestRunId == run.Id)
                .Select(e => e.TestCase!.ApplicationId)
                .Where(id => id != null)
                .Distinct()
                .ToListAsync(ct);

            var hasBaseline = await _db.ApiContracts
                .AnyAsync(c => c.IsBaseline && applicationIds.Contains(c.ApplicationId), ct);

            if (!hasBaseline)
            {
                _logger.LogDebug("Run {RunId}: no contract baselines, so no contract check was performed.", run.Id);
                return;
            }

            var result = await _contracts.CheckRunAsync(run.Id, ct);
            if (!result.IsSuccess)
            {
                _logger.LogWarning("Run {RunId}: the contract check could not be performed: {Error}",
                    run.Id, result.Error!.Message);
                return;
            }

            run.ContractCheckedAt = _clock.UtcNow;
            run.ContractBreakingChangeCount = result.Value!.BreakingCount;
            run.ContractPotentiallyBreakingChangeCount = result.Value.PotentiallyBreakingCount;
            await _db.SaveChangesAsync(ct);

            if (result.Value.BreakingCount > 0)
            {
                _logger.LogWarning(
                    "Run {RunId}: the contract check found {Breaking} breaking and {Potential} potentially "
                    + "breaking change(s) across {Endpoints} endpoint(s).",
                    run.Id, result.Value.BreakingCount, result.Value.PotentiallyBreakingCount,
                    result.Value.EndpointsWithBaseline);
            }
        }
        catch (Exception error)
        {
            // Reported, not swallowed, and not turned into a test failure.
            _logger.LogError(error, "Run {RunId}: the contract check threw.", run.Id);
        }
    }

    private static bool IsPass(ExecutionStatus status)
        => status is ExecutionStatus.Passed or ExecutionStatus.Healed or ExecutionStatus.Flaky;

    private static BrowserActionType ParseAction(string value)
        => Enum.TryParse<BrowserActionType>(value, ignoreCase: true, out var parsed) ? parsed : BrowserActionType.Wait;

    private static ArtifactKind ParseArtifactKind(string value)
        => Enum.TryParse<ArtifactKind>(value, ignoreCase: true, out var parsed) ? parsed : ArtifactKind.Other;

    private static string? Truncate(string? value, int max)
        => string.IsNullOrEmpty(value) ? null : value.Length <= max ? value : value[..max];
}
