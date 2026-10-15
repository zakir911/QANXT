using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using QaNxt.Application.Forms;
using QaNxt.Application.Notifications;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Diagnosis;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Evidence;
using QaNxt.Domain.Testing;

namespace QaNxt.Application.Reporting;

public interface IRunBugReportService
{
    Task<Result<RunBugReport>> BuildAsync(Guid runId, CancellationToken ct = default);

    /// <summary>The report as a file: <c>html</c> (one self-contained page, screenshots
    /// embedded), <c>zip</c> (that page, a Markdown copy, JSON and every evidence file) or
    /// <c>json</c>.</summary>
    Task<Result<ReportFile>> ExportAsync(Guid runId, string format, CancellationToken ct = default);
}

/// <summary>Assembles <see cref="RunBugReport"/> from what a run stored. Nothing is inferred
/// that the run did not observe: steps are the actions that ran, values are the values
/// typed, requests are the requests recorded, and the "where to look" note says plainly that
/// it is a starting point drawn from the symptom, not a diagnosis of the code.</summary>
public sealed class RunBugReportService : IRunBugReportService
{
    private const int MaxExchangesPerBug = 10;
    private const int MaxConsoleLinesPerBug = 20;
    private const int MaxExtraScreenshotsPerBug = 5;

    private static readonly FailureCategory[] NotProduct =
    {
        FailureCategory.LocatorChange, FailureCategory.TestDefect, FailureCategory.EnvironmentDefect,
        FailureCategory.NetworkIssue, FailureCategory.AuthenticationIssue, FailureCategory.ThirdPartyDependency
    };

    private static readonly ExecutionStatus[] FailedStatuses =
        { ExecutionStatus.Failed, ExecutionStatus.Error, ExecutionStatus.TimedOut };

    private readonly IQaNxtDbContext _db;
    private readonly IArtifactStore _store;
    private readonly IClock _clock;
    private readonly string? _consoleUrl;

    public RunBugReportService(IQaNxtDbContext db, IArtifactStore store, IClock clock, NotificationOptions? options = null)
    {
        _db = db;
        _store = store;
        _clock = clock;
        _consoleUrl = options?.ConsoleBaseUrl?.TrimEnd('/');
    }

    public async Task<Result<ReportFile>> ExportAsync(Guid runId, string format, CancellationToken ct = default)
    {
        format = (format ?? "html").Trim().ToLowerInvariant();
        if (format is not ("html" or "zip" or "json"))
            return Error.Validation("The report format must be html, zip or json.");

        var built = await BuildAsync(runId, ct);
        if (!built.IsSuccess) return built.Error!;
        var report = built.Value!;
        var baseName = $"qanxt-bug-report-{Slug(report.Run.Name)}-{(report.Run.StartedAt ?? report.GeneratedAt):yyyyMMdd-HHmm}";

        switch (format)
        {
            case "json":
                return Result<ReportFile>.Success(new ReportFile($"{baseName}.json", "application/json",
                    JsonSerializer.SerializeToUtf8Bytes(report, RunBugReportRenderer.Json)));
            case "zip":
                return Result<ReportFile>.Success(new ReportFile($"{baseName}.zip", "application/zip",
                    await RunBugReportRenderer.ZipAsync(report, ReadArtifactAsync, ct)));
            default:
                var html = await RunBugReportRenderer.HtmlAsync(report, ReadArtifactAsync, ct);
                return Result<ReportFile>.Success(new ReportFile($"{baseName}.html", "text/html; charset=utf-8", System.Text.Encoding.UTF8.GetBytes(html)));
        }
    }

    private async Task<byte[]?> ReadArtifactAsync(ReportArtifact artifact, CancellationToken ct)
    {
        await using var stream = await _store.GetAsync(artifact.StorageKey, ct);
        if (stream is null) return null;
        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer, ct);
        return buffer.ToArray();
    }

    public async Task<Result<RunBugReport>> BuildAsync(Guid runId, CancellationToken ct = default)
    {
        var run = await _db.TestRuns.FirstOrDefaultAsync(r => r.Id == runId, ct);
        if (run is null) return Error.NotFound("The test run");

        var project = await _db.Projects.Where(p => p.Id == run.ProjectId).Select(p => p.Name).FirstOrDefaultAsync(ct) ?? "(project)";
        var environment = run.EnvironmentId is null ? null
            : await _db.Environments.Where(e => e.Id == run.EnvironmentId).Select(e => new { e.Name, e.BaseUrl }).FirstOrDefaultAsync(ct);

        // Every attempt, so a test that failed and then passed on retry is reported as such;
        // the verdict is the latest attempt's.
        var attempts = await _db.TestExecutions.Include(e => e.TestCase)
            .Where(e => e.TestRunId == runId).ToListAsync(ct);
        var latest = attempts.GroupBy(e => e.TestCaseId)
            .Select(g => g.OrderByDescending(e => e.Attempt).ThenByDescending(e => e.CreatedAt).First()).ToList();

        var applicationIds = latest.Select(e => e.TestCase?.ApplicationId).Where(id => id is not null).Select(id => id!.Value).Distinct().ToList();
        var applications = await _db.Applications.Where(a => applicationIds.Contains(a.Id))
            .Select(a => new { a.Id, a.Name, a.BaseUrl }).ToListAsync(ct);
        var applicationName = applications.ToDictionary(a => a.Id, a => a.Name);

        var failedExecutions = latest.Where(e => FailedStatuses.Contains(e.Status)).ToList();
        var failedIds = failedExecutions.Select(e => e.Id).ToList();
        var failures = await _db.Failures.Where(f => failedIds.Contains(f.TestExecutionId)).ToListAsync(ct);
        var failureByExecution = failures.GroupBy(f => f.TestExecutionId).ToDictionary(g => g.Key, g => g.OrderBy(f => f.CreatedAt).First());

        var defectIds = failures.Where(f => f.DefectId is not null).Select(f => f.DefectId!.Value).Distinct().ToList();
        var defects = await _db.Defects.Where(d => defectIds.Contains(d.Id)).ToDictionaryAsync(d => d.Id, ct);
        var defectOrder = await _db.Defects.Where(d => d.ProjectId == run.ProjectId).OrderBy(d => d.CreatedAt).Select(d => d.Id).ToListAsync(ct);
        var regressionIds = defects.Values.Where(d => d.RegressionTestCaseId is not null).Select(d => d.RegressionTestCaseId!.Value).ToList();
        var regressionRefs = await _db.TestCases.Where(tc => regressionIds.Contains(tc.Id)).ToDictionaryAsync(tc => tc.Id, tc => tc.Reference, ct);

        var formIds = failedExecutions.Select(e => e.TestCase?.ApplicationFormId).Where(id => id is not null).Select(id => id!.Value).Distinct().ToList();
        var forms = await _db.ApplicationForms.Where(f => formIds.Contains(f.Id)).ToDictionaryAsync(f => f.Id, ct);

        var actions = (await _db.TestActions.Where(a => failedIds.Contains(a.TestExecutionId)).ToListAsync(ct))
            .GroupBy(a => a.TestExecutionId).ToDictionary(g => g.Key, g => g.OrderBy(a => a.Order).ToList());
        var artifacts = (await _db.Artifacts.Where(a => a.TestExecutionId != null && failedIds.Contains(a.TestExecutionId.Value)).ToListAsync(ct))
            .GroupBy(a => a.TestExecutionId!.Value).ToDictionary(g => g.Key, g => g.ToList());
        var testCaseIds = failedExecutions.Select(e => e.TestCaseId).ToList();
        var steps = (await _db.TestSteps.Where(s => testCaseIds.Contains(s.TestCaseId)).ToListAsync(ct))
            .GroupBy(s => s.TestCaseId).ToDictionary(g => g.Key, g => g.OrderBy(s => s.Order).ToList());

        // Group: a failure attached to a live defect is a bug; the rest is somebody else's work.
        var bugGroups = new List<List<TestExecution>>();
        var others = new List<ReportOtherFailure>();
        foreach (var group in failedExecutions.GroupBy(e => failureByExecution.TryGetValue(e.Id, out var f) && f.DefectId is { } d
                     && defects.TryGetValue(d, out var defect) && defect.Status is not (DefectStatus.Rejected or DefectStatus.Duplicate) ? d : (Guid?)null))
        {
            if (group.Key is not null) { bugGroups.Add(group.ToList()); continue; }
            foreach (var execution in group)
            {
                var failure = failureByExecution.GetValueOrDefault(execution.Id);
                var rejected = failure?.DefectId is { } d && defects.TryGetValue(d, out var defect)
                    && defect.Status is DefectStatus.Rejected or DefectStatus.Duplicate;
                if (!rejected && failure is not null && !NotProduct.Contains(failure.Category) && IsProductSymptom(failure, actions.GetValueOrDefault(execution.Id)))
                {
                    // A product failure that was never correlated (the correlation runs on
                    // ingest; an older run predates it). It is still the developer's.
                    bugGroups.Add(new List<TestExecution> { execution });
                    continue;
                }
                others.Add(new ReportOtherFailure(
                    execution.TestCase?.Reference ?? "(test)", execution.TestCase?.Name ?? "(deleted test)",
                    rejected ? "Rejected as a product defect" : Classification(failure?.Category),
                    Masked(failure?.RawMessage ?? execution.ErrorMessage ?? "The test failed without a message."),
                    rejected ? "Nobody — a person reviewed this and decided it is not a defect." : WhoActs(failure?.Category),
                    execution.Id));
            }
        }

        // Network and console only for the execution each bug is shown with: they are the
        // evidence, and loading them for every failing test would make a big run slow.
        var representatives = bugGroups.Select(g => Representative(g)).ToList();
        var repIds = representatives.Select(e => e.Id).ToList();
        var network = (await _db.NetworkEvents.Where(n => n.TestExecutionId != null && repIds.Contains(n.TestExecutionId.Value)).ToListAsync(ct))
            .GroupBy(n => n.TestExecutionId!.Value).ToDictionary(g => g.Key, g => g.OrderBy(n => n.OccurredAt).ToList());
        var consoleEvents = (await _db.ConsoleEvents.Where(c => c.TestExecutionId != null && repIds.Contains(c.TestExecutionId.Value)).ToListAsync(ct))
            .GroupBy(c => c.TestExecutionId!.Value).ToDictionary(g => g.Key, g => g.OrderBy(c => c.OccurredAt).ToList());

        var bugs = new List<(ReportBug Bug, int SeverityRank, int Affected)>();
        foreach (var group in bugGroups)
        {
            var execution = Representative(group);
            var testCase = execution.TestCase!;
            var failure = failureByExecution.GetValueOrDefault(execution.Id);
            var defect = failure?.DefectId is { } id ? defects.GetValueOrDefault(id) : null;
            var executionActions = actions.GetValueOrDefault(execution.Id) ?? new List<TestAction>();
            var failing = failure?.TestActionId is { } fa ? executionActions.FirstOrDefault(a => a.Id == fa)
                : executionActions.FirstOrDefault(a => a.Status == ExecutionStatus.Failed);
            var form = testCase.ApplicationFormId is { } formId ? forms.GetValueOrDefault(formId) : null;
            // Requests the test itself caused. The sign-in before the first step, and anything
            // else with no step of its own, is setup: it is not this bug's evidence, unless the
            // server failed on it.
            var allNetwork = network.GetValueOrDefault(execution.Id) ?? new List<NetworkEvent>();
            var executionNetwork = allNetwork.Any(n => n.TestActionId is not null)
                ? allNetwork.Where(n => n.TestActionId is not null || n.StatusCode >= 500).ToList()
                : allNetwork;
            // Only a bug about what was sent or answered shows requests; a layout or an
            // accessibility finding does not need the login call beside it.
            var aboutRequests = failing?.Action is BrowserActionType.AssertRequests or BrowserActionType.AssertFormAccepted
                    or BrowserActionType.AssertFormRejected or BrowserActionType.AssertNoServerError or BrowserActionType.AssertNoMarkupInjection
                    or BrowserActionType.AssertLoadTimeUnder or BrowserActionType.ApiRequest
                || executionNetwork.Any(n => n.StatusCode >= 500);
            if (!aboutRequests) executionNetwork = executionNetwork.Where(n => n.StatusCode >= 400 || n.IsFailed).ToList();
            var exchanges = Exchanges(executionNetwork);
            var serverError = executionNetwork.FirstOrDefault(n => n.StatusCode >= 500);
            var endpoint = (serverError ?? executionNetwork.FirstOrDefault(n => n.Method != "GET" && n.ResourceType is "xhr" or "fetch" or "document")) is { } e
                ? $"{e.Method} {PathOf(e.Url)}" : null;

            var reportSteps = Steps(executionActions, steps.GetValueOrDefault(testCase.Id), failing);
            var failingStep = reportSteps.FirstOrDefault(s => s.Status == "failed");
            var severity = defect?.Severity ?? SeverityOf(testCase);
            var number = defect is null ? 0 : defectOrder.IndexOf(defect.Id) + 1;
            var affected = group.OrderBy(e2 => e2.TestCase!.Priority).ThenBy(e2 => e2.TestCase!.Reference).Select(e2 =>
            {
                var f = failureByExecution.GetValueOrDefault(e2.Id);
                return new ReportAffectedTest(e2.TestCase!.Reference, e2.TestCase.Name, e2.TestCase.FieldKey, e2.TestCase.Technique,
                    Masked(f?.RawMessage ?? e2.ErrorMessage ?? string.Empty), Data(e2.TestCase.TestDataJson), e2.Id);
            }).ToList();

            var screenshots = Screenshots(artifacts.GetValueOrDefault(execution.Id), failing, testCase.Reference, primary: true);
            foreach (var other in group.Where(o => o.Id != execution.Id).Take(MaxExtraScreenshotsPerBug))
            {
                var otherFailure = failureByExecution.GetValueOrDefault(other.Id);
                var otherFailing = otherFailure?.TestActionId is { } ofa ? actions.GetValueOrDefault(other.Id)?.FirstOrDefault(a => a.Id == ofa) : null;
                screenshots.AddRange(Screenshots(artifacts.GetValueOrDefault(other.Id), otherFailing, other.TestCase!.Reference, primary: false)
                    .Where(s => screenshots.All(existing => existing.StorageKey != s.StorageKey)).Take(1));
            }

            // The page's text only when it carries the error: a server's error page, an
            // internal-detail leak, a refusal message. Otherwise it is a dump of whatever the
            // page showed — on an admin page, other people's data.
            var showsError = executionNetwork.Any(n => n.StatusCode >= 500)
                || failing?.Action is BrowserActionType.AssertNoServerError or BrowserActionType.AssertFormAccepted;
            var pageText = showsError ? await PageTextAsync(artifacts.GetValueOrDefault(execution.Id), failing, ct) : null;
            var actual = Masked(failure?.RawMessage ?? failing?.ErrorMessage ?? execution.ErrorMessage ?? "The test failed.");
            var category = testCase.Category is { } c ? TestingTaxonomy.All.FirstOrDefault(t => t.Category == c)?.Name : null;
            var title = defect?.Title ?? $"{(form is null ? string.Empty : form.Name + ": ")}{FirstSentence(actual)}";
            var refs = string.Join(", ", affected.Select(a => a.Reference));
            var regression = defect?.RegressionTestCaseId is { } rid ? regressionRefs.GetValueOrDefault(rid) : null;

            var bug = new ReportBug(
                Key: string.Empty,
                DefectId: defect?.Id, DefectReference: defect is null ? null : $"DEF-{number:0000}", DefectStatus: defect?.Status.ToString(),
                Title: title, Severity: severity.ToString(), Priority: testCase.Priority.ToString(), Category: category,
                Classification: failure?.Category is null or FailureCategory.Unknown && failing is not null && IsCheck(failing.Action)
                    ? "Application behaviour (a check failed)" : Classification(failure?.Category),
                Confidence: failure?.CategoryConfidence ?? 0,
                Application: testCase.ApplicationId is { } appId ? applicationName.GetValueOrDefault(appId) : null,
                PageUrl: form?.PageUrl ?? failing?.Url ?? executionActions.Select(a => a.Url).FirstOrDefault(u => u is not null),
                Form: form?.Name, Field: testCase.FieldKey, Endpoint: endpoint,
                Browser: execution.Browser.ToString(), BrowserVersion: execution.BrowserVersion, Viewport: ViewportOf(steps.GetValueOrDefault(testCase.Id)),
                FirstSeenAt: defect?.FirstSeenAt ?? failure?.FirstSeenAt, Occurrences: defect?.OccurrenceCount ?? failure?.OccurrenceCount,
                RegressionTest: regression,
                Summary: $"Found by {testCase.Reference} ({testCase.Name})"
                    + (failingStep is null ? "." : $", which fails at step {failingStep.Order}: {failingStep.Description}.")
                    + (affected.Count > 1 ? $" {affected.Count} tests in this run fail the same way ({refs})." : string.Empty),
                Steps: reportSteps,
                TestData: Data(testCase.TestDataJson),
                Expected: string.IsNullOrWhiteSpace(testCase.ExpectedResults) ? defect?.ExpectedBehaviour ?? "(not recorded)" : testCase.ExpectedResults,
                Actual: actual,
                FailingStep: failingStep,
                PageText: pageText,
                WhereToLook: WhereToLook(failing, failure, testCase, form?.Name, serverError, actual),
                Exchanges: exchanges,
                Curl: Curl(serverError ?? executionNetwork.FirstOrDefault(n => n.Method != "GET" && n.ResourceType is "xhr" or "fetch" or "document")
                    ?? executionNetwork.LastOrDefault(n => n.Method == "GET" && n.ResourceType == "document" && n.Url.Contains('?'))),
                Console: (consoleEvents.GetValueOrDefault(execution.Id) ?? new List<ConsoleEvent>())
                    .Where(c => c.Level is "error" or "pageerror" or "warn").Take(MaxConsoleLinesPerBug)
                    .Select(c => new ReportConsoleLine(c.Level, Masked(c.Message), c.Url, c.StackTrace is null ? null : Masked(c.StackTrace))).ToList(),
                Accessibility: Accessibility(failing?.AccessibilityJson),
                Screenshots: screenshots,
                Attachments: Attachments(artifacts.GetValueOrDefault(execution.Id), failing),
                AffectedTests: affected,
                VerifyTheFix: $"Re-run {refs} in QA NXT — open this run and choose Run failed, or run {(affected.Count > 1 ? "the tests" : "the test")} on {(affected.Count > 1 ? "their" : "its")} own. "
                    + "Each passes when the fix is in, and fails again with this report's symptom if it is not."
                    + (regression is null ? string.Empty : $" Regression test {regression} guards against it coming back."),
                ExecutionId: execution.Id,
                ExecutionUrl: _consoleUrl is null ? null : $"{_consoleUrl}/executions/{execution.Id}");
            bugs.Add((bug, (int)severity, affected.Count));
        }

        // The security scan run with these tests: its findings are bugs in the same report,
        // tagged with their testing type like every other bug.
        ReportSecurityScan? security = null;
        if (run.SecurityScanId is { } scanId)
        {
            var scan = await _db.SecurityScans.FirstOrDefaultAsync(x => x.Id == scanId, ct);
            if (scan is not null)
            {
                var findings = await (from link in _db.SecurityScanFindings
                                      join f in _db.SecurityFindings on link.SecurityFindingId equals f.Id
                                      where link.SecurityScanId == scanId
                                            && f.Status != Domain.Security.SecurityFindingStatus.FalsePositive
                                            && f.Status != Domain.Security.SecurityFindingStatus.Accepted
                                      select new { f, link.Severity, link.WasNew, link.WasRegression }).ToListAsync(ct);
                var finished = scan.CompletedAt is not null;
                security = new ReportSecurityScan(scan.Reference, scan.Status, scan.Profile.ToString(), scan.TestsExecuted, scan.TestsSkipped,
                    scan.RequestsBlocked, findings.Count,
                    !finished ? "The security scan had not finished when this report was made; download it again once it has to include everything it finds."
                        : scan.ErrorMessage);
                foreach (var item in findings.Where(x => x.Severity != Domain.Security.SecuritySeverity.Informational || x.f.Status == Domain.Security.SecurityFindingStatus.Confirmed))
                    bugs.Add((SecurityBug(item.f, item.Severity, item.WasNew, item.WasRegression, scan), SecurityRank(item.Severity), 1));
            }
        }

        var ordered = bugs.OrderBy(b => b.SeverityRank).ThenByDescending(b => b.Affected).ThenBy(b => b.Bug.Title, StringComparer.Ordinal)
            .Select((b, i) => b.Bug with { Key = $"BUG-{i + 1:00}" }).ToList();

        var flaky = attempts.GroupBy(e => e.TestCaseId)
            .Where(g => g.Count() > 1 && g.OrderByDescending(e => e.Attempt).First().Status is ExecutionStatus.Passed or ExecutionStatus.Flaky or ExecutionStatus.Healed
                && g.Any(e => FailedStatuses.Contains(e.Status)))
            .Select(g => new ReportFlakyTest(g.First().TestCase?.Reference ?? "(test)", g.First().TestCase?.Name ?? "(deleted test)", g.Count(),
                Masked(g.Where(e => FailedStatuses.Contains(e.Status)).OrderBy(e => e.Attempt).First().ErrorMessage ?? "failed")))
            .OrderBy(f => f.Reference).ToList();

        var skipped = latest.Where(e => e.Status is ExecutionStatus.Skipped or ExecutionStatus.Blocked or ExecutionStatus.Cancelled)
            .GroupBy(e => string.IsNullOrWhiteSpace(e.ErrorMessage) ? $"{e.Status} without a recorded reason" : FirstSentence(e.ErrorMessage!))
            .Select(g => new ReportSkipGroup(g.Key, g.Count(), g.Select(e => e.TestCase?.Reference ?? "(test)").OrderBy(r => r).ToList()))
            .OrderByDescending(g => g.Count).ToList();

        var browserVersion = latest.Select(e => e.BrowserVersion).FirstOrDefault(v => !string.IsNullOrEmpty(v));
        var reportRun = new ReportRun(run.Id, run.Name, project, environment?.Name, environment?.BaseUrl,
            applications.Select(a => new ReportApplication(a.Name, a.BaseUrl)).ToList(),
            run.Trigger.ToString(), run.Browser.ToString(), browserVersion, run.StartedAt, run.CompletedAt, run.DurationMs, run.Status.ToString(),
            latest.Count, latest.Count(e => e.Status is ExecutionStatus.Passed or ExecutionStatus.Healed or ExecutionStatus.Flaky),
            failedExecutions.Count, latest.Count(e => e.Status is ExecutionStatus.Skipped or ExecutionStatus.Cancelled),
            latest.Count(e => e.Status == ExecutionStatus.Blocked),
            run.CiCommitSha, run.CiBranch, run.CiBuildId, run.ApplicationBuildRef,
            _consoleUrl is null ? null : $"{_consoleUrl}/runs/{run.Id}");

        // Pass and fail by testing type, from the latest attempt of every test.
        var byType = latest.GroupBy(e => e.TestCase?.Category is { } c ? TestingTaxonomy.All.FirstOrDefault(t => t.Category == c)?.Name ?? c.ToString() : "Recorded and imported tests")
            .Select(g =>
            {
                var passed = g.Count(e => e.Status is ExecutionStatus.Passed or ExecutionStatus.Healed or ExecutionStatus.Flaky);
                var failed = g.Count(e => FailedStatuses.Contains(e.Status));
                var notRun = g.Count(e => e.Status is ExecutionStatus.Skipped or ExecutionStatus.Blocked or ExecutionStatus.Cancelled);
                var bugsOfType = ordered.Count(b => b.Category == g.Key);
                var verdict = failed > 0 ? (bugsOfType > 0 ? "Failed" : "Failed (not product bugs)") : passed == 0 ? "Not run" : g.Count() - passed - notRun > 0 ? "In progress" : "Passed";
                return new ReportTypeResult(g.Key, g.Count(), passed, failed, notRun, bugsOfType, verdict);
            })
            .OrderBy(t => t.TestingType, StringComparer.Ordinal).ToList();
        if (security is not null)
            byType.Add(new ReportTypeResult("Security scan", security.ChecksExecuted + security.ChecksSkipped, security.Findings == 0 ? security.ChecksExecuted : security.ChecksExecuted - security.Findings,
                security.Findings, security.ChecksSkipped, ordered.Count(b => b.Category == "Security scan"),
                security.Note is not null && security.Status != "completed" ? "In progress" : security.Findings > 0 ? "Failed" : "Passed"));

        return Result<RunBugReport>.Success(new RunBugReport(reportRun, ordered, others, flaky, skipped, _clock.UtcNow, byType, security));
    }

    // ---- Pieces -----------------------------------------------------------------------

    private static int SecurityRank(Domain.Security.SecuritySeverity severity) => severity switch
    {
        Domain.Security.SecuritySeverity.Critical => (int)DefectSeverity.Critical,
        Domain.Security.SecuritySeverity.High or Domain.Security.SecuritySeverity.Medium => (int)DefectSeverity.Major,
        Domain.Security.SecuritySeverity.Low => (int)DefectSeverity.Minor,
        _ => (int)DefectSeverity.Trivial
    };

    /// <summary>A security finding as a bug: the same sections a developer reads for any other,
    /// filled from what the scan recorded.</summary>
    private ReportBug SecurityBug(Domain.Security.SecurityFinding f, Domain.Security.SecuritySeverity severity, bool isNew, bool isRegression,
        Domain.Security.SecurityScan scan)
    {
        var steps = f.ReproductionSteps.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select((line, i) => new ReportStep(i + 1, Masked(System.Text.RegularExpressions.Regex.Replace(line, @"^\d+[.)]\s*", "")), null, "passed", null, false))
            .ToList();
        var standards = string.Join(" · ", new[] { f.Cwe, f.OwaspWebCategory, f.OwaspApiCategory }.Where(x => !string.IsNullOrWhiteSpace(x)));
        return new ReportBug(
            Key: string.Empty, DefectId: null, DefectReference: f.Reference, DefectStatus: f.Status.ToString(),
            Title: Masked(f.Title), Severity: severity.ToString(), Priority: severity >= Domain.Security.SecuritySeverity.High ? "High" : "Medium",
            Category: "Security scan",
            Classification: $"Security finding · {f.Confidence} confidence{(isRegression ? " · came back after being fixed" : isNew ? " · new in this scan" : string.Empty)}",
            Confidence: f.Confidence switch { Domain.Security.SecurityConfidence.High => 90, Domain.Security.SecurityConfidence.Medium => 60, _ => 30 },
            Application: null, PageUrl: f.Endpoint, Form: null, Field: f.Parameter,
            Endpoint: f.HttpMethod is null || f.Endpoint is null ? f.Endpoint : $"{f.HttpMethod} {f.Endpoint}",
            Browser: "—", BrowserVersion: null, Viewport: "—",
            FirstSeenAt: f.FirstSeenAt, Occurrences: null, RegressionTest: null,
            Summary: $"{Masked(f.Description)}{(standards.Length > 0 ? $" ({standards})" : string.Empty)}",
            Steps: steps, TestData: f.ObservedAsRole is null ? null : new Dictionary<string, string> { ["signed in as"] = f.ObservedAsRole },
            Expected: $"The application is not open to {f.Category.ToLowerInvariant()}.",
            Actual: Masked(string.IsNullOrWhiteSpace(f.Impact) ? f.Description : f.Impact),
            FailingStep: null, PageText: null,
            WhereToLook: string.IsNullOrWhiteSpace(f.Remediation) ? "See the finding in QA NXT's Security page." : Masked(f.Remediation),
            Exchanges: Array.Empty<ReportExchange>(), Curl: null, Console: Array.Empty<ReportConsoleLine>(), Accessibility: Array.Empty<ReportA11yViolation>(),
            Screenshots: Array.Empty<ReportArtifact>(), Attachments: Array.Empty<ReportArtifact>(), AffectedTests: Array.Empty<ReportAffectedTest>(),
            VerifyTheFix: $"Run the security scan again (Testing → Run with security, or Security → {scan.Reference}). The finding is marked resolved once a scan no longer observes it.",
            ExecutionId: Guid.Empty, ExecutionUrl: _consoleUrl is null ? null : $"{_consoleUrl}/security");
    }

    private const int MaxPageSnapshotBytes = 512 * 1024;
    private const int MaxPageTextChars = 3000;

    /// <summary>The visible text of the page when the step failed, read from the DOM snapshot
    /// the worker took (already masked). A server's error page, a validation message or a
    /// stack trace the application printed is often the fastest clue there is.</summary>
    private async Task<string?> PageTextAsync(List<Artifact>? artifacts, TestAction? failing, CancellationToken ct)
    {
        var snapshot = artifacts?.Where(a => a.Kind == ArtifactKind.DomSnapshot && (failing is null || a.TestActionId == failing.Id))
            .OrderByDescending(a => a.CreatedAt).FirstOrDefault();
        if (snapshot is null || snapshot.SizeBytes > MaxPageSnapshotBytes) return null;
        try
        {
            await using var stream = await _store.GetAsync(snapshot.StorageKey, ct);
            if (stream is null) return null;
            using var reader = new StreamReader(stream);
            var text = VisibleText(await reader.ReadToEndAsync(ct));
            if (text.Length == 0) return null;
            return Masked(text.Length > MaxPageTextChars ? text[..MaxPageTextChars] + "…" : text);
        }
        catch (IOException)
        {
            return null;
        }
    }

    /// <summary>Text a person would see: scripts, styles and tags removed, entities decoded,
    /// blank runs collapsed, line structure kept.</summary>
    public static string VisibleText(string html)
    {
        var text = Regex.Replace(html, @"<(script|style|noscript|template|head)\b[^>]*>.*?</\1\s*>", " ", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        text = Regex.Replace(text, @"<!--.*?-->", " ", RegexOptions.Singleline);
        text = Regex.Replace(text, @"<(br|/p|/div|/li|/tr|/h[1-6]|/pre|/label|/section|/form|/table|/ul|/ol)\b[^>]*>", "\n", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"<[^>]+>", " ");
        text = System.Net.WebUtility.HtmlDecode(text);
        var lines = text.Split('\n').Select(l => Regex.Replace(l, @"[ \t\r\f\v]+", " ").Trim()).Where(l => l.Length > 0);
        return string.Join("\n", lines);
    }

    /// <summary>The failing test a bug is shown with: the most important one, so the report
    /// leads with the clearest reproduction.</summary>
    private static TestExecution Representative(IEnumerable<TestExecution> group)
        => group.OrderBy(e => e.TestCase!.Priority).ThenBy(e => e.TestCase!.Reference, StringComparer.Ordinal).First();

    private static bool IsCheck(BrowserActionType action)
        => BrowserActionVerbs.IsAssertion(action) || action is BrowserActionType.CheckAccessibility or BrowserActionType.CheckVisual;

    private static bool IsProductSymptom(Failure failure, List<TestAction>? actions)
    {
        if (failure.Category == FailureCategory.ApplicationDefect) return true;
        var action = failure.TestActionId is { } id ? actions?.FirstOrDefault(a => a.Id == id) : null;
        return action is not null && (BrowserActionVerbs.IsAssertion(action.Action)
            || action.Action is BrowserActionType.CheckAccessibility or BrowserActionType.CheckVisual);
    }

    private static List<ReportStep> Steps(List<TestAction> actions, List<TestStep>? planned, TestAction? failing)
    {
        // The actions are what ran, with the values actually typed; steps after the failure
        // never ran, so they come from the test's plan and are marked as not reached.
        // A navigation's recorded URL is where the page was before it (about:blank for the
        // first step); the planned URL is where it went, which is what a person needs.
        string? NavigationUrl(TestAction a)
        {
            var plannedUrl = planned?.FirstOrDefault(s => s.Id == a.TestStepId || s.Order == a.Order && s.Action == BrowserActionType.Navigate)?.Url;
            return plannedUrl ?? (a.Url is null || a.Url.StartsWith("about:", StringComparison.Ordinal) ? null : a.Url);
        }
        var result = actions.Select(a => new ReportStep(a.Order, Readable(a.Description), a.Action == BrowserActionType.Navigate ? NavigationUrl(a) : null,
            a.Id == failing?.Id ? "failed" : a.Status switch
            {
                ExecutionStatus.Passed or ExecutionStatus.Healed => "passed",
                ExecutionStatus.Failed => "failed",
                ExecutionStatus.Skipped => "skipped",
                _ => a.Status.ToString().ToLowerInvariant()
            },
            a.Id == failing?.Id || a.Status == ExecutionStatus.Failed ? a.ErrorMessage : null,
            BrowserActionVerbs.IsAssertion(a.Action) || a.Action is BrowserActionType.CheckAccessibility or BrowserActionType.CheckVisual)).ToList();

        if (planned is not null)
        {
            var last = result.Count == 0 ? 0 : result.Max(s => s.Order);
            result.AddRange(planned.Where(s => s.Order > last).Select(s => new ReportStep(s.Order, Readable(s.Description),
                s.Action == BrowserActionType.Navigate ? s.Url : null, "not reached", null, BrowserActionVerbs.IsAssertion(s.Action))));
            if (actions.Count == 0) result = result.OrderBy(s => s.Order).ToList();
        }
        // Only the first failure is "the" failing step; later failed checks are consequences.
        var firstFailed = result.FindIndex(s => s.Status == "failed");
        for (var i = 0; i < result.Count; i++)
            if (i != firstFailed && result[i].Status == "failed") result[i] = result[i] with { Status = "failed (after the first failure)" };
        return result;
    }

    private static string Readable(string description)
    {
        var text = Regex.Replace(description, @"\$\{secret:([A-Za-z0-9_.-]+)\}", m => $"[secret \"{m.Groups[1].Value}\" — the value configured in QA NXT]");
        // A 5000-character value reads as a wall of letters; say what it is.
        return Regex.Replace(text, @"""([^""]{120,})""", m =>
        {
            var value = m.Groups[1].Value;
            var repeated = value.Distinct().Count() == 1;
            return repeated ? $"\"{value[0]}\" × {value.Length}" : $"\"{value[..60]}…\" ({value.Length} characters; full value in the test data)";
        });
    }

    private static IReadOnlyDictionary<string, string>? Data(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            var data = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
            return data?.ToDictionary(kv => kv.Key, kv => Regex.IsMatch(kv.Value, @"^\$\{secret:")
                ? "[secret — the value configured in QA NXT]" : kv.Value);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static List<ReportExchange> Exchanges(List<NetworkEvent> events)
    {
        var masker = new SecretMasker();
        // Submissions, failures, and page loads that carried input in their query string —
        // which is how a search box's value reaches the server.
        return events.Where(n => n.StatusCode >= 400 || n.IsFailed || n.Method != "GET" && n.ResourceType is "xhr" or "fetch" or "document"
                || n.ResourceType == "document" && n.Url.Contains('?'))
            .Take(MaxExchangesPerBug)
            .Select(n => new ReportExchange(n.Method, masker.MaskText(n.Url), n.StatusCode, n.DurationMs,
                Headers(n.RequestHeadersJson, masker),
                n.RequestBodyExcerpt is null ? null : MaskSessionFields(masker.MaskJson(n.RequestBodyExcerpt)),
                n.ResponseBodyExcerpt is null ? null : masker.MaskJson(n.ResponseBodyExcerpt),
                n.FailureText)).ToList();
    }

    private static string? Headers(string? json, SecretMasker masker)
    {
        var headers = ParseHeaders(json);
        if (headers is null) return null;
        // Browser fingerprint headers (sec-ch-*, user-agent) say nothing about the bug.
        var masked = masker.MaskHeaders(headers.Where(h => !h.Key.StartsWith("sec-", StringComparison.OrdinalIgnoreCase)
            && !h.Key.Equals("user-agent", StringComparison.OrdinalIgnoreCase)).ToDictionary(h => h.Key, h => h.Value));
        return masked.Count == 0 ? null : string.Join("\n", masked.Select(h => $"{h.Key}: {h.Value}"));
    }

    private static Dictionary<string, string>? ParseHeaders(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object) return null;
            return document.RootElement.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() ?? string.Empty : p.Value.ToString(),
                StringComparer.OrdinalIgnoreCase);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>A command that replays the request outside the browser. Masked values stay
    /// masked: the developer substitutes their own, and the note says so.</summary>
    public static string? Curl(NetworkEvent? request)
    {
        if (request is null) return null;
        var masker = new SecretMasker();
        static string Quote(string value) => "'" + value.Replace("'", "'\\''") + "'";
        var lines = new List<string> { $"curl -i -X {request.Method} {Quote(masker.MaskText(request.Url))}" };
        var headers = ParseHeaders(request.RequestHeadersJson);
        var contentType = headers?.GetValueOrDefault("content-type");
        var body = request.RequestBodyExcerpt;
        if (body is not null)
        {
            contentType ??= body.TrimStart().StartsWith('{') || body.TrimStart().StartsWith('[') ? "application/json" : "application/x-www-form-urlencoded";
            if (contentType.StartsWith("multipart/", StringComparison.OrdinalIgnoreCase))
                return string.Join(" \\\n  ", lines) + "\n# The request was a file upload (multipart); repeat it with -F field=@file for each part shown under the request.";
            lines.Add($"-H {Quote("Content-Type: " + contentType)}");
            lines.Add($"--data-raw {Quote(MaskSessionFields(masker.MaskJson(body)))}");
        }
        return string.Join(" \\\n  ", lines);
    }

    /// <summary>Anti-forgery tokens belong to the tester's session; a report shared beyond the
    /// team must not carry one, and a replay needs a fresh one anyway.</summary>
    internal static string MaskSessionFields(string body)
        => SessionField().Replace(body, m => $"{m.Groups[1].Value}{m.Groups[2].Value}{SecretMasker.Redacted}");

    private static Regex SessionField() => new(
        @"((?:^|[&""\s{,])[""]?(?:_?csrf[\w-]*|_?xsrf[\w-]*|authenticity_token|__RequestVerificationToken|_token)[""]?)(\s*[=:]\s*[""]?)([^&""\s,}]+)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static List<ReportA11yViolation> Accessibility(string? json)
    {
        var result = new List<ReportA11yViolation>();
        if (string.IsNullOrWhiteSpace(json)) return result;
        try
        {
            using var document = JsonDocument.Parse(json);
            if (!document.RootElement.TryGetProperty("violations", out var violations) || violations.ValueKind != JsonValueKind.Array) return result;
            foreach (var v in violations.EnumerateArray())
            {
                string? Text(string name) => v.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
                var nodes = v.TryGetProperty("nodes", out var n) && n.ValueKind == JsonValueKind.Array
                    ? n.EnumerateArray().Select(node => node.TryGetProperty("target", out var t) ? t.ValueKind == JsonValueKind.String ? t.GetString() ?? string.Empty : t.ToString() : string.Empty)
                        .Where(t => t.Length > 0).Take(10).ToList()
                    : new List<string>();
                result.Add(new ReportA11yViolation(Text("id") ?? "(rule)", Text("impact"), Text("help") ?? Text("description") ?? string.Empty, Text("helpUrl"), nodes));
            }
        }
        catch (JsonException)
        {
            // Not the shape the worker writes; the failure message still names the rules.
        }
        return result;
    }

    private static List<ReportArtifact> Screenshots(List<Artifact>? artifacts, TestAction? failing, string reference, bool primary)
    {
        if (artifacts is null) return new List<ReportArtifact>();
        var shots = artifacts.Where(a => a.Kind == ArtifactKind.Screenshot).ToList();
        var chosen = shots.Where(a => failing is not null && (a.TestActionId == failing.Id || a.Id == failing.BeforeScreenshotId || a.Id == failing.AfterScreenshotId))
            .OrderBy(a => a.Name.Contains("before", StringComparison.OrdinalIgnoreCase) ? 0 : 1).ThenBy(a => a.Name).ToList();
        if (chosen.Count == 0) chosen = shots.Where(a => a.Name.StartsWith("final", StringComparison.OrdinalIgnoreCase)).Take(1).ToList();
        if (chosen.Count == 0) chosen = shots.OrderByDescending(a => a.CreatedAt).Take(1).ToList();
        return chosen.DistinctBy(a => a.StorageKey).Select(a => new ReportArtifact(a.Id, "screenshot", a.Name, a.ContentType, a.SizeBytes, Caption(a, failing, reference, primary), a.StorageKey)).ToList();
    }

    private static string Caption(Artifact artifact, TestAction? failing, string reference, bool primary)
    {
        var prefix = primary ? string.Empty : $"{reference}: ";
        var name = artifact.Name.ToLowerInvariant();
        if (name.Contains("before")) return $"{prefix}Before step {failing?.Order}";
        if (name.Contains("failure")) return $"{prefix}The page when step {failing?.Order} failed";
        if (name.Contains("baseline")) return $"{prefix}Approved baseline";
        if (name.Contains("diff")) return $"{prefix}Visual difference (changed pixels highlighted)";
        if (name.StartsWith("final")) return $"{prefix}The page at the end of the test";
        return prefix + artifact.Name;
    }

    private static List<ReportArtifact> Attachments(List<Artifact>? artifacts, TestAction? failing)
    {
        if (artifacts is null) return new List<ReportArtifact>();
        return artifacts.Where(a => a.Kind is ArtifactKind.Trace or ArtifactKind.Video or ArtifactKind.Har
                || a.Kind is ArtifactKind.DomSnapshot or ArtifactKind.AccessibilityTree && (failing is null || a.TestActionId == failing.Id))
            .OrderBy(a => a.Kind).ThenBy(a => a.Name)
            .Select(a => new ReportArtifact(a.Id, a.Kind.ToString().ToLowerInvariant(), a.Name, a.ContentType, a.SizeBytes, a.Kind switch
            {
                ArtifactKind.Trace => "Playwright trace: every action with a DOM snapshot, the network and the console. Open it with `npx playwright show-trace trace.zip` or at https://trace.playwright.dev.",
                ArtifactKind.Video => "Video of the whole test.",
                ArtifactKind.Har => "Every request and response (HAR), masked.",
                ArtifactKind.DomSnapshot => "The page's HTML when the step failed, with secrets masked.",
                ArtifactKind.AccessibilityTree => "The accessibility tree when the step failed — what a screen reader is given.",
                _ => a.Name
            }, a.StorageKey)).ToList();
    }

    private static string ViewportOf(List<TestStep>? steps)
        => steps?.Where(s => s.Action == BrowserActionType.SetViewport).Select(s => s.Value).LastOrDefault(v => !string.IsNullOrEmpty(v)) ?? "1440x900 (default)";

    /// <summary>A starting point for the developer, read from the symptom the test observed.</summary>
    internal static string WhereToLook(TestAction? failing, Failure? failure, TestCase testCase, string? form, NetworkEvent? serverError, string actual)
    {
        var field = testCase.FieldKey is null ? "the field" : $"\"{testCase.FieldKey}\"";
        string hint;
        if (serverError is not null)
        {
            hint = $"The server failed: {serverError.Method} {PathOf(serverError.Url)} returned HTTP {serverError.StatusCode}. "
                + "Start in the server handler for that route. The request that triggered it, with the values sent, is under API exchange, and the curl command replays it without a browser. "
                + (Regex.IsMatch(actual, "internal error detail|stack trace|SQL", RegexOptions.IgnoreCase)
                    ? "The page also showed internal error detail to the user — catch the error and show a generic message as well as fixing the cause." : string.Empty);
        }
        else
        {
            hint = failing?.Action switch
            {
                BrowserActionType.AssertFormRejected when actual.Contains("accepted", StringComparison.OrdinalIgnoreCase) => testCase.Category switch
                {
                    TestCategory.CrossField => "The application accepted a combination of values it should refuse. The rule between these fields is not enforced on the server: add the check to the submit handler and return an error attached to the second field.",
                    TestCategory.Dynamic => $"{field} is shown and required on the page once its trigger is answered, but the server accepts the submission without it. Enforce the same conditional requirement on the server.",
                    _ => $"The application accepted a value it should refuse for {field} (technique: {testCase.Technique}). The page declares the rule, so the browser would stop a normal user — but the server does not enforce it, and anything that skips the page's checks gets through. Add the same validation to the server-side handler and return an error tied to {field}."
                },
                BrowserActionType.AssertFormRejected => "The submission was refused, but nothing told the user what was wrong. Show a message next to the field at fault and mark the field aria-invalid=\"true\".",
                BrowserActionType.AssertFormAccepted => "A valid submission was not accepted. Compare the values under Test data with the server's validation rules; the server's answer is under API exchange.",
                BrowserActionType.AssertErrorAssociated => $"The error for {field} is shown but not tied to the field: set aria-invalid=\"true\" on it and reference the error's id from aria-describedby (WCAG 3.3.1, 4.1.2), so a screen reader announces it with the field.",
                BrowserActionType.AssertRequests when actual.Contains("at most", StringComparison.Ordinal) =>
                    "The submission was sent more than once. Disable the submit control while the request is in flight, and make the endpoint idempotent (an idempotency key, or a unique constraint on the business key) so a repeat cannot create a second record.",
                BrowserActionType.AssertRequests when actual.Contains("within", StringComparison.Ordinal) =>
                    "The response took longer than its budget. The timing of each request is under API exchange; profile the server handler for the slowest one.",
                BrowserActionType.AssertRequests => "The request the page should send was not sent, or did not carry what was typed. Check the form's submit handler and the field names it posts.",
                BrowserActionType.AssertNoMarkupInjection => $"Input from {field} is written into the page as live HTML (reflected cross-site scripting, CWE-79). Encode output in the template, or set textContent rather than innerHTML.",
                BrowserActionType.AssertNoHorizontalScroll => "An element is wider than the viewport. Look for fixed widths (width or min-width in px), and images or tables without max-width: 100%.",
                BrowserActionType.AssertPresent when (testCase.Technique ?? string.Empty).Contains("csrf", StringComparison.OrdinalIgnoreCase) || testCase.Name.Contains("forgery", StringComparison.OrdinalIgnoreCase) =>
                    "The form carries no anti-forgery token. Add a per-session token as a hidden field and verify it on the server (CWE-352).",
                BrowserActionType.AssertPresent => "An element the test expects is missing from the page.",
                BrowserActionType.AssertValue => $"The value of {field} was lost. For a multi-step form, check that each step's answers are kept when the user goes back.",
                BrowserActionType.AssertHidden or BrowserActionType.AssertVisible => $"The visibility of {field} does not follow the answer that controls it. Check the show/hide logic for it.",
                BrowserActionType.AssertFocused => "Keyboard focus does not move in the expected order. Check the DOM order and any tabindex values.",
                BrowserActionType.AssertLoadTimeUnder => "The page loaded more slowly than its budget. The request timings are under API exchange.",
                BrowserActionType.AssertNoServerError => "The page showed an error or an uncaught script error. See Console below.",
                BrowserActionType.CheckAccessibility => "Fix the accessibility rules listed below; each links to guidance on what the rule requires.",
                BrowserActionType.CheckVisual => "The page differs from its approved baseline. If the change is intended, approve the new baseline in QA NXT instead of changing the page.",
                _ => failure?.Category == FailureCategory.TimingIssue
                    ? "The page did not reach the expected state in time. Check for slow responses under API exchange and for elements that appear late."
                    : "Start from the failing step and the evidence below."
            };
        }
        return hint.Trim() + " (A starting point drawn from what the test observed, not a diagnosis of the code.)";
    }

    private static string Classification(FailureCategory? category) => category switch
    {
        FailureCategory.ApplicationDefect => "Application defect",
        FailureCategory.TestDefect => "Test defect",
        FailureCategory.EnvironmentDefect => "Environment problem",
        FailureCategory.LocatorChange => "Locator change (the page changed under the test)",
        FailureCategory.TimingIssue => "Timing",
        FailureCategory.NetworkIssue => "Network problem",
        FailureCategory.AuthenticationIssue => "Authentication problem",
        FailureCategory.DataIssue => "Test data problem",
        FailureCategory.ThirdPartyDependency => "Third-party dependency",
        _ => "Not yet classified"
    };

    private static string WhoActs(FailureCategory? category) => category switch
    {
        FailureCategory.LocatorChange => "QA: the page changed and the test must follow it. A healing suggestion may be waiting in QA NXT.",
        FailureCategory.TestDefect => "QA: the test itself is wrong.",
        FailureCategory.EnvironmentDefect or FailureCategory.NetworkIssue => "Whoever runs the test environment: it was unavailable or unhealthy.",
        FailureCategory.AuthenticationIssue => "QA: the test could not sign in. Check the credentials configured in QA NXT.",
        FailureCategory.ThirdPartyDependency => "Whoever owns the integration: a third-party service failed.",
        FailureCategory.DataIssue => "QA: the test's data does not suit the environment.",
        FailureCategory.TimingIssue => "QA first: re-run it. If it keeps failing, it is a slow or racy page and becomes a developer's.",
        _ => "QA, to triage before it goes to a developer."
    };

    private static DefectSeverity SeverityOf(TestCase testCase) => (testCase.Category, testCase.Priority) switch
    {
        (TestCategory.Security, _) => DefectSeverity.Critical,
        (_, TestPriority.Critical) => DefectSeverity.Critical,
        (_, TestPriority.High or TestPriority.Medium) => DefectSeverity.Major,
        _ => DefectSeverity.Minor
    };

    private static string PathOf(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.AbsolutePath : url;

    private static string Masked(string? text) => new SecretMasker().MaskText(text);

    private static string FirstSentence(string message)
    {
        var match = Regex.Match(message, @"^(.+?)(?:[.:](?:\s|$)|\n)");
        var sentence = match.Success ? match.Groups[1].Value : message;
        return sentence.Length > 160 ? sentence[..160] + "…" : sentence;
    }

    private static string Slug(string value)
    {
        var slug = Regex.Replace(value.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
        return slug.Length == 0 ? "run" : slug.Length > 40 ? slug[..40].TrimEnd('-') : slug;
    }
}
