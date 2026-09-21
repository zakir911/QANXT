using System.Text.Json;
using Aira.Application.Abstractions;
using Aira.Application.Applications;
using Aira.Application.Contracts;
using Aira.Application.Discovery;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Aira.Domain.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Testing;

public sealed record StartTestRunRequest(
    Guid ProjectId, Guid? TestSuiteId, Guid[]? TestCaseIds, Guid? EnvironmentId,
    BrowserType? Browser, bool? Headless, int? Parallelism, int? MaxRetries,
    string? Name, RunTrigger? Trigger, CiContext? Ci);

public sealed record CiContext(string? Provider, string? BuildId, string? CommitSha, string? Branch, string? ApplicationBuildRef);

public sealed record TestRunSummary(
    Guid Id, Guid ProjectId, string Name, ExecutionStatus Status, RunTrigger Trigger, BrowserType Browser,
    DateTimeOffset CreatedAt, DateTimeOffset? StartedAt, DateTimeOffset? CompletedAt, int DurationMs,
    int TotalCount, int PassedCount, int FailedCount, int SkippedCount, int BlockedCount,
    int HealedCount, int FlakyCount, bool? QualityGatePassed, string? CiBuildId, string? CiBranch);

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
    private readonly IAiraDbContext _db;
    private readonly IJobQueue _queue;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly ITokenService _tokens;
    private readonly IApplicationService _applications;
    private readonly ISecretProtector _protector;
    private readonly ITargetPolicy _targetPolicy;
    private readonly ICorrelationContext _correlation;
    private readonly IPlatformUrls _urls;
    private readonly IAuditLogger _audit;
    private readonly IExecutionEventPublisher _events;
    private readonly ILogger<TestRunService> _logger;

    public TestRunService(IAiraDbContext db, IJobQueue queue, ICurrentUser currentUser, IClock clock,
        ITokenService tokens, IApplicationService applications, ISecretProtector protector,
        ITargetPolicy targetPolicy, ICorrelationContext correlation, IPlatformUrls urls,
        IAuditLogger audit, IExecutionEventPublisher events, ILogger<TestRunService> logger)
    {
        _db = db;
        _queue = queue;
        _currentUser = currentUser;
        _clock = clock;
        _tokens = tokens;
        _applications = applications;
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
            CreatedAt = _clock.UtcNow
        }).ToList();

        _db.TestExecutions.AddRange(executions);
        await _db.SaveChangesAsync(ct);

        var dispatched = 0;
        var dispatchErrors = new List<string>();

        foreach (var execution in executions)
        {
            var testCase = cases.First(c => c.Id == execution.TestCaseId);
            var payload = await BuildPayloadAsync(run, execution, testCase, project, environment, ct);

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
                await _queue.EnqueueAsync(QueueNames.Execution, "execution", payload.Value!, ct);
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
        if (dispatched == 0)
        {
            run.Status = ExecutionStatus.Error;
            run.CompletedAt = _clock.UtcNow;
        }

        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.TestRunStarted, nameof(TestRun), run.Id,
            $"Run '{run.Name}' started with {dispatched} of {cases.Count} execution(s) queued.",
            projectId: project.Id, ct: ct);

        await _events.PublishAsync(run.OrganizationId, new ExecutionEvent(
            ExecutionEventTypes.RunQueued, run.Id, null,
            new { run.Name, total = cases.Count, dispatched, errors = dispatchErrors }, _clock.UtcNow), ct);

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
                r.HealedCount, r.FlakyCount, r.QualityGatePassed, r.CiBuildId, r.CiBranch))
            .ToListAsync(ct);
    }

    public async Task<Result<TestRunSummary>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var run = await _db.TestRuns.FirstOrDefaultAsync(r => r.Id == id, ct);
        return run is null ? Error.NotFound("The test run") : Result<TestRunSummary>.Success(Map(run));
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
        Domain.Projects.Environment? environment, CancellationToken ct)
    {
        var application = testCase.ApplicationId is null
            ? await _db.Applications.FirstOrDefaultAsync(a => a.ProjectId == project.Id, ct)
            : await _db.Applications.FirstOrDefaultAsync(a => a.Id == testCase.ApplicationId, ct);

        if (application is null)
            return Error.Validation($"{testCase.Reference} has no application to run against.");

        var baseUrl = environment?.BaseUrl ?? application.BaseUrl;
        var allowlist = ApplicationService.ParseAllowlist(application.AllowedDomains, baseUrl);
        if (!_targetPolicy.IsAllowed(baseUrl, allowlist, out var reason))
            return Error.Validation($"{testCase.Reference} cannot run: {reason}");

        var steps = await _db.TestSteps
            .Where(s => s.TestCaseId == testCase.Id)
            .OrderBy(s => s.Order)
            .Include(s => s.Assertions)
            .ToListAsync(ct);

        if (steps.Count == 0)
            return Error.Validation($"{testCase.Reference} has no steps.");

        var credentials = await _applications.ResolveCredentialsAsync(application, ct);
        var secrets = await ResolveSecretsAsync(testCase, environment, credentials, ct);
        var data = await ResolveDataAsync(testCase, ct);
        var fingerprints = await LoadFingerprintsAsync(testCase, ct);

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
            Attempt = execution.Attempt,
            Browser = run.Browser.ToString().ToLowerInvariant(),
            Headless = run.Headless,
            BaseUrl = baseUrl,
            Auth = new AuthConfigPayload
            {
                Strategy = application.AuthStrategy,
                LoginUrl = application.LoginUrl,
                Username = credentials.Username,
                Password = credentials.Password,
                BearerToken = credentials.BearerToken,
                StorageStateJson = credentials.StorageStateJson,
                SuccessUrlContains = ReadLoginFlowHint(application.LoginFlowJson, "successUrlContains")
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
                    // A step has no expected-value column of its own: the expectation lives
                    // on its assertion. The engine evaluates an assertion-typed action as
                    // well as the planned assertions, so without this the action is judged
                    // against an empty string — assertValue always failed and assertText
                    // and assertUrl passed whatever the page said (BUG-0010).
                    Expected = step.Assertions
                        .OrderBy(a => a.CreatedAt)
                        .Select(a => a.ExpectedValue)
                        .FirstOrDefault(value => !string.IsNullOrEmpty(value))
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
                DomSnapshotOnFailure = true
            },
            Healing = new HealingSettingsPayload
            {
                Policy = ToCamel(project.HealingPolicy.ToString()),
                ConfidenceThreshold = project.HealingConfidenceThreshold
            },
            AllowScriptExecution = project.AllowScriptExecution,
            AllowedHosts = allowlist.ToArray(),
            AllowPrivateNetworks = _targetPolicy.AllowPrivateNetworks,
            DefaultTimeoutMs = project.DefaultActionTimeoutMs,
            CallbackToken = _tokens.IssueWorkerToken(run.OrganizationId, execution.Id, "execution", TimeSpan.FromHours(2)),
            CallbackBaseUrl = _urls.ApiBaseUrl,
            CorrelationId = _correlation.CorrelationId
        });
    }

    /// <summary>Resolves the secrets a test may reference. The application's own credentials
    /// are always available under well-known names so a generated test can sign in without
    /// any additional configuration.</summary>
    private async Task<Dictionary<string, string>> ResolveSecretsAsync(
        TestCase testCase, Domain.Projects.Environment? environment, ApplicationCredentials credentials, CancellationToken ct)
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

        if (testCase.TestDataSetId is not null)
        {
            var sensitive = await _db.TestDataFields
                .Where(f => f.TestDataSetId == testCase.TestDataSetId && f.Kind == TestDataKind.SecretReference)
                .ToListAsync(ct);

            foreach (var field in sensitive)
            {
                // A secret reference names a secret; it does not contain one.
                var referenced = ExtractSecretName(field.Value);
                if (referenced is not null && secrets.TryGetValue(referenced, out var resolved))
                    secrets[field.Key] = resolved;
            }
        }

        return secrets;
    }

    private async Task<Dictionary<string, string>> ResolveDataAsync(TestCase testCase, CancellationToken ct)
    {
        if (testCase.TestDataSetId is null) return new Dictionary<string, string>();

        var fields = await _db.TestDataFields
            .Where(f => f.TestDataSetId == testCase.TestDataSetId)
            .ToListAsync(ct);

        var data = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var field in fields)
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

    /// <summary>Attaches what each step's target looked like when it was authored, taken
    /// from the discovered element model. Without this a healer can only compare against
    /// the broken locator; with it, a renamed control is still recognisable.</summary>
    private async Task<Dictionary<Guid, ElementFingerprintPayload>> LoadFingerprintsAsync(TestCase testCase, CancellationToken ct)
    {
        if (testCase.ApplicationId is null) return new Dictionary<Guid, ElementFingerprintPayload>();

        var steps = await _db.TestSteps
            .Where(s => s.TestCaseId == testCase.Id && s.TargetJson != null)
            .Select(s => new { s.Id, s.TargetJson })
            .ToListAsync(ct);

        var pageIds = await _db.ApplicationPages
            .Where(p => p.ApplicationId == testCase.ApplicationId)
            .Select(p => p.Id)
            .ToListAsync(ct);

        var elements = await _db.ApplicationElements
            .Where(e => pageIds.Contains(e.ApplicationPageId))
            .Select(e => new
            {
                e.TestId, e.AriaRole, e.AccessibleName, e.Label, e.Placeholder, e.TagName, e.Text,
                e.ElementId, e.Name, e.Type, e.DomPath, e.ParentSignature, e.NeighbourText,
                e.BoundingX, e.BoundingY, e.BoundingWidth, e.BoundingHeight
            })
            .ToListAsync(ct);

        var result = new Dictionary<Guid, ElementFingerprintPayload>();

        foreach (var step in steps)
        {
            var locator = LocatorDescriptor.FromJson(step.TargetJson);
            if (locator is null) continue;

            var match = locator.Strategy switch
            {
                LocatorStrategy.TestId => elements.FirstOrDefault(e => e.TestId == locator.Value),
                LocatorStrategy.Role => elements.FirstOrDefault(e =>
                    e.AriaRole == locator.Value &&
                    (locator.Name == null || e.AccessibleName == locator.Name)),
                LocatorStrategy.Label => elements.FirstOrDefault(e => e.Label == locator.Value),
                LocatorStrategy.Placeholder => elements.FirstOrDefault(e => e.Placeholder == locator.Value),
                LocatorStrategy.Text => elements.FirstOrDefault(e => e.Text == locator.Value),
                _ => null
            };

            if (match is null) continue;

            result[step.Id] = new ElementFingerprintPayload
            {
                TagName = match.TagName,
                AriaRole = match.AriaRole,
                AccessibleName = match.AccessibleName,
                Text = match.Text,
                Label = match.Label,
                Placeholder = match.Placeholder,
                TestId = match.TestId,
                ElementId = match.ElementId,
                Name = match.Name,
                Type = match.Type,
                DomPath = match.DomPath,
                ParentSignature = match.ParentSignature,
                NeighbourText = match.NeighbourText,
                Bounding = new BoundingPayload(match.BoundingX, match.BoundingY, match.BoundingWidth, match.BoundingHeight)
            };
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

    private static TestRunSummary Map(TestRun r) => new(
        r.Id, r.ProjectId, r.Name, r.Status, r.Trigger, r.Browser, r.CreatedAt, r.StartedAt, r.CompletedAt,
        r.DurationMs, r.TotalCount, r.PassedCount, r.FailedCount, r.SkippedCount, r.BlockedCount,
        r.HealedCount, r.FlakyCount, r.QualityGatePassed, r.CiBuildId, r.CiBranch);
}
