using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using QaNxt.Application.Security;
using QaNxt.Application.Testing;
using QaNxt.Domain.Common;
using QaNxt.Domain.Diagnosis;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Testing;

namespace QaNxt.Application.Diagnosis;

public sealed record DefectSummary(
    Guid Id, string Reference, string Title, DefectSeverity Severity, DefectStatus Status, string? Category,
    int AffectedTestCount, int OccurrenceCount, DateTimeOffset? FirstSeenAt, DateTimeOffset? LastSeenAt,
    Guid? ApplicationFormId, Guid? RegressionTestCaseId, bool ProposedByAi);

public sealed record DefectDetail(
    DefectSummary Summary, string Description, string StepsToReproduce, string ExpectedBehaviour, string ActualBehaviour,
    string? Signature, IReadOnlyList<AffectedTest> AffectedTests);

public sealed record AffectedTest(Guid TestCaseId, string Reference, string Name, Guid FailureId, Guid ExecutionId, DateTimeOffset At);

public sealed record FailureReport(
    Guid FailureId, Guid TestCaseId, string TestReference, string TestName, string? Category, string? Technique,
    string ApplicationName, string? PageUrl, string? FormName, string? Field, string Severity, string Priority,
    string Expected, string Actual, string Error, string? StackTrace, string? Url, string Browser, string? BrowserVersion,
    string? Viewport, DateTimeOffset At, Guid ExecutionId, Guid TestRunId, string? Environment,
    IReadOnlyList<object> ApiExchanges, IReadOnlyList<object> ConsoleLogs, IReadOnlyList<object> NetworkLogs,
    IReadOnlyList<object> Artifacts, object? TestData, IReadOnlyList<string> ReproductionSteps,
    Guid? DefectId, string FailureCategory, string? DiagnosisSummary);

public interface IDefectService
{
    /// <summary>Correlates a recorded failure with the defect that explains it, proposing a new
    /// defect when none does. Returns null when the failure is not an application defect.</summary>
    Task<Defect?> CorrelateAsync(Failure failure, CancellationToken ct = default);
    Task<IReadOnlyList<DefectSummary>> ListAsync(Guid projectId, Guid? applicationId, DefectStatus? status, CancellationToken ct = default);
    Task<Result<DefectDetail>> GetAsync(Guid id, CancellationToken ct = default);
    Task<Result<DefectSummary>> SetStatusAsync(Guid id, DefectStatus status, string? note, CancellationToken ct = default);
    Task<Result<Guid>> CreateRegressionTestAsync(Guid id, CancellationToken ct = default);
    Task<Result<FailureReport>> FailureReportAsync(Guid failureId, CancellationToken ct = default);
}

/// <summary>From failures to defects, and from confirmed defects to regression tests.
///
/// A defect is proposed, never asserted: the platform says "these twelve failures look like
/// one problem" and a person confirms it. Correlation is by symptom and place — the same
/// server error from the same endpoint, the same accepted-invalid behaviour on the same
/// field, the same accessibility rule on the same form — and deliberately not by test, which
/// is what used to make twenty tests failing on one crash look like twenty problems.
/// Every affected test stays linked through its failure.
///
/// A regression test is made only from a confirmed defect. It is a copy of the test that
/// caught it, filed in the project's regression suite, and it is never regenerated, so it
/// survives whatever later happens to the form it came from.</summary>
public sealed class DefectService : IDefectService
{
    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly ILogger<DefectService> _logger;

    public DefectService(IQaNxtDbContext db, ICurrentUser currentUser, IClock clock, IAuditLogger audit, ILogger<DefectService> logger)
    {
        _db = db;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
        _logger = logger;
    }

    private static readonly FailureCategory[] NotDefects =
    {
        FailureCategory.LocatorChange, FailureCategory.TestDefect, FailureCategory.EnvironmentDefect,
        FailureCategory.NetworkIssue, FailureCategory.AuthenticationIssue, FailureCategory.ThirdPartyDependency
    };

    public async Task<Defect?> CorrelateAsync(Failure failure, CancellationToken ct = default)
    {
        var testCase = await _db.TestCases.FirstOrDefaultAsync(tc => tc.Id == failure.TestCaseId, ct);
        if (testCase is null) return null;
        var action = failure.TestActionId is null ? null : await _db.TestActions.FirstOrDefaultAsync(a => a.Id == failure.TestActionId, ct);

        // Only behaviour the application got wrong becomes a defect. A test that broke
        // because the page was redesigned, or because the environment was down, is a test
        // or environment problem, and proposing it as a defect is noise somebody must clear.
        var oracle = action is not null && (BrowserActionVerbs.IsAssertion(action.Action)
            || action.Action is BrowserActionType.CheckAccessibility or BrowserActionType.CheckVisual);
        if (NotDefects.Contains(failure.Category)) return null;
        if (failure.Category != FailureCategory.ApplicationDefect && !oracle) return null;

        // A check about the form's own elements that fails because the test is no longer on
        // the form's page — a back button that returned somewhere else, a redirect after
        // sign-in — says where the test ended up, not what the form does.
        var form0 = testCase.ApplicationFormId is null ? null : await _db.ApplicationForms.FirstOrDefaultAsync(f => f.Id == testCase.ApplicationFormId, ct);
        if (action is not null && form0 is not null && ElementCheck(action.Action)
            && failure.RawMessage.Contains("No element matched", StringComparison.OrdinalIgnoreCase)
            && !SamePage(action.Url, form0.PageUrl))
        {
            failure.Category = FailureCategory.TestDefect;
            failure.CategoryConfidence = 75;
            await _db.SaveChangesAsync(ct);
            return null;
        }

        var serverError = await _db.NetworkEvents
            .Where(n => n.TestExecutionId == failure.TestExecutionId && n.StatusCode >= 500)
            .OrderBy(n => n.OccurredAt).FirstOrDefaultAsync(ct);
        var (signature, symptom) = Signature(failure, testCase, action, serverError);

        var defect = await _db.Defects.FirstOrDefaultAsync(d => d.ProjectId == failure.ProjectId && d.Signature == signature
            && d.Status != DefectStatus.Rejected && d.Status != DefectStatus.Duplicate, ct);
        var now = _clock.UtcNow;
        if (defect is null)
        {
            var form = testCase.ApplicationFormId is null ? null : await _db.ApplicationForms.FirstOrDefaultAsync(f => f.Id == testCase.ApplicationFormId, ct);
            var steps = await _db.TestSteps.Where(s => s.TestCaseId == testCase.Id).OrderBy(s => s.Order).Select(s => s.Description).ToListAsync(ct);
            defect = new Defect
            {
                OrganizationId = failure.OrganizationId,
                ProjectId = failure.ProjectId,
                FailureId = failure.Id,
                TestCaseId = testCase.Id,
                TestExecutionId = failure.TestExecutionId,
                ApplicationId = testCase.ApplicationId,
                ApplicationFormId = testCase.ApplicationFormId,
                Category = testCase.Category,
                Signature = signature,
                // Where it happened leads the title: the form, or for a page-level check the page.
                Title = Truncate($"{(form is not null ? form.Name + ": " : PagePath(action?.Url) is { } path ? path + ": " : string.Empty)}{symptom}", 300),
                Description = Truncate($"Proposed from failing test {testCase.Reference} ({testCase.Name}). "
                    + $"{(testCase.Objective.Length > 0 ? "It checks: " + testCase.Objective + " " : string.Empty)}"
                    + "Every test that fails with the same symptom in the same place is attached to this defect.", 8000),
                StepsToReproduce = Truncate(string.Join("\n", steps.Select((s, i) => $"{i + 1}. {s}")), 8000),
                ExpectedBehaviour = Truncate(testCase.ExpectedResults, 4000),
                ActualBehaviour = Truncate(failure.RawMessage, 4000),
                // A server crash is at least major whatever test reached it: the input that
                // found it is incidental, the failure is not.
                Severity = serverError is null ? SeverityOf(testCase) : (DefectSeverity)Math.Min((int)SeverityOf(testCase), (int)DefectSeverity.Major),
                Status = DefectStatus.Proposed,
                Confidence = failure.CategoryConfidence,
                ProposedByAi = false,
                EvidenceRefsJson = JsonSerializer.Serialize(new { executionId = failure.TestExecutionId, failureId = failure.Id }),
                FirstSeenAt = now,
                CreatedAt = now
            };
            _db.Defects.Add(defect);
            await _audit.LogAsync(AuditAction.DefectCreated, nameof(Defect), defect.Id,
                $"Defect proposed from {testCase.Reference}: {defect.Title}", projectId: failure.ProjectId, ct: ct);
        }

        failure.DefectId = defect.Id;
        defect.OccurrenceCount += 1;
        defect.LastSeenAt = now;
        await _db.SaveChangesAsync(ct);
        defect.AffectedTestCount = await _db.Failures.Where(f => f.DefectId == defect.Id).Select(f => f.TestCaseId).Distinct().CountAsync(ct);
        await _db.SaveChangesAsync(ct);
        return defect;
    }

    /// <summary>What makes two failures the same problem. The symptom and where it happened;
    /// never which test noticed.</summary>
    private static (string Signature, string Symptom) Signature(Failure failure, TestCase testCase, TestAction? action,
        Domain.Evidence.NetworkEvent? serverError)
    {
        string key;
        string symptom;
        var place = testCase.ApplicationFormId?.ToString("N") ?? testCase.ApplicationId?.ToString("N") ?? "project";

        if (serverError is not null)
        {
            var path = Uri.TryCreate(serverError.Url, UriKind.Absolute, out var uri) ? uri.AbsolutePath : serverError.Url;
            path = Regex.Replace(path, @"/\d+|/[0-9a-f]{8,}(-[0-9a-f]{4,})*", "/{id}");
            key = $"server|{serverError.Method}|{path}|{serverError.StatusCode}";
            symptom = $"{serverError.Method} {path} fails with HTTP {serverError.StatusCode}";
        }
        else if (action is not null && action.Action == BrowserActionType.AssertFormRejected && failure.RawMessage.Contains("accepted", StringComparison.OrdinalIgnoreCase))
        {
            var rule = RuleOf(testCase);
            key = $"accepts-invalid|{place}|{testCase.FieldKey}|{rule}";
            symptom = $"accepts an invalid {testCase.FieldKey ?? "submission"}{(rule is null ? string.Empty : $" ({rule})")}";
        }
        else if (action is not null && action.Action == BrowserActionType.CheckAccessibility)
        {
            var rules = Regex.Matches(failure.RawMessage, @"\b([a-z]+(?:-[a-z]+)+)\b").Select(m => m.Groups[1].Value).Distinct().OrderBy(r => r).Take(5);
            var ruleList = Regex.Matches(failure.RawMessage, @"([a-z]+(?:-[a-z]+)+) \((critical|serious|moderate|minor)\)").Select(m => m.Groups[1].Value).Distinct().ToList();
            var elements = Regex.Match(failure.RawMessage, @"and (\d+) other element").Success ? int.Parse(Regex.Match(failure.RawMessage, @"and (\d+) other element").Groups[1].Value) + 1 : (int?)null;
            key = $"a11y|{place}|{string.Join(',', rules)}";
            symptom = ruleList.Count == 0 ? "has accessibility violations"
                : $"breaks the accessibility rule{(ruleList.Count > 1 ? "s" : string.Empty)} {string.Join(", ", ruleList)}{(elements is null ? string.Empty : $" on {elements} element{(elements == 1 ? string.Empty : "s")}")}";
        }
        else if (action is not null)
        {
            var normalised = Regex.Replace(failure.RawMessage.ToLowerInvariant(), @"""[^""]*""|\d+", "#");
            key = $"{action.Action}|{place}|{testCase.FieldKey}|{normalised[..Math.Min(normalised.Length, 200)]}";
            symptom = action.Action switch
            {
                BrowserActionType.AssertErrorAssociated => $"does not tie the error to {testCase.FieldKey}",
                BrowserActionType.AssertRequests => failure.RawMessage.Contains("at most", StringComparison.Ordinal)
                    ? "sends a submission more than once" : failure.RawMessage.Contains("within", StringComparison.Ordinal) ? "responds more slowly than its budget" : "sends the wrong requests",
                BrowserActionType.AssertNoMarkupInjection => $"writes input from {testCase.FieldKey} back into the page as markup",
                BrowserActionType.AssertNoHorizontalScroll => "overflows a small screen",
                BrowserActionType.AssertPresent => "lacks an element it should have",
                BrowserActionType.AssertValue => $"loses the value of {testCase.FieldKey ?? "a field"}",
                BrowserActionType.AssertNoServerError => "shows an error",
                BrowserActionType.AssertLoadTimeUnder => "loads more slowly than its budget",
                BrowserActionType.AssertFormAccepted => "refuses a valid submission",
                _ => FirstSentence(failure.RawMessage)
            };
        }
        else
        {
            key = $"message|{place}|{Regex.Replace(failure.RawMessage.ToLowerInvariant(), @"\d+", "#")}";
            symptom = FirstSentence(failure.RawMessage);
        }
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant();
        return (hash, symptom);
    }

    private static string? RuleOf(TestCase testCase)
    {
        if (testCase.Technique is null) return null;
        return testCase.Category switch
        {
            // Every value under a minimum is the same defect when the minimum is not enforced;
            // min-1, zero and a negative value are three tests of one rule.
            TestCategory.Boundary => testCase.Technique is "min-1" or "zero" or "negative" or "minlength-1" ? "below its minimum"
                : testCase.Technique is "max+1" or "very-large" or "maxlength+1" ? "above its maximum" : testCase.Technique,
            TestCategory.CrossField => "a cross-field rule",
            TestCategory.Dynamic => "a conditional requirement",
            TestCategory.Negative => testCase.Technique == "whitespace-only" ? "whitespace only" : "missing",
            _ => testCase.Technique
        };
    }

    private static string FirstSentence(string message)
    {
        var end = message.IndexOfAny(new[] { '.', '\n' });
        var sentence = end > 0 ? message[..end] : message;
        return sentence.Length > 160 ? sentence[..160] : sentence;
    }

    private static string? PagePath(string? url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) ? $"Page {uri.AbsolutePath}" : null;

    private static bool ElementCheck(BrowserActionType action) => action is BrowserActionType.AssertVisible or BrowserActionType.AssertHidden
        or BrowserActionType.AssertValue or BrowserActionType.AssertFocused or BrowserActionType.AssertErrorAssociated
        or BrowserActionType.AssertFieldInvalid or BrowserActionType.AssertFieldValid or BrowserActionType.AssertText or BrowserActionType.AssertEnabled;

    private static bool SamePage(string? actual, string? expected)
    {
        if (actual is null || expected is null) return true;
        if (!Uri.TryCreate(actual, UriKind.Absolute, out var a) || !Uri.TryCreate(expected, UriKind.Absolute, out var e)) return true;
        return string.Equals(a.Host, e.Host, StringComparison.OrdinalIgnoreCase)
            && string.Equals(a.AbsolutePath.TrimEnd('/'), e.AbsolutePath.TrimEnd('/'), StringComparison.OrdinalIgnoreCase);
    }

    private static DefectSeverity SeverityOf(TestCase testCase) => (testCase.Category, testCase.Priority) switch
    {
        (TestCategory.Security, _) => DefectSeverity.Critical,
        (_, TestPriority.Critical) => DefectSeverity.Critical,
        (_, TestPriority.High) => DefectSeverity.Major,
        (_, TestPriority.Medium) => DefectSeverity.Major,
        _ => DefectSeverity.Minor
    };

    public async Task<IReadOnlyList<DefectSummary>> ListAsync(Guid projectId, Guid? applicationId, DefectStatus? status, CancellationToken ct = default)
    {
        var query = _db.Defects.Where(d => d.ProjectId == projectId);
        if (applicationId is not null) query = query.Where(d => d.ApplicationId == applicationId);
        if (status is not null) query = query.Where(d => d.Status == status);
        var defects = await query.OrderBy(d => d.Severity).ThenByDescending(d => d.AffectedTestCount).ThenBy(d => d.CreatedAt).ToListAsync(ct);
        var ordered = await _db.Defects.Where(d => d.ProjectId == projectId).OrderBy(d => d.CreatedAt).Select(d => d.Id).ToListAsync(ct);
        return defects.Select(d => Summary(d, ordered.IndexOf(d.Id) + 1)).ToList();
    }

    private static DefectSummary Summary(Defect d, int number) => new(
        d.Id, $"DEF-{number:0000}", d.Title, d.Severity, d.Status, d.Category is null ? null : Forms.TestingProfile.CategoryKey(d.Category.Value),
        d.AffectedTestCount, d.OccurrenceCount, d.FirstSeenAt, d.LastSeenAt, d.ApplicationFormId, d.RegressionTestCaseId, d.ProposedByAi);

    public async Task<Result<DefectDetail>> GetAsync(Guid id, CancellationToken ct = default)
    {
        var defect = await _db.Defects.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (defect is null) return Error.NotFound("The defect");
        var number = await _db.Defects.CountAsync(d => d.ProjectId == defect.ProjectId && d.CreatedAt <= defect.CreatedAt, ct);
        var affected = await (from f in _db.Failures
                              join tc in _db.TestCases on f.TestCaseId equals tc.Id
                              where f.DefectId == id
                              orderby f.CreatedAt
                              select new AffectedTest(tc.Id, tc.Reference, tc.Name, f.Id, f.TestExecutionId, f.CreatedAt)).ToListAsync(ct);
        return Result<DefectDetail>.Success(new DefectDetail(Summary(defect, number), defect.Description, defect.StepsToReproduce,
            defect.ExpectedBehaviour, defect.ActualBehaviour, defect.Signature, affected));
    }

    public async Task<Result<DefectSummary>> SetStatusAsync(Guid id, DefectStatus status, string? note, CancellationToken ct = default)
    {
        var defect = await _db.Defects.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (defect is null) return Error.NotFound("The defect");
        var previous = defect.Status;
        defect.Status = status;
        defect.UpdatedByUserId = _currentUser.UserId;
        if (!string.IsNullOrWhiteSpace(note)) defect.Description = Truncate($"{defect.Description}\n\n{_clock.UtcNow:yyyy-MM-dd}: {note.Trim()}", 8000);
        await _db.SaveChangesAsync(ct);
        await _audit.LogAsync(AuditAction.DefectCreated, nameof(Defect), defect.Id,
            $"Defect status changed from {previous} to {status}.", projectId: defect.ProjectId, ct: ct);
        var number = await _db.Defects.CountAsync(d => d.ProjectId == defect.ProjectId && d.CreatedAt <= defect.CreatedAt, ct);
        return Result<DefectSummary>.Success(Summary(defect, number));
    }

    public async Task<Result<Guid>> CreateRegressionTestAsync(Guid id, CancellationToken ct = default)
    {
        var defect = await _db.Defects.FirstOrDefaultAsync(d => d.Id == id, ct);
        if (defect is null) return Error.NotFound("The defect");
        if (defect.Status is DefectStatus.Proposed or DefectStatus.Rejected or DefectStatus.Duplicate)
            return Error.Validation("Confirm the defect first. A regression test is made from a confirmed defect, so that a proposal nobody has looked at cannot become a permanent test.");
        if (defect.RegressionTestCaseId is { } existingId && await _db.TestCases.AnyAsync(tc => tc.Id == existingId, ct))
            return Result<Guid>.Success(existingId);
        if (defect.TestCaseId is null) return Error.Validation("The defect has no test to make a regression test from.");

        var source = await _db.TestCases.Include(tc => tc.Steps).ThenInclude(s => s.Assertions)
            .FirstOrDefaultAsync(tc => tc.Id == defect.TestCaseId, ct);
        if (source is null) return Error.NotFound("The test that found the defect");

        var suiteName = "Regression — confirmed defects";
        var suite = await _db.TestSuites.FirstOrDefaultAsync(s => s.ProjectId == defect.ProjectId && s.Name == suiteName, ct);
        if (suite is null)
        {
            suite = new TestSuite
            {
                ProjectId = defect.ProjectId, Name = suiteName, CreatedByUserId = _currentUser.UserId, CreatedAt = _clock.UtcNow,
                Description = "One test per confirmed defect, copied from the test that caught it. Never regenerated, so it outlives changes to the form."
            };
            _db.TestSuites.Add(suite);
            await _db.SaveChangesAsync(ct);
        }

        var reference = await TestRepositoryService.NextReferenceAsync(_db, defect.ProjectId, ct);
        var copy = TestRepositoryService.Copy(source, suite.Id, reference, _currentUser.UserId, _clock.UtcNow);
        var number = await _db.Defects.CountAsync(d => d.ProjectId == defect.ProjectId && d.CreatedAt <= defect.CreatedAt, ct);
        copy.Name = Truncate($"Regression DEF-{number:0000}: {source.Name}", 300);
        copy.Category = TestCategory.Regression;
        copy.Technique = $"defect:{defect.Id:N}";
        copy.Source = TestCaseSource.DefectRegression;
        copy.SourceDefectId = defect.Id;
        copy.GenerationKey = null;
        copy.Tags = Truncate(string.Join(',', source.Tags.Split(',', StringSplitOptions.RemoveEmptyEntries).Append("regression").Append($"defect:DEF-{number:0000}").Distinct()), 500);
        copy.Objective = Truncate($"Guards against DEF-{number:0000} returning: {defect.Title}. {source.Objective}", 2000);
        _db.TestCases.Add(copy);
        defect.RegressionTestCaseId = copy.Id;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.TestCaseCreated, nameof(TestCase), copy.Id,
            $"Regression test {copy.Reference} made from defect DEF-{number:0000}.", projectId: defect.ProjectId, ct: ct);
        return Result<Guid>.Success(copy.Id);
    }

    public async Task<Result<FailureReport>> FailureReportAsync(Guid failureId, CancellationToken ct = default)
    {
        var failure = await _db.Failures.Include(f => f.Analysis).FirstOrDefaultAsync(f => f.Id == failureId, ct);
        if (failure is null) return Error.NotFound("The failure");
        var execution = await _db.TestExecutions.Include(e => e.TestRun).FirstOrDefaultAsync(e => e.Id == failure.TestExecutionId, ct);
        if (execution is null) return Error.NotFound("The execution");
        var testCase = await _db.TestCases.Include(tc => tc.Steps).FirstOrDefaultAsync(tc => tc.Id == failure.TestCaseId, ct);
        if (testCase is null) return Error.NotFound("The test");
        var application = testCase.ApplicationId is null ? null : await _db.Applications.FirstOrDefaultAsync(a => a.Id == testCase.ApplicationId, ct);
        var form = testCase.ApplicationFormId is null ? null : await _db.ApplicationForms.FirstOrDefaultAsync(f => f.Id == testCase.ApplicationFormId, ct);
        var action = failure.TestActionId is null ? null : await _db.TestActions.FirstOrDefaultAsync(a => a.Id == failure.TestActionId, ct);
        var environment = execution.TestRun?.EnvironmentId is null ? null
            : await _db.Environments.Where(e => e.Id == execution.TestRun.EnvironmentId).Select(e => e.Name).FirstOrDefaultAsync(ct);

        var network = await _db.NetworkEvents.Where(n => n.TestExecutionId == execution.Id).OrderBy(n => n.OccurredAt).ToListAsync(ct);
        var console = await _db.ConsoleEvents.Where(c => c.TestExecutionId == execution.Id).OrderBy(c => c.OccurredAt)
            .Select(c => (object)new { c.Level, c.Message, c.Url, c.OccurredAt }).ToListAsync(ct);
        var artifacts = await _db.Artifacts.Where(a => a.TestExecutionId == execution.Id)
            .Select(a => (object)new { a.Id, Kind = a.Kind.ToString(), a.Name, a.ContentType, a.SizeBytes }).ToListAsync(ct);
        var viewport = testCase.Steps.Where(s => s.Action == BrowserActionType.SetViewport).Select(s => s.Value).LastOrDefault();

        // The API exchanges around the failure: what the page asked, and what came back.
        var exchanges = network.Where(n => n.ResourceType is "xhr" or "fetch" or "document" && n.Method != "GET" || n.StatusCode >= 400)
            .Select(n => (object)new { n.Method, n.Url, n.StatusCode, n.DurationMs, request = n.RequestBodyExcerpt, response = n.ResponseBodyExcerpt }).ToList();

        return Result<FailureReport>.Success(new FailureReport(
            failure.Id, testCase.Id, testCase.Reference, testCase.Name,
            testCase.Category is null ? null : Forms.TestingProfile.CategoryKey(testCase.Category.Value), testCase.Technique,
            application?.Name ?? "(unknown)", form?.PageUrl ?? action?.Url, form?.Name, testCase.FieldKey,
            SeverityOf(testCase).ToString(), testCase.Priority.ToString(), testCase.ExpectedResults, failure.RawMessage,
            action?.ErrorMessage ?? execution.ErrorMessage ?? failure.RawMessage, failure.RawStack, action?.Url,
            execution.Browser.ToString(), execution.BrowserVersion, viewport ?? "1440x900 (default)",
            failure.CreatedAt, execution.Id, execution.TestRunId, environment,
            exchanges, console,
            network.Select(n => (object)new { n.Method, n.Url, n.StatusCode, n.DurationMs, n.IsFailed, n.FailureText }).ToList(),
            artifacts,
            string.IsNullOrEmpty(testCase.TestDataJson) ? null : JsonSerializer.Deserialize<Dictionary<string, string>>(testCase.TestDataJson),
            testCase.Steps.OrderBy(s => s.Order).Select(s => $"{s.Order}. {s.Description}").ToList(),
            failure.DefectId, failure.Category.ToString(), failure.Analysis?.Summary));
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
