using System.Text.Json;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Ai;
using QaNxt.Application.Contracts;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace QaNxt.Application.Testing;

public sealed record GenerateTestsRequest(
    Guid ApplicationId,
    Guid? TestSuiteId,
    string? SuiteName,
    /// <summary>A natural-language requirement, user story or acceptance criterion.</summary>
    string? Requirement,
    /// <summary>Restricts generation to these pages; empty means the whole application.</summary>
    Guid[]? PageIds,
    int? MaxScenarios);

public sealed record GeneratedTestSummary(
    Guid TestSuiteId, string TestSuiteName, int CasesCreated, int StepsCreated,
    string PlanSummary, LlmProviderKind Provider, string Model, bool IsLocalProvider,
    Guid AiRequestId, int PromptTokens, int CompletionTokens, decimal EstimatedCostUsd,
    IReadOnlyList<string> Warnings);

public interface ITestGenerationService
{
    Task<Result<GeneratedTestSummary>> GenerateAsync(GenerateTestsRequest request, CancellationToken ct = default);
}

/// <summary>Turns the discovered application model into reviewable, executable test cases.
///
/// Generation never produces something the engine cannot run: every step a model proposes
/// is validated against the same <see cref="BrowserActionValidator"/> that guards live
/// execution, and a scenario containing an invalid step is dropped with a warning rather
/// than stored as a test that will fail confusingly later. Generated cases are marked as
/// AI-authored and carry the id of the request that produced them, so their provenance is
/// always recoverable.</summary>
public sealed class TestGenerationService : ITestGenerationService
{
    /// <summary>How many pages one generation call reads.
    ///
    /// Still bounded, because this becomes one request payload, but the old 25 silently
    /// excluded most of a large application from ever being considered. The summary says
    /// when it bit, so a truncated run no longer looks like a complete one.</summary>
    private const int MaxPagesInContext = 200;
    private const int MaxElementsPerPage = 30;

    private readonly IQaNxtDbContext _db;
    private readonly IAiOrchestrator _ai;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly SecretMasker _masker;
    private readonly ILogger<TestGenerationService> _logger;

    public TestGenerationService(IQaNxtDbContext db, IAiOrchestrator ai, ICurrentUser currentUser,
        IClock clock, IAuditLogger audit, SecretMasker masker, ILogger<TestGenerationService> logger)
    {
        _db = db;
        _ai = ai;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
        _masker = masker;
        _logger = logger;
    }

    public async Task<Result<GeneratedTestSummary>> GenerateAsync(GenerateTestsRequest request, CancellationToken ct = default)
    {
        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == request.ApplicationId, ct);
        if (application is null) return Error.NotFound("The application");

        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == application.ProjectId, ct);
        if (project is null) return Error.NotFound("The project");
        if (!project.AiEnabled) return Error.Validation("AI features are disabled for this project.");

        var pages = await LoadPagesAsync(request, ct);
        if (pages.Count == 0)
        {
            return Error.Validation(
                "This application has no discovered pages yet. Run discovery before generating tests.");
        }

        var discoveredPages = await _db.ApplicationPages
            .CountAsync(p => p.ApplicationId == request.ApplicationId, ct);

        var context = BuildContext(application.BaseUrl, request.Requirement, pages,
            request.MaxScenarios ?? DefaultScenarioBudget,
            application.AuthStrategy != AuthenticationStrategy.None);

        var result = await _ai.ExecuteAsync<GeneratedTestPlan>(new AiCallOptions
        {
            Kind = AiRequestKind.TestCaseGeneration,
            SchemaName = AiSchemaCatalog.TestPlan,
            ProjectId = project.Id,
            PreferredProvider = project.AiProvider,
            Model = project.AiModel,
            MaxTokens = 8000,
            SystemPrompt = SystemPrompt,
            UserPrompt = BuildUserPrompt(application.Name, application.BaseUrl, request.Requirement, pages.Count),
            Context = context
        }, ct);

        if (!result.IsSuccess || result.Value is null)
            return Error.Dependency("ai_generation_failed", result.Error ?? "Test generation failed.");

        var suite = await ResolveSuiteAsync(request, project.Id, application.Name, ct);

        // The budget is enforced here rather than only asked for in the prompt. The
        // built-in rules planner generates one scenario per page and ignores it, and a
        // hosted model is under no obligation to obey it either — so a caller who asked
        // for two test cases was getting eleven (BUG-0011).
        var plan = result.Value;
        var budget = request.MaxScenarios ?? DefaultScenarioBudget;
        var truncated = 0;
        if (budget > 0 && plan.Scenarios.Count > budget)
        {
            truncated = plan.Scenarios.Count - budget;
            plan = plan with { Scenarios = plan.Scenarios.Take(budget).ToList() };
        }

        var persisted = await PersistAsync(plan, suite, project, application.Id, result.AiRequestId,
            request.Requirement, ct);

        if (truncated > 0)
        {
            persisted.Warnings.Add(
                $"The plan proposed {truncated + budget} scenarios; {truncated} were dropped to stay "
                + $"within the requested limit of {budget}. Raise or clear the limit to keep them.");
        }

        if (discoveredPages > pages.Count)
        {
            // Said out loud. A run that considered 200 of 900 pages is not a run that
            // covered the application, and nothing else on the screen would reveal it.
            persisted.Warnings.Add(
                $"This application has {discoveredPages} discovered pages and this run considered "
                + $"{pages.Count} of them. The rest are not covered by these tests. Generate again "
                + "with a page selection to reach them.");
        }

        await _audit.LogAsync(AuditAction.AiGeneration, nameof(TestSuite), suite.Id,
            $"Generated {persisted.Cases} test case(s) for '{application.Name}' using {result.Provider}/{result.Model}.",
            projectId: project.Id, ct: ct);

        return Result<GeneratedTestSummary>.Success(new GeneratedTestSummary(
            suite.Id, suite.Name, persisted.Cases, persisted.Steps, plan.Summary,
            result.Provider, result.Model, result.IsLocalProvider, result.AiRequestId,
            result.Usage?.PromptTokens ?? 0, result.Usage?.CompletionTokens ?? 0,
            result.EstimatedCostUsd, persisted.Warnings));
    }

    private const string SystemPrompt = """
        You are a senior QA engineer writing automated tests for a web application.

        You are given the application's discovered page model: real pages, and the real
        elements observed on them with their accessible names, roles, labels and test ids.

        Rules:
        - Use only elements that appear in the supplied model. Never invent a locator.
        - Prefer the most stable locator available for an element: testId, then role with
          its accessible name, then label, then placeholder. Use css only as a last resort.
        - Cover the positive path first, then negative, boundary, validation and
          session-handling cases where the page supports them.
        - Every scenario must assert something observable. A scenario that only performs
          actions proves nothing.
        - Never put a real credential in a step value. Use ${secret:name} references.
        - Keep each scenario independent: it must start from a known state and not depend
          on another scenario having run.
        """;

    private static string BuildUserPrompt(string applicationName, string baseUrl, string? requirement, int pageCount)
    {
        var scope = requirement is null
            ? $"Generate a test plan covering the {pageCount} discovered pages."
            : $"Generate a test plan for this requirement:\n\n{requirement}\n\nUse the {pageCount} discovered pages as the source of truth for what exists.";

        return $"""
            Application: {applicationName}
            Base URL: {baseUrl}

            {scope}

            The discovered page model follows as JSON.
            """;
    }

    private async Task<List<PageContext>> LoadPagesAsync(GenerateTestsRequest request, CancellationToken ct)
    {
        var query = _db.ApplicationPages.Where(p => p.ApplicationId == request.ApplicationId);
        if (request.PageIds is { Length: > 0 }) query = query.Where(p => request.PageIds.Contains(p.Id));

        var pages = await query
            // Shallow, element-rich pages first: they are where the journeys start.
            .OrderBy(p => p.Depth).ThenByDescending(p => p.ElementCount)
            .Take(MaxPagesInContext)
            .Select(p => new
            {
                p.Id, p.Url, p.Route, p.Title, p.Kind, p.Depth, p.RequiresAuthentication, p.ElementCount
            })
            .ToListAsync(ct);

        var pageIds = pages.Select(p => p.Id).ToList();
        var elements = await _db.ApplicationElements
            .Where(e => pageIds.Contains(e.ApplicationPageId) && e.IsVisible)
            .Select(e => new
            {
                e.Id, e.ApplicationPageId, e.Kind, e.TagName, e.AriaRole, e.AccessibleName, e.Text,
                e.Label, e.Placeholder, e.TestId, e.Name, e.Type, e.IsRequired, e.CssSelector,
                e.StabilityScore
            })
            .ToListAsync(ct);

        return pages.Select(page => new PageContext(
            page.Route, page.Url, page.Title, page.Kind.ToString().ToLowerInvariant(),
            page.Depth, page.RequiresAuthentication, page.ElementCount,
            elements.Where(e => e.ApplicationPageId == page.Id)
                .OrderBy(e => TestabilityRank(e.Kind))
                .ThenByDescending(e => e.StabilityScore)
                .ThenBy(e => e.TestId ?? string.Empty)
                .ThenBy(e => e.Id)
                .Take(MaxElementsPerPage)
                .Select(e => new ElementContext(
                    e.Kind.ToString().ToLowerInvariant(), e.TagName, e.AriaRole,
                    _masker.MaskText(e.AccessibleName ?? string.Empty) is { Length: > 0 } name ? name : null,
                    e.Label, e.Placeholder, e.TestId, e.Name, e.Type, e.IsRequired, e.CssSelector))
                .ToList()))
            .ToList();
    }

    /// <summary>What a page's elements are worth to a test author, most first.
    ///
    /// A page can hold more elements than the context carries, and the cut used to be made
    /// on stability score alone — which the crawler gives every stable element equally, so
    /// the order was really the database's and the cut was arbitrary. A page's form controls
    /// were dropped in favour of the navigation links that appear on every page, and two
    /// runs against the same model saw different elements. The generated tests varied with
    /// it: the same scenario filled a date range in the right order on one run and the wrong
    /// one on the next (BUG-0016).
    ///
    /// Controls a test acts on come first, then the content it asserts about, then the
    /// furniture. Within a rank the order is stability, then test id, then id, so the same
    /// model always produces the same context.</summary>
    private static int TestabilityRank(ElementKind kind) => kind switch
    {
        ElementKind.TextInput or ElementKind.PasswordInput or ElementKind.NumberInput
            or ElementKind.DateInput or ElementKind.FileInput or ElementKind.Checkbox
            or ElementKind.Radio or ElementKind.Select or ElementKind.TextArea => 0,
        ElementKind.Button => 1,
        ElementKind.Form => 2,
        ElementKind.Table or ElementKind.Alert => 3,
        ElementKind.Dialog or ElementKind.Tab or ElementKind.Menu => 4,
        ElementKind.Heading => 5,
        ElementKind.Link => 6,
        ElementKind.Navigation or ElementKind.Image or ElementKind.Text => 7,
        _ => 8
    };

    /// <summary>The ceiling when a caller does not ask for one.</summary>
    /// <summary>No cap unless the caller asks for one.
    ///
    /// This was 20, which is where "generate tests for my application" quietly became
    /// "generate twenty tests". A limit the user did not choose is indistinguishable from
    /// the engine having nothing more to offer, and it is the first thing that makes a
    /// coverage number a lie. Zero means unlimited; the caller may still pass a number.</summary>
    private const int DefaultScenarioBudget = 0;

    /// <param name="requiresSignIn">Whether this application is configured to authenticate.
    /// Passed because the planner was asserting "The customer is signed in." as a
    /// precondition on every smoke scenario, including for a public site where nothing in the
    /// discovered model supported it.</param>
    private static object BuildContext(string baseUrl, string? requirement, List<PageContext> pages,
        int maxScenarios, bool requiresSignIn)
        => new { baseUrl, requirement, maxScenarios, requiresSignIn, pages };

    private async Task<TestSuite> ResolveSuiteAsync(GenerateTestsRequest request, Guid projectId, string applicationName, CancellationToken ct)
    {
        if (request.TestSuiteId is not null)
        {
            var existing = await _db.TestSuites.FirstOrDefaultAsync(s => s.Id == request.TestSuiteId, ct);
            if (existing is not null) return existing;
        }

        var name = request.SuiteName?.Trim();
        if (string.IsNullOrEmpty(name)) name = $"{applicationName} — generated";

        var suite = await _db.TestSuites.FirstOrDefaultAsync(s => s.ProjectId == projectId && s.Name == name, ct);
        if (suite is not null) return suite;

        suite = new TestSuite
        {
            // OrganizationId is stamped by the DbContext from the tenant context on save.
            // Reading it from the signed-in user instead would work only for callers that
            // have an HTTP request, and the autonomous agent does not have one.
            ProjectId = projectId,
            Name = name,
            Description = "Created by AI test generation from the discovered application model.",
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };
        _db.TestSuites.Add(suite);
        await _db.SaveChangesAsync(ct);
        return suite;
    }

    private async Task<(int Cases, int Steps, List<string> Warnings)> PersistAsync(
        GeneratedTestPlan plan, TestSuite suite, Domain.Projects.Project project, Guid applicationId,
        Guid aiRequestId, string? requirement, CancellationToken ct)
    {
        var warnings = new List<string>();
        var policy = new BrowserActionPolicy(
            project.AllowScriptExecution,
            AllowXPathLocators: true,
            // Generation-time URL checking is permissive: navigation targets are re-checked
            // against the application's allowlist at dispatch, where the authoritative
            // policy lives.
            (string url, out string reason) => { reason = string.Empty; return true; });

        var reference = await NextReferenceNumberAsync(project.Id, ct);
        var cases = 0;
        var steps = 0;

        foreach (var scenario in plan.Scenarios)
        {
            var validated = ValidateScenario(scenario, policy, out var scenarioWarnings);
            warnings.AddRange(scenarioWarnings);
            if (!validated)
            {
                _logger.LogWarning("Dropping generated scenario '{Name}': it contains steps the engine cannot run.", scenario.Name);
                continue;
            }

            var testCase = new TestCase
            {
                OrganizationId = suite.OrganizationId,
                ProjectId = project.Id,
                TestSuiteId = suite.Id,
                ApplicationId = applicationId,
                Reference = $"TC-{reference++:0000}",
                Name = Truncate(scenario.Name, 300),
                Objective = Truncate(scenario.Objective, 2000),
                Preconditions = Truncate(scenario.Preconditions, 2000),
                ExpectedResults = Truncate(scenario.ExpectedResults, 4000),
                Priority = scenario.Priority,
                Risk = scenario.Risk,
                Tags = Truncate(string.Join(',', scenario.Tags.Append(scenario.Category).Distinct()), 500),
                Source = TestCaseSource.AiGenerated,
                GeneratedByAiRequestId = aiRequestId,
                RequirementReference = requirement is null ? null : Truncate(requirement, 500),
                CreatedByUserId = _currentUser.UserId,
                CreatedAt = _clock.UtcNow
            };
            _db.TestCases.Add(testCase);

            var order = 1;
            foreach (var step in scenario.Steps)
            {
                var testStep = new TestStep
                {
                    OrganizationId = suite.OrganizationId,
                    TestCaseId = testCase.Id,
                    Order = order++,
                    Description = Truncate(step.Description, 1000),
                    Action = step.Action,
                    TargetJson = step.Target?.ToJson(),
                    Value = Truncate(step.Value, 4000),
                    Url = Truncate(step.Url, 2048),
                    CreatedAt = _clock.UtcNow
                };
                _db.TestSteps.Add(testStep);
                steps++;

                foreach (var assertion in step.Assertions)
                {
                    _db.Assertions.Add(new Assertion
                    {
                        OrganizationId = suite.OrganizationId,
                        TestStepId = testStep.Id,
                        Type = assertion.Type,
                        TargetJson = assertion.Target?.ToJson(),
                        ExpectedValue = Truncate(assertion.Expected, 4000),
                        AttributeName = Truncate(assertion.Attribute, 100),
                        Description = Truncate(assertion.Description, 1000),
                        CreatedAt = _clock.UtcNow
                    });
                }

                // An assertion verb carries its own expectation; record it as an assertion
                // too so reports can count what a test actually checks.
                if (IsAssertionAction(step.Action) && step.Assertions.Count == 0)
                {
                    _db.Assertions.Add(new Assertion
                    {
                        OrganizationId = suite.OrganizationId,
                        TestStepId = testStep.Id,
                        Type = MapAssertionType(step.Action),
                        TargetJson = step.Target?.ToJson(),
                        ExpectedValue = Truncate(step.Expected, 4000),
                        AttributeName = Truncate(step.Attribute, 100),
                        Description = Truncate(step.Description, 1000),
                        CreatedAt = _clock.UtcNow
                    });
                }
            }

            if (scenario.TestData.Count > 0)
            {
                await AttachTestDataAsync(testCase, scenario, project.Id, ct);
            }

            cases++;
        }

        await _db.SaveChangesAsync(ct);
        return (cases, steps, warnings);
    }

    /// <summary>Rejects a scenario whose steps the execution engine could not run. Running
    /// the real validator here means generation can never store a test that fails for a
    /// reason the platform already knew about.</summary>
    private static bool ValidateScenario(GeneratedScenario scenario, BrowserActionPolicy policy, out List<string> warnings)
    {
        warnings = new List<string>();

        if (scenario.Steps.Count == 0)
        {
            warnings.Add($"Scenario '{scenario.Name}' was dropped: it has no steps.");
            return false;
        }

        var hasAssertion = scenario.Steps.Any(s => IsAssertionAction(s.Action) || s.Assertions.Count > 0);
        if (!hasAssertion)
        {
            warnings.Add($"Scenario '{scenario.Name}' was dropped: it asserts nothing, so it could not fail meaningfully.");
            return false;
        }

        foreach (var step in scenario.Steps)
        {
            var action = new BrowserAction
            {
                Action = step.Action,
                Description = step.Description,
                Target = step.Target,
                Value = step.Value,
                Url = step.Url,
                Expected = step.Expected,
                Attribute = step.Attribute
            };

            var validation = BrowserActionValidator.Validate(action, policy);
            if (validation.IsValid) continue;

            warnings.Add($"Scenario '{scenario.Name}' was dropped: step '{step.Description}' is not executable ({string.Join("; ", validation.Errors)}).");
            return false;
        }

        return true;
    }

    private async Task AttachTestDataAsync(TestCase testCase, GeneratedScenario scenario, Guid projectId, CancellationToken ct)
    {
        var dataSet = new TestDataSet
        {
            OrganizationId = testCase.OrganizationId,
            ProjectId = projectId,
            Name = Truncate($"{testCase.Reference} data", 200),
            Description = $"Test data generated with {testCase.Name}.",
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };
        _db.TestDataSets.Add(dataSet);

        foreach (var (key, value) in scenario.TestData.Take(50))
        {
            var isSecretReference = value.StartsWith("${secret:", StringComparison.Ordinal);
            _db.TestDataFields.Add(new TestDataField
            {
                OrganizationId = testCase.OrganizationId,
                TestDataSetId = dataSet.Id,
                Key = Truncate(key, 100)!,
                // A generated credential is stored as a reference, never as a literal.
                Kind = isSecretReference ? TestDataKind.SecretReference : TestDataKind.Static,
                Value = Truncate(value, 4000),
                IsSensitive = isSecretReference,
                CreatedAt = _clock.UtcNow
            });
        }

        testCase.TestDataSetId = dataSet.Id;
        await Task.CompletedTask;
    }

    private async Task<int> NextReferenceNumberAsync(Guid projectId, CancellationToken ct)
    {
        var existing = await _db.TestCases
            .Where(tc => tc.ProjectId == projectId && tc.Reference.StartsWith("TC-"))
            .Select(tc => tc.Reference)
            .ToListAsync(ct);

        var highest = existing
            .Select(r => int.TryParse(r[3..], out var n) ? n : 0)
            .DefaultIfEmpty(0)
            .Max();

        return highest + 1;
    }

    private static bool IsAssertionAction(BrowserActionType action) => BrowserActionVerbs.IsAssertion(action);

    private static AssertionType MapAssertionType(BrowserActionType action) => action switch
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
        _ => AssertionType.Visible
    };

    private static string Truncate(string? value, int max)
        => value is null ? string.Empty : value.Length <= max ? value : value[..max];

    private sealed record PageContext(
        string Route, string Url, string Title, string Kind, int Depth,
        bool RequiresAuthentication, int ElementCount, List<ElementContext> Elements);

    private sealed record ElementContext(
        string Kind, string TagName, string? AriaRole, string? AccessibleName, string? Label,
        string? Placeholder, string? TestId, string? Name, string? Type, bool IsRequired, string? CssSelector);
}
