using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using QaNxt.Application.Security;
using QaNxt.Domain.Applications;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Testing;
using QaNxt.Application.Testing;

namespace QaNxt.Application.Forms;

public sealed record GenerateFormTestsRequest(
    Guid ApplicationId,
    /// <summary>Only these forms; empty means every form discovery found.</summary>
    Guid[]? FormIds = null,
    string? SuiteName = null);

public sealed record FormGenerationSummary(
    Guid FormId, string Name, string Route, int Fields, int Tests, int Gaps, int HumanTasks, int Findings,
    IReadOnlyDictionary<string, int> TestsByCategory, IReadOnlyList<string> NotApplicable);

public sealed record GenerateFormTestsResult(
    Guid TestSuiteId, string TestSuiteName, int Forms, int TestsCreated, int TestsUpdated, int TestsUnchanged,
    int TestsDeprecated, int TestsLeftAsEdited, int Gaps, int HumanTasks, int Findings,
    bool UsedAi, string Engine, IReadOnlyList<FormGenerationSummary> PerForm, IReadOnlyList<string> Warnings);

public sealed record ApplicationFormSummary(
    Guid Id, string FormKey, string Name, string Route, string PageUrl, string Method, string? Action,
    bool IsMultiStep, bool HasCsrfToken, int FieldCount, int RequiredFieldCount, int DependencyCount,
    bool IsPresent, DateTimeOffset LastSeenAt, DateTimeOffset? ChangedAt);

public interface IFormTestingService
{
    Task<Result<IReadOnlyList<ApplicationFormSummary>>> ListFormsAsync(Guid applicationId, CancellationToken ct = default);
    Task<Result<DiscoveredFormModel>> GetFormModelAsync(Guid formId, CancellationToken ct = default);
    Task<Result<TestingProfile>> GetProfileAsync(Guid applicationId, CancellationToken ct = default);
    Task<Result<TestingProfile>> SaveProfileAsync(Guid applicationId, TestingProfile profile, CancellationToken ct = default);
    Task<Result<GenerateFormTestsResult>> GenerateAsync(GenerateFormTestsRequest request, CancellationToken ct = default);
}

/// <summary>Turns every discovered form into its test suite, its gaps, its human tasks and
/// its findings, and keeps them in step with the application as it changes.
///
/// No model is consulted. The project's AI switch does not apply here, because nothing
/// here is AI: a project with AI turned off generates exactly the same tests.
///
/// Regeneration is careful about what it owns. A generated test keeps its identity (its
/// generation key) across runs, so its history survives. A test a person edited is never
/// overwritten — the edit is theirs, and "nothing changes itself without asking". A test
/// whose field disappeared is deprecated, not deleted, so its results still mean something.
/// A verdict somebody gave a human verification task is never reset.</summary>
public sealed class FormTestingService : IFormTestingService
{
    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly Applications.IApplicationService _applications;
    private readonly ILogger<FormTestingService> _logger;

    public FormTestingService(IQaNxtDbContext db, ICurrentUser currentUser, IClock clock, IAuditLogger audit,
        Applications.IApplicationService applications, ILogger<FormTestingService> logger)
    {
        _db = db;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
        _applications = applications;
        _logger = logger;
    }

    public async Task<Result<IReadOnlyList<ApplicationFormSummary>>> ListFormsAsync(Guid applicationId, CancellationToken ct = default)
    {
        if (!await _db.Applications.AnyAsync(a => a.Id == applicationId, ct)) return Error.NotFound("The application");
        var forms = await _db.ApplicationForms.Where(f => f.ApplicationId == applicationId)
            .OrderBy(f => f.Route).ThenBy(f => f.FormKey)
            .Select(f => new ApplicationFormSummary(f.Id, f.FormKey, f.Name, f.Route, f.PageUrl, f.Method, f.Action,
                f.IsMultiStep, f.HasCsrfToken, f.FieldCount, f.RequiredFieldCount, f.DependencyCount, f.IsPresent, f.LastSeenAt, f.ChangedAt))
            .ToListAsync(ct);
        return Result<IReadOnlyList<ApplicationFormSummary>>.Success(forms);
    }

    public async Task<Result<DiscoveredFormModel>> GetFormModelAsync(Guid formId, CancellationToken ct = default)
    {
        var form = await _db.ApplicationForms.FirstOrDefaultAsync(f => f.Id == formId, ct);
        if (form is null) return Error.NotFound("The form");
        var model = DiscoveredFormModel.FromJson(form.ModelJson);
        return model is null
            ? Error.Validation("The stored form could not be read; discover the application again.")
            : Result<DiscoveredFormModel>.Success(model);
    }

    public async Task<Result<TestingProfile>> GetProfileAsync(Guid applicationId, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == applicationId, ct);
        if (application is null) return Error.NotFound("The application");
        return Result<TestingProfile>.Success(TestingProfile.FromJson(application.TestingConfigJson));
    }

    public async Task<Result<TestingProfile>> SaveProfileAsync(Guid applicationId, TestingProfile profile, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == applicationId, ct);
        if (application is null) return Error.NotFound("The application");
        var problems = profile.Validate();
        if (problems.Count > 0) return Error.Validation(string.Join(" ", problems));

        application.TestingConfigJson = profile.ToJson();
        application.UpdatedByUserId = _currentUser.UserId;
        await _db.SaveChangesAsync(ct);
        await _audit.LogAsync(AuditAction.ConfigurationChanged, nameof(Domain.Applications.Application), application.Id,
            $"Testing configuration for '{application.Name}' set to {profile.Mode} with {profile.EffectiveCategories().Count} categories.",
            projectId: application.ProjectId, ct: ct);
        return Result<TestingProfile>.Success(profile);
    }

    public async Task<Result<GenerateFormTestsResult>> GenerateAsync(GenerateFormTestsRequest request, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == request.ApplicationId, ct);
        if (application is null) return Error.NotFound("The application");
        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == application.ProjectId, ct);
        if (project is null) return Error.NotFound("The project");

        var query = _db.ApplicationForms.Where(f => f.ApplicationId == application.Id && f.IsPresent);
        if (request.FormIds is { Length: > 0 }) query = query.Where(f => request.FormIds.Contains(f.Id));
        var forms = await query.OrderBy(f => f.Route).ThenBy(f => f.FormKey).ToListAsync(ct);
        if (forms.Count == 0)
        {
            return Error.Validation(request.FormIds is { Length: > 0 }
                ? "None of the selected forms is present in the latest discovery."
                : "Discovery has not found any forms in this application yet. Run discovery first; if it has run, the pages it reached have no forms.");
        }

        var profile = TestingProfile.FromJson(application.TestingConfigJson);
        // Only whether credentials exist is needed here; their values go no further than this line.
        var credentials = await _applications.ResolveCredentialsAsync(application, ct);
        var hasCredentials = !string.IsNullOrEmpty(credentials.Username) && !string.IsNullOrEmpty(credentials.Password);
        var pageIds = forms.Select(f => f.ApplicationPageId).Distinct().ToList();
        var endpoints = await _db.ApiEndpoints.Where(e => e.ApplicationId == application.Id && e.TriggeredByPageId != null && pageIds.Contains(e.TriggeredByPageId.Value))
            .Select(e => new { e.TriggeredByPageId, e.Method, e.UrlTemplate }).ToListAsync(ct);

        var suite = await ResolveSuiteAsync(project.Id, request.SuiteName ?? $"{application.Name} — form tests", ct);
        var warnings = new List<string>();
        var policy = new BrowserActionPolicy(AllowScriptExecution: false, AllowXPathLocators: true,
            (string url, out string reason) => { reason = string.Empty; return true; });

        var existing = await _db.TestCases
            .Where(tc => tc.ProjectId == project.Id && tc.ApplicationId == application.Id && tc.GenerationKey != null)
            .Include(tc => tc.Steps).ThenInclude(s => s.Assertions)
            .ToListAsync(ct);
        var byKey = existing.ToDictionary(tc => tc.GenerationKey!, StringComparer.Ordinal);
        var reference = await NextReferenceNumberAsync(project.Id, ct);
        var formIds = forms.Select(f => f.Id).ToList();

        // Gaps and findings are derived state: rebuilt for the forms generated now.
        _db.CoverageGaps.RemoveRange(await _db.CoverageGaps.Where(g => g.ApplicationId == application.Id
            && (g.ApplicationFormId == null || formIds.Contains(g.ApplicationFormId.Value))).ToListAsync(ct));
        _db.FormFindings.RemoveRange(await _db.FormFindings.Where(f => formIds.Contains(f.ApplicationFormId)).ToListAsync(ct));
        var tasks = await _db.HumanVerificationTasks.Where(t => t.ApplicationId == application.Id && t.GenerationKey != null).ToListAsync(ct);
        var tasksByKey = tasks.ToDictionary(t => t.GenerationKey!, StringComparer.Ordinal);

        int created = 0, updated = 0, unchanged = 0, deprecated = 0, leftAsEdited = 0, gapCount = 0, taskCount = 0, findingCount = 0;
        var perForm = new List<FormGenerationSummary>();
        var designedKeys = new HashSet<string>(StringComparer.Ordinal);

        foreach (var form in forms)
        {
            var model = DiscoveredFormModel.FromJson(form.ModelJson);
            if (model is null)
            {
                warnings.Add($"The stored model of {form.Name} ({form.Route}) could not be read; discover the application again.");
                continue;
            }

            var design = FormTestDesigner.Design(new FormDesignContext(
                form.Id, model, form.PageUrl, form.Route, FormName(form, model), hasCredentials,
                endpoints.Where(e => e.TriggeredByPageId == form.ApplicationPageId).Select(e => new CorrelatedEndpoint(e.Method, e.UrlTemplate)).ToList(),
                profile));

            var formTests = 0;
            foreach (var designed in design.Tests)
            {
                var invalid = Invalid(designed, policy);
                if (invalid is not null)
                {
                    // Never stored as a test that would fail for a reason the platform already
                    // knows; recorded as a gap, so the omission is visible.
                    warnings.Add($"{designed.Name}: not stored, a step is not executable ({invalid}).");
                    _db.CoverageGaps.Add(NewGap(project.Id, application.Id, form.Id, new DesignedGap(designed.Category, designed.FieldKey,
                        designed.Name, $"The designed test could not be expressed as executable steps: {invalid}", "Report this as a QA NXT defect.", CoverageGapStatus.NotCovered)));
                    gapCount++;
                    continue;
                }

                designedKeys.Add(designed.Key);
                formTests++;
                if (byKey.TryGetValue(designed.Key, out var testCase))
                {
                    switch (Reconcile(testCase, designed, form.Id))
                    {
                        case Outcome.Unchanged: unchanged++; break;
                        case Outcome.Updated: updated++; break;
                        case Outcome.LeftAsEdited: leftAsEdited++; break;
                    }
                }
                else
                {
                    testCase = NewTestCase(designed, suite, project.Id, application.Id, form.Id, $"TC-{reference++:0000}");
                    _db.TestCases.Add(testCase);
                    WriteSteps(testCase, designed);
                    byKey[designed.Key] = testCase;
                    created++;
                }
            }

            foreach (var gap in design.Gaps)
            {
                _db.CoverageGaps.Add(NewGap(project.Id, application.Id, form.Id, gap));
                gapCount++;
            }

            foreach (var task in design.HumanTasks)
            {
                taskCount++;
                if (tasksByKey.TryGetValue(task.Key, out var existingTask))
                {
                    existingTask.Title = task.Title;
                    existingTask.Reason = task.Reason;
                    existingTask.Steps = task.Steps;
                    existingTask.ExpectedResult = task.Expected;
                    continue;
                }
                var newTask = new HumanVerificationTask
                {
                    ProjectId = project.Id, ApplicationId = application.Id, ApplicationFormId = form.Id,
                    Title = task.Title, Category = task.Category, Reason = task.Reason, Steps = task.Steps,
                    ExpectedResult = task.Expected, Origin = "generated", GenerationKey = task.Key, CreatedAt = _clock.UtcNow
                };
                _db.HumanVerificationTasks.Add(newTask);
                tasksByKey[task.Key] = newTask;
            }

            foreach (var finding in design.Findings)
            {
                _db.FormFindings.Add(new FormFinding
                {
                    ApplicationId = application.Id, ApplicationFormId = form.Id, Kind = finding.Kind, Code = finding.Code,
                    FieldKey = finding.FieldKey, Message = Truncate(finding.Message, 1000), Severity = finding.Severity, CreatedAt = _clock.UtcNow
                });
                findingCount++;
            }

            perForm.Add(new FormGenerationSummary(form.Id, FormName(form, model), form.Route, model.Fields.Count, formTests,
                design.Gaps.Count, design.HumanTasks.Count, design.Findings.Count,
                design.Tests.GroupBy(t => TestingProfile.CategoryKey(t.Category)).ToDictionary(g => g.Key, g => g.Count()),
                profile.EffectiveCategories().Where(c => !design.Applicable.Contains(c)).Select(TestingProfile.CategoryKey).ToList()));
        }

        // Tests made for these forms that the design no longer contains: the field or the
        // rule is gone. Deprecated, never deleted.
        foreach (var testCase in existing.Where(tc => tc.ApplicationFormId is { } id && formIds.Contains(id) && !designedKeys.Contains(tc.GenerationKey!)
                     && tc.Lifecycle is TestCaseLifecycle.Active or TestCaseLifecycle.Draft && tc.Source == TestCaseSource.RuleGenerated))
        {
            Snapshot(testCase, "Deprecated: the form no longer has what this test checked.");
            testCase.SetLifecycle(TestCaseLifecycle.Deprecated);
            deprecated++;
        }

        // Things no form-level design can cover, said once per application.
        foreach (var gap in ApplicationGaps(profile))
        {
            _db.CoverageGaps.Add(NewGap(project.Id, application.Id, null, gap));
            gapCount++;
        }

        await _db.SaveChangesAsync(ct);

        if (leftAsEdited > 0)
            warnings.Add($"{leftAsEdited} test(s) were edited by a person and the form has changed since. They were left as edited; review them against the form.");
        if (deprecated > 0)
            warnings.Add($"{deprecated} generated test(s) were deprecated because what they tested is no longer on the form.");

        await _audit.LogAsync(AuditAction.TestCaseCreated, nameof(TestSuite), suite.Id,
            $"Form test generation for '{application.Name}': {forms.Count} form(s), {created} created, {updated} updated, {deprecated} deprecated, {gapCount} gap(s). Deterministic engine; no AI.",
            projectId: project.Id, ct: ct);

        _logger.LogInformation("Generated form tests for {Application}: {Forms} forms, {Created} created, {Updated} updated, {Gaps} gaps",
            application.Id, forms.Count, created, updated, gapCount);

        return Result<GenerateFormTestsResult>.Success(new GenerateFormTestsResult(suite.Id, suite.Name, forms.Count, created, updated, unchanged, deprecated, leftAsEdited,
            gapCount, taskCount, findingCount, UsedAi: false, Engine: "QA NXT form test engine (deterministic)", perForm, warnings));
    }

    private static string FormName(ApplicationForm form, DiscoveredFormModel model)
        => string.IsNullOrWhiteSpace(model.Name) ? form.Route : model.Name;

    private static IEnumerable<DesignedGap> ApplicationGaps(TestingProfile profile)
    {
        if (profile.Includes(TestCategory.Performance))
            yield return new DesignedGap(TestCategory.Performance, null, "load, stress, spike and endurance testing",
                "These need many concurrent virtual users over time. The browser worker measures single-user response times; it is not a load generator.",
                "Use a load-testing tool (k6, Gatling, JMeter) against the endpoints listed under API.", CoverageGapStatus.Unsupported);
        if (profile.Includes(TestCategory.Workflow))
            yield return new DesignedGap(TestCategory.Workflow, null, "journeys across several forms",
                "End-to-end workflows are taken from recorded journeys. They are not inferred from discovery, because the order of real business steps is not visible in the page.",
                "Record the application's key journeys with the browser extension.", CoverageGapStatus.PartiallyCovered);
    }

    // ---- Persistence helpers -------------------------------------------------------

    private enum Outcome { Unchanged, Updated, LeftAsEdited }

    /// <summary>Brings an existing generated test in line with its design, unless a person
    /// has edited it.</summary>
    private Outcome Reconcile(TestCase testCase, DesignedTest designed, Guid formId)
    {
        var current = StoredFingerprint(testCase);
        var wanted = DesignedFingerprint(designed);

        testCase.ApplicationFormId = formId;
        testCase.CoverageKeysJson = JsonSerializer.Serialize(designed.CoverageKeys);
        if (current == wanted) return Outcome.Unchanged;
        if (testCase.UpdatedByUserId is not null) return Outcome.LeftAsEdited;

        Snapshot(testCase, "Regenerated: the discovered form changed.");
        foreach (var step in testCase.Steps.ToList())
        {
            _db.Assertions.RemoveRange(step.Assertions);
            _db.TestSteps.Remove(step);
        }
        testCase.Steps.Clear();
        ApplyMetadata(testCase, designed);
        testCase.Version++;
        WriteSteps(testCase, designed);
        if (testCase.Lifecycle == TestCaseLifecycle.Deprecated) testCase.SetLifecycle(TestCaseLifecycle.Active);
        return Outcome.Updated;
    }

    // Steps and their assertions, with locators compared as canonical JSON: the columns are
    // jsonb, which stores keys in its own order, so the text read back never equals the text
    // written and every regeneration would otherwise look like a change.
    private static string StoredFingerprint(TestCase testCase)
        => string.Join("\n", testCase.Steps.OrderBy(s => s.Order).Select(s =>
            StepLine(s.Action, s.TargetJson, s.Value, s.Url) + string.Concat(s.Assertions
                .OrderBy(a => a.Type).ThenBy(a => a.Negate)
                .Select(a => AssertionLine(a.Type, a.TargetJson, a.ExpectedValue, a.AttributeName, a.Negate)))));

    private static string DesignedFingerprint(DesignedTest designed)
        => string.Join("\n", designed.Steps.Select(s =>
        {
            var target = s.Target?.ToJson();
            var assertions = new List<(AssertionType Type, string? Expected, string? Attribute, bool Negate)>();
            if (AssertionFor(s.Action) is { } verdict)
                assertions.Add((verdict, s.Expected ?? (s.Action == BrowserActionType.AssertCount ? s.Count?.ToString() : null), s.Attribute, false));
            if (s.ExtraAssertion is { } extra) assertions.Add((extra, s.ExtraExpected, null, s.ExtraNegate));
            return StepLine(s.Action, target, s.Value is null ? null : Truncate(s.Value, 4000), s.Url is null ? null : Truncate(s.Url, 2048))
                + string.Concat(assertions.OrderBy(a => a.Type).ThenBy(a => a.Negate)
                    .Select(a => AssertionLine(a.Type, target, a.Expected, a.Attribute, a.Negate)));
        }));

    private static string StepLine(BrowserActionType action, string? target, string? value, string? url)
        => $"{action}|{CanonicalJson(target)}|{value}|{url}";

    private static string AssertionLine(AssertionType type, string? target, string? expected, string? attribute, bool negate)
        => $" [{type}|{CanonicalJson(target)}|{expected}|{attribute}|{negate}]";

    private static string? CanonicalJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var document = JsonDocument.Parse(json);
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream)) Write(document.RootElement, writer);
            return System.Text.Encoding.UTF8.GetString(stream.ToArray());
        }
        catch (JsonException)
        {
            return json;
        }

        static void Write(JsonElement element, Utf8JsonWriter writer)
        {
            switch (element.ValueKind)
            {
                case JsonValueKind.Object:
                    writer.WriteStartObject();
                    foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                    {
                        writer.WritePropertyName(property.Name);
                        Write(property.Value, writer);
                    }
                    writer.WriteEndObject();
                    break;
                case JsonValueKind.Array:
                    writer.WriteStartArray();
                    foreach (var item in element.EnumerateArray()) Write(item, writer);
                    writer.WriteEndArray();
                    break;
                default:
                    element.WriteTo(writer);
                    break;
            }
        }
    }

    private void Snapshot(TestCase testCase, string summary)
        => _db.TestCaseVersions.Add(TestCaseHistory.SnapshotOf(testCase, summary, _currentUser.UserId, _clock.UtcNow));

    private TestCase NewTestCase(DesignedTest designed, TestSuite suite, Guid projectId, Guid applicationId, Guid formId, string reference)
    {
        var testCase = new TestCase
        {
            ProjectId = projectId,
            TestSuiteId = suite.Id,
            ApplicationId = applicationId,
            ApplicationFormId = formId,
            Reference = reference,
            Source = TestCaseSource.RuleGenerated,
            GenerationKey = designed.Key,
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };
        ApplyMetadata(testCase, designed);
        testCase.SetLifecycle(TestCaseLifecycle.Active);
        return testCase;
    }

    private static void ApplyMetadata(TestCase testCase, DesignedTest designed)
    {
        testCase.Name = Truncate(designed.Name, 300);
        testCase.Objective = Truncate(designed.Objective, 2000);
        testCase.Preconditions = Truncate(designed.Preconditions, 2000);
        testCase.ExpectedResults = Truncate(designed.Expected, 4000);
        testCase.Priority = designed.Priority;
        testCase.Risk = designed.Risk;
        testCase.Category = designed.Category;
        testCase.Technique = Truncate(designed.Technique, 120);
        testCase.FieldKey = designed.FieldKey is null ? null : Truncate(designed.FieldKey, 200);
        testCase.Tags = Truncate(string.Join(',', designed.Tags.Distinct()), 500);
        testCase.CoverageKeysJson = JsonSerializer.Serialize(designed.CoverageKeys);
        testCase.TestDataJson = designed.TestData.Count == 0 ? null : JsonSerializer.Serialize(designed.TestData);
        testCase.EvidenceRequirements = Truncate(designed.EvidenceRequirements, 1000);
        testCase.AutomationStatus = AutomationStatus.Automated;
        testCase.Kind = TestCaseKind.Ui;
    }

    private void WriteSteps(TestCase testCase, DesignedTest designed)
    {
        var order = 1;
        foreach (var step in designed.Steps)
        {
            var testStep = new TestStep
            {
                OrganizationId = testCase.OrganizationId,
                TestCaseId = testCase.Id,
                Order = order++,
                Description = Truncate(step.Description, 1000),
                Action = step.Action,
                TargetJson = step.Target?.ToJson(),
                Value = step.Value is null ? null : Truncate(step.Value, 4000),
                Url = step.Url is null ? null : Truncate(step.Url, 2048),
                CreatedAt = _clock.UtcNow
            };
            _db.TestSteps.Add(testStep);
            testCase.Steps.Add(testStep);

            var verdict = AssertionFor(step.Action);
            if (verdict is not null)
            {
                var assertion = new Assertion
                {
                    OrganizationId = testCase.OrganizationId, TestStepId = testStep.Id, Type = verdict.Value,
                    TargetJson = step.Target?.ToJson(), ExpectedValue = step.Expected ?? (step.Action == BrowserActionType.AssertCount ? step.Count?.ToString() : null),
                    AttributeName = step.Attribute, Description = Truncate(step.Description, 1000), CreatedAt = _clock.UtcNow
                };
                _db.Assertions.Add(assertion);
                testStep.Assertions.Add(assertion);
            }
            if (step.ExtraAssertion is { } extra)
            {
                var assertion = new Assertion
                {
                    OrganizationId = testCase.OrganizationId, TestStepId = testStep.Id, Type = extra,
                    TargetJson = step.Target?.ToJson(), ExpectedValue = step.ExtraExpected, Negate = step.ExtraNegate,
                    Description = Truncate($"{step.Description} ({(step.ExtraNegate ? "must not be" : "must be")} \"{step.ExtraExpected}\")", 1000),
                    CreatedAt = _clock.UtcNow
                };
                _db.Assertions.Add(assertion);
                testStep.Assertions.Add(assertion);
            }
        }
    }

    /// <summary>The planned assertion that records a step's own check, so reports can count
    /// what a test asserts. Verbs whose expectation the engine reads from an assertion
    /// (text, value, attribute) get the matching type; the form oracles get StepVerdict.</summary>
    private static AssertionType? AssertionFor(BrowserActionType action) => action switch
    {
        BrowserActionType.AssertText => AssertionType.TextContains,
        BrowserActionType.AssertVisible => AssertionType.Visible,
        BrowserActionType.AssertHidden => AssertionType.Hidden,
        BrowserActionType.AssertUrl => AssertionType.UrlContains,
        BrowserActionType.AssertValue => AssertionType.ValueEquals,
        BrowserActionType.AssertCount => AssertionType.CountEquals,
        BrowserActionType.AssertAttribute => AssertionType.AttributeEquals,
        BrowserActionType.AssertEnabled => AssertionType.Enabled,
        BrowserActionType.AssertDisabled => AssertionType.Disabled,
        BrowserActionType.CheckAccessibility or BrowserActionType.CheckVisual => AssertionType.StepVerdict,
        _ when BrowserActionVerbs.IsAssertion(action) => AssertionType.StepVerdict,
        _ => null
    };

    private static string? Invalid(DesignedTest designed, BrowserActionPolicy policy)
    {
        foreach (var step in designed.Steps)
        {
            var result = BrowserActionValidator.Validate(new BrowserAction
            {
                Action = step.Action, Description = step.Description, Target = step.Target, Value = step.Value,
                Url = step.Url, Expected = step.Expected, Attribute = step.Attribute, Count = step.Count
            }, policy);
            if (!result.IsValid) return $"step \"{step.Description}\": {string.Join("; ", result.Errors)}";
        }
        return designed.Steps.Any(s => BrowserActionVerbs.IsAssertion(s.Action) || s.Action is BrowserActionType.CheckAccessibility or BrowserActionType.CheckVisual)
            ? null : "it asserts nothing";
    }

    private CoverageGap NewGap(Guid projectId, Guid applicationId, Guid? formId, DesignedGap gap) => new()
    {
        ProjectId = projectId, ApplicationId = applicationId, ApplicationFormId = formId, FieldKey = gap.FieldKey,
        Category = gap.Category, Missing = Truncate(gap.Missing, 500), Reason = Truncate(gap.Reason, 2000),
        RecommendedAction = Truncate(gap.Action, 1000), Status = gap.Status, CreatedAt = _clock.UtcNow
    };

    private async Task<TestSuite> ResolveSuiteAsync(Guid projectId, string name, CancellationToken ct)
    {
        var suite = await _db.TestSuites.FirstOrDefaultAsync(s => s.ProjectId == projectId && s.Name == name, ct);
        if (suite is not null) return suite;
        suite = new TestSuite
        {
            ProjectId = projectId,
            Name = Truncate(name, 200),
            Description = "Generated from the discovered forms by QA NXT's deterministic form test engine. No AI was used.",
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };
        _db.TestSuites.Add(suite);
        await _db.SaveChangesAsync(ct);
        return suite;
    }

    private async Task<int> NextReferenceNumberAsync(Guid projectId, CancellationToken ct)
    {
        var references = await _db.TestCases.IgnoreQueryFilters()
            .Where(tc => tc.ProjectId == projectId && tc.Reference.StartsWith("TC-"))
            .Select(tc => tc.Reference).ToListAsync(ct);
        return references.Select(r => int.TryParse(r[3..], out var n) ? n : 0).DefaultIfEmpty(0).Max() + 1;
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
