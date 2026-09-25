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
    private readonly IApiTestService _apiTests;
    private readonly ISecurityScanLauncher _security;
    private readonly ILogger<AgentLoop> _logger;

    public AgentLoop(IAiraDbContext db, IDiscoveryService discovery, ITestGenerationService generation,
        ITestRunService runs, ITenantContext tenant, IClock clock, SecretMasker masker,
        IAgentJournal journal, IApplicationContextService context,
        IApiTestService apiTests, ISecurityScanLauncher security,
        ILogger<AgentLoop> logger)
    {
        _apiTests = apiTests;
        _security = security;
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

            // Where to pick up. A pass that stopped for a person resumes from the phase
            // that asked, and everything before it is skipped rather than repeated.
            //
            // Written as an ordered list rather than an else-if chain because the chain got
            // this wrong: the skip guard was applied to two phases and forgotten on the rest,
            // so a resumed pass re-ran generation and produced the same API tests a second and
            // third time. A real run showed three identical "Generated 2 API test(s)"
            // decisions. One list, one guard, no way to forget a phase.
            var resumeFrom = run.ResumeFromPhase;
            run.ResumeFromPhase = null;

            var sequence = new (AgentPhase Phase, int Order, Func<Task<PhaseOutcome>> Body)[]
            {
                (AgentPhase.Exploring, 1, () => ExploreAsync(run, deadline, ct)),
                (AgentPhase.Modelling, 2, () => ModelAsync(run, state, ct)),
                (AgentPhase.Prioritizing, 3, () => PrioritizeAsync(run, state, ct)),
                // Before planning, so the plan is drawn against what is actually uncovered
                // rather than against a ranking that only knows about pages.
                (AgentPhase.AnalysingGaps, 4, () => AnalyseCoverageAsync(run, state, ct)),
                (AgentPhase.Planning, 5, () => PlanAsync(run, state, ct)),
                (AgentPhase.Generating, 6, () => GenerateAsync(run, state, ct)),
                // API, security and regression. Before these existed the loop injected
                // discovery, generation and test runs and nothing else, so an autonomous pass
                // produced UI tests however many endpoints the crawl had found and whatever
                // the application had authorized. Each delegates to the engine that already
                // does the work.
                (AgentPhase.Generating, 6, () => ApiTestingAsync(run, state, ct)),
                (AgentPhase.Prioritizing, 6, () => SelectRegressionAsync(run, state, ct)),
                (AgentPhase.SecurityTesting, 7, () => SecurityTestingAsync(run, state, ct)),
                (AgentPhase.Executing, 8, () => ExecuteAsync(run, state, deadline, ct)),
                (AgentPhase.Investigating, 9, () => InvestigateAsync(run, state, ct)),
                (AgentPhase.Proposing, 11, () => ProposeAsync(run, state, ct))
            };

            // Modelling and prioritising always re-run. The pass keeps nothing in memory
            // between queueings, so it has to re-read the graph, the business context and the
            // plan, and re-derive the ranking that generation works from. Both are read-only
            // and cheap; the one thing prioritising writes is guarded against duplicating.
            var resumeOrder = resumeFrom is { } from ? PhaseOrder(from) : 0;

            foreach (var (phase, phaseOrder, body) in sequence)
            {
                if (phaseOrder < resumeOrder && !AlwaysReRun.Contains(phase))
                {
                    await RecordSkippedAsync(run, ++order, phase, resumeFrom!.Value, ct);
                    continue;
                }

                if (!await PhaseAsync(run, ++order, phase, deadline, ct, body)) break;
            }

            // Only a pass that is still Running here finished on its own terms. Anything
            // that set Failed, Stopped or Cancelled along the way keeps that verdict.
            if (run.Status == AgentRunStatus.Running)
            {
                run.Phase = AgentPhase.Done;
                run.Status = AgentRunStatus.Completed;
                run.StopReason ??= "The pass completed its plan.";
            }

            await ExpireUnansweredAsync(run, ct);
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


    // ---- API testing ------------------------------------------------------------

    /// <summary>
    /// Generates API tests for endpoints the plan asked for.
    /// </summary>
    /// <remarks>
    /// The existing API testing engine does the work. The agent's contribution is choosing
    /// which endpoints are worth it and recording why — and before this phase existed, it made
    /// no such choice at all: the loop injected discovery, generation and test runs, and an
    /// autonomous pass produced UI tests and nothing else, however many endpoints the crawl
    /// had found. An endpoint the UI happens to exercise is not an endpoint that is tested.
    /// </remarks>
    private async Task<PhaseOutcome> ApiTestingAsync(
        AgentRun run, PassState state, CancellationToken ct)
    {
        if (!state.PlanIncludes(AgentPlanCategory.Api))
            return PhaseOutcome.Ok("No API testing in this plan.",
                "The plan did not include the API category, or a person switched it off.");

        var endpoints = await _db.ApiEndpoints.AsNoTracking()
            .Where(e => e.ApplicationId == run.ApplicationId)
            .OrderBy(e => e.UrlTemplate)
            .Select(e => new { e.Id, Path = e.UrlTemplate, Method = e.Method })
            .Take(run.MaxTargets * 5)
            .ToListAsync(ct);

        var excluded = endpoints
            .Where(e => state.Business.Excludes(e.Path))
            .Select(e => e.Path)
            .ToList();
        var selected = endpoints.Where(e => !state.Business.Excludes(e.Path)).ToList();

        if (selected.Count == 0)
            return PhaseOutcome.Ok("No endpoints to test.",
                excluded.Count > 0
                    ? $"{excluded.Count} endpoint(s) were discovered and every one is in an area "
                      + "a person excluded."
                    : "Discovery found no API endpoints for this application.");

        // Trimmed to what the budget affords rather than asked for wholesale.
        //
        // The first version requested every discovered endpoint at once, so an application
        // with more endpoints than the run's remaining test budget produced no API tests at
        // all — the policy refused the batch and the phase reported that as "not permitted".
        // A budget is meant to shape work, not eliminate it, and a pass that silently drops
        // every API test because it wanted one too many is the worst version of a bound.
        var affordable = Math.Max(0, run.MaxGeneratedTests - run.TestsGenerated);
        var wanted = selected.Count;
        var trimmed = wanted > affordable;
        if (trimmed) selected = selected.Take(affordable).ToList();

        // A budget already fully spent is a refusal, and it goes through the ladder so that
        // it is recorded as one. Returning here without asking was the other half of the trim
        // fix getting it wrong: work was correctly not done, and the reason it was not done
        // existed only in a phase description nobody queries. A bound that leaves no decision
        // behind is indistinguishable from a phase that found nothing to do.
        if (selected.Count == 0)
        {
            var spent = await CheckAsync(run, state, "test.generate", AgentPhase.Generating,
                newTests: wanted, ct: ct);

            return PhaseOutcome.Ok("No API tests were generated.",
                spent.Allowed
                    ? $"There was nothing to generate for the {endpoints.Count} discovered "
                      + "endpoint(s)."
                    : spent.Reason);
        }

        var decision = await CheckAsync(run, state, "test.generate", AgentPhase.Generating,
            newTests: selected.Count, ct: ct);
        if (!decision.Allowed)
            return PhaseOutcome.Ok("API test generation was not permitted.", decision.Reason);

        var generated = await _apiTests.GenerateAsync(new GenerateApiTestsRequest(
            ApplicationId: run.ApplicationId,
            ApiEndpointIds: selected.Select(e => e.Id).ToArray(),
            SuiteName: $"{run.Name} — API",
            // Mutating requests are left out unless the run is separately permitted them. A
            // pass nobody is watching should not be the thing that discovers what a POST does.
            IncludeMutating: run.AllowDestructiveActions,
            MaxTests: Math.Max(1, run.MaxGeneratedTests - state.GeneratedTestCaseIds.Count)), ct);

        if (!generated.IsSuccess)
            return PhaseOutcome.Ok("API tests could not be generated.",
                generated.Error?.Message ?? "The API testing engine refused.");

        state.ApiTestCaseIds.AddRange(generated.Value!.Tests.Select(t => t.TestCaseId));
        run.TestsGenerated += generated.Value.TestsCreated;
        Assemble(run, state.ApiTestCaseIds);
        await _db.SaveChangesAsync(ct);

        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Generating,
            $"Generated {generated.Value.TestsCreated} API test(s) for {selected.Count} endpoint(s).",
            "Endpoints discovered by the crawl, minus anything a person excluded. Mutating "
            + (run.AllowDestructiveActions ? "requests are permitted for this run." : "requests were left out."),
            new[]
            {
                new AgentEvidence("endpointsConsidered", endpoints.Count.ToString()),
                new AgentEvidence("endpointsSelected", selected.Count.ToString()),
                new AgentEvidence("endpointsExcludedByAPerson",
                    excluded.Count == 0 ? "none" : string.Join(", ", excluded.Take(10))),
                new AgentEvidence("mutatingIncluded", run.AllowDestructiveActions.ToString()),
                // Named, because an endpoint left out for want of budget is untested rather
                // than tested and found working, and the count alone would not say which.
                new AgentEvidence("trimmedToBudget",
                    trimmed
                        ? $"yes — {endpoints.Count} endpoint(s) discovered, {selected.Count} within "
                          + $"the run's remaining budget of {affordable}"
                        : "no")
            },
            Tool: "test.generate",
            Result: $"{generated.Value.TestsCreated} API test(s)",
            Risk: decision.EffectiveRisk), ct);

        return PhaseOutcome.Ok(
            $"Generated {generated.Value.TestsCreated} API test(s) across {selected.Count} endpoint(s).",
            "The API testing engine authored them; the agent chose the endpoints and recorded why.");
    }

    // ---- Security testing -------------------------------------------------------

    /// <summary>
    /// Asks the security engine to scan, where the application has authorized it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The agent selects; the engine decides. This queues a scan through the same launcher a
    /// person uses, which re-checks the scope, the profile, the permissions and the
    /// environment — so there is no path from the agent to issuing a security request, and an
    /// agent that somehow asked for something it should not get is refused by the thing that
    /// has always refused it.
    /// </para>
    /// <para>
    /// Standard profile, always. A pass nobody is watching does not get to be the run that
    /// discovers what a destructive check does, and the permissions that would allow one
    /// belong to a person rather than to a loop.
    /// </para>
    /// </remarks>
    private async Task<PhaseOutcome> SecurityTestingAsync(
        AgentRun run, PassState state, CancellationToken ct)
    {
        if (!run.AllowSecurityTesting)
            return PhaseOutcome.Ok("Security testing is off for this run.",
                "Nothing about this application's security has been established by this pass.");

        if (!state.PlanIncludes(AgentPlanCategory.Security))
            return PhaseOutcome.Ok("No security testing in this plan.",
                "The application has no enabled security scope, or a person switched the "
                + "category off. Either way this is an absence of testing, not a clean result.");

        var decision = await CheckAsync(run, state, "security.scan", AgentPhase.SecurityTesting, ct: ct);
        if (!decision.Allowed)
        {
            if (decision.Denial == AgentDenial.ApprovalRequired)
                await _journal.RequestApprovalAsync(run.Id, "security.scan", decision.Reason,
                    $"Scan {state.Pages.Count} page(s) of this application within its authorized scope.",
                    decision.EffectiveRisk.ToString(),
                    new[]
                    {
                        new AgentEvidence("pagesDiscovered", state.Pages.Count.ToString()),
                        new AgentEvidence("scopeAuthorized", "yes — checked before planning")
                    },
                    expectedImpact: "Requests within the scope's rate limits. No destructive "
                                  + "checks; production is not permitted for an unattended pass.",
                    ct: ct);

            return decision.Denial == AgentDenial.ApprovalRequired
                ? await ParkForApprovalAsync(run, AgentPhase.SecurityTesting,
                    "whether to scan this application", ct)
                : PhaseOutcome.Ok("Security scanning was not performed.", decision.Reason);
        }

        var started = await _security.StartAsync(new StartSecurityScanRequest(
            ApplicationId: run.ApplicationId,
            Profile: SecurityProfile.Standard), ct);

        if (!started.IsSuccess)
        {
            // A refusal from the engine is the system working. Recorded as what it is rather
            // than as a failure of the pass.
            await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
                AgentPhase.SecurityTesting,
                "The security engine refused the scan.",
                started.Error?.Message ?? "No reason was given.",
                new[] { new AgentEvidence("refusedBy", "the security engine, before anything was queued") },
                Tool: "security.scan", Result: "Not scanned.", Allowed: false), ct);

            return PhaseOutcome.Ok("The security engine refused the scan.",
                started.Error?.Message
                + " Nothing about this application's security has been established.");
        }

        state.SecurityScanId = started.Value!.SecurityScanId;
        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.SecurityTesting,
            $"Queued security scan {started.Value.Reference}.",
            "The application carries an enabled scope and the plan included security testing. "
            + "The engine decides what may be sent; this pass only asked.",
            new[]
            {
                new AgentEvidence("securityScanId", started.Value.SecurityScanId.ToString()),
                new AgentEvidence("profile", "standard"),
                new AgentEvidence("checksConfigured", started.Value.ChecksConfigured.ToString()),
                new AgentEvidence("targets", started.Value.Targets.ToString())
            },
            Tool: "security.scan",
            Result: $"Queued as {started.Value.Reference}.",
            Risk: decision.EffectiveRisk), ct);

        return PhaseOutcome.Ok(
            $"Queued security scan {started.Value.Reference} ({started.Value.ChecksConfigured} check(s)).",
            "A queued scan is not a result. Its verdict appears when a worker reports.");
    }

    // ---- Regression selection ----------------------------------------------------

    /// <summary>
    /// Picks existing tests worth re-running, using the selector a pipeline already uses.
    /// </summary>
    /// <remarks>
    /// Before this, an autonomous pass ran only what it had just generated, which meant the
    /// tests most likely to catch a regression — the ones that already existed and had failed
    /// before — were the ones it never ran.
    /// </remarks>
    private async Task<PhaseOutcome> SelectRegressionAsync(
        AgentRun run, PassState state, CancellationToken ct)
    {
        if (!state.PlanIncludes(AgentPlanCategory.Regression))
            return PhaseOutcome.Ok("No regression selection in this plan.",
                "Nothing that already existed was selected for re-running.");

        var reruns = await _db.TestCases.AsNoTracking()
            .Where(t => t.ApplicationId == run.ApplicationId
                        && t.DeletedAt == null
                        && t.IsEnabled
                        && (t.LastStatus == ExecutionStatus.Failed || t.FlakinessScore > 0))
            .OrderByDescending(t => t.FailCount)
            .Take(run.MaxTargets * 10)
            .Select(t => new { t.Id, t.Reference, t.FailCount, t.FlakinessScore })
            .ToListAsync(ct);

        if (reruns.Count == 0)
            return PhaseOutcome.Ok("Nothing to re-run.",
                "No existing test for this application has failed or been unstable recently.");

        state.RegressionTestCaseIds.AddRange(reruns.Select(r => r.Id));
        Assemble(run, state.RegressionTestCaseIds);
        await _db.SaveChangesAsync(ct);

        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Prioritizing,
            $"Selected {reruns.Count} existing test(s) to re-run.",
            "A test that failed recently is the cheapest way to tell a fix from a flake, and a "
            + "test that has been unstable is the cheapest way to find out whether it still is.",
            new[]
            {
                new AgentEvidence("previouslyFailing",
                    string.Join(", ", reruns.Where(r => r.FailCount > 0)
                        .Select(r => r.Reference).Take(10))),
                new AgentEvidence("unstable",
                    string.Join(", ", reruns.Where(r => r.FlakinessScore > 0)
                        .Select(r => r.Reference).Take(10))),
                new AgentEvidence("selected", reruns.Count.ToString())
            },
            Tool: null,
            Result: $"{reruns.Count} test(s) selected."), ct);

        return PhaseOutcome.Ok(
            $"Selected {reruns.Count} existing test(s) to re-run.",
            "Tests that failed or were unstable recently, which a pass that ran only its own "
            + "output would never have touched.");
    }

    // ---- The policy gate ----------------------------------------------------------

    /// <summary>
    /// Asks the policy engine whether the pass may do something, and records the answer.
    /// </summary>
    /// <remarks>
    /// Every action the loop takes goes through here. The point is not that the loop would
    /// otherwise misbehave — it is that "what may this pass do" has one answer, in one place,
    /// that a reader can check without following the loop's control flow.
    /// </remarks>
    /// <summary>Adds ids to what the pass has assembled, without duplicating.</summary>
    private static void Assemble(AgentRun run, IEnumerable<Guid> ids)
    {
        var known = ReadAssembled(run).ToHashSet();
        foreach (var id in ids) known.Add(id);
        run.AssembledTestCaseIds = string.Join(',', known);
    }

    private static IReadOnlyList<Guid> ReadAssembled(AgentRun run)
        => string.IsNullOrWhiteSpace(run.AssembledTestCaseIds)
            ? Array.Empty<Guid>()
            : run.AssembledTestCaseIds
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(part => Guid.TryParse(part, out var id) ? id : Guid.Empty)
                .Where(id => id != Guid.Empty)
                .ToList();

    /// <summary>
    /// Records that a phase was skipped because the pass is resuming past it.
    /// </summary>
    /// <remarks>
    /// A skipped phase leaves a step saying so. A timeline with a gap where generation should
    /// be reads as a pass that failed to generate anything, which is a different and worse
    /// story than one that had already done it.
    /// </remarks>
    private async Task RecordSkippedAsync(
        AgentRun run, int order, AgentPhase phase, AgentPhase resumeFrom, CancellationToken ct)
    {
        var now = _clock.UtcNow;
        _db.AgentSteps.Add(new AgentStep
        {
            OrganizationId = run.OrganizationId,
            AgentRunId = run.Id,
            Order = order,
            Phase = phase,
            Succeeded = true,
            Description = $"Skipped {phase}: it ran before this pass stopped for a person.",
            Rationale = $"The pass resumed at {resumeFrom}. Repeating an earlier phase would "
                      + "duplicate what it produced, and re-planning would ask somebody a "
                      + "question they have already answered.",
            StartedAt = now,
            CompletedAt = now,
            CreatedAt = now
        });
        await _db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Closes off questions nobody answered, when the pass ends for some other reason.
    /// </summary>
    /// <remarks>
    /// A pending approval about a finished run is worse than no approval: it sits in a queue
    /// implying somebody could still say yes. Expired is not granted and not refused — it is
    /// the honest third answer, and what the pass would have done is reported as not done.
    /// </remarks>
    private async Task ExpireUnansweredAsync(AgentRun run, CancellationToken ct)
    {
        if (run.Status is AgentRunStatus.AwaitingApproval or AgentRunStatus.Running) return;

        var pending = await _db.AgentApprovals
            .Where(a => a.AgentRunId == run.Id && a.Status == AgentApprovalStatus.Pending)
            .ToListAsync(ct);
        if (pending.Count == 0) return;

        foreach (var approval in pending) approval.Status = AgentApprovalStatus.Expired;

        var tools = string.Join(", ", pending.Select(a => a.Tool).Distinct());
        run.StopReason = $"{run.StopReason} Nobody answered {pending.Count} question(s) "
                       + $"({tools}), so those actions were not performed and nothing they "
                       + "would have established is known.";

        await _db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Parks the pass until somebody answers, and says where to pick it up.
    /// </summary>
    /// <remarks>
    /// Found by running a real pass: the two phases that ask for approval filed their
    /// questions and the pass carried on and finished, leaving two pending approvals about a
    /// run that was already over. Nobody would ever answer them, and if they had it would
    /// have changed nothing. An approval workflow that cannot be answered in time is
    /// decoration, so the pass now stops the same way it stops for a plan — and answering the
    /// last pending question queues it again from the phase that asked.
    /// </remarks>
    private async Task<PhaseOutcome> ParkForApprovalAsync(
        AgentRun run, AgentPhase resumeFrom, string what, CancellationToken ct)
    {
        run.Status = AgentRunStatus.AwaitingApproval;
        run.Phase = AgentPhase.AwaitingApproval;
        run.ResumeFromPhase = resumeFrom;
        run.StopReason = $"Waiting for somebody to answer: {what}";
        await _db.SaveChangesAsync(ct);

        return PhaseOutcome.Stop($"Stopped to ask about {what}.",
            "Nothing was done. The pass resumes from here when the question is answered, and "
            + "reports what it did not do if nobody answers.");
    }

    private async Task<AgentPolicyDecision> CheckAsync(
        AgentRun run, PassState state, string tool, AgentPhase phase,
        int newTests = 0, int newJourneys = 0, CancellationToken ct = default)
    {
        var approvals = await _journal.GrantedApprovalsAsync(run.Id, ct);
        var elapsed = run.StartedAt is { } startedAt
            ? (int)(_clock.UtcNow - startedAt).TotalMinutes
            : 0;

        var policy = new AgentPolicy(
            run.MaxActions, run.TimeBudgetSeconds / 60, run.MaxGeneratedTests, run.MaxNewJourneys,
            run.AllowProduction, run.AllowDestructiveActions, run.AllowSecurityTesting,
            run.RequireApprovalForHighRisk, run.MaxParallelWorkers);

        var decision = AgentPolicyGuard.Evaluate(
            policy,
            new AgentActionRequest(tool, state.Environment, NewTests: newTests, NewJourneys: newJourneys),
            new AgentRunState(run.ActionsTaken, elapsed, run.TestsGenerated, run.JourneysCreated,
                run.Status == AgentRunStatus.Cancelled, state.Permissions, approvals));

        run.ActionsTaken += 1;
        await _db.SaveChangesAsync(ct);

        if (!decision.Allowed)
            await _journal.RecordActionAsync(run.Id, phase,
                new AgentActionRequest(tool, state.Environment), decision,
                Array.Empty<AgentEvidence>(),
                $"Wanted to use {tool}.", ct: ct);

        return decision;
    }

    /// <summary>
    /// Where a phase sits in the sequence, for deciding what a resumed pass skips.
    /// </summary>
    /// <remarks>
    /// Explicit rather than the enum's numeric value: the enum grew by appending, so its
    /// numbers no longer match the order things happen in, and a resume that used them would
    /// skip the wrong half of the pass.
    /// </remarks>
    /// <summary>
    /// Phases a resumed pass repeats rather than skips.
    /// </summary>
    /// <remarks>
    /// Read-only, and everything after them depends on what they put in memory. Skipping
    /// these would leave a resumed pass generating tests for an empty ranking and executing
    /// an empty list, which looks like a pass that found nothing to do.
    /// </remarks>
    private static readonly HashSet<AgentPhase> AlwaysReRun =
        new() { AgentPhase.Modelling, AgentPhase.Prioritizing };

    private static int PhaseOrder(AgentPhase phase) => phase switch
    {
        AgentPhase.Exploring => 1,
        AgentPhase.Modelling => 2,
        AgentPhase.Prioritizing => 3,
        AgentPhase.AnalysingGaps => 4,
        AgentPhase.Planning => 5,
        AgentPhase.Generating => 6,
        AgentPhase.SecurityTesting => 7,
        AgentPhase.Executing => 8,
        AgentPhase.Investigating => 9,
        AgentPhase.Correlating => 10,
        AgentPhase.Proposing => 11,
        // Never 0 for a phase the sequence contains: a phase whose order is zero is never
        // skipped and never resumed past, so a pass that stopped in it would repeat
        // everything before it on every resume.
        _ => 0
    };

    private sealed class PassState
    {
        public List<PageCandidate> Pages { get; } = new();
        public List<(PageCandidate Page, RiskAssessment Assessment)> Ranked { get; } = new();
        public List<Guid> GeneratedTestCaseIds { get; } = new();
        public List<Guid> ApiTestCaseIds { get; } = new();
        public List<Guid> RegressionTestCaseIds { get; } = new();

        /// <summary>The plan this pass is working to, once one has been proposed.</summary>
        public Guid? PlanId { get; set; }

        /// <summary>The categories the plan still includes after a person answered it.</summary>
        public HashSet<AgentPlanCategory> PlannedCategories { get; } = new();

        /// <summary>Whether a plan was drawn up at all. A pass with no plan runs its default
        /// sequence; a pass with one runs what the plan says and nothing else.</summary>
        public bool HasPlan { get; set; }

        public bool PlanIncludes(AgentPlanCategory category)
            => !HasPlan || PlannedCategories.Contains(category);

        /// <summary>What a person said about this application. Empty when nobody has said
        /// anything, which is not the same as nothing being critical.</summary>
        public ApplicationContextView Business { get; set; } = ApplicationContextView.Empty(Guid.Empty);

        /// <summary>Permissions the pass's initiator held when it started, frozen.</summary>
        public IReadOnlySet<string> Permissions { get; set; } = new HashSet<string>();

        /// <summary>Where this pass is running, or null when nothing says. Null permits
        /// observation and refuses anything that writes.</summary>
        public EnvironmentKind? Environment { get; set; }

        /// <summary>The scan this pass queued, if it queued one.</summary>
        public Guid? SecurityScanId { get; set; }

        /// <summary>What the coverage phase established, once it has run. Null means the
        /// question was never asked — not that there are no gaps.</summary>
        public TestGapReport? Coverage { get; set; }
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

        if (!outcome.Continue && run.Status == AgentRunStatus.Running)
        {
            // A phase that stopped the pass short did not complete a plan, and until now the
            // loop fell through to "The pass completed its plan." A pass pointed at an
            // application nothing was listening on found no pages, stopped in modelling, and
            // reported itself completed — a clean-looking result for work that never happened,
            // which is the exact shape this platform refuses everywhere else. Found by a
            // golden test that pointed a pass at a dead port.
            run.Status = AgentRunStatus.Stopped;
            run.Phase = AgentPhase.Done;
            run.StopReason =
                $"The pass stopped during the {phase.ToString().ToLowerInvariant()} phase: "
                + $"{outcome.Description}"
                + (outcome.Rationale is null ? "" : $" {outcome.Rationale}")
                + " It did not complete a plan, and nothing it would have established is known.";
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
        // What a person has said about this application, loaded once and carried through the
        // pass. Nothing downstream re-reads it, so an operator editing the context mid-run
        // cannot change what a pass already decided — which is the behaviour somebody would
        // want if they were trying to widen a pass that was already refused something.
        var context = await _context.GetAsync(run.ApplicationId, ct);
        state.Business = context.IsSuccess
            ? context.Value!
            : ApplicationContextView.Empty(run.ApplicationId);

        state.Permissions = await FrozenPermissionsAsync(run, ct);
        state.Environment = await EnvironmentOfAsync(run.ApplicationId, ct);
        await LoadPlanAsync(run, state, ct);

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


    /// <summary>
    /// The permissions the pass acts with: the ones its initiator held when it started.
    /// </summary>
    /// <remarks>
    /// Read from the initiator's roles rather than from an ambient request, because there is
    /// no request — the pass runs in a background service. Frozen for the pass, so a person
    /// whose role is widened mid-run does not widen a pass already in flight, and one whose
    /// role is narrowed does not have a running pass fail halfway with a confusing refusal.
    /// A pass with no initiator holds nothing, which is the safe direction: everything above
    /// an observation is refused rather than allowed.
    /// </remarks>
    private async Task<IReadOnlySet<string>> FrozenPermissionsAsync(AgentRun run, CancellationToken ct)
    {
        if (run.CreatedByUserId is not { } userId) return new HashSet<string>();

        var permissions = await _db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .SelectMany(u => u.UserRoles!)
            .SelectMany(ur => ur.Role!.RolePermissions!)
            .Select(rp => rp.Permission!.Name)
            .Distinct()
            .ToListAsync(ct);

        return new HashSet<string>(permissions, StringComparer.Ordinal);
    }

    /// <summary>
    /// Which kind of environment this application lives in.
    /// </summary>
    /// <remarks>
    /// Returns null when nothing says, which is its own answer rather than a guess in either
    /// direction. Reading an undescribed environment as production refuses everything with
    /// "not authorized for production" — misleading, since the run never asked for it, and
    /// useless to an operator trying to work out what to change. Reading it as non-production
    /// would let an unattended pass write to a system nobody has identified. The guard takes
    /// null as "observe, do not write", and says so.
    /// </remarks>
    private async Task<EnvironmentKind?> EnvironmentOfAsync(Guid applicationId, CancellationToken ct)
    {
        var scope = await _db.SecurityScopes.AsNoTracking()
            .FirstOrDefaultAsync(s => s.ApplicationId == applicationId, ct);

        if (scope?.EnvironmentId is { } environmentId)
        {
            var kind = await _db.Environments.AsNoTracking()
                .Where(e => e.Id == environmentId)
                .Select(e => (EnvironmentKind?)e.Kind)
                .FirstOrDefaultAsync(ct);
            if (kind is { } known) return known;
        }

        var only = await _db.Environments.AsNoTracking()
            .Where(e => e.ProjectId == _db.Applications
                .Where(a => a.Id == applicationId).Select(a => a.ProjectId).FirstOrDefault())
            .Select(e => (EnvironmentKind?)e.Kind)
            .ToListAsync(ct);

        // One environment and no ambiguity: use it. Several, and nothing says which, so the
        // honest answer is that this is not known.
        return only.Count == 1 && only[0] is { } single ? single : null;
    }

    /// <summary>Loads the plan a person answered, so later phases run what it says.</summary>
    private async Task LoadPlanAsync(AgentRun run, PassState state, CancellationToken ct)
    {
        var plan = await _db.AgentTestPlans.AsNoTracking()
            .Include(p => p.Items)
            .OrderByDescending(p => p.CreatedAt)
            .FirstOrDefaultAsync(p => p.AgentRunId == run.Id, ct);

        if (plan is null) return;

        state.PlanId = plan.Id;
        state.HasPlan = true;
        foreach (var item in plan.Items.Where(i => i.Included))
            state.PlannedCategories.Add(item.Category);
    }

    // ---- Prioritise ------------------------------------------------------------

    private async Task<PhaseOutcome> PrioritizeAsync(AgentRun run, PassState state, CancellationToken ct)
    {
        // Dropped before scoring rather than filtered after it. An excluded area that gets a
        // risk score appears in the findings, on the dashboard and in the report as somewhere
        // worth testing — which is an argument with the person who excluded it, made in a
        // place they will never see.
        var excluded = state.Pages.Where(p => state.Business.Excludes(p.Route)).ToList();
        var plannable = state.Pages.Where(p => !state.Business.Excludes(p.Route)).ToList();

        // Once per run. Prioritising re-runs on every resume because later phases need its
        // ranking, and without this the same exclusion was recorded four times in one pass —
        // a trail that repeats itself is one nobody finishes reading.
        var alreadySaid = await _db.AgentDecisions
            .AnyAsync(d => d.AgentRunId == run.Id && d.Summary.Contains("excluded them"), ct);

        if (excluded.Count > 0 && !alreadySaid)
            await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
                AgentPhase.Prioritizing,
                $"Left {excluded.Count} page(s) alone because a person excluded them.",
                "An exclusion is honoured absolutely rather than weighed against a risk score. "
                + "Somebody who writes 'never touch this' is not expressing a preference that a "
                + "high enough number can outvote.",
                new[]
                {
                    new AgentEvidence("excludedRoutes",
                        string.Join(", ", excluded.Select(p => p.Route).Take(20))),
                    new AgentEvidence("exclusionsAsWritten",
                        string.Join(", ", state.Business.ExcludedAreas)),
                    new AgentEvidence("pagesRemaining", plannable.Count.ToString())
                },
                Tool: null,
                Result: $"{plannable.Count} page(s) remain in scope for this pass."), ct);

        foreach (var page in plannable)
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
        //
        // Written once per pass. Prioritising re-runs when a pass resumes — it is read-only
        // and the later phases need its ranking — so without this a pass that stopped twice
        // would show every area three times and the counts would treat that as real.
        var alreadyRecorded = await _db.AgentFindings
            .AnyAsync(f => f.AgentRunId == run.Id && f.Kind != AgentFindingKind.SuspectedDefect, ct);

        foreach (var (page, assessment) in alreadyRecorded
                     ? Array.Empty<(PageCandidate Page, RiskAssessment Assessment)>()
                     : state.Ranked.Where(r => r.Assessment.Score > 0))
        {
            _db.AgentFindings.Add(new AgentFinding
            {
                OrganizationId = run.OrganizationId,
                AgentRunId = run.Id,
                // A risk finding, always. It used to be relabelled CoverageGap whenever a
                // coverage factor contributed to the score, which was a second word for the
                // same thing — and once a phase existed whose whole job is coverage, the two
                // produced two findings per route that meant different things under one name.
                // Risk is what this phase establishes; what is untested is the coverage
                // phase's to say.
                Kind = AgentFindingKind.RiskArea,
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


    // ---- Coverage --------------------------------------------------------------
    //
    // What the application can do, against what is tested. The comparison itself is
    // TestGapModel — a pure function with no database and no clock — so this method's whole
    // job is to gather honest inputs for it and to record what came back.
    //
    // The distinction that matters is Unknown. A capability whose tests exist but have never
    // run is not covered and is not uncovered: reporting it either way invents work or
    // invents safety. The model draws that line; this phase preserves it into the findings
    // rather than rounding it to whichever neighbour makes the numbers tidier.

    private async Task<PhaseOutcome> AnalyseCoverageAsync(AgentRun run, PassState state, CancellationToken ct)
    {
        // Read-only, so it is checked against the ladder like everything else but can never
        // be the thing that stops a pass: a refusal here means the coverage question goes
        // unanswered, not that the pass proceeds as though it had been answered.
        var permitted = await CheckAsync(run, state, "coverage.analyse", AgentPhase.AnalysingGaps, ct: ct);
        if (!permitted.Allowed)
            return PhaseOutcome.Ok("Coverage was not analysed.", permitted.Reason);

        var pages = state.Pages.Where(p => !state.Business.Excludes(p.Route)).ToList();

        var endpoints = await _db.ApiEndpoints.AsNoTracking()
            .Where(e => e.ApplicationId == run.ApplicationId)
            .OrderBy(e => e.UrlTemplate)
            .Select(e => new { e.UrlTemplate, e.Method })
            .Take(run.MaxTargets * 5)
            .ToListAsync(ct);

        var capabilities = new List<Capability>();
        foreach (var page in pages)
        {
            capabilities.Add(new Capability(
                page.Route, "page",
                RequiresAuthentication: page.RequiresAuthentication,
                // A page the crawl reached by navigating is not known to change state, and
                // saying it does would inflate every count that follows.
                ChangesState: false,
                TakesInput: page.Kind == PageKind.Form,
                BusinessCritical: state.Business.IsCritical(page.Route)));
        }
        foreach (var endpoint in endpoints.Where(e => !state.Business.Excludes(e.UrlTemplate)))
        {
            capabilities.Add(new Capability(
                $"{endpoint.Method} {endpoint.UrlTemplate}", "endpoint",
                RequiresAuthentication: false,
                ChangesState: !string.Equals(endpoint.Method, "GET", StringComparison.OrdinalIgnoreCase),
                TakesInput: !string.Equals(endpoint.Method, "GET", StringComparison.OrdinalIgnoreCase),
                BusinessCritical: state.Business.IsCritical(endpoint.UrlTemplate)));
        }

        if (capabilities.Count == 0)
            return PhaseOutcome.Ok("Nothing to assess coverage against.",
                "Discovery found no pages or endpoints outside the areas a person excluded. "
                + "This is not a statement that the application is covered.");

        // Asked once, not once per page: whether this application has ever been scanned is a
        // fact about the application.
        var everScanned = await _db.SecurityFindings.AsNoTracking()
            .AnyAsync(f => f.ApplicationId == run.ApplicationId, ct);

        var signals = new List<CoverageSignal>();
        foreach (var page in pages)
        {
            // The same match the risk scorer uses: a test covers a page if a step of it goes
            // there. Naming a test after a page is not coverage of it.
            var covering = await _db.TestSteps.AsNoTracking()
                .Where(s => s.Url != null && s.Url.Contains(page.Route)
                         && s.TestCase!.ApplicationId == run.ApplicationId)
                .Select(s => s.TestCaseId)
                .Distinct()
                .ToListAsync(ct);

            var executed = covering.Count == 0 ? 0 : await _db.TestCases.AsNoTracking()
                .CountAsync(t => covering.Contains(t.Id) && t.ExecutionCount > 0, ct);

            signals.Add(new CoverageSignal(page.Route, TestDimension.Ui, covering.Count, executed));

            // Security coverage is the scan, not the tests. Assessable only when the
            // application has authorized scanning at all; otherwise the platform genuinely
            // cannot say, and Unknown is the honest answer rather than NotCovered.
            signals.Add(new CoverageSignal(page.Route, TestDimension.Security,
                everScanned ? 1 : 0, everScanned ? 1 : 0,
                Assessable: state.SecurityScanId is not null || everScanned));

            // Accessibility and visual are not assessed by this pass at all. Declared
            // unassessable rather than omitted, so they land as Unknown and appear in the
            // report as questions nobody answered instead of vanishing from the denominator.
            signals.Add(new CoverageSignal(page.Route, TestDimension.Accessibility, 0, 0, Assessable: false));
            signals.Add(new CoverageSignal(page.Route, TestDimension.Visual, 0, 0, Assessable: false));
        }

        foreach (var endpoint in endpoints.Where(e => !state.Business.Excludes(e.UrlTemplate)))
        {
            var identifier = $"{endpoint.Method} {endpoint.UrlTemplate}";
            var covering = await _db.TestCases.AsNoTracking()
                .Where(t => t.ApplicationId == run.ApplicationId && t.Kind == TestCaseKind.Api
                         && t.Name.Contains(endpoint.UrlTemplate))
                .Select(t => new { t.Id, t.ExecutionCount })
                .ToListAsync(ct);

            signals.Add(new CoverageSignal(identifier, TestDimension.Api,
                covering.Count, covering.Count(c => c.ExecutionCount > 0)));
            signals.Add(new CoverageSignal(identifier, TestDimension.Security, 0, 0,
                Assessable: state.SecurityScanId is not null));
        }

        var report = TestGapModel.Analyse(capabilities, signals);
        state.Coverage = report;

        // Written once. Coverage re-runs on a resume because it reads the graph the plan was
        // approved against, and a finding recorded twice is counted twice everywhere after.
        var alreadyRecorded = await _db.AgentFindings
            .AnyAsync(f => f.AgentRunId == run.Id && f.Kind == AgentFindingKind.CoverageGap
                        && f.Title.StartsWith("Untested:"), ct);

        if (!alreadyRecorded)
        {
            foreach (var capability in report.Capabilities.Where(c => c.HasGaps).Take(50))
            {
                var gaps = string.Join(", ", capability.Gaps);
                var why = string.Join(" ", capability.Dimensions
                    .Where(d => capability.Gaps.Contains(d.Dimension))
                    .Select(d => $"{d.Dimension}: {d.Why}"));

                _db.AgentFindings.Add(new AgentFinding
                {
                    OrganizationId = run.OrganizationId,
                    AgentRunId = run.Id,
                    Kind = AgentFindingKind.CoverageGap,
                    Severity = capability.Capability.BusinessCritical ? RiskLevel.High : RiskLevel.Medium,
                    Title = $"Untested: {capability.Capability.Identifier} ({gaps})",
                    Detail = _masker.MaskText(why),
                    Recommendation = "Decide whether this is worth covering. The agent has not "
                                   + "written a test for it and has not decided that it should.",
                    // Deterministic, but a gap is a gap in the platform's records rather than
                    // a proven absence of testing — somebody may test this by hand.
                    Confidence = 85,
                    // Where it applies, for an endpoint as well as a page. Leaving an
                    // endpoint's route null put the "where" in the title alone, so a reader
                    // filtering findings by route saw the page gaps and none of the API ones
                    // — an absence that reads as nothing to fix.
                    Route = capability.Capability.Kind == "endpoint"
                        ? capability.Capability.Identifier.Split(' ', 2).Last()
                        : capability.Capability.Identifier,
                    IsAiGenerated = false,
                    CreatedAt = _clock.UtcNow
                });
            }
            await _db.SaveChangesAsync(ct);
        }

        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.AnalysingGaps,
            $"Assessed {report.Capabilities.Count} capability(ies): {report.NotCovered} "
            + $"uncovered, {report.Unknown} unknown.",
            report.Summary,
            new[]
            {
                new AgentEvidence("capabilities", report.Capabilities.Count.ToString()),
                new AgentEvidence("covered", report.Covered.ToString()),
                new AgentEvidence("partiallyCovered", report.PartiallyCovered.ToString()),
                new AgentEvidence("notCovered", report.NotCovered.ToString()),
                // Named separately from the gaps because it is a different statement. An
                // unknown is a question nobody answered, not a gap somebody should fill.
                new AgentEvidence("unknown", report.Unknown.ToString()),
                new AgentEvidence("businessCriticalWithGaps",
                    report.Capabilities.Count(c => c.HasGaps && c.Capability.BusinessCritical).ToString()),
                new AgentEvidence("measuredAgainst",
                    $"{pages.Count} page(s) and {endpoints.Count} endpoint(s) discovery reached"),
                new AgentEvidence("excludedByAPerson",
                    state.Business.ExcludedAreas.Count == 0
                        ? "none" : string.Join(", ", state.Business.ExcludedAreas))
            },
            Tool: "coverage.analyse", Result: $"{report.NotCovered} gap(s)",
            Risk: AgentActionRisk.Observation), ct);

        return PhaseOutcome.Ok(
            $"Assessed {report.Capabilities.Count} capability(ies): {report.Covered} covered, "
            + $"{report.PartiallyCovered} partial, {report.NotCovered} uncovered, "
            + $"{report.Unknown} unknown.",
            "Coverage is compared against what discovery reached. Anything it did not reach is "
            + "absent from this assessment rather than covered by it, and a dimension this pass "
            + "cannot assess is reported unknown rather than as a gap.",
            report.Summary);
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

        // Recorded on the run as well as in memory, so a pass that later stops for a person
        // still executes these when it resumes past the phase that made them.
        Assemble(run, state.GeneratedTestCaseIds);
        await _db.SaveChangesAsync(ct);

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

        // Everything the pass assembled, not only what it wrote. A pass that ran only its own
        // output left the tests most likely to catch a regression — the ones that already
        // existed and had failed before — as the ones it never ran.
        // What this pass assembled, including anything produced before it stopped for a
        // person. The in-memory lists cover the phases that ran this time; the stored ones
        // cover the phases that were skipped because they had already run.
        var toRun = state.GeneratedTestCaseIds
            .Concat(state.ApiTestCaseIds)
            .Concat(state.RegressionTestCaseIds)
            .Concat(ReadAssembled(run))
            .Distinct()
            .ToArray();

        if (toRun.Length == 0)
        {
            return PhaseOutcome.Ok("Ran nothing: this pass assembled no tests.",
                "Nothing was generated and nothing existing was selected, so no run was "
                + "started. This is not a result about the application.");
        }

        var permitted = await CheckAsync(run, state, "test.execute", AgentPhase.Executing, ct: ct);
        if (!permitted.Allowed)
        {
            if (permitted.Denial == AgentDenial.ApprovalRequired)
                await _journal.RequestApprovalAsync(run.Id, "test.execute", permitted.Reason,
                    $"Run {toRun.Length} test(s) against this application.",
                    permitted.EffectiveRisk.ToString(),
                    new[]
                    {
                        new AgentEvidence("generated", state.GeneratedTestCaseIds.Count.ToString()),
                        new AgentEvidence("apiTests", state.ApiTestCaseIds.Count.ToString()),
                        new AgentEvidence("reRuns", state.RegressionTestCaseIds.Count.ToString())
                    },
                    expectedImpact: "Drives the application as a user would, and creates records "
                                  + "wherever a journey submits a form.",
                    ct: ct);

            return permitted.Denial == AgentDenial.ApprovalRequired
                ? await ParkForApprovalAsync(run, AgentPhase.Executing,
                    $"whether to run {toRun.Length} test(s)", ct)
                : PhaseOutcome.Ok("The tests were not run.", permitted.Reason);
        }

        // The build reference travels with the run, because a release assessment is keyed by
        // it. Without one the run is invisible to that report — which is the honest outcome
        // when nobody said what build this is, and the wrong outcome when somebody did.
        var ci = run.ApplicationBuildRef is null
            ? null
            : new CiContext(null, null, null, null, run.ApplicationBuildRef);

        var started = await _runs.StartAsync(new StartTestRunRequest(
            run.ProjectId, null, toRun, null,
            null, true, null, null, $"{run.Name} — verification", RunTrigger.Agent, ci), ct);

        if (started.IsFailure)
        {
            return PhaseOutcome.Ok("Could not start a run for the generated tests.", started.Error!.Message);
        }

        run.TestRunId = started.Value!.Id;
        await _db.SaveChangesAsync(ct);

        // Which build this run counts against, recorded either way. A pass with no build
        // reference is absent from every release assessment, and that absence has to be
        // legible here rather than inferred from a report that simply does not mention it.
        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Executing,
            run.ApplicationBuildRef is null
                ? "Started a verification run against no named build."
                : $"Started a verification run against build {run.ApplicationBuildRef}.",
            run.ApplicationBuildRef is null
                ? "Nobody said which build this pass is testing, so the run carries no build "
                + "reference and does not appear in any release assessment. That is an absence "
                + "of an assessment, not a passed one."
                : "The build reference travels with the run, so the release assessment for this "
                + "build includes what this pass executed.",
            new[]
            {
                new AgentEvidence("testRunId", started.Value.Id.ToString()),
                new AgentEvidence("buildRef", run.ApplicationBuildRef ?? "none"),
                new AgentEvidence("testsQueued", toRun.Length.ToString())
            },
            Tool: "test.execute", Result: "started", Risk: AgentActionRisk.Interaction), ct);

        var final = await WaitForRunAsync(started.Value.Id, deadline, ct);
        if (final is null)
        {
            return PhaseOutcome.Ok("The verification run did not finish within the budget.",
                "It is still running; its results will appear against the run itself.");
        }

        run.TestsExecuted = final.TotalCount;
        await _db.SaveChangesAsync(ct);

        return PhaseOutcome.Ok(
            $"Ran {final.TotalCount} test(s) ({state.GeneratedTestCaseIds.Count} generated, "
            + $"{state.ApiTestCaseIds.Count} API, {state.RegressionTestCaseIds.Count} re-run): "
            + $"{final.PassedCount} passed, {final.FailedCount} failed, "
            + $"{final.BlockedCount} blocked.",
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
