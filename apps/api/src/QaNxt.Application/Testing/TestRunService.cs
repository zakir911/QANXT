using System.Text.Json;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Applications;
using QaNxt.Application.Contracts;
using QaNxt.Application.Discovery;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Application.Testing;

public sealed record StartTestRunRequest(
    Guid ProjectId, Guid? TestSuiteId, Guid[]? TestCaseIds, Guid? EnvironmentId,
    BrowserType? Browser, bool? Headless, int? Parallelism, int? MaxRetries,
    string? Name, RunTrigger? Trigger, CiContext? Ci);

public sealed record CiContext(string? Provider, string? BuildId, string? CommitSha, string? Branch, string? ApplicationBuildRef);

public sealed record TestRunSummary(
    Guid Id, Guid ProjectId, string Name, ExecutionStatus Status, RunTrigger Trigger, BrowserType Browser,
    DateTimeOffset CreatedAt, DateTimeOffset? StartedAt, DateTimeOffset? CompletedAt, int DurationMs,
    int TotalCount, int PassedCount, int FailedCount, int SkippedCount, int BlockedCount,
    int HealedCount, int FlakyCount, bool? QualityGatePassed,
    /// <summary>Where this run came from. Recorded so a failure months later can be traced
    /// to the commit that produced it, which is only possible if these survive to a
    /// reader — storing them and not returning them is the same as not storing them.</summary>
    string? CiBuildId, string? CiBranch, string? CiProvider = null, string? CiCommitSha = null,
    string? ApplicationBuildRef = null,
    Guid? EnvironmentId = null,
    /// <summary>The environment by the name a person uses for it. The id alone makes a
    /// report unreadable without a second lookup, and a reader asking "which deployment did
    /// this evidence come from?" is asking about "staging", not about a UUID.</summary>
    string? EnvironmentKey = null, string? EnvironmentName = null,
    /// <summary>When a contract check ran against this run's evidence, and what it found.
    /// Null means no check ran, which is a different statement from "no breaking changes".</summary>
    DateTimeOffset? ContractCheckedAt = null,
    int ContractBreakingChangeCount = 0,
    int ContractPotentiallyBreakingChangeCount = 0,
    /// <summary>The security scan started with this run, whose findings are in its bug report.</summary>
    Guid? SecurityScanId = null);

public interface ITestRunService
{
    Task<Result<TestRunSummary>> StartAsync(StartTestRunRequest request, CancellationToken ct = default);
    Task<IReadOnlyList<TestRunSummary>> ListAsync(Guid? projectId, int limit, CancellationToken ct = default);
    Task<Result<TestRunSummary>> GetAsync(Guid id, CancellationToken ct = default);
    Task<Result> CancelAsync(Guid id, CancellationToken ct = default);
}

/// <summary>Creates runs and dispatches their executions.
///
/// Every decision that needs project context, credentials or authorization is made here,
/// and the worker receives only a self-contained plan. That asymmetry is deliberate: the
/// execution plane drives browsers against arbitrary customer applications, so it is given
/// the least information and the least authority that still lets it do the job.</summary>
public sealed class TestRunService : ITestRunService
{
    /// <summary>Stands in for a test case that draws on no data set, so the resolvers take the
    /// same shape whether or not there is one.</summary>
    private static readonly List<TestDataField> EmptyDataFields = new();

    private readonly IQaNxtDbContext _db;
    private readonly IJobQueue _queue;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly ITokenService _tokens;
    private readonly IApplicationService _applications;
    private readonly Projects.IEnvironmentService _environments;
    private readonly ISecretProtector _protector;
    private readonly ITargetPolicy _targetPolicy;
    private readonly ICorrelationContext _correlation;
    private readonly IPlatformUrls _urls;
    private readonly IAuditLogger _audit;
    private readonly IExecutionEventPublisher _events;
    private readonly ILogger<TestRunService> _logger;

    public TestRunService(IQaNxtDbContext db, IJobQueue queue, ICurrentUser currentUser, IClock clock,
        ITokenService tokens, IApplicationService applications,
        Projects.IEnvironmentService environments, ISecretProtector protector,
        ITargetPolicy targetPolicy, ICorrelationContext correlation, IPlatformUrls urls,
        IAuditLogger audit, IExecutionEventPublisher events, ILogger<TestRunService> logger)
    {
        _db = db;
        _queue = queue;
        _currentUser = currentUser;
        _clock = clock;
        _tokens = tokens;
        _applications = applications;
        _environments = environments;
        _protector = protector;
        _targetPolicy = targetPolicy;
        _correlation = correlation;
        _urls = urls;
        _audit = audit;
        _events = events;
        _logger = logger;
    }

    public async Task<Result<TestRunSummary>> StartAsync(StartTestRunRequest request, CancellationToken ct = default)
    {
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == request.ProjectId, ct);
        if (project is null) return Error.NotFound("The project");

        var cases = await SelectCasesAsync(request, ct);
        if (cases.Count == 0)
            return Error.Validation("No enabled test cases matched the selection.");

        var environment = request.EnvironmentId is null
            ? null
            : await _db.Environments.FirstOrDefaultAsync(e => e.Id == request.EnvironmentId, ct);

        if (request.EnvironmentId is not null && environment is null)
            return Error.NotFound("The environment");

        if (environment is not null)
        {
            // Checked at the moment a run is asked for, not only when the environment was
            // configured. The environment model already knew how to refuse production; it
            // was not being asked, so a run against an unauthorized production environment
            // would have been accepted.
            var testable = await _environments.EnsureTestableAsync(environment.Id, ct);
            if (!testable.IsSuccess) return Result<TestRunSummary>.Failure(testable.Error!);
        }

        var run = new TestRun
        {
            OrganizationId = project.OrganizationId,
            ProjectId = project.Id,
            TestSuiteId = request.TestSuiteId,
            EnvironmentId = environment?.Id,
            Name = request.Name?.Trim() is { Length: > 0 } name
                ? name
                : $"{project.Key} run {_clock.UtcNow:yyyy-MM-dd HH:mm}",
            Trigger = request.Trigger ?? RunTrigger.Manual,
            Browser = request.Browser ?? project.DefaultBrowser,
            Headless = request.Headless ?? true,
            Parallelism = Math.Clamp(request.Parallelism ?? project.MaxParallelExecutions, 1, 50),
            MaxRetries = Math.Clamp(request.MaxRetries ?? project.DefaultRetries, 0, 5),
            Status = ExecutionStatus.Queued,
            TotalCount = cases.Count,
            CiProvider = request.Ci?.Provider,
            CiBuildId = request.Ci?.BuildId,
            CiCommitSha = request.Ci?.CommitSha,
            CiBranch = request.Ci?.Branch,
            ApplicationBuildRef = request.Ci?.ApplicationBuildRef,
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };

        _db.TestRuns.Add(run);

        var executions = cases.Select(testCase => new TestExecution
        {
            OrganizationId = project.OrganizationId,
            TestRunId = run.Id,
            TestCaseId = testCase.Id,
            TestCaseVersion = testCase.Version,
            Attempt = 1,
            Status = ExecutionStatus.Queued,
            Browser = run.Browser,
            // The id of the request that asked for this run, so the stored execution, the
            // job the worker receives, the worker's own log lines and the audit record all
            // carry the same value. The property's initialiser generates one, which meant
            // that until this assignment existed every execution carried a fresh id that
            // matched nothing: the CLI report published it, and following it found no log
            // line and no audit record (BUG-0037).
            CorrelationId = _correlation.CorrelationId,
            CreatedAt = _clock.UtcNow
        }).ToList();

        _db.TestExecutions.AddRange(executions);
        await _db.SaveChangesAsync(ct);

        // From here the request's cancellation token is deliberately NOT used.
        //
        // The executions above are committed. Dispatching them is one enqueue per execution,
        // and a large suite is a lot of them: a 137-screen application designed 5,832 tests,
        // and inserting and queueing them took longer than the client's 60-second timeout.
        // When the client gave up, ct was cancelled, the loop below stopped partway, and
        // 3,756 executions were left Pending with no job ever queued for them.
        //
        // The run then reported 5,832 total and could never finish. Twenty minutes later the
        // stranded sweep ended those executions with "No worker picked this test up" — which
        // is true and blames the wrong component: no worker was ever told. A client that
        // hangs up, or a user who closes a tab, silently truncated a test run and the
        // platform attributed it to the worker.
        //
        // Cancelling a request must not abandon work the request already committed, so the
        // dispatch runs to completion on its own token. The caller has already been given
        // the run id; the right to stop a run belongs to the cancel endpoint, not to a
        // dropped socket.
        var dispatchCt = CancellationToken.None;

        // Everything the dispatch loop would otherwise fetch once per execution.
        //
        // Building one execution's payload asked the database for the application, the
        // test's steps and their assertions, and the application's credentials — every
        // time. On a 7,774-test suite that is tens of thousands of round trips, and the
        // whole insert-and-dispatch ran past the client's timeout: the caller gave up
        // believing the run had failed while the control plane carried on executing it. A
        // product that cannot start its own largest suite without the client dying is not
        // one somebody buys, and the cost here was never the work — it was asking for the
        // same three things over and over.
        //
        // None of them vary within a run, so each is fetched once. Steps come back in a
        // single query for every case in the run, ordered and with their assertions, and
        // are handed to the builder already grouped.
        var caseIds = executions.Select(e => e.TestCaseId).Distinct().ToList();
        var stepsByCase = (await _db.TestSteps
                .Where(s => caseIds.Contains(s.TestCaseId))
                .OrderBy(s => s.Order)
                .Include(s => s.Assertions)
                .ToListAsync(dispatchCt))
            .GroupBy(s => s.TestCaseId)
            .ToDictionary(g => g.Key, g => g.ToList());

        var applicationIds = cases.Where(c => c.ApplicationId is not null)
            .Select(c => c.ApplicationId!.Value).Distinct().ToList();
        var applicationsById = await _db.Applications
            .Where(a => applicationIds.Contains(a.Id))
            .ToDictionaryAsync(a => a.Id, dispatchCt);

        // The one a test with no application of its own falls back to.
        var projectApplication = cases.Any(c => c.ApplicationId is null)
            ? await _db.Applications.FirstOrDefaultAsync(a => a.ProjectId == project.Id, dispatchCt)
            : null;

        var credentialsByApplication = new Dictionary<Guid, ApplicationCredentials>();

        // Two more were still asked per execution, found by measuring the fixed build rather
        // than trusting it. The element model a step's fingerprint is matched against is the
        // whole application's — 8,599 rows for the freight target — and it was queried,
        // materialised and then linearly scanned once per execution. At 20ms for the query
        // alone that was about 150 of the 257 seconds the dispatch took. The test data set a
        // case draws from was asked twice per execution on top.
        //
        // Neither varies within a run for tests that share an application or a data set, so
        // each is built once. The element model is also indexed by the ways a locator can name
        // a control, which replaces the scan.
        var fingerprintsByApplication = new Dictionary<Guid, ElementFingerprintIndex>();
        var dataFieldsBySet = new Dictionary<Guid, List<TestDataField>>();

        // Looked up per execution; a linear scan here is quadratic over the run.
        var casesById = cases.ToDictionary(c => c.Id);

        var dispatched = 0;
        var dispatchErrors = new List<string>();

        var skipped = 0;
        foreach (var execution in executions)
        {
            var testCase = casesById[execution.TestCaseId];

            // A compatibility test belongs to one browser. In a run on another it is skipped,
            // and says so, rather than passing in the wrong engine and being counted as
            // evidence that the form works where it was never opened.
            var target = TargetBrowserOf(testCase.Tags);
            if (target is not null && target != run.Browser)
            {
                execution.Status = ExecutionStatus.Skipped;
                execution.ErrorMessage = $"This compatibility test runs only in {target}; this run uses {run.Browser}.";
                execution.CompletedAt = _clock.UtcNow;
                skipped++;
                continue;
            }

            var payload = await BuildPayloadAsync(run, execution, testCase, project, environment,
                stepsByCase, applicationsById, projectApplication, credentialsByApplication,
                fingerprintsByApplication, dataFieldsBySet, dispatchCt);

            if (payload.IsFailure)
            {
                execution.Status = ExecutionStatus.Blocked;
                execution.ErrorMessage = payload.Error!.Message;
                execution.CompletedAt = _clock.UtcNow;
                dispatchErrors.Add($"{testCase.Reference}: {payload.Error.Message}");
                continue;
            }

            try
            {
                await _queue.EnqueueAsync(QueueNames.Execution, "execution", payload.Value!, dispatchCt);
                dispatched++;
            }
            catch (Exception ex)
            {
                // A queue failure is reported on the execution rather than left to look like
                // a worker that never picked the job up.
                execution.Status = ExecutionStatus.Error;
                execution.ErrorMessage = "The execution could not be queued. Check that the job queue is reachable.";
                execution.CompletedAt = _clock.UtcNow;
                dispatchErrors.Add($"{testCase.Reference}: could not be queued.");
                _logger.LogError(ex, "Failed to queue execution {ExecutionId}", execution.Id);
            }
        }

        run.BlockedCount = executions.Count(e => e.Status == ExecutionStatus.Blocked);
        run.SkippedCount = skipped;
        if (dispatched == 0)
        {
            run.Status = skipped == executions.Count ? ExecutionStatus.Skipped : ExecutionStatus.Error;
            run.CompletedAt = _clock.UtcNow;
        }

        // Also on the dispatch token: a cancelled request must not lose the record of what
        // it managed to queue.
        await _db.SaveChangesAsync(dispatchCt);

        await _audit.LogAsync(AuditAction.TestRunStarted, nameof(TestRun), run.Id,
            $"Run '{run.Name}' started with {dispatched} of {cases.Count} execution(s) queued.",
            projectId: project.Id, ct: ct);

        await _events.PublishAsync(run.OrganizationId, new ExecutionEvent(
            ExecutionEventTypes.RunQueued, run.Id, null,
            new { run.Name, total = cases.Count, dispatched, errors = dispatchErrors }, _clock.UtcNow), ct);

        if (dispatched == 0 && skipped == executions.Count)
            return Result<TestRunSummary>.Success(Map(run));

        if (dispatched == 0)
        {
            return Error.Dependency("dispatch_failed",
                $"No execution could be started. {string.Join(" ", dispatchErrors.Take(3))}");
        }

        _logger.LogInformation("Run {RunId} queued {Dispatched} execution(s)", run.Id, dispatched);
        return Result<TestRunSummary>.Success(Map(run));
    }

    public async Task<IReadOnlyList<TestRunSummary>> ListAsync(Guid? projectId, int limit, CancellationToken ct = default)
    {
        var query = _db.TestRuns.AsQueryable();
        if (projectId is not null) query = query.Where(r => r.ProjectId == projectId);

        return await query
            .OrderByDescending(r => r.CreatedAt)
            .Take(Math.Clamp(limit, 1, 200))
            .Select(r => new TestRunSummary(
                r.Id, r.ProjectId, r.Name, r.Status, r.Trigger, r.Browser, r.CreatedAt, r.StartedAt, r.CompletedAt,
                r.DurationMs, r.TotalCount, r.PassedCount, r.FailedCount, r.SkippedCount, r.BlockedCount,
                r.HealedCount, r.FlakyCount, r.QualityGatePassed, r.CiBuildId, r.CiBranch,
                r.CiProvider, r.CiCommitSha, r.ApplicationBuildRef, r.EnvironmentId,
                _db.Environments.Where(e => e.Id == r.EnvironmentId).Select(e => e.Key).FirstOrDefault(),
                _db.Environments.Where(e => e.Id == r.EnvironmentId).Select(e => e.Name).FirstOrDefault(),
                r.ContractCheckedAt, r.ContractBreakingChangeCount,
                r.ContractPotentiallyBreakingChangeCount, r.SecurityScanId))
            .ToListAsync(ct);
    }

    public async Task<Result<TestRunSummary>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var run = await _db.TestRuns.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (run is null) return Error.NotFound("The test run");

        var environment = run.EnvironmentId is null
            ? null
            : await _db.Environments.FirstOrDefaultAsync(e => e.Id == run.EnvironmentId, ct);

        return Result<TestRunSummary>.Success(Map(run, environment));
    }

    public async Task<Result> CancelAsync(Guid id, CancellationToken ct = default)
    {
        var run = await _db.TestRuns.FirstOrDefaultAsync(r => r.Id == id, ct);
        if (run is null) return Result.Failure(Error.NotFound("The test run"));

        if (run.Status is ExecutionStatus.Passed or ExecutionStatus.Failed or ExecutionStatus.Cancelled)
            return Result.Failure(Error.Conflict("run_finished", "That run has already finished."));

        var pending = await _db.TestExecutions
            .Where(e => e.TestRunId == run.Id &&
                        (e.Status == ExecutionStatus.Queued || e.Status == ExecutionStatus.Pending))
            .ToListAsync(ct);

        foreach (var execution in pending)
        {
            execution.Status = ExecutionStatus.Cancelled;
            execution.CompletedAt = _clock.UtcNow;
        }

        // Executions already running finish and report normally; cancelling mid-browser
        // would discard evidence that has already been paid for.
        run.Status = ExecutionStatus.Cancelled;
        run.CompletedAt = _clock.UtcNow;
        await _db.SaveChangesAsync(ct);

        _logger.LogInformation("Run {RunId} cancelled; {Count} queued execution(s) will not start", run.Id, pending.Count);
        return Result.Success();
    }

    /// <summary>The browser a compatibility test is tagged for, if it is tagged for one.</summary>
    private static BrowserType? TargetBrowserOf(string tags)
    {
        foreach (var tag in tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (tag.StartsWith("browser:", StringComparison.OrdinalIgnoreCase)
                && Enum.TryParse<BrowserType>(tag["browser:".Length..], ignoreCase: true, out var browser))
                return browser;
        }
        return null;
    }

    private async Task<List<TestCase>> SelectCasesAsync(StartTestRunRequest request, CancellationToken ct)
    {
        var query = _db.TestCases.Where(tc => tc.ProjectId == request.ProjectId && tc.IsEnabled);

        if (request.TestCaseIds is { Length: > 0 })
            query = query.Where(tc => request.TestCaseIds.Contains(tc.Id));
        else if (request.TestSuiteId is not null)
            query = query.Where(tc => tc.TestSuiteId == request.TestSuiteId);

        // Highest-priority first, so a run that is cut short has still covered what matters.
        return await query.OrderBy(tc => tc.Priority).ThenBy(tc => tc.Reference).ToListAsync(ct);
    }

    private async Task<Result<ExecutionJobPayload>> BuildPayloadAsync(
        TestRun run, TestExecution execution, TestCase testCase, Domain.Projects.Project project,
        Domain.Projects.Environment? environment,
        IReadOnlyDictionary<Guid, List<TestStep>> stepsByCase,
        IReadOnlyDictionary<Guid, Domain.Applications.Application> applicationsById,
        Domain.Applications.Application? projectApplication,
        Dictionary<Guid, ApplicationCredentials> credentialsByApplication,
        Dictionary<Guid, ElementFingerprintIndex> fingerprintsByApplication,
        Dictionary<Guid, List<TestDataField>> dataFieldsBySet,
        CancellationToken ct)
    {
        var application = testCase.ApplicationId is null
            ? projectApplication
            : applicationsById.GetValueOrDefault(testCase.ApplicationId.Value);

        if (application is null)
            return Error.Validation($"{testCase.Reference} has no application to run against.");

        var baseUrl = environment?.BaseUrl ?? application.BaseUrl;
        // The API is often on another origin. It is added to the allowlist explicitly
        // rather than by widening the guard, so an API test still cannot reach a host
        // nobody configured.
        var apiBaseUrl = string.IsNullOrWhiteSpace(environment?.ApiBaseUrl) ? baseUrl : environment!.ApiBaseUrl!;
        var allowlist = ApplicationService.ParseAllowlist(application.AllowedDomains, baseUrl);
        if (!_targetPolicy.IsAllowed(baseUrl, allowlist, out var reason))
            return Error.Validation($"{testCase.Reference} cannot run: {reason}");

        if (!string.Equals(apiBaseUrl, baseUrl, StringComparison.OrdinalIgnoreCase))
        {
            allowlist = ApplicationService.ParseAllowlist(application.AllowedDomains, baseUrl, apiBaseUrl);
            if (!_targetPolicy.IsAllowed(apiBaseUrl, allowlist, out var apiReason))
                return Error.Validation($"{testCase.Reference} cannot run: its API base URL {apiReason}");
        }

        var steps = stepsByCase.GetValueOrDefault(testCase.Id) ?? new List<TestStep>();

        if (steps.Count == 0)
            return Error.Validation($"{testCase.Reference} has no steps.");

        // Resolving credentials decrypts and can reach the database; it is the same answer
        // for every test of an application, so it is asked once.
        if (!credentialsByApplication.TryGetValue(application.Id, out var credentials))
        {
            credentials = await _applications.ResolveCredentialsAsync(application, ct);
            credentialsByApplication[application.Id] = credentials;
        }
        // Both of these were a query per execution; now one per data set and one per
        // application, for the whole run.
        var dataFields = EmptyDataFields;
        if (testCase.TestDataSetId is { } dataSetId
            && !dataFieldsBySet.TryGetValue(dataSetId, out dataFields!))
        {
            dataFields = await _db.TestDataFields
                .Where(f => f.TestDataSetId == dataSetId)
                .ToListAsync(ct);
            dataFieldsBySet[dataSetId] = dataFields;
        }

        ElementFingerprintIndex? fingerprintIndex = null;
        if (testCase.ApplicationId is { } fingerprintApplicationId
            && !fingerprintsByApplication.TryGetValue(fingerprintApplicationId, out fingerprintIndex))
        {
            fingerprintIndex = await LoadElementFingerprintIndexAsync(fingerprintApplicationId, ct);
            fingerprintsByApplication[fingerprintApplicationId] = fingerprintIndex;
        }

        var secrets = ResolveSecrets(environment, credentials, dataFields);
        var data = ResolveData(dataFields);
        var fingerprints = ResolveFingerprints(steps, fingerprintIndex);

        return Result<ExecutionJobPayload>.Success(new ExecutionJobPayload
        {
            JobId = execution.Id.ToString(),
            ExecutionId = execution.Id,
            OrganizationId = run.OrganizationId,
            ProjectId = project.Id,
            TestRunId = run.Id,
            TestCaseId = testCase.Id,
            TestCaseName = testCase.Name,
            TestCaseVersion = testCase.Version,
            TestCaseKind = ToCamel(testCase.Kind.ToString()),
            Attempt = execution.Attempt,
            Browser = run.Browser.ToString().ToLowerInvariant(),
            Headless = run.Headless,
            BaseUrl = baseUrl,
            ApiBaseUrl = apiBaseUrl,
            Auth = new AuthConfigPayload
            {
                Strategy = application.AuthStrategy,
                LoginUrl = application.LoginUrl,
                Username = credentials.Username,
                Password = credentials.Password,
                BearerToken = credentials.BearerToken,
                StorageStateJson = credentials.StorageStateJson,
                OtpMode = credentials.OtpMode,
                OtpValue = credentials.OtpValue,
                SuccessUrlContains = ReadLoginFlowHint(application.LoginFlowJson, "successUrlContains"),
                UsernameLocator = LoginFlowHints.CssLocator(application.LoginFlowJson, "usernameSelector"),
                PasswordLocator = LoginFlowHints.CssLocator(application.LoginFlowJson, "passwordSelector"),
                SubmitLocator = LoginFlowHints.CssLocator(application.LoginFlowJson, "submitSelector"),
                TokenEndpoint = LoginFlowHints.Read(application.LoginFlowJson, "tokenEndpoint"),
                TokenField = LoginFlowHints.Read(application.LoginFlowJson, "tokenField"),
                TokenUsernameField = LoginFlowHints.Read(application.LoginFlowJson, "usernameField"),
                TokenPasswordField = LoginFlowHints.Read(application.LoginFlowJson, "passwordField"),
                TokenHeader = LoginFlowHints.Read(application.LoginFlowJson, "tokenHeader"),
                TokenPrefix = LoginFlowHints.Read(application.LoginFlowJson, "tokenPrefix")
            },
            Steps = steps.Select(step => new ExecutionStepPayload
            {
                TestStepId = step.Id,
                Order = step.Order,
                Action = new BrowserAction
                {
                    Action = step.Action,
                    Description = step.Description,
                    Target = LocatorDescriptor.FromJson(step.TargetJson),
                    Value = step.Value,
                    Url = step.Url,
                    TimeoutMs = step.TimeoutMs,
                    Critical = step.IsCritical,
                    ApiRequest = ApiRequestValidator.Deserialize(step.ApiRequestJson),
                    // A step has no expected-value column of its own: the expectation lives
                    // on its assertion. The engine evaluates an assertion-typed action as
                    // well as the planned assertions, so without this the action is judged
                    // against an empty string — assertValue always failed and assertText
                    // and assertUrl passed whatever the page said (BUG-0010).
                    Expected = step.Assertions
                        .OrderBy(a => a.CreatedAt)
                        .Select(a => a.ExpectedValue)
                        .FirstOrDefault(value => !string.IsNullOrEmpty(value)),
                    // The same reasoning as Expected, for the two assertions that need more
                    // than a value. Without these the engine ran assertAttribute with no
                    // attribute name and assertCount with no count, so neither could ever
                    // hold — which is half of why they were unreachable (BUG-0017).
                    Attribute = step.Assertions
                        .OrderBy(a => a.CreatedAt)
                        .Select(a => a.AttributeName)
                        .FirstOrDefault(value => !string.IsNullOrEmpty(value)),
                    Count = step.Assertions
                        .OrderBy(a => a.CreatedAt)
                        .Select(a => int.TryParse(a.ExpectedValue, out var parsed) ? parsed : (int?)null)
                        .FirstOrDefault(value => value is not null)
                },
                Fingerprint = fingerprints.GetValueOrDefault(step.Id),
                ContinueOnFailure = step.ContinueOnFailure,
                Assertions = step.Assertions.Select(a => new PlannedAssertionPayload
                {
                    AssertionId = a.Id,
                    Type = ToCamel(a.Type.ToString()),
                    Target = LocatorDescriptor.FromJson(a.TargetJson),
                    Expected = a.ExpectedValue,
                    Attribute = a.AttributeName,
                    Negate = a.Negate,
                    IsSoft = a.IsSoft,
                    Description = a.Description
                }).ToList()
            }).ToList(),
            Data = data,
            Secrets = secrets,
            Capture = new CaptureSettingsPayload
            {
                Video = project.CaptureVideo,
                Trace = project.CaptureTrace,
                Har = project.CaptureHar,
                ScreenshotOnEveryAction = false,
                DomSnapshotOnFailure = true,
                RetainHeavyArtifactsOnPass = project.RetainHeavyArtifactsOnPass
            },
            Healing = new HealingSettingsPayload
            {
                Policy = ToCamel(project.HealingPolicy.ToString()),
                ConfidenceThreshold = project.HealingConfidenceThreshold
            },
            AllowScriptExecution = project.AllowScriptExecution,
            // Production refuses writes unless the environment says otherwise, and an
            // environment with no record at all is treated as the safer case.
            AllowMutatingApiRequests = environment is null || !environment.IsProduction || environment.AllowDestructiveTests,
            AllowedHosts = allowlist.ToArray(),
            AllowPrivateNetworks = _targetPolicy.AllowPrivateNetworks,
            DefaultTimeoutMs = project.DefaultActionTimeoutMs,
            // A head start, not the credential this job will necessarily use. Queue time is
            // the suite's size over the fleet's size, and neither is known here: run
            // accddf2b queued 5,887 executions, the fleet managed about forty a minute, and
            // the 1,116 still waiting when this token expired could never report at all.
            // A worker whose token has expired by the time it starts exchanges the fleet
            // secret for a fresh one (WorkerTokenController), so this lifetime only decides
            // how often that exchange happens, never whether the work can finish.
            CallbackToken = _tokens.IssueWorkerToken(run.OrganizationId, execution.Id, "execution", TimeSpan.FromHours(2)),
            CallbackBaseUrl = _urls.ApiBaseUrl,
            CorrelationId = _correlation.CorrelationId
        });
    }

    /// <summary>Resolves the secrets a test may reference. The application's own credentials
    /// are always available under well-known names so a generated test can sign in without
    /// any additional configuration.</summary>
    private Dictionary<string, string> ResolveSecrets(
        Domain.Projects.Environment? environment, ApplicationCredentials credentials,
        IReadOnlyList<TestDataField> dataFields)
    {
        var secrets = new Dictionary<string, string>(StringComparer.Ordinal);

        if (!string.IsNullOrEmpty(credentials.Username)) secrets["app_username"] = credentials.Username;
        if (!string.IsNullOrEmpty(credentials.Password)) secrets["app_password"] = credentials.Password;

        if (environment?.EncryptedSecretsJson is { Length: > 0 } encrypted
            && _protector.TryUnprotect(encrypted, out var json))
        {
            try
            {
                var values = JsonSerializer.Deserialize<Dictionary<string, string>>(json, JsonDefaults.Options);
                if (values is not null)
                {
                    foreach (var (key, value) in values) secrets[key] = value;
                }
            }
            catch (JsonException ex)
            {
                _logger.LogError(ex, "Environment {EnvironmentId} has malformed secret storage", environment.Id);
            }
        }

        foreach (var field in dataFields)
        {
            if (field.Kind != TestDataKind.SecretReference) continue;

            // A secret reference names a secret; it does not contain one.
            var referenced = ExtractSecretName(field.Value);
            if (referenced is not null && secrets.TryGetValue(referenced, out var resolved))
                secrets[field.Key] = resolved;
        }

        return secrets;
    }

    private static Dictionary<string, string> ResolveData(IReadOnlyList<TestDataField> dataFields)
    {
        var data = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var field in dataFields)
        {
            if (field.Kind == TestDataKind.SecretReference) continue;    // handled as a secret
            data[field.Key] = field.Kind switch
            {
                TestDataKind.Generated or TestDataKind.Random or TestDataKind.SeededRandom
                    => TestDataGenerator.Generate(field.Key, field.GeneratorJson, field.Seed),
                _ => field.Value ?? string.Empty
            };
        }

        return data;
    }

    /// <summary>Loads one application's discovered element model and indexes it by the ways a
    /// step's locator can name a control. Called once per application in a run.
    ///
    /// It used to be called once per execution, and each call read the whole model — every
    /// element of every page of the application. The query alone measured 19.8ms against 8,599
    /// rows on the freight target, so starting its 7,602-test suite spent about 150 seconds
    /// re-reading the same table.</summary>
    private async Task<ElementFingerprintIndex> LoadElementFingerprintIndexAsync(Guid applicationId, CancellationToken ct)
    {
        var pageIds = await _db.ApplicationPages
            .Where(p => p.ApplicationId == applicationId)
            .Select(p => p.Id)
            .ToListAsync(ct);

        var elements = await _db.ApplicationElements
            .Where(e => pageIds.Contains(e.ApplicationPageId))
            // Ordered so that "the first element matching this locator" means the same thing on
            // every run. Unordered, which control a fingerprint described when two shared a
            // name was left to whatever order the database happened to return.
            .OrderBy(e => e.ApplicationPageId).ThenBy(e => e.Id)
            .Select(e => new
            {
                e.TestId, e.AriaRole, e.AccessibleName, e.Label, e.Placeholder, e.TagName, e.Text,
                e.ElementId, e.Name, e.Type, e.DomPath, e.ParentSignature, e.NeighbourText,
                e.BoundingX, e.BoundingY, e.BoundingWidth, e.BoundingHeight
            })
            .ToListAsync(ct);

        var index = new ElementFingerprintIndex();
        foreach (var e in elements)
        {
            index.Add(e.TestId, e.AriaRole, e.AccessibleName, e.Label, e.Placeholder, e.Text,
                new ElementFingerprintPayload
                {
                    TagName = e.TagName,
                    AriaRole = e.AriaRole,
                    AccessibleName = e.AccessibleName,
                    Text = e.Text,
                    Label = e.Label,
                    Placeholder = e.Placeholder,
                    TestId = e.TestId,
                    ElementId = e.ElementId,
                    Name = e.Name,
                    Type = e.Type,
                    DomPath = e.DomPath,
                    ParentSignature = e.ParentSignature,
                    NeighbourText = e.NeighbourText,
                    Bounding = new BoundingPayload(e.BoundingX, e.BoundingY, e.BoundingWidth, e.BoundingHeight)
                });
        }

        return index;
    }

    /// <summary>Attaches what each step's target looked like when it was authored, taken
    /// from the discovered element model. Without this a healer can only compare against
    /// the broken locator; with it, a renamed control is still recognisable.</summary>
    private static Dictionary<Guid, ElementFingerprintPayload> ResolveFingerprints(
        IReadOnlyList<TestStep> steps, ElementFingerprintIndex? index)
    {
        var result = new Dictionary<Guid, ElementFingerprintPayload>();

        // No application means no discovered model to match against.
        if (index is null) return result;

        foreach (var step in steps)
        {
            if (step.TargetJson is null) continue;

            var locator = LocatorDescriptor.FromJson(step.TargetJson);
            if (locator is null) continue;

            var match = index.Match(locator);
            if (match is null) continue;

            result[step.Id] = match;
        }

        return result;
    }

    private static string? ExtractSecretName(string? value)
    {
        if (value is null) return null;
        const string prefix = "${secret:";
        if (!value.StartsWith(prefix, StringComparison.Ordinal) || !value.EndsWith('}')) return null;
        return value[prefix.Length..^1];
    }

    private static string? ReadLoginFlowHint(string? loginFlowJson, string property)
    {
        if (string.IsNullOrWhiteSpace(loginFlowJson)) return null;
        try
        {
            using var document = JsonDocument.Parse(loginFlowJson!);
            return document.RootElement.TryGetProperty(property, out var value) ? value.GetString() : null;
        }
        catch (JsonException) { return null; }
    }

    private static string ToCamel(string value) => char.ToLowerInvariant(value[0]) + value[1..];

    private static TestRunSummary Map(TestRun r, Domain.Projects.Environment? environment = null) => new(
        r.Id, r.ProjectId, r.Name, r.Status, r.Trigger, r.Browser, r.CreatedAt, r.StartedAt, r.CompletedAt,
        r.DurationMs, r.TotalCount, r.PassedCount, r.FailedCount, r.SkippedCount, r.BlockedCount,
        r.HealedCount, r.FlakyCount, r.QualityGatePassed, r.CiBuildId, r.CiBranch,
        r.CiProvider, r.CiCommitSha, r.ApplicationBuildRef, r.EnvironmentId,
        environment?.Key, environment?.Name,
        r.ContractCheckedAt, r.ContractBreakingChangeCount, r.ContractPotentiallyBreakingChangeCount, r.SecurityScanId);
}
