using Aira.Application.Abstractions;
using Aira.Application.Discovery;
using Aira.Application.Intelligence;
using Aira.Application.Security;
using Aira.Application.Testing;
using Aira.Domain.Agent;
using Aira.Domain.Enums;
using Aira.Domain.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Agent;

public interface IAgentLoop
{
    Task RunAsync(Guid agentRunId, CancellationToken ct = default);
}

/// <summary>One bounded pass: explore, model, prioritise, generate, execute, investigate,
/// propose.
///
/// The loop is a fixed sequence rather than something a model decides, and that is the
/// whole point. A model chooses *what to look at* — it never chooses what the agent is
/// allowed to do, and it never drives a browser. Every phase is recorded as it happens,
/// because nobody watched this run and its conclusions are worth nothing if they cannot be
/// read back afterwards.
///
/// Three bounds are checked between every phase: wall clock, model spend, and whether
/// somebody cancelled. Hitting one stops the pass and says so in the write-up, so "the
/// agent found nothing else" is never confused with "the agent ran out of budget".</summary>
public sealed class AgentLoop : IAgentLoop
{
    /// <summary>How long to wait between checks on a discovery or test run.</summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(3);

    private readonly IAiraDbContext _db;
    private readonly IDiscoveryService _discovery;
    private readonly ITestGenerationService _generation;
    private readonly ITestRunService _runs;
    private readonly ITenantContext _tenant;
    private readonly IClock _clock;
    private readonly SecretMasker _masker;
    private readonly IAgentJournal _journal;
    private readonly IApplicationContextService _context;
    private readonly ILogger<AgentLoop> _logger;

    public AgentLoop(IAiraDbContext db, IDiscoveryService discovery, ITestGenerationService generation,
        ITestRunService runs, ITenantContext tenant, IClock clock, SecretMasker masker,
        IAgentJournal journal, IApplicationContextService context,
        ILogger<AgentLoop> logger)
    {
        _db = db;
        _discovery = discovery;
        _generation = generation;
        _runs = runs;
        _tenant = tenant;
        _clock = clock;
        _masker = masker;
        _journal = journal;
        _context = context;
        _logger = logger;
    }

    public async Task RunAsync(Guid agentRunId, CancellationToken ct = default)
    {
        var run = await _db.AgentRuns.FirstOrDefaultAsync(r => r.Id == agentRunId, ct);
        if (run is null) return;

        // The pass acts on behalf of the organization that started it, not of a request.
        _tenant.SetOrganization(run.OrganizationId);

        var deadline = _clock.UtcNow.AddSeconds(run.TimeBudgetSeconds);
        var order = 0;

        run.Status = AgentRunStatus.Running;
        run.StartedAt = _clock.UtcNow;
        await _db.SaveChangesAsync(ct);

        try
        {
            var state = new PassState();

            // A resumed pass already crawled and already had its plan answered. Re-crawling
            // would change the application map underneath a plan somebody approved against the
            // old one, so exploration is skipped and the model is simply re-read.
            var resuming = run.ResumeFromPhase is not null;
            if (resuming) run.ResumeFromPhase = null;

            if (!resuming && !await PhaseAsync(run, ++order, AgentPhase.Exploring, deadline, ct,
                    () => ExploreAsync(run, deadline, ct))) { }
            else if (!await PhaseAsync(run, ++order, AgentPhase.Modelling, deadline, ct,
                    () => ModelAsync(run, state, ct))) { }
            else if (!await PhaseAsync(run, ++order, AgentPhase.Prioritizing, deadline, ct,
                    () => PrioritizeAsync(run, state, ct))) { }
            // Planning is skipped on a resume: the plan was proposed and answered before the
            // run was queued again, and proposing a second one would ask the same person the
            // same question about work they have already authorized.
            else if (!resuming && !await PhaseAsync(run, ++order, AgentPhase.Planning, deadline, ct,
                    () => PlanAsync(run, state, ct))) { }
            else if (!await PhaseAsync(run, ++order, AgentPhase.Generating, deadline, ct,
                    () => GenerateAsync(run, state, ct))) { }
            else if (!await PhaseAsync(run, ++order, AgentPhase.Executing, deadline, ct,
                    () => ExecuteAsync(run, state, deadline, ct))) { }
            else if (!await PhaseAsync(run, ++order, AgentPhase.Investigating, deadline, ct,
                    () => InvestigateAsync(run, state, ct))) { }
            else
            {
                await PhaseAsync(run, ++order, AgentPhase.Proposing, deadline, ct,
                    () => ProposeAsync(run, state, ct));
            }

            // Only a pass that is still Running here finished on its own terms. Anything
            // that set Failed, Stopped or Cancelled along the way keeps that verdict.
            if (run.Status == AgentRunStatus.Running)
            {
                run.Phase = AgentPhase.Done;
                run.Status = AgentRunStatus.Completed;
                run.StopReason ??= "The pass completed its plan.";
            }
        }
        catch (OperationCanceledException)
        {
            run.Status = AgentRunStatus.Cancelled;
            run.StopReason = "The pass was cancelled.";
        }
        catch (Exception exception)
        {
            _logger.LogError(exception, "Agent run {RunId} failed", run.Id);
            run.Status = AgentRunStatus.Failed;
            run.ErrorMessage = _masker.MaskText(exception.Message);
            run.StopReason = "The pass stopped because of an error.";
        }
        finally
        {
            run.CompletedAt = _clock.UtcNow;
            run.UpdatedAt = _clock.UtcNow;
            await _db.SaveChangesAsync(CancellationToken.None);
        }
    }

    /// <summary>Carries what each phase learned to the next one. Deliberately in memory and
    /// per-pass: the agent has no state that outlives its own run.</summary>

    // ---- Plan ------------------------------------------------------------------

    /// <summary>
    /// Draws up what the pass intends to test, and stops for a person if the policy says so.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Everything the plan rests on is counted from the graph, the coverage already stored, the
    /// security scope and the operator's own business context. Nothing is asked of a model: this
    /// is the screen where somebody authorizes work against a live environment, and a plan whose
    /// numbers cannot be traced is a plan nobody can refuse intelligently.
    /// </para>
    /// <para>
    /// If the run requires approval, the pass stops here rather than waiting. A pass holding a
    /// background slot open until somebody wakes up is a pass starving every other run, so the
    /// plan is recorded, the run goes to AwaitingApproval, and approving it queues the run again
    /// to resume from generation.
    /// </para>
    /// </remarks>
    private async Task<PhaseOutcome> PlanAsync(AgentRun run, PassState state, CancellationToken ct)
    {
        var context = await _context.GetAsync(run.ApplicationId, ct);
        var business = context.IsSuccess ? context.Value! : ApplicationContextView.Empty(run.ApplicationId);

        var endpoints = await _db.ApiEndpoints.AsNoTracking()
            .CountAsync(e => e.ApplicationId == run.ApplicationId, ct);
        var journeys = await _db.Journeys.AsNoTracking()
            .CountAsync(j => j.ApplicationId == run.ApplicationId, ct);
        var forms = state.Pages.Count(p => p.Kind == PageKind.Form);
        var authPages = state.Pages.Count(p => p.RequiresAuthentication);

        var scope = await _db.SecurityScopes.AsNoTracking()
            .FirstOrDefaultAsync(s => s.ApplicationId == run.ApplicationId, ct);
        var securityAuthorized = scope is { Enabled: true }
            && !string.IsNullOrWhiteSpace(scope.AuthorizationNote);

        var openFindings = securityAuthorized
            ? await _db.SecurityFindings.AsNoTracking().CountAsync(
                f => f.ApplicationId == run.ApplicationId
                     && (f.Status == SecurityFindingStatus.Confirmed
                         || f.Status == SecurityFindingStatus.Regressed), ct)
            : 0;

        // Coverage that exists, by dimension, so the plan can say how much of it is new work.
        var existingUi = await _db.TestCases.AsNoTracking().CountAsync(
            t => t.ApplicationId == run.ApplicationId && t.Kind == TestCaseKind.Ui && t.DeletedAt == null, ct);
        var existingApi = await _db.TestCases.AsNoTracking().CountAsync(
            t => t.ApplicationId == run.ApplicationId && t.Kind == TestCaseKind.Api && t.DeletedAt == null, ct);

        var recentFailures = await _db.TestExecutions.AsNoTracking()
            .Where(e => e.TestCase!.ApplicationId == run.ApplicationId
                        && e.Status == ExecutionStatus.Failed)
            .OrderByDescending(e => e.StartedAt)
            .Take(50)
            .CountAsync(ct);

        // Pages a person excluded are not counted into anything. An excluded area is not a
        // gap, and proposing work against it would be proposing to disobey.
        var plannablePages = state.Pages.Count(p => !business.Excludes(p.Route));

        var inputs = new PlanningInputs(
            Objective: run.Objective ?? run.Name,
            Pages: plannablePages,
            Endpoints: endpoints,
            Journeys: journeys,
            Roles: Math.Max(1, authPages > 0 ? 2 : 1),
            Forms: forms,
            UploadWorkflows: 0,
            Gaps: new Dictionary<TestDimension, int>
            {
                [TestDimension.Ui] = Math.Max(0, plannablePages - existingUi),
                [TestDimension.Api] = Math.Max(0, endpoints - existingApi),
                [TestDimension.Accessibility] = plannablePages
            },
            ExistingTests: new Dictionary<TestDimension, int>
            {
                [TestDimension.Ui] = existingUi,
                [TestDimension.Api] = existingApi
            },
            CriticalAreas: business.CriticalJourneys.Concat(business.HighRiskAreas).Distinct().ToList(),
            ExcludedAreas: business.ExcludedAreas,
            SecurityAuthorized: securityAuthorized,
            OpenSecurityFindings: openFindings,
            RecentFailures: recentFailures,
            ObservedSecondsPerTest: await ObservedSecondsAsync(run.ApplicationId, ct));

        var proposed = AgentPlanModel.Build(inputs);

        var plan = new AgentTestPlan
        {
            OrganizationId = run.OrganizationId,
            AgentRunId = run.Id,
            ApplicationId = run.ApplicationId,
            Objective = inputs.Objective,
            PagesDiscovered = inputs.Pages,
            EndpointsDiscovered = inputs.Endpoints,
            JourneysKnown = inputs.Journeys,
            RolesKnown = inputs.Roles,
            Summary = proposed.Summary,
            NotCovered = string.Join('\n', proposed.NotCovered),
            Status = AgentPlanStatus.Proposed
        };
        foreach (var category in proposed.Categories)
            plan.Items.Add(new AgentTestPlanItem
            {
                OrganizationId = run.OrganizationId,
                Category = category.Category,
                TestCount = category.TestCount,
                ToGenerate = category.ToGenerate,
                Why = category.Why,
                Risk = category.Risk,
                Coverage = category.Coverage,
                EstimatedSeconds = category.EstimatedSeconds,
                EstimateFromHistory = category.EstimateFromHistory,
                PotentialImpact = category.PotentialImpact,
                Included = true
            });

        _db.AgentTestPlans.Add(plan);
        await _db.SaveChangesAsync(ct);
        state.PlanId = plan.Id;

        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Planning,
            $"Proposed {proposed.TotalTests} test(s) across {proposed.Categories.Count} category(ies).",
            proposed.Summary,
            new[]
            {
                new AgentEvidence("pagesPlannable", inputs.Pages.ToString()),
                new AgentEvidence("endpointsDiscovered", inputs.Endpoints.ToString()),
                new AgentEvidence("journeysKnown", inputs.Journeys.ToString()),
                new AgentEvidence("securityAuthorized", securityAuthorized.ToString()),
                new AgentEvidence("openSecurityFindings", openFindings.ToString()),
                new AgentEvidence("criticalAreasNamedByAPerson",
                    inputs.CriticalAreas.Count == 0 ? "none" : string.Join(", ", inputs.CriticalAreas)),
                new AgentEvidence("excludedByAPerson",
                    inputs.ExcludedAreas.Count == 0 ? "none" : string.Join(", ", inputs.ExcludedAreas))
            },
            Tool: null,
            Result: $"{proposed.TotalTests} test(s) proposed."), ct);

        if (!run.RequireApprovalForHighRisk)
            return PhaseOutcome.Ok(
                $"Planned {proposed.TotalTests} test(s) across {proposed.Categories.Count} category(ies).",
                "This run does not require plan approval, so the plan proceeds as proposed.");

        // Stop rather than wait. Approving the plan queues the run again to resume from
        // generation, so nothing holds a background slot open waiting for a person.
        run.Status = AgentRunStatus.AwaitingApproval;
        run.Phase = AgentPhase.AwaitingApproval;
        run.StopReason = $"Waiting for somebody to approve the plan: {proposed.TotalTests} "
                       + $"test(s) across {proposed.Categories.Count} category(ies).";
        await _db.SaveChangesAsync(ct);

        return PhaseOutcome.Stop(
            $"Proposed {proposed.TotalTests} test(s) and stopped for approval.",
            "Nothing has been tested. A plan is a proposal, and this run requires a person to "
            + "approve one before any of it runs.");
    }

    /// <summary>
    /// How long a test of each kind has actually taken on this application.
    /// </summary>
    /// <remarks>
    /// Read from stored executions rather than guessed, and absent where there are none — the
    /// plan says which of its estimates rest on history and which on a default, and it can only
    /// say that if the two are distinguishable here.
    /// </remarks>
    private async Task<IReadOnlyDictionary<TestDimension, int>> ObservedSecondsAsync(
        Guid applicationId, CancellationToken ct)
    {
        var observed = new Dictionary<TestDimension, int>();

        var byKind = await _db.TestExecutions.AsNoTracking()
            .Where(e => e.TestCase!.ApplicationId == applicationId && e.DurationMs > 0)
            .GroupBy(e => e.TestCase!.Kind)
            .Select(g => new { Kind = g.Key, AverageMs = g.Average(e => e.DurationMs) })
            .ToListAsync(ct);

        foreach (var entry in byKind)
        {
            var dimension = entry.Kind == TestCaseKind.Api ? TestDimension.Api : TestDimension.Ui;
            var seconds = (int)Math.Ceiling(entry.AverageMs / 1000.0);
            if (seconds > 0) observed[dimension] = seconds;
        }

        return observed;
    }

    private sealed class PassState
    {
        public List<PageCandidate> Pages { get; } = new();
        public List<(PageCandidate Page, RiskAssessment Assessment)> Ranked { get; } = new();
        public List<Guid> GeneratedTestCaseIds { get; } = new();
        /// <summary>The plan this pass is working to, once one has been proposed.</summary>
        public Guid? PlanId { get; set; }
    }

    private sealed record PageCandidate(Guid Id, string Route, string NormalizedUrl, PageKind Kind,
        bool RequiresAuthentication, int ConsoleErrorCount, int LoadTimeMs);

    /// <summary>Runs one phase, recording it, and reports whether the pass should continue.</summary>
    private async Task<bool> PhaseAsync(
        AgentRun run, int order, AgentPhase phase, DateTimeOffset deadline,
        CancellationToken ct, Func<Task<PhaseOutcome>> body)
    {
        if (await ShouldStopAsync(run, deadline, order, phase, ct)) return false;

        run.Phase = phase;
        await _db.SaveChangesAsync(ct);

        var startedAt = _clock.UtcNow;
        var step = new AgentStep
        {
            OrganizationId = run.OrganizationId,
            AgentRunId = run.Id,
            Order = order,
            Phase = phase,
            StartedAt = startedAt,
            CreatedAt = startedAt
        };

        PhaseOutcome outcome;
        try
        {
            outcome = await body();
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            _logger.LogWarning(exception, "Agent run {RunId} phase {Phase} failed", run.Id, phase);
            outcome = PhaseOutcome.Failed(_masker.MaskText(exception.Message));
        }

        step.Succeeded = outcome.Succeeded;
        step.Description = _masker.MaskText(outcome.Description);
        step.Rationale = outcome.Rationale is null ? null : _masker.MaskText(outcome.Rationale);
        step.Detail = outcome.Detail is null ? null : _masker.MaskText(outcome.Detail);
        step.CompletedAt = _clock.UtcNow;
        step.DurationMs = (int)(step.CompletedAt.Value - startedAt).TotalMilliseconds;

        _db.AgentSteps.Add(step);
        await _db.SaveChangesAsync(ct);

        if (!outcome.Succeeded && outcome.Fatal)
        {
            // A phase that threw did not merely stop the pass early — it failed. Reporting
            // this as "completed" because the loop reached its end would be exactly the kind
            // of quiet green the platform refuses everywhere else.
            run.Status = AgentRunStatus.Failed;
            run.ErrorMessage = outcome.Description;
            run.StopReason = $"The pass failed during the {phase.ToString().ToLowerInvariant()} phase.";
            return false;
        }

        return outcome.Continue;
    }

    private sealed record PhaseOutcome(
        bool Succeeded, bool Continue, string Description, string? Rationale = null,
        string? Detail = null, bool Fatal = false)
    {
        public static PhaseOutcome Ok(string description, string? rationale = null, string? detail = null)
            => new(true, true, description, rationale, detail);

        public static PhaseOutcome Stop(string description, string? rationale = null)
            => new(true, false, description, rationale);

        public static PhaseOutcome Failed(string description)
            => new(false, false, description, Fatal: true);
    }

    /// <summary>The three things that end a pass early, checked between every phase.</summary>
    private async Task<bool> ShouldStopAsync(
        AgentRun run, DateTimeOffset deadline, int order, AgentPhase phase, CancellationToken ct)
    {
        var current = await _db.AgentRuns.AsNoTracking()
            .Where(r => r.Id == run.Id)
            .Select(r => r.Status)
            .FirstOrDefaultAsync(ct);

        if (current == AgentRunStatus.Cancelled)
        {
            run.Status = AgentRunStatus.Cancelled;
            run.StopReason = "Cancelled by a person.";
            return true;
        }

        if (_clock.UtcNow >= deadline)
        {
            run.Status = AgentRunStatus.Stopped;
            run.StopReason = $"The {run.TimeBudgetSeconds}s time budget ran out before the "
                + $"{phase.ToString().ToLowerInvariant()} phase.";
            await RecordBoundHitAsync(run, order, phase, run.StopReason, ct);
            return true;
        }

        if (run.AiCostUsd >= run.MaxAiCostUsd && run.MaxAiCostUsd > 0)
        {
            run.Status = AgentRunStatus.Stopped;
            run.StopReason = $"The ${run.MaxAiCostUsd:0.00} model budget was spent before the "
                + $"{phase.ToString().ToLowerInvariant()} phase.";
            await RecordBoundHitAsync(run, order, phase, run.StopReason, ct);
            return true;
        }

        return false;
    }

    private async Task RecordBoundHitAsync(AgentRun run, int order, AgentPhase phase, string reason, CancellationToken ct)
    {
        var now = _clock.UtcNow;
        _db.AgentSteps.Add(new AgentStep
        {
            OrganizationId = run.OrganizationId,
            AgentRunId = run.Id,
            Order = order,
            Phase = phase,
            Succeeded = true,
            Description = "Stopped at a bound.",
            Rationale = reason,
            StartedAt = now,
            CompletedAt = now,
            CreatedAt = now
        });
        await _db.SaveChangesAsync(ct);
    }

    // ---- Explore -------------------------------------------------------------

    private async Task<PhaseOutcome> ExploreAsync(AgentRun run, DateTimeOffset deadline, CancellationToken ct)
    {
        if (!run.ExploreEnabled)
        {
            return PhaseOutcome.Ok("Skipped exploration.",
                "Exploration was disabled for this pass, so the existing knowledge graph is used as it stands.");
        }

        var started = await _discovery.StartAsync(new StartDiscoveryRequest(
            run.ApplicationId, null, run.MaxDepth, run.MaxPages, null), ct);

        if (started.IsFailure)
        {
            // A stale graph is still a graph. Failing the whole pass because a crawl could
            // not start would throw away the work the rest of the phases can still do.
            return PhaseOutcome.Ok("Could not start exploration; continuing with the existing graph.",
                started.Error!.Message);
        }

        run.DiscoveryRunId = started.Value!.Id;
        await _db.SaveChangesAsync(ct);

        var final = await WaitForDiscoveryAsync(started.Value.Id, deadline, ct);

        run.PagesConsidered = final?.PagesDiscovered ?? 0;
        await _db.SaveChangesAsync(ct);

        if (final is null)
        {
            return PhaseOutcome.Ok("Exploration did not finish within the budget; using what it found.",
                "The remaining phases work from the pages discovered so far rather than waiting longer.");
        }

        var blocked = final.PagesBlockedByPolicy > 0
            ? $" {final.PagesBlockedByPolicy} page(s) were outside the allowed domains and were not visited."
            : string.Empty;

        return PhaseOutcome.Ok(
            $"Explored {final.PagesDiscovered} page(s) and {final.ElementsDiscovered} element(s).",
            $"Bounded to {run.MaxPages} page(s) at depth {run.MaxDepth}.{blocked}");
    }

    /// <summary>Waits for a crawl, reading the row fresh each time.
    ///
    /// The read has to bypass change tracking. A scoped DbContext lives for the whole pass,
    /// and once it has tracked an entity it keeps returning that same instance — so polling
    /// through a tracking query watches a snapshot taken before the crawl started and waits
    /// for a status that, from its point of view, never changes.</summary>
    private async Task<DiscoveryProgress?> WaitForDiscoveryAsync(Guid id, DateTimeOffset deadline, CancellationToken ct)
    {
        while (_clock.UtcNow < deadline)
        {
            var progress = await _db.DiscoveryRuns.AsNoTracking()
                .Where(r => r.Id == id)
                .Select(r => new DiscoveryProgress(
                    r.Status, r.PagesDiscovered, r.ElementsDiscovered, r.PagesBlockedByPolicy))
                .FirstOrDefaultAsync(ct);

            if (progress is not null && progress.Status is DiscoveryStatus.Completed
                or DiscoveryStatus.Failed or DiscoveryStatus.PartiallyCompleted or DiscoveryStatus.Cancelled)
            {
                return progress;
            }

            await Task.Delay(PollInterval, ct);
        }
        return null;
    }

    private sealed record DiscoveryProgress(
        DiscoveryStatus Status, int PagesDiscovered, int ElementsDiscovered, int PagesBlockedByPolicy);

    // ---- Model ---------------------------------------------------------------

    private async Task<PhaseOutcome> ModelAsync(AgentRun run, PassState state, CancellationToken ct)
    {
        var pages = await _db.ApplicationPages.AsNoTracking()
            .Where(p => p.ApplicationId == run.ApplicationId)
            .OrderBy(p => p.Depth).ThenBy(p => p.Route)
            .Take(run.MaxPages)
            .Select(p => new PageCandidate(p.Id, p.Route, p.NormalizedUrl, p.Kind,
                p.RequiresAuthentication, p.ConsoleErrorCount, p.LoadTimeMs))
            .ToListAsync(ct);

        state.Pages.AddRange(pages);
        run.PagesConsidered = Math.Max(run.PagesConsidered, pages.Count);
        await _db.SaveChangesAsync(ct);

        if (pages.Count == 0)
        {
            return PhaseOutcome.Stop("The application has no discovered pages to work from.",
                "Run discovery for this application first, or start the pass with exploration enabled.");
        }

        return PhaseOutcome.Ok($"Read {pages.Count} page(s) from the knowledge graph.",
            "The graph is the agent's whole picture of the application; it does not browse to form one.");
    }

    // ---- Prioritise ------------------------------------------------------------

    private async Task<PhaseOutcome> PrioritizeAsync(AgentRun run, PassState state, CancellationToken ct)
    {
        foreach (var page in state.Pages)
        {
            var signals = await GatherSignalsAsync(run, page, ct);
            state.Ranked.Add((page, RiskScorer.Score(signals)));
        }

        state.Ranked.Sort((left, right) => right.Assessment.Score.CompareTo(left.Assessment.Score));

        run.AreasAssessed = state.Ranked.Count;
        await _db.SaveChangesAsync(ct);

        // Every assessed area becomes a finding, not only the ones acted on: the ranking is
        // the agent's reasoning, and hiding the part it chose not to work on would make the
        // choice unreviewable.
        foreach (var (page, assessment) in state.Ranked.Where(r => r.Assessment.Score > 0))
        {
            _db.AgentFindings.Add(new AgentFinding
            {
                OrganizationId = run.OrganizationId,
                AgentRunId = run.Id,
                Kind = assessment.Factors.Any(f => f.Name.Contains("coverage", StringComparison.OrdinalIgnoreCase))
                    ? AgentFindingKind.CoverageGap
                    : AgentFindingKind.RiskArea,
                Severity = assessment.Level,
                Title = $"{page.Route} — risk {assessment.Score}",
                Detail = _masker.MaskText(string.Join(" ",
                    new[] { assessment.Summary }.Concat(assessment.Factors.Select(f => f.Explanation)))),
                Recommendation = assessment.Recommendation,
                Confidence = 90,          // Deterministic scoring; high, but never certainty.
                Route = page.Route,
                IsAiGenerated = false,
                CreatedAt = _clock.UtcNow
            });
        }
        await _db.SaveChangesAsync(ct);

        var top = state.Ranked.Take(run.MaxTargets).ToList();
        var detail = string.Join("; ", top.Select(t => $"{t.Page.Route} ({t.Assessment.Score})"));

        return PhaseOutcome.Ok(
            $"Scored {state.Ranked.Count} area(s) and chose the top {top.Count} to work on.",
            "Risk is scored deterministically from coverage, change, failure history and what a "
            + "failure would cost, so the same application always produces the same ordering.",
            detail);
    }

    private async Task<RiskSignals> GatherSignalsAsync(AgentRun run, PageCandidate page, CancellationToken ct)
    {
        var elements = await _db.ApplicationElements.AsNoTracking()
            .Where(e => e.ApplicationPageId == page.Id)
            .Select(e => new { e.Kind })
            .ToListAsync(ct);

        var inputKinds = new[]
        {
            ElementKind.TextInput, ElementKind.NumberInput, ElementKind.DateInput,
            ElementKind.Select, ElementKind.TextArea, ElementKind.Checkbox, ElementKind.Radio
        };
        var sensitiveKinds = new[] { ElementKind.PasswordInput, ElementKind.FileInput };

        // Tests are matched to a page by the URL their steps visit; a test that never goes
        // there is not coverage of it however it is named.
        var coveringTestIds = await _db.TestSteps.AsNoTracking()
            .Where(s => s.Url != null && s.Url.Contains(page.Route) && s.TestCase!.ApplicationId == run.ApplicationId)
            .Select(s => s.TestCaseId)
            .Distinct()
            .ToListAsync(ct);

        var assertionCount = coveringTestIds.Count == 0 ? 0 : await _db.Assertions.AsNoTracking()
            .CountAsync(a => coveringTestIds.Contains(a.TestStep!.TestCaseId), ct);

        var recent = coveringTestIds.Count == 0
            ? []
            : await _db.TestExecutions.AsNoTracking()
                .Where(e => coveringTestIds.Contains(e.TestCaseId))
                .OrderByDescending(e => e.StartedAt)
                .Take(30)
                .Select(e => new
                {
                    Failed = e.Status == ExecutionStatus.Failed || e.Status == ExecutionStatus.Error
                          || e.Status == ExecutionStatus.TimedOut,
                    Flaky = e.Status == ExecutionStatus.Flaky
                })
                .ToListAsync(ct);

        var openDefects = coveringTestIds.Count == 0 ? 0 : await _db.Defects.AsNoTracking()
            .CountAsync(d => d.ProjectId == run.ProjectId &&
                (d.Status == DefectStatus.Open || d.Status == DefectStatus.Triaged), ct);

        var inbound = await _db.PageTransitions.AsNoTracking()
            .CountAsync(t => t.ToPageId == page.Id, ct);

        return new RiskSignals
        {
            Route = page.Route,
            Kind = page.Kind,
            RequiresAuthentication = page.RequiresAuthentication,
            InputElementCount = elements.Count(e => inputKinds.Contains(e.Kind)),
            ActionElementCount = elements.Count(e => e.Kind == ElementKind.Button),
            SensitiveInputCount = elements.Count(e => sensitiveKinds.Contains(e.Kind)),
            CoveringTestCount = coveringTestIds.Count,
            AssertionCount = assertionCount,
            RecentExecutionCount = recent.Count,
            RecentFailureCount = recent.Count(r => r.Failed),
            RecentFlakyCount = recent.Count(r => r.Flaky),
            OpenDefectCount = openDefects,
            ConsoleErrorCount = page.ConsoleErrorCount,
            InboundTransitionCount = inbound,
            LoadTimeMs = page.LoadTimeMs,
            ChangedElementCount = 0
        };
    }

    // ---- Generate ---------------------------------------------------------------

    private async Task<PhaseOutcome> GenerateAsync(AgentRun run, PassState state, CancellationToken ct)
    {
        // Only areas that actually lack coverage. Generating a second test for something
        // already covered spends budget and gives a team more to maintain for nothing.
        var targets = state.Ranked
            .Where(r => r.Assessment.Recommendation is not null
                     && r.Assessment.Recommendation.StartsWith("Generate", StringComparison.Ordinal))
            .Take(run.MaxTargets)
            .ToList();

        if (targets.Count == 0)
        {
            return PhaseOutcome.Ok("Generated nothing: every prioritised area already has coverage.",
                "The agent adds tests where there are none rather than duplicating what exists.");
        }

        var before = await _db.TestCases.AsNoTracking()
            .Where(t => t.ApplicationId == run.ApplicationId)
            .Select(t => t.Id)
            .ToListAsync(ct);

        var generated = await _generation.GenerateAsync(new GenerateTestsRequest(
            run.ApplicationId,
            run.TestSuiteId,
            $"{run.Name} — generated",
            run.Objective,
            targets.Select(t => t.Page.Id).ToArray(),
            run.MaxGeneratedTests), ct);

        if (generated.IsFailure)
        {
            return PhaseOutcome.Ok("Could not generate tests for the prioritised areas.",
                generated.Error!.Message);
        }

        var summary = generated.Value!;
        run.TestSuiteId = summary.TestSuiteId;
        run.TestsGenerated = summary.CasesCreated;
        run.AiCostUsd += summary.EstimatedCostUsd;
        await _db.SaveChangesAsync(ct);

        state.GeneratedTestCaseIds.AddRange(await _db.TestCases.AsNoTracking()
            .Where(t => t.ApplicationId == run.ApplicationId && !before.Contains(t.Id))
            .Select(t => t.Id)
            .ToListAsync(ct));

        var warnings = summary.Warnings.Count > 0
            ? $" {summary.Warnings.Count} scenario(s) were dropped: {string.Join("; ", summary.Warnings.Take(3))}"
            : string.Empty;

        return PhaseOutcome.Ok(
            $"Generated {summary.CasesCreated} test(s) across {summary.StepsCreated} step(s) for "
            + $"{targets.Count} uncovered area(s).",
            summary.IsLocalProvider
                ? "Produced by the built-in deterministic planner; no external model was used."
                : $"Planned by {summary.Provider} ({summary.Model}); every step was validated before it was stored.",
            $"{summary.PlanSummary}{warnings}");
    }

    // ---- Execute -------------------------------------------------------------------

    private async Task<PhaseOutcome> ExecuteAsync(AgentRun run, PassState state, DateTimeOffset deadline, CancellationToken ct)
    {
        if (!run.ExecuteEnabled)
        {
            return PhaseOutcome.Ok("Skipped execution.",
                "Execution was disabled for this pass, so the generated tests are left for a person to run.");
        }

        if (state.GeneratedTestCaseIds.Count == 0)
        {
            return PhaseOutcome.Ok("Ran nothing: no tests were generated this pass.",
                "There is nothing new to execute, so no run was started.");
        }

        var started = await _runs.StartAsync(new StartTestRunRequest(
            run.ProjectId, null, state.GeneratedTestCaseIds.ToArray(), null,
            null, true, null, null, $"{run.Name} — verification", RunTrigger.Agent, null), ct);

        if (started.IsFailure)
        {
            return PhaseOutcome.Ok("Could not start a run for the generated tests.", started.Error!.Message);
        }

        run.TestRunId = started.Value!.Id;
        await _db.SaveChangesAsync(ct);

        var final = await WaitForRunAsync(started.Value.Id, deadline, ct);
        if (final is null)
        {
            return PhaseOutcome.Ok("The verification run did not finish within the budget.",
                "It is still running; its results will appear against the run itself.");
        }

        run.TestsExecuted = final.TotalCount;
        await _db.SaveChangesAsync(ct);

        return PhaseOutcome.Ok(
            $"Ran {final.TotalCount} generated test(s): {final.PassedCount} passed, "
            + $"{final.FailedCount} failed, {final.BlockedCount} blocked.",
            "A generated test that cannot pass on the application as it is now is worth knowing "
            + "about before anyone relies on it.");
    }

    /// <summary>Waits for the verification run, reading fresh for the same reason as above.</summary>
    private async Task<RunProgress?> WaitForRunAsync(Guid id, DateTimeOffset deadline, CancellationToken ct)
    {
        while (_clock.UtcNow < deadline)
        {
            var progress = await _db.TestRuns.AsNoTracking()
                .Where(r => r.Id == id)
                .Select(r => new RunProgress(
                    r.Status, r.TotalCount, r.PassedCount, r.FailedCount, r.BlockedCount))
                .FirstOrDefaultAsync(ct);

            if (progress is not null && progress.Status is ExecutionStatus.Passed
                or ExecutionStatus.Failed or ExecutionStatus.Cancelled
                or ExecutionStatus.Error or ExecutionStatus.Blocked)
            {
                return progress;
            }

            await Task.Delay(PollInterval, ct);
        }
        return null;
    }

    private sealed record RunProgress(
        ExecutionStatus Status, int TotalCount, int PassedCount, int FailedCount, int BlockedCount);

    // ---- Investigate -----------------------------------------------------------------

    private async Task<PhaseOutcome> InvestigateAsync(AgentRun run, PassState state, CancellationToken ct)
    {
        if (run.TestRunId is null)
        {
            return PhaseOutcome.Ok("Nothing to investigate: no verification run was made.");
        }

        var failures = await _db.Failures.AsNoTracking()
            .Where(f => _db.TestExecutions.Where(e => e.TestRunId == run.TestRunId)
                .Select(e => e.Id).Contains(f.TestExecutionId))
            .Include(f => f.Analysis)
            .Take(25)
            .ToListAsync(ct);

        foreach (var failure in failures)
        {
            var analysis = failure.Analysis;

            // Whether this is the application's fault decides who reads it, so it is stated
            // rather than implied — and the agent only ever proposes.
            var isApplicationDefect = analysis?.IsLikelyApplicationDefect == true;
            var kind = failure.Category == FailureCategory.LocatorChange
                ? AgentFindingKind.BrokenLocator
                : isApplicationDefect ? AgentFindingKind.SuspectedDefect : AgentFindingKind.Observation;

            _db.AgentFindings.Add(new AgentFinding
            {
                OrganizationId = run.OrganizationId,
                AgentRunId = run.Id,
                Kind = kind,
                Severity = isApplicationDefect ? RiskLevel.High : RiskLevel.Medium,
                Title = _masker.MaskText(Truncate(failure.RawMessage, 160)),
                Detail = _masker.MaskText(analysis is null
                    ? $"Classified as {failure.Category} with {failure.CategoryConfidence}% confidence."
                    : $"{analysis.Summary} Likely cause: {analysis.LikelyCause} "
                      + $"Suggested action: {analysis.SuggestedAction}"),
                Recommendation = isApplicationDefect
                    ? "Review the evidence and raise a defect if it holds up. The agent has not raised one."
                    : "Check whether the test or the environment is at fault before changing the application.",
                Confidence = analysis?.Confidence ?? failure.CategoryConfidence,
                TestCaseId = failure.TestCaseId,
                TestExecutionId = failure.TestExecutionId,
                FailureId = failure.Id,
                IsAiGenerated = analysis?.ProducedByAi ?? false,
                CreatedAt = _clock.UtcNow
            });
        }

        run.FailuresInvestigated = failures.Count;
        await _db.SaveChangesAsync(ct);

        return failures.Count == 0
            ? PhaseOutcome.Ok("No failures to investigate.",
                "Every generated test passed, so there was nothing to diagnose.")
            : PhaseOutcome.Ok($"Investigated {failures.Count} failure(s).",
                "Each one is recorded as a proposal with its evidence. The agent raises no defects "
                + "and changes no tests.");
    }

    // ---- Propose ----------------------------------------------------------------------

    private async Task<PhaseOutcome> ProposeAsync(AgentRun run, PassState state, CancellationToken ct)
    {
        await AddRegressionFindingsAsync(run, ct);

        var findings = await _db.AgentFindings.AsNoTracking()
            .Where(f => f.AgentRunId == run.Id)
            .ToListAsync(ct);

        run.ProposalsMade = findings.Count;

        var bySeverity = findings.GroupBy(f => f.Severity)
            .OrderBy(g => g.Key)
            .Select(g => $"{g.Count()} {g.Key.ToString().ToLowerInvariant()}")
            .ToList();

        var lines = new List<string>
        {
            $"Considered {run.PagesConsidered} page(s) and scored {run.AreasAssessed} area(s)."
        };

        if (run.TestsGenerated > 0)
            lines.Add($"Generated {run.TestsGenerated} test(s) for areas that had none.");
        else
            lines.Add("Generated no tests: the prioritised areas already had coverage.");

        if (run.TestsExecuted > 0)
            lines.Add($"Ran {run.TestsExecuted} of them to check they hold on the application as it is now.");

        if (run.FailuresInvestigated > 0)
            lines.Add($"Investigated {run.FailuresInvestigated} failure(s).");

        lines.Add(findings.Count == 0
            ? "Nothing needs attention."
            : $"{findings.Count} proposal(s) for review: {string.Join(", ", bySeverity)}.");

        lines.Add("Everything above is a proposal. The agent did not raise a defect, change a test, "
            + "approve a healing proposal or alter a quality gate — it has no authority to do any of those.");

        run.Summary = _masker.MaskText(string.Join(" ", lines));
        await _db.SaveChangesAsync(ct);

        return PhaseOutcome.Ok($"Wrote up {findings.Count} proposal(s).",
            "The pass ends with a write-up rather than an action, because acting on these is a "
            + "person's decision.");
    }

    /// <summary>Adds what the execution history says, independently of this pass's own run:
    /// a test that regressed last week is worth surfacing even if it passed today.</summary>
    private async Task AddRegressionFindingsAsync(AgentRun run, CancellationToken ct)
    {
        var testCases = await _db.TestCases.AsNoTracking()
            .Where(t => t.ApplicationId == run.ApplicationId && t.IsEnabled)
            .Select(t => new { t.Id, t.Reference, t.Name })
            .Take(200)
            .ToListAsync(ct);

        foreach (var testCase in testCases)
        {
            var history = await _db.TestExecutions.AsNoTracking()
                .Where(e => e.TestCaseId == testCase.Id)
                .OrderByDescending(e => e.StartedAt)
                .Take(12)
                .Select(e => new
                {
                    Passed = e.Status == ExecutionStatus.Passed
                          || e.Status == ExecutionStatus.Healed
                          || e.Status == ExecutionStatus.Flaky,
                    Flaky = e.Status == ExecutionStatus.Flaky,
                    e.StartedAt
                })
                .ToListAsync(ct);

            if (history.Count == 0) continue;

            var verdict = RegressionClassifier.Classify(history
                .Select(h => new VerdictPoint(h.Passed, h.Flaky, h.StartedAt ?? _clock.UtcNow))
                .ToList());

            // Only the two that need a person. Stable, recovered and unknown are noise here.
            if (verdict.Kind is not (RegressionKind.Regressed or RegressionKind.Unstable)) continue;

            _db.AgentFindings.Add(new AgentFinding
            {
                OrganizationId = run.OrganizationId,
                AgentRunId = run.Id,
                Kind = verdict.Kind == RegressionKind.Regressed
                    ? AgentFindingKind.Regression
                    : AgentFindingKind.UnstableTest,
                Severity = verdict.Kind == RegressionKind.Regressed ? RiskLevel.High : RiskLevel.Medium,
                Title = $"{testCase.Reference} {testCase.Name}",
                Detail = verdict.Explanation,
                Recommendation = verdict.Kind == RegressionKind.Regressed
                    ? "Look at what changed since the last passing run."
                    : "Stabilise this test; neither of its verdicts is evidence while it alternates.",
                Confidence = verdict.Confidence,
                TestCaseId = testCase.Id,
                IsAiGenerated = false,
                CreatedAt = _clock.UtcNow
            });
        }

        await _db.SaveChangesAsync(ct);
    }

    private static string Truncate(string value, int max)
        => value.Length <= max ? value : $"{value[..max]}…";
}
