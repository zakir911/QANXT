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
                // After investigating, because it groups what that phase wrote up, and before
                // proposing, so the summary counts a cause once rather than its symptoms.
                (AgentPhase.Correlating, 10, () => CorrelateAsync(run, state, ct)),
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
        {
            await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
                AgentPhase.Generating,
                "No API testing in this plan.",
                "The plan did not include the API category, or a person switched it off. The "
                + "discovered endpoints are untested by this pass rather than tested and found "
                + "working, and that was somebody's decision rather than the agent's.",
                new[]
                {
                    new AgentEvidence("apiTestsGenerated", "0"),
                    new AgentEvidence("reason", "the plan does not include the API category")
                },
                Tool: null, Result: "not in this plan"), ct);

            return PhaseOutcome.Ok("No API testing in this plan.",
                "The plan did not include the API category, or a person switched it off.");
        }

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

    /// <summary>
    /// Records that selection ran and chose nothing.
    /// </summary>
    /// <remarks>
    /// The two ways it can choose nothing are different statements and both need saying: no
    /// test existed to consider, or every test's history argued against re-running it. Returning
    /// silently would make either indistinguishable from the phase never having run.
    /// </remarks>
    private async Task RecordNoSelectionAsync(
        AgentRun run, int considered, int ordered, string why, CancellationToken ct)
        => await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Prioritizing,
            $"Selected 0 of {considered} existing test(s) to re-run.",
            why,
            new[]
            {
                new AgentEvidence("considered", considered.ToString()),
                new AgentEvidence("selected", "0"),
                new AgentEvidence("why", why),
                new AgentEvidence("reasonsUsed",
                    "none — no test's history contributed a point"),
                new AgentEvidence("notSelected",
                    considered == 0
                        ? "none — there were no existing tests to consider"
                        : $"{ordered} test(s) whose history did not argue for a re-run")
            },
            Tool: null,
            Result: "0 test(s) selected."), ct);

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
            Profile: SecurityProfile.Standard,
            // The build travels with the scan. Without it the release assessment has to work
            // out which build a scan covered by comparing timestamps against the build's test
            // runs, and this pass produces the ordering that breaks: the scan finishes moments
            // before the verification run starts, so no window drawn from the run contains it.
            ApplicationBuildRef: run.ApplicationBuildRef), ct);

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
        {
            // A person switching a category off is itself a decision about what this pass did,
            // and the decision log is where somebody looks to find out why nothing was re-run.
            await RecordNoSelectionAsync(run, 0, 0,
                "The plan does not include regression, either because it was not proposed or "
                + "because a person switched it off. Nothing that already existed was selected "
                + "for re-running, and that was somebody's decision rather than the agent's.", ct);

            return PhaseOutcome.Ok("No regression selection in this plan.",
                "Nothing that already existed was selected for re-running.");
        }

        // Every enabled test for the application, not only the ones that have failed. Which of
        // them is worth re-running is TestHistoryModel's judgement, and it can only make it if
        // it sees the ones with clean histories too — a selector fed only failures cannot
        // distinguish "nothing is worth re-running" from "nothing has failed".
        var candidates = await _db.TestCases.AsNoTracking()
            .Where(t => t.ApplicationId == run.ApplicationId && t.DeletedAt == null && t.IsEnabled)
            .Select(t => new
            {
                t.Id, t.Reference, t.ExecutionCount, t.FailCount, t.FlakinessScore,
                t.LastStatus, t.LastExecutedAt,
                Route = t.Steps!.OrderBy(step => step.Order)
                    .Select(step => step.Url).FirstOrDefault(url => url != null)
            })
            .Take(500)
            .ToListAsync(ct);

        if (candidates.Count == 0)
        {
            await RecordNoSelectionAsync(run, 0, 0,
                "This application has no existing enabled tests, so there is nothing that could "
                + "be re-run. That is an absence of tests, not a finding that nothing needs "
                + "re-running.", ct);

            return PhaseOutcome.Ok("Nothing to re-run.",
                "This application has no existing enabled tests, so there is nothing that could "
                + "be re-run. That is not a statement that nothing needs re-running.");
        }

        // Explainable rules with fixed weights, and every point attributed to a named reason.
        // The order two runs over the same data produce is the same order, which is most of
        // what makes a selection worth comparing.
        var ordered = TestHistoryModel.Order(
            candidates.Select(t => new TestHistory(
                TestCaseId: t.Id,
                Reference: t.Reference,
                ExecutionCount: t.ExecutionCount,
                FailCount: t.FailCount,
                FlakinessScore: t.FlakinessScore,
                LastExecutedAt: t.LastExecutedAt,
                LastFailed: t.LastStatus == ExecutionStatus.Failed,
                // Nothing in this pass computes a per-test change impact, so this is false
                // rather than guessed. A signal the platform cannot establish must not be
                // asserted: it would add points nobody could trace to a change.
                TouchedByChange: false,
                BusinessCritical: state.Business.IsCritical(RouteOf(t.Route)))).ToList(),
            _clock.UtcNow);

        // Only tests whose history actually argues for them. A score of zero means nothing
        // about this test's past raises it, and re-running the whole suite on every pass is
        // not selection.
        var selected = ordered.Where(p => p.Score > 0).Take(run.MaxTargets * 10).ToList();

        if (selected.Count == 0)
        {
            await RecordNoSelectionAsync(run, candidates.Count, ordered.Count,
                "No test has failed recently, been unstable, or gone stale, so nothing about any "
                + "of their histories argues for a re-run. Re-running all of them anyway would "
                + "not be selection.", ct);

            return PhaseOutcome.Ok(
                $"Nothing to re-run: none of {candidates.Count} existing test(s) has a history "
                + "that argues for it.",
                "No test has failed recently, been unstable, or gone stale. Re-running all of "
                + "them anyway would not be selection.");
        }

        state.RegressionTestCaseIds.AddRange(selected.Select(p => p.TestCaseId));
        Assemble(run, state.RegressionTestCaseIds);
        await _db.SaveChangesAsync(ct);

        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Prioritizing,
            $"Selected {selected.Count} of {candidates.Count} existing test(s) to re-run.",
            "Ordered by explainable rules with fixed weights rather than a learned model: a "
            + "priority nobody can argue with is a priority nobody trusts. Every point below is "
            + "attributed to a named reason.",
            new[]
            {
                new AgentEvidence("considered", candidates.Count.ToString()),
                new AgentEvidence("selected", selected.Count.ToString()),
                // The top of the order with its reasoning, so somebody who disagrees can see
                // which rule produced it rather than be told the score was high.
                new AgentEvidence("why",
                    string.Join(" | ", selected.Take(8).Select(p => p.Summary))),
                new AgentEvidence("reasonsUsed",
                    string.Join(", ", selected.SelectMany(p => p.Reasons)
                        .Select(r => r.Name).Distinct().OrderBy(name => name))),
                // Named because it is a bound, not a conclusion: tests below it were not
                // judged unimportant, they were judged less urgent than the ones above.
                new AgentEvidence("notSelected",
                    (ordered.Count - selected.Count).ToString()
                    + " test(s) whose history did not argue for a re-run, or that fell outside "
                    + "this pass's selection budget")
            },
            Tool: null,
            Result: $"{selected.Count} test(s) selected."), ct);

        return PhaseOutcome.Ok(
            $"Selected {selected.Count} of {candidates.Count} existing test(s) to re-run.",
            "Prioritised from what has happened to each test before, by rules with fixed weights "
            + "and every point attributed. A pass that ran only its own output would have touched "
            + "none of these.",
            selected.Count == 0 ? null : selected[0].Summary);
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

        await RecordExplorationAsync(run, final, ct);

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
    /// What the exploration reached, and — the part that matters — what it did not.
    /// </summary>
    /// <remarks>
    /// The difference between "explored 25 pages" and "explored 25 of 60" is the difference
    /// between a reader believing the application has been walked and knowing it has not.
    /// ExploratoryModel produces the second, along with the standing limits of any walk: no
    /// form was submitted, nothing irreversible was attempted, and anything behind a control
    /// nobody happened to click is unexplored.
    /// </remarks>
    private async Task RecordExplorationAsync(
        AgentRun run, DiscoveryProgress final, CancellationToken ct)
    {
        // Everything the graph knows, including pages earlier crawls found. The denominator is
        // what makes the fraction mean anything.
        var pagesKnown = await _db.ApplicationPages.AsNoTracking()
            .CountAsync(p => p.ApplicationId == run.ApplicationId, ct);

        var forms = await _db.ApplicationPages.AsNoTracking()
            .CountAsync(p => p.ApplicationId == run.ApplicationId && p.Kind == PageKind.Form, ct);

        var apis = await _db.ApiEndpoints.AsNoTracking()
            .CountAsync(e => e.ApplicationId == run.ApplicationId, ct);

        // The bounds this pass actually ran under, not the model's defaults. A pass reports what
        // it was allowed, and this pass never submits a form or does anything irreversible
        // during exploration: a crawl looks, and both of those are state changes that go
        // through the policy ladder in a later phase if they happen at all.
        var bounds = new ExploratoryBounds(
            MaxPages: run.MaxPages,
            MaxActions: run.MaxActions,
            MaxMinutes: Math.Max(1, run.TimeBudgetSeconds / 60),
            MaxCandidateJourneys: run.MaxNewJourneys,
            MaxCandidateTests: run.MaxGeneratedTests,
            MaySubmitForms: false,
            MayBeDestructive: false);

        var report = ExploratoryModel.Report(
            bounds,
            pagesExplored: final.PagesDiscovered,
            pagesKnown: Math.Max(pagesKnown, final.PagesDiscovered),
            formsExplored: forms,
            apisObserved: apis,
            // No observations, candidate journeys or candidate tests: this pass explores by
            // running the crawler, which records pages and elements rather than narrated
            // findings. Empty lists rather than invented entries — a candidate journey nobody
            // observed is exactly the kind of thing this platform must not manufacture.
            observations: [],
            candidateJourneys: [],
            candidateTests: [],
            potentialDefects: [],
            potentialSecurityIssues: [],
            stoppedBy: final.PagesDiscovered >= run.MaxPages
                ? $"it reached its bound of {run.MaxPages} page(s)"
                : null);

        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Exploring,
            $"Explored {report.PagesExplored} page(s) of {Math.Max(pagesKnown, report.PagesExplored)} known.",
            report.Summary,
            new[]
            {
                new AgentEvidence("pagesExplored", report.PagesExplored.ToString()),
                new AgentEvidence("pagesKnownToTheGraph", pagesKnown.ToString()),
                new AgentEvidence("formsKnown", report.FormsExplored.ToString()),
                new AgentEvidence("apiEndpointsObserved", report.ApisObserved.ToString()),
                new AgentEvidence("pagesBlockedByPolicy", final.PagesBlockedByPolicy.ToString()),
                // The list that stops a crawl count from reading as coverage.
                new AgentEvidence("notExplored", string.Join(" | ", report.NotExplored)),
                new AgentEvidence("stoppedBy", report.StoppedBy ?? "nothing — it finished")
            },
            Tool: "application.discover",
            Result: $"{report.PagesExplored} page(s)",
            Risk: AgentActionRisk.Interaction), ct);
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

        // Which of the operator's named areas correspond to nothing the crawl reached.
        var named = state.Business.CriticalJourneys.Concat(state.Business.HighRiskAreas).ToList();
        var unmatched = named
            .Where(area => !capabilities.Any(c =>
                c.Identifier.Contains(area, StringComparison.OrdinalIgnoreCase)))
            .ToList();

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
                // The quiet failure this exists to stop. Critical areas are matched against
                // routes by substring, so somebody who writes a journey in English — "search
                // for a package" — names something no route can ever contain. Their input is
                // accepted, stored and echoed back, and changes nothing. Naming the ones that
                // matched nothing is the difference between an operator learning that and an
                // operator believing the pass is prioritising what they asked for.
                new AgentEvidence("namedAreasMatchingNothingDiscoveryReached",
                    unmatched.Count == 0 ? "none" : string.Join(", ", unmatched)),
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

        // Whether any of them repeat a test that already existed. Reported, never deleted.
        await DetectDuplicatesAsync(run, state, before, state.GeneratedTestCaseIds, ct);

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

        // What the run saw that argues for looking somewhere else. Proposals, not work.
        await ReactToObservationsAsync(run, state, ct);

        return failures.Count == 0
            ? PhaseOutcome.Ok("No failures to investigate.",
                "Every generated test passed, so there was nothing to diagnose.")
            : PhaseOutcome.Ok($"Investigated {failures.Count} failure(s).",
                "Each one is recorded as a proposal with its evidence. The agent raises no defects "
                + "and changes no tests.");
    }


    /// <summary>
    /// What this pass is allowed to say about the release, and what it must refuse to say.
    /// </summary>
    /// <remarks>
    /// Every input is a count of stored rows or an explicit "not measured". Nothing is
    /// estimated and nothing is filled in: an area this pass did not test arrives as
    /// <c>Measured: false</c> rather than as zero failures, because zero failures in an area
    /// nobody tested reads as an all-clear.
    /// </remarks>
    private async Task<AutonomousAssessment> AssessAsync(
        AgentRun run, PassState state, IReadOnlyList<AgentFinding> findings, CancellationToken ct)
    {
        var rows = run.TestRunId is null
            ? []
            : await _db.TestExecutions.AsNoTracking()
                .Where(e => e.TestRunId == run.TestRunId)
                .Join(_db.TestCases.AsNoTracking(), e => e.TestCaseId, t => t.Id,
                    (e, t) => new { e.Status, t.Kind })
                .ToListAsync(ct);

        // Healed counts as passed: a test that needed a new locator still established that the
        // application works. Named helpers rather than inline predicates because "did this
        // pass" is the judgement the whole assessment rests on.
        static bool DidPass(ExecutionStatus status)
            => status is ExecutionStatus.Passed or ExecutionStatus.Healed;
        static bool DidFail(ExecutionStatus status)
            => status is ExecutionStatus.Failed or ExecutionStatus.Error or ExecutionStatus.TimedOut;

        var ui = rows.Where(r => r.Kind != TestCaseKind.Api).ToList();
        var api = rows.Where(r => r.Kind == TestCaseKind.Api).ToList();

        // Security: only what a scan this pass can point at actually reported. A pass that
        // queued a scan which has not come back has not established anything about security,
        // and that is Measured: false rather than zero findings.
        var scanned = state.SecurityScanId is not null && await _db.SecurityScans.AsNoTracking()
            .AnyAsync(s => s.Id == state.SecurityScanId && s.CompletedAt != null, ct);

        var openBySeverity = scanned
            ? await _db.SecurityFindings.AsNoTracking()
                .Where(f => f.ApplicationId == run.ApplicationId
                         && f.Status != SecurityFindingStatus.FalsePositive
                         && f.Status != SecurityFindingStatus.Accepted)
                .GroupBy(f => f.Severity)
                .Select(g => new { Severity = g.Key, Count = g.Count() })
                .ToListAsync(ct)
            : [];

        int OpenAt(SecuritySeverity severity)
            => openBySeverity.FirstOrDefault(row => row.Severity == severity)?.Count ?? 0;

        var regressions = scanned
            ? await _db.SecurityFindings.AsNoTracking()
                .CountAsync(f => f.ApplicationId == run.ApplicationId && f.RegressedAt != null, ct)
            : 0;

        // A failing test on a route a person called business-critical. Read from the findings
        // this pass already wrote rather than re-derived, so the assessment and the proposals
        // cannot disagree.
        var criticalFailed = findings.Count(f =>
            f.Kind == AgentFindingKind.SuspectedDefect
            && f.Route is not null
            && state.Business.IsCritical(f.Route));

        var gate = run.TestRunId is null ? null : await _db.TestRuns.AsNoTracking()
            .Where(r => r.Id == run.TestRunId)
            .Select(r => r.QualityGatePassed)
            .FirstOrDefaultAsync(ct);

        // What this pass did not assess, named. Accessibility and visual are not things a pass
        // does at all, and the coverage phase's unknowns belong here too: a dimension nobody
        // could decide is untested, not clean.
        var untested = new List<string>
        {
            "Accessibility — a pass does not assess it; the platform tests it elsewhere.",
            "Visual appearance — a pass does not assess it; the platform tests it elsewhere."
        };
        if (!scanned)
            untested.Add(state.SecurityScanId is null
                ? "Security — no scan was run by this pass."
                : "Security — the scan this pass queued has not reported yet.");
        if (state.Coverage is { Unknown: > 0 } coverage)
            untested.Add($"{coverage.Unknown} capability/dimension pair(s) the coverage analysis "
                       + "could not decide either way.");
        if (state.Business.ExcludedAreas.Count > 0)
            untested.Add($"{state.Business.ExcludedAreas.Count} area(s) a person excluded: "
                       + string.Join(", ", state.Business.ExcludedAreas));

        var assessment = AutonomousAssessmentModel.Assess(new AssessmentInputs(
            FunctionalExecuted: ui.Count,
            FunctionalPassed: ui.Count(r => DidPass(r.Status)),
            FunctionalFailed: ui.Count(r => DidFail(r.Status)),
            ApiExecuted: api.Count,
            ApiPassed: api.Count(r => DidPass(r.Status)),
            ApiFailed: api.Count(r => DidFail(r.Status)),
            SecurityScanned: scanned,
            SecurityCritical: OpenAt(SecuritySeverity.Critical),
            SecurityHigh: OpenAt(SecuritySeverity.High),
            SecurityMedium: OpenAt(SecuritySeverity.Medium),
            SecurityRegressions: regressions,
            // Neither is something an autonomous pass does. Declared false rather than
            // omitted, so they land in the untested list instead of vanishing.
            AccessibilityRun: false, AccessibilityViolations: 0,
            VisualRun: false, VisualDifferences: 0,
            CriticalJourneysFailed: criticalFailed,
            GateConfigured: gate is not null,
            GatePassed: gate == true,
            UntestedAreas: untested));

        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Proposing,
            $"Release assessment: {assessment.Verdict}.",
            assessment.Summary,
            new[]
            {
                new AgentEvidence("verdict", assessment.Verdict.ToString()),
                new AgentEvidence("functional", $"{ui.Count(r => DidPass(r.Status))}/{ui.Count} passed"),
                new AgentEvidence("api", $"{api.Count(r => DidPass(r.Status))}/{api.Count} passed"),
                new AgentEvidence("securityScanned", scanned.ToString()),
                new AgentEvidence("criticalJourneysFailed", criticalFailed.ToString()),
                new AgentEvidence("gate", gate is null ? "none configured" : gate.ToString()!),
                // Both lists, by name. A verdict with no blocking factors and no untested
                // areas would be the only kind worth reading as reassurance, and it is
                // almost never what a pass produces.
                new AgentEvidence("blockingFactors",
                    assessment.BlockingFactors.Count == 0
                        ? "none" : string.Join("; ", assessment.BlockingFactors)),
                new AgentEvidence("untestedAreas", string.Join("; ", assessment.UntestedAreas)),
                // Said explicitly because its absence is the design. Somebody looking for a
                // number should find this sentence instead of inventing one.
                new AgentEvidence("overallScore",
                    "none — deliberately. A single number is the thing everybody reads and "
                    + "nobody can act on, and it cannot be checked.")
            },
            Tool: "report.generate",
            Result: assessment.Verdict.ToString(),
            Risk: AgentActionRisk.Observation), ct);

        return assessment;
    }

    /// <summary>
    /// Whether the tests this pass just wrote duplicate ones that already existed.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Checked after generation rather than before, because the agent does not author the
    /// candidates — the generation engine does, and the agent sees them only once they exist.
    /// </para>
    /// <para>
    /// And <strong>nothing is deleted.</strong> A duplicate is reported as a proposal with the
    /// test it duplicates named, and the decision says plainly that the agent did not remove
    /// it. An agent that quietly deletes a test it judged redundant is an agent whose judgement
    /// nobody can review, and the one it got wrong is a coverage gap with no record.
    /// </para>
    /// </remarks>
    private async Task DetectDuplicatesAsync(
        AgentRun run, PassState state, IReadOnlyList<Guid> before, IReadOnlyList<Guid> created,
        CancellationToken ct)
    {
        if (created.Count == 0)
        {
            await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
                AgentPhase.Generating,
                "No duplication check was needed: this pass generated no tests.",
                "There is nothing to compare against what already exists. That is an absence of "
                + "new tests, not a finding that the suite contains no duplicates.",
                new[]
                {
                    new AgentEvidence("newTests", "0"),
                    new AgentEvidence("existingCompared", before.Count.ToString()),
                    new AgentEvidence("testsDeletedOrChanged",
                        "none — the agent has no authority to delete or change a test")
                },
                Tool: "test.generate", Result: "nothing generated to check",
                Risk: AgentActionRisk.Observation), ct);
            return;
        }

        if (before.Count == 0)
        {
            // The first pass over an application has nothing to duplicate. Said rather than
            // skipped: otherwise a reader cannot tell this from the check not happening.
            await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
                AgentPhase.Generating,
                $"No duplication check was possible for {created.Count} new test(s).",
                "This application had no tests before this pass, so there is nothing the new "
                + "ones could duplicate. That is an absence of anything to compare against, "
                + "not a finding that they are all distinct.",
                new[]
                {
                    new AgentEvidence("newTests", created.Count.ToString()),
                    new AgentEvidence("existingCompared", "0"),
                    new AgentEvidence("testsDeletedOrChanged",
                        "none — the agent has no authority to delete or change a test")
                },
                Tool: "test.generate", Result: "nothing to compare against",
                Risk: AgentActionRisk.Observation), ct);
            return;
        }

        var relevant = before.Concat(created).ToList();
        var rows = await _db.TestCases.AsNoTracking()
            .Where(t => relevant.Contains(t.Id) && t.DeletedAt == null)
            .Select(t => new
            {
                t.Id, t.Reference, t.Name, t.Objective, t.Kind,
                // The route the test actually visits, and what it checks. Both read from the
                // stored steps: a test named after a page is not a test of it.
                Target = t.Steps!.OrderBy(s => s.Order)
                    .Select(s => s.Url).FirstOrDefault(u => u != null),
                Assertions = t.Steps!.SelectMany(s => s.Assertions!)
                    .Select(a => $"{a.Type}:{a.ExpectedValue ?? a.AttributeName ?? string.Empty}")
                    .ToList()
            })
            .ToListAsync(ct);

        var existing = rows.Where(r => before.Contains(r.Id))
            .Select(r => new ExistingTest(
                r.Id, r.Reference, r.Name, r.Objective,
                RouteOf(r.Target) ?? string.Empty,
                r.Kind == TestCaseKind.Api ? TestDimension.Api : TestDimension.Ui,
                r.Assertions))
            .ToList();

        var decisions = new List<(string Reference, DuplicationDecision Decision)>();
        foreach (var row in rows.Where(r => created.Contains(r.Id)))
        {
            var candidate = new CandidateTest(
                row.Name, row.Objective, RouteOf(row.Target) ?? string.Empty,
                row.Kind == TestCaseKind.Api ? TestDimension.Api : TestDimension.Ui,
                row.Assertions);
            decisions.Add((row.Reference, TestDuplicationModel.Evaluate(candidate, existing)));
        }

        var reuse = decisions.Where(d => d.Decision.Verdict == DuplicationVerdict.Reuse).ToList();
        var extend = decisions.Where(d => d.Decision.Verdict == DuplicationVerdict.Extend).ToList();

        foreach (var (reference, decision) in reuse.Concat(extend))
        {
            _db.AgentFindings.Add(new AgentFinding
            {
                OrganizationId = run.OrganizationId,
                AgentRunId = run.Id,
                Kind = AgentFindingKind.Observation,
                // Low, because it costs maintenance rather than breaking anything, and an
                // inflated severity here would compete with findings about the application.
                Severity = RiskLevel.Low,
                Title = decision.Verdict == DuplicationVerdict.Reuse
                    ? $"Duplicate: {reference} repeats {decision.ExistingReference}"
                    : $"Nearly a duplicate: {reference} overlaps {decision.ExistingReference}",
                Detail = _masker.MaskText(decision.Reason),
                Recommendation = decision.Verdict == DuplicationVerdict.Reuse
                    ? $"Consider deleting {reference} and keeping {decision.ExistingReference}. "
                    + "The agent has not deleted anything and cannot."
                    : $"Consider adding the missing check(s) to {decision.ExistingReference} and "
                    + $"deleting {reference}: {string.Join(", ", decision.MissingAssertions.Take(5))}. "
                    + "The agent has not changed either test and cannot.",
                Confidence = decision.Similarity,
                IsAiGenerated = false,
                CreatedAt = _clock.UtcNow
            });
        }

        if (reuse.Count > 0 || extend.Count > 0) await _db.SaveChangesAsync(ct);

        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Generating,
            $"Checked {decisions.Count} new test(s) against {existing.Count} existing one(s): "
            + $"{reuse.Count} duplicate, {extend.Count} overlapping.",
            "Running the same check twice is not more coverage; it is the same coverage and "
            + "twice the maintenance. Comparison is structural and deterministic rather than a "
            + "model's judgement, because a test silently not written because something thought "
            + "it a duplicate is a coverage gap with no record.",
            new[]
            {
                new AgentEvidence("newTests", decisions.Count.ToString()),
                new AgentEvidence("existingCompared", existing.Count.ToString()),
                new AgentEvidence("duplicates",
                    reuse.Count == 0 ? "none"
                        : string.Join(", ", reuse.Select(d => $"{d.Reference}≡{d.Decision.ExistingReference}"))),
                new AgentEvidence("overlapping",
                    extend.Count == 0 ? "none"
                        : string.Join(", ", extend.Select(d => $"{d.Reference}~{d.Decision.ExistingReference}"))),
                // The line that matters. Whatever this phase concluded, the suite is unchanged.
                new AgentEvidence("testsDeletedOrChanged",
                    "none — the agent has no authority to delete or change a test, so every "
                    + "duplicate above is still in the suite and is a proposal")
            },
            Tool: "test.generate",
            Result: $"{reuse.Count + extend.Count} proposal(s)",
            Risk: AgentActionRisk.Observation), ct);
    }

    /// <summary>
    /// What this pass observed that might deserve a permanent place in the regression suite.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A regression suite is a promise: everything in it runs on every release, for ever, and
    /// somebody maintains it. The failure mode is not a missing test — it is a suite that grew
    /// by a hundred things nobody vouched for, went amber, and got switched off.
    /// </para>
    /// <para>
    /// So this proposes and does not promote. Even the one case the model promotes
    /// automatically — a confirmed security finding, where the engine established the
    /// vulnerability with a reproducible exchange — is recorded here as a proposal carrying
    /// that recommendation, because creating a permanent test is a state change and the agent
    /// asks before those. What the model decides is *whether it would need a person*; the
    /// answer travels with the proposal so nobody has to re-derive it.
    /// </para>
    /// </remarks>
    private async Task ProposePromotionsAsync(
        AgentRun run, PassState state, CancellationToken ct)
    {
        var already = await _db.AgentFindings
            .AnyAsync(f => f.AgentRunId == run.Id && f.Title.StartsWith("Worth keeping:"), ct);
        if (already) return;

        var candidates = new List<(RegressionCandidate Candidate, string Detail)>();

        // Confirmed security findings for this application. Only confirmed: a finding somebody
        // has marked a false positive or accepted is not a thing to guard against for ever.
        var confirmed = await _db.SecurityFindings.AsNoTracking()
            .Where(f => f.ApplicationId == run.ApplicationId
                     && f.Status == SecurityFindingStatus.Confirmed)
            .OrderByDescending(f => f.Severity)
            .Take(20)
            .Select(f => new
            {
                f.Id, f.Reference, f.Title, f.Category, f.Severity, f.Endpoint,
                // How many scans have reported it. The real record of "times observed", read
                // through the sightings rather than invented: a finding's own scan id names
                // its latest sighting only.
                Sightings = _db.SecurityScanFindings.Count(link => link.SecurityFindingId == f.Id)
            })
            .ToListAsync(ct);

        foreach (var finding in confirmed)
        {
            candidates.Add((
                new RegressionCandidate(
                    RegressionOrigin.ConfirmedSecurityFinding,
                    $"{finding.Reference} — {finding.Title}",
                    TimesObserved: Math.Max(1, finding.Sightings),
                    // Confirmed is a person's word, by definition of that status.
                    HumanConfirmed: true,
                    Confidence: 95,
                    BusinessCritical: state.Business.IsCritical(finding.Endpoint)),
                $"{finding.Category} at {finding.Endpoint ?? "an unrecorded endpoint"}, "
                + $"severity {finding.Severity}."));
        }

        // Journeys the platform has actually seen work, as distinct from ones it inferred from
        // structure. Only Observed: an inferred journey is a guess about what the application
        // is for, and a guess does not belong in a promise.
        var journeys = await _db.Journeys.AsNoTracking()
            .Where(j => j.ApplicationId == run.ApplicationId
                     && j.Evidence == JourneyEvidence.Observed)
            .Take(20)
            .Select(j => new { j.Name, j.IsCritical })
            .ToListAsync(ct);

        foreach (var journey in journeys)
        {
            candidates.Add((
                new RegressionCandidate(
                    RegressionOrigin.ObservedJourney,
                    journey.Name,
                    // One. The platform records THAT a journey was observed and not how many
                    // times, so this is the only number it can honestly supply — and the
                    // promotion bar for a journey is three observations, which means no
                    // journey is ever proposed on this path today. That is recorded as a
                    // platform gap in the evidence below rather than papered over with a
                    // number chosen to make the feature look active.
                    TimesObserved: 1,
                    HumanConfirmed: false,
                    Confidence: 75,
                    BusinessCritical: journey.IsCritical || state.Business.IsCritical(journey.Name)),
                "Observed end to end at least once; the platform does not count how many."));
        }

        if (candidates.Count == 0)
        {
            await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
                AgentPhase.Proposing,
                "No candidate for the permanent suite.",
                "Nothing this pass could see qualifies as a candidate: there is no confirmed "
                + "security finding for this application and no journey the platform has "
                + "observed end to end. An empty candidate list is not a finding that the "
                + "suite is complete.",
                new[]
                {
                    new AgentEvidence("securityFindingsConsidered", "0"),
                    new AgentEvidence("observedJourneysConsidered", "0"),
                    new AgentEvidence("journeyPromotionLimitation",
                        $"A journey needs {RegressionPromotionModel.JourneyObservationsRequired} "
                        + "observations to be proposed, and the platform records only that a "
                        + "journey was observed, not how many times. No journey can reach the bar "
                        + "on this path until it does."),
                    new AgentEvidence("proposed", "0"),
                    new AgentEvidence("belowTheBar", "none — there were no candidates at all"),
                    new AgentEvidence("testsCreated",
                        "none — creating a permanent test changes state, and the agent asks "
                        + "before it changes state")
                },
                Tool: null, Result: "no candidates"), ct);
            return;
        }

        var decisions = candidates
            .Select(entry => (entry.Candidate, entry.Detail, Decision: RegressionPromotionModel.Evaluate(entry.Candidate)))
            .ToList();

        var worthKeeping = decisions.Where(d => d.Decision.Promote).ToList();

        foreach (var (candidate, detail, decision) in worthKeeping)
        {
            _db.AgentFindings.Add(new AgentFinding
            {
                OrganizationId = run.OrganizationId,
                AgentRunId = run.Id,
                Kind = AgentFindingKind.Regression,
                Severity = decision.Priority,
                Title = $"Worth keeping: {Truncate(candidate.Subject, 120)}",
                Detail = _masker.MaskText($"{detail} {decision.Reason}"),
                Recommendation = decision.NeedsApproval
                    ? "Somebody should decide whether this belongs in the permanent suite. "
                    + "The agent has not created a test and cannot."
                    : "This is the one case with no judgement in it: the engine established it "
                    + "with a reproducible exchange, and a test that re-checks it is how anybody "
                    + "finds out if it comes back. The agent has still not created one — that is "
                    + "a state change, and it asks before those.",
                Confidence = candidate.Confidence,
                IsAiGenerated = false,
                CreatedAt = _clock.UtcNow
            });
        }

        if (worthKeeping.Count > 0) await _db.SaveChangesAsync(ct);

        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Proposing,
            $"Assessed {decisions.Count} candidate(s) for the permanent suite: "
            + $"{worthKeeping.Count} worth proposing.",
            "A regression suite is a promise that everything in it runs on every release for "
            + "ever. The bar is high and differs by where a candidate came from: a confirmed "
            + "security finding needs no judgement, an observed journey needs somebody.",
            new[]
            {
                new AgentEvidence("securityFindingsConsidered", confirmed.Count.ToString()),
                new AgentEvidence("observedJourneysConsidered", journeys.Count.ToString()),
                // Stated because the consequence is invisible otherwise: journeys cannot reach
                // the bar, and a reader would otherwise conclude none was worth keeping.
                new AgentEvidence("journeyPromotionLimitation",
                    $"A journey needs {RegressionPromotionModel.JourneyObservationsRequired} "
                    + "observations to be proposed, and the platform records only that a journey "
                    + "was observed, not how many times. No journey can reach the bar on this "
                    + "path until it does."),
                new AgentEvidence("proposed", worthKeeping.Count.ToString()),
                new AgentEvidence("belowTheBar",
                    (decisions.Count - worthKeeping.Count) == 0
                        ? "none"
                        : string.Join("; ", decisions.Where(d => !d.Decision.Promote)
                            .Select(d => $"{Truncate(d.Candidate.Subject, 60)}: {d.Decision.Reason}")
                            .Take(6))),
                new AgentEvidence("needingAPerson",
                    worthKeeping.Count(d => d.Decision.NeedsApproval).ToString()),
                // The line that keeps this honest. Whatever it concluded, the suite is unchanged.
                new AgentEvidence("testsCreated",
                    "none — every one above is a proposal. Creating a permanent test changes "
                    + "state, and the agent asks before it changes state")
            },
            Tool: null,
            Result: $"{worthKeeping.Count} proposal(s)"), ct);
    }

    /// <summary>
    /// What else is worth looking at, from what this run actually saw.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The fixed phase order makes a pass reproducible and also makes it blind: a payment
    /// endpoint returning 403 halfway through is the most interesting thing that will happen in
    /// the run, and a loop that cannot react to it finishes its plan and reports the 403 as one
    /// failure among many.
    /// </para>
    /// <para>
    /// These are <strong>proposals for the next pass</strong>, not work this one does. Adding
    /// tests after execution would mean generating what nothing ran, and the pass has already
    /// spent its budget. So the observation and what it argues for are recorded, and a person
    /// or the next pass acts. Reacting to evidence is a reason to do more; it is never a reason
    /// to be allowed more, and nothing here widens what the policy permits.
    /// </para>
    /// </remarks>
    private async Task ReactToObservationsAsync(
        AgentRun run, PassState state, CancellationToken ct)
    {
        if (run.TestRunId is null) return;

        var already = await _db.AgentFindings
            .AnyAsync(f => f.AgentRunId == run.Id && f.Title.StartsWith("Worth a look:"), ct);
        if (already) return;

        // Error responses the run actually observed, with where they happened. Read from the
        // network events the worker recorded rather than from the failures, because the most
        // interesting status codes are often on requests that did not fail a test.
        var executionIds = await _db.TestExecutions.AsNoTracking()
            .Where(e => e.TestRunId == run.TestRunId)
            .Select(e => e.Id)
            .ToListAsync(ct);

        if (executionIds.Count == 0) return;

        var errors = await _db.NetworkEvents.AsNoTracking()
            .Where(n => n.TestExecutionId != null && executionIds.Contains(n.TestExecutionId!.Value)
                     && n.StatusCode >= 400)
            .Select(n => new { n.Method, n.Url, n.StatusCode })
            .Take(200)
            .ToListAsync(ct);

        if (errors.Count == 0) return;

        var securityAuthorized = await _db.SecurityScopes.AsNoTracking()
            .AnyAsync(scope => scope.ApplicationId == run.ApplicationId && scope.Enabled, ct);

        // The graph's own spelling for each place, so a reaction to evidence names somewhere a
        // reader can find. The graph is not uniform about this — a page is a path and an
        // endpoint is an absolute template — and reducing an observed URL to its path produced
        // findings about "/api/session" in a run whose endpoint records all said
        // "http://localhost:4300/api/session". Two names for one endpoint in one pass breaks
        // every join a reader or the assessment might make: the business-critical check matches
        // a finding's route against the areas a person named, and it cannot match a spelling
        // nothing else uses.
        var knownEndpoints = await _db.ApiEndpoints.AsNoTracking()
            .Where(e => e.ApplicationId == run.ApplicationId)
            .Select(e => e.UrlTemplate)
            .ToListAsync(ct);
        var knownPages = await _db.ApplicationPages.AsNoTracking()
            .Where(p => p.ApplicationId == run.ApplicationId)
            .Select(p => p.Route)
            .ToListAsync(ct);

        // Falls back to the path as observed. A place the graph does not know is still a place
        // the run reached, so it is reported rather than dropped — but it is reported as what
        // was seen, never as a graph record that does not exist.
        string Locate(string url)
        {
            var path = RouteOf(url);

            var endpoint = knownEndpoints.FirstOrDefault(t =>
                    string.Equals(t, url, StringComparison.OrdinalIgnoreCase))
                ?? knownEndpoints.FirstOrDefault(t =>
                    path is not null
                    && string.Equals(RouteOf(t), path, StringComparison.OrdinalIgnoreCase));
            if (endpoint is not null) return endpoint;

            var page = knownPages.FirstOrDefault(r =>
                path is not null && string.Equals(r, path, StringComparison.OrdinalIgnoreCase));
            return page ?? path ?? url;
        }

        // One observation per distinct status-and-route, so ten 403s on one endpoint argue once.
        var observations = errors
            .Select(e => new MidRunObservation(
                What: $"{e.Method} returned {e.StatusCode}",
                Where: Locate(e.Url),
                HttpStatus: e.StatusCode,
                Detail: $"Observed during the verification run this pass started."))
            .GroupBy(o => (o.HttpStatus, o.Where))
            .Select(g => g.First())
            .ToList();

        var selections = DynamicSelectionModel.Bound(
            observations.SelectMany(o => DynamicSelectionModel.React(o, securityAuthorized)).ToList(),
            // Bounded by the pass's own target budget. An unbounded reaction to evidence is how
            // a pass that saw one broken endpoint proposes forty things.
            run.MaxTargets * 2);

        if (selections.Count == 0) return;

        foreach (var selection in selections)
        {
            _db.AgentFindings.Add(new AgentFinding
            {
                OrganizationId = run.OrganizationId,
                AgentRunId = run.Id,
                Kind = AgentFindingKind.RiskArea,
                Severity = selection.Risk,
                Title = $"Worth a look: {Truncate(selection.Target, 100)} "
                      + $"({selection.Dimension.ToString().ToLowerInvariant()})",
                // The observation verbatim. "Why is this here" is the question somebody asks
                // about exactly these, because they are the ones nobody asked for.
                Detail = _masker.MaskText(
                    $"{selection.Reason} Observed: {selection.Trigger.What} at "
                    + $"{selection.Trigger.Where}. Expected to establish: {selection.Expectation}"),
                Recommendation = "This pass had already spent its budget when it saw this, so it "
                               + "proposes rather than acts. Nothing was generated or run for it.",
                Confidence = 80,
                Route = selection.Target,
                IsAiGenerated = false,
                CreatedAt = _clock.UtcNow
            });
        }
        await _db.SaveChangesAsync(ct);

        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Investigating,
            $"Observed {observations.Count} distinct error response(s); {selections.Count} "
            + "argue for something else to be looked at.",
            "A fixed phase order makes a pass reproducible and also makes it blind. Evidence the "
            + "run produced can argue for more work — and only for more. Nothing here widens what "
            + "the policy permits or reaches outside the authorized scope.",
            new[]
            {
                new AgentEvidence("errorResponsesObserved", errors.Count.ToString()),
                new AgentEvidence("distinctObservations", observations.Count.ToString()),
                new AgentEvidence("statuses",
                    string.Join(", ", observations.Select(o => o.HttpStatus).Distinct().OrderBy(s => s))),
                new AgentEvidence("proposed", selections.Count.ToString()),
                new AgentEvidence("securityAuthorized", securityAuthorized.ToString()),
                // The distinction that keeps this from reading as work done.
                new AgentEvidence("actedOn",
                    "nothing — this pass had spent its budget by the time it saw these, so each "
                    + "is a proposal for a person or for the next pass")
            },
            Tool: null,
            Result: $"{selections.Count} proposal(s)"), ct);
    }

    // ---- Correlate -------------------------------------------------------------
    //
    // Seventeen red tests caused by one endpoint returning 500 is one problem, and a list of
    // seventeen is a worse description of it than a list of one with sixteen underneath.
    //
    // The grouping itself is FailureCorrelationModel — a pure function, deterministic, with
    // rules ordered from strongest evidence to weakest. This method's job is to gather honest
    // signals for it and to record what came back, including the failures that matched
    // nothing: a group is a convenience, and a hidden failure is a defect nobody finds out
    // about.

    private async Task<PhaseOutcome> CorrelateAsync(AgentRun run, PassState state, CancellationToken ct)
    {
        if (run.TestRunId is null)
            return PhaseOutcome.Ok("Nothing to correlate: no verification run was made.");

        var executionIds = await _db.TestExecutions.AsNoTracking()
            .Where(e => e.TestRunId == run.TestRunId)
            .Select(e => e.Id)
            .ToListAsync(ct);

        if (executionIds.Count == 0)
            return PhaseOutcome.Ok("Nothing to correlate: the run recorded no executions.");

        var failures = await _db.Failures.AsNoTracking()
            .Where(f => executionIds.Contains(f.TestExecutionId))
            .Select(f => new
            {
                f.Id, f.TestExecutionId, f.TestActionId, f.TestCaseId,
                f.Category, f.Signature, f.RawMessage
            })
            .Take(100)
            .ToListAsync(ct);

        if (failures.Count < 2)
        {
            // Recorded rather than returned silently. A phase that ran and left nothing behind
            // is indistinguishable from a phase that never ran, and "the pass looked and found
            // nothing to group" is a different statement from "the pass did not look".
            await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
                AgentPhase.Correlating,
                $"Nothing to correlate: {failures.Count} failure(s).",
                "Correlation groups failures that share a cause. With fewer than two there is "
                + "nothing to group, which is not the same as having found no common cause.",
                new[]
                {
                    new AgentEvidence("failuresIn", failures.Count.ToString()),
                    new AgentEvidence("accountedFor", failures.Count.ToString()),
                    new AgentEvidence("groups", "0"),
                    new AgentEvidence("ungrouped", failures.Count.ToString()),
                    new AgentEvidence("executionsExamined", executionIds.Count.ToString())
                },
                Tool: "failure.correlate", Result: "nothing to group",
                Risk: AgentActionRisk.Observation), ct);

            return PhaseOutcome.Ok(
                failures.Count == 0
                    ? "Nothing to correlate: every test passed."
                    : "Nothing to correlate: one failure cannot share a cause with anything.",
                "Correlation groups failures that share a cause. With fewer than two there is "
                + "nothing to group, which is not the same as having found no common cause.");
        }

        var testNames = await _db.TestCases.AsNoTracking()
            .Where(t => failures.Select(f => f.TestCaseId).Contains(t.Id))
            .Select(t => new { t.Id, t.Reference, t.Name })
            .ToDictionaryAsync(t => t.Id, ct);

        // Where the test was when it failed, and what failed underneath it. Both read from
        // what the execution actually recorded rather than inferred from the test's intent:
        // a test named after a page proves nothing about where it got to.
        var actionIds = failures.Where(f => f.TestActionId is not null)
            .Select(f => f.TestActionId!.Value).Distinct().ToList();

        var actionRoutes = actionIds.Count == 0
            ? new Dictionary<Guid, string?>()
            : await _db.TestActions.AsNoTracking()
                .Where(a => actionIds.Contains(a.Id))
                .Select(a => new { a.Id, a.Url })
                .ToDictionaryAsync(a => a.Id, a => a.Url, ct);

        // The failing request observed during the failing action, if the worker saw one. Only
        // errors: a 200 during a failing step is not the cause of anything.
        var failingCalls = actionIds.Count == 0
            ? new List<dynamic>()
            : (await _db.NetworkEvents.AsNoTracking()
                .Where(n => n.TestActionId != null && actionIds.Contains(n.TestActionId!.Value)
                         && n.StatusCode >= 400)
                .Select(n => new { n.TestActionId, n.Method, n.Url, n.StatusCode })
                .ToListAsync(ct)).Cast<dynamic>().ToList();

        var signals = failures.Select(failure =>
        {
            var call = failure.TestActionId is { } actionId
                ? failingCalls.FirstOrDefault(c => c.TestActionId == actionId)
                : null;
            var route = failure.TestActionId is { } id && actionRoutes.TryGetValue(id, out var url)
                ? RouteOf(url)
                : null;

            return new FailureSignal(
                ExecutionId: failure.TestExecutionId,
                TestReference: testNames.TryGetValue(failure.TestCaseId, out var test) ? test.Reference : "unknown",
                TestName: test?.Name ?? "unknown",
                Route: route,
                FailingApiCall: call is null ? null : $"{call.Method} {RouteOf((string)call.Url)}",
                ApiStatusCode: call is null ? null : (int?)call.StatusCode,
                Classification: failure.Category.ToString(),
                Signature: failure.Signature,
                FailedAt: _clock.UtcNow);
        }).ToList();

        var result = FailureCorrelationModel.Correlate(signals);

        var permitted = await CheckAsync(run, state, "failure.correlate", AgentPhase.Correlating, ct: ct);
        if (!permitted.Allowed)
            return PhaseOutcome.Ok("Failures were not correlated.", permitted.Reason);

        // Written once. Correlating is read-only and cheap, so a resumed pass re-runs it, and
        // a finding recorded twice is counted twice everywhere after.
        var alreadyRecorded = await _db.AgentFindings
            .AnyAsync(f => f.AgentRunId == run.Id && f.Title.StartsWith("One cause:"), ct);

        if (!alreadyRecorded)
        {
            foreach (var group in result.Groups.Where(g => g.Count > 1))
            {
                _db.AgentFindings.Add(new AgentFinding
                {
                    OrganizationId = run.OrganizationId,
                    AgentRunId = run.Id,
                    Kind = AgentFindingKind.Observation,
                    // The size of the group is the severity signal. One endpoint breaking
                    // seventeen tests is worth reading before seventeen separate failures.
                    Severity = group.Count >= 5 ? RiskLevel.High : RiskLevel.Medium,
                    Title = $"One cause: {Truncate(group.PrimaryFailure, 120)}",
                    Detail = _masker.MaskText(
                        $"{group.Why} Affects {group.Count} failure(s) across "
                        + $"{group.AffectedTests.Count} test(s)"
                        + (group.AffectedRoutes.Count > 0
                            ? $", {string.Join(", ", group.AffectedRoutes.Take(5))}" : string.Empty)
                        + (group.AffectedApiCalls.Count > 0
                            ? $". Failing call(s): {string.Join(", ", group.AffectedApiCalls.Take(5))}"
                            : string.Empty)),
                    Recommendation = "Look at this one thing before the failures underneath it. "
                                   + "The agent has grouped them; it has not decided they are the same bug.",
                    Confidence = group.Confidence,
                    Route = group.AffectedRoutes.FirstOrDefault(),
                    IsAiGenerated = false,
                    CreatedAt = _clock.UtcNow
                });
            }
            await _db.SaveChangesAsync(ct);
        }

        await _journal.RecordAsync(run.Id, new AgentDecisionRecord(
            AgentPhase.Correlating,
            $"Grouped {failures.Count} failure(s) into {result.Groups.Count} cause(s), "
            + $"{result.Ungrouped.Count} ungrouped.",
            result.Summary,
            new[]
            {
                new AgentEvidence("failuresIn", failures.Count.ToString()),
                new AgentEvidence("groups", result.Groups.Count.ToString()),
                // Named because a hidden failure is the one defect this phase could introduce.
                // The two numbers must add up to the first, and a reader can check.
                new AgentEvidence("ungrouped", result.Ungrouped.Count.ToString()),
                new AgentEvidence("accountedFor", result.TotalFailures.ToString()),
                new AgentEvidence("largestGroup",
                    result.Groups.Count == 0 ? "0" : result.Groups.Max(g => g.Count).ToString()),
                new AgentEvidence("confidences",
                    result.Groups.Count == 0
                        ? "none" : string.Join(", ", result.Groups.Select(g => $"{g.Confidence}%")))
            },
            Tool: "failure.correlate",
            Result: $"{result.Groups.Count} group(s)",
            Risk: AgentActionRisk.Observation), ct);

        return PhaseOutcome.Ok(
            $"Grouped {failures.Count} failure(s) into {result.Groups.Count} likely cause(s); "
            + $"{result.Ungrouped.Count} matched nothing.",
            "Every failure appears somewhere — inside a group or in the ungrouped list. A group "
            + "is the agent's reading of what they share, not a decision that they are one bug.",
            result.Summary);
    }

    /// <summary>The path of a URL, or the string unchanged when it is not one.</summary>
    private static string? RouteOf(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        return Uri.TryCreate(url, UriKind.Absolute, out var absolute) ? absolute.AbsolutePath : url;
    }

    // ---- Propose ----------------------------------------------------------------------

    private async Task<PhaseOutcome> ProposeAsync(AgentRun run, PassState state, CancellationToken ct)
    {
        await AddRegressionFindingsAsync(run, ct);

        // What this pass saw that might deserve a permanent place. Proposed, never created.
        await ProposePromotionsAsync(run, state, ct);

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

        // ---- What this pass is allowed to say about the release -------------------
        //
        // AutonomousAssessmentModel produces facts, a configured gate's verdict and blocking
        // factors by name. Deliberately no overall score: a single number is the thing
        // everybody reads and nobody can act on, and an AI-generated one launders measured
        // facts and unmeasured ones together into a figure that cannot be checked.
        //
        // The verdict that earns its place is NotAssessed. A pass where almost nothing ran has
        // not found a clean release; it has found nothing, and every other verdict would read
        // as a statement about the application rather than about the pass.
        var assessment = await AssessAsync(run, state, findings, ct);

        lines.Add($"Release assessment: {assessment.Verdict}. {assessment.Summary}");

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
