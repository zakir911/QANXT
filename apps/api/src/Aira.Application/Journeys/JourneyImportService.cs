using System.Text.Json.Serialization;
using Aira.Application.Abstractions;
using Aira.Application.Applications;
using Aira.Application.Contracts;
using Aira.Application.Security;
using Aira.Domain.Applications;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Aira.Domain.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Journeys;

/// <summary>A journey exported by the recorder extension. Mirrors the TypeScript contract.</summary>
public sealed record RecordedJourneyPayload
{
    [JsonPropertyName("schemaVersion")] public int SchemaVersion { get; init; }
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("startUrl")] public string StartUrl { get; init; } = string.Empty;
    [JsonPropertyName("recordedAt")] public DateTimeOffset RecordedAt { get; init; }
    [JsonPropertyName("recorderVersion")] public string RecorderVersion { get; init; } = string.Empty;
    [JsonPropertyName("steps")] public List<RecordedStepPayload> Steps { get; init; } = new();
}

public sealed record RecordedStepPayload
{
    [JsonPropertyName("order")] public int Order { get; init; }
    [JsonPropertyName("action")] public BrowserActionType Action { get; init; }
    [JsonPropertyName("description")] public string Description { get; init; } = string.Empty;
    [JsonPropertyName("target")] public LocatorDescriptor? Target { get; init; }
    [JsonPropertyName("candidates")] public List<LocatorDescriptor>? Candidates { get; init; }
    [JsonPropertyName("value")] public string? Value { get; init; }
    [JsonPropertyName("url")] public string? Url { get; init; }
    [JsonPropertyName("expected")] public string? Expected { get; init; }
    /// <summary>The attribute an assertAttribute step reads. Without it the step cannot be
    /// imported, which is what made that assertion type unreachable (BUG-0017).</summary>
    [JsonPropertyName("attribute")] public string? Attribute { get; init; }
    /// <summary>How many elements an assertCount step expects.</summary>
    [JsonPropertyName("count")] public int? Count { get; init; }
    [JsonPropertyName("annotation")] public string? Annotation { get; init; }
    [JsonPropertyName("timestampMs")] public long TimestampMs { get; init; }
}

public sealed record ImportJourneyRequest(Guid ProjectId, Guid ApplicationId, RecordedJourneyPayload Journey, bool? GenerateTestCase);

public sealed record ImportJourneyResult(
    Guid JourneyId, string JourneyName, int StepCount,
    Guid? TestCaseId, string? TestCaseReference, IReadOnlyList<string> Warnings);

public interface IJourneyImportService
{
    Task<Result<ImportJourneyResult>> ImportAsync(ImportJourneyRequest request, CancellationToken ct = default);
    Task<IReadOnlyList<JourneySummary>> ListAsync(Guid? applicationId, CancellationToken ct = default);
}

public sealed record JourneySummary(
    Guid Id, Guid ApplicationId, string Name, string Description, JourneySource Source,
    RiskLevel Risk, int RiskScore, string? RiskRationale, bool IsCritical, int StepCount, DateTimeOffset CreatedAt);

/// <summary>Turns a recorded journey into a stored journey, and optionally into a test.
///
/// A recording describes what someone did; a test says what should be true. Generation
/// bridges that gap by keeping the recorded actions and adding the assertions the recorder
/// captured, and it refuses to store a step the engine could not run — the same validator
/// that guards live execution decides.</summary>
public sealed class JourneyImportService : IJourneyImportService
{
    private const int SupportedSchemaVersion = 1;

    private readonly IAiraDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly ITargetPolicy _targetPolicy;
    private readonly IAuditLogger _audit;
    private readonly SecretMasker _masker;
    private readonly Applications.IApplicationService _applications;
    private readonly ILogger<JourneyImportService> _logger;

    public JourneyImportService(IAiraDbContext db, ICurrentUser currentUser, IClock clock,
        ITargetPolicy targetPolicy, IAuditLogger audit, SecretMasker masker,
        Applications.IApplicationService applications, ILogger<JourneyImportService> logger)
    {
        _applications = applications;
        _db = db;
        _currentUser = currentUser;
        _clock = clock;
        _targetPolicy = targetPolicy;
        _audit = audit;
        _masker = masker;
        _logger = logger;
    }

    public async Task<Result<ImportJourneyResult>> ImportAsync(ImportJourneyRequest request, CancellationToken ct = default)
    {
        var journey = request.Journey;

        if (journey.SchemaVersion != SupportedSchemaVersion)
        {
            // Failing loudly beats importing a shape this version does not understand.
            return Error.Validation(
                $"This journey was recorded with schema version {journey.SchemaVersion}; this platform supports version {SupportedSchemaVersion}. Update the recorder extension.");
        }

        if (string.IsNullOrWhiteSpace(journey.Name)) return Error.Validation("The journey needs a name.");
        if (journey.Steps.Count == 0) return Error.Validation("The journey has no steps.");
        if (journey.Steps.Count > 500) return Error.Validation("A journey may contain at most 500 steps.");

        var application = await _db.Applications.FirstOrDefaultAsync(a => a.Id == request.ApplicationId, ct);
        if (application is null) return Error.NotFound("The application");
        if (application.ProjectId != request.ProjectId) return Error.Validation("That application belongs to a different project.");

        var allowlist = ApplicationService.ParseAllowlist(application.AllowedDomains, application.BaseUrl);

        // Resolved once so that any step value equal to a stored credential can be replaced
        // with a reference rather than persisted in the clear. A credential that will not
        // decrypt must not stop an import, so this degrades to the shape-based check.
        ApplicationCredentials? credentials = null;
        try
        {
            credentials = await _applications.ResolveCredentialsAsync(application, ct);
        }
        catch (InvalidOperationException exception)
        {
            _logger.LogWarning(exception,
                "Could not resolve credentials for application {ApplicationId} while importing a journey; "
                + "falling back to pattern-based masking.", application.Id);
        }
        var warnings = new List<string>();

        // A recording made against a different site must not become a test that navigates there.
        foreach (var url in journey.Steps.Select(s => s.Url).Where(u => !string.IsNullOrWhiteSpace(u)).Distinct())
        {
            if (_targetPolicy.IsAllowed(url!, allowlist, out var reason)) continue;
            return Error.Validation(
                $"This journey visits {url}, which is not permitted for '{application.Name}': {reason}");
        }

        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == request.ProjectId, ct);
        if (project is null) return Error.NotFound("The project");

        var stored = new Journey
        {
            OrganizationId = application.OrganizationId,
            ProjectId = application.ProjectId,
            ApplicationId = application.Id,
            Name = Truncate(journey.Name, 300),
            Description = Truncate(journey.Description ?? $"Recorded with the AIRA extension {journey.RecorderVersion}.", 2000),
            Source = JourneySource.Recorded,
            Risk = RiskLevel.Medium,
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };
        _db.Journeys.Add(stored);

        var order = 1;
        foreach (var step in journey.Steps.OrderBy(s => s.Order))
        {
            _db.JourneySteps.Add(new JourneyStep
            {
                OrganizationId = application.OrganizationId,
                JourneyId = stored.Id,
                Order = order++,
                Action = step.Action,
                Description = Truncate(_masker.MaskText(step.Description), 1000),
                TargetJson = step.Target?.ToJson(),
                // Masked on arrival: a recorder can only promise so much, and a value that
                // looks like a credential must not become a stored literal.
                Value = Truncate(MaskRecordedValue(step.Value, credentials), 2000),
                Url = Truncate(step.Url, 2048),
                Annotation = Truncate(step.Annotation, 2000),
                ExpectedResult = Truncate(step.Expected, 2000),
                AttributeName = Truncate(step.Attribute, 200),
                ExpectedCount = step.Count,
                CreatedAt = _clock.UtcNow
            });
        }

        await _db.SaveChangesAsync(ct);

        Guid? testCaseId = null;
        string? reference = null;

        if (request.GenerateTestCase ?? true)
        {
            var generated = await GenerateTestCaseAsync(stored, journey, application, project, credentials, warnings, ct);
            testCaseId = generated?.Id;
            reference = generated?.Reference;
        }

        await _audit.LogAsync(AuditAction.TestCaseCreated, nameof(Journey), stored.Id,
            $"Journey '{stored.Name}' imported from the recorder with {journey.Steps.Count} step(s).",
            projectId: application.ProjectId, ct: ct);

        _logger.LogInformation("Imported journey {JourneyId} with {Steps} step(s); test case {TestCaseId}",
            stored.Id, journey.Steps.Count, testCaseId);

        return Result<ImportJourneyResult>.Success(new ImportJourneyResult(
            stored.Id, stored.Name, journey.Steps.Count, testCaseId, reference, warnings));
    }

    public async Task<IReadOnlyList<JourneySummary>> ListAsync(Guid? applicationId, CancellationToken ct = default)
    {
        var query = _db.Journeys.AsQueryable();
        if (applicationId is not null) query = query.Where(j => j.ApplicationId == applicationId);

        return await query
            .OrderByDescending(j => j.RiskScore).ThenByDescending(j => j.CreatedAt)
            .Select(j => new JourneySummary(
                j.Id, j.ApplicationId, j.Name, j.Description, j.Source, j.Risk, j.RiskScore,
                j.RiskRationale, j.IsCritical, _db.JourneySteps.Count(s => s.JourneyId == j.Id), j.CreatedAt))
            .ToListAsync(ct);
    }

    private async Task<TestCase?> GenerateTestCaseAsync(
        Journey journey, RecordedJourneyPayload payload, Domain.Applications.Application application,
        Domain.Projects.Project project, ApplicationCredentials? credentials, List<string> warnings, CancellationToken ct)
    {
        var suite = await ResolveSuiteAsync(project.Id, application.Name, ct);
        var policy = new BrowserActionPolicy(
            project.AllowScriptExecution, AllowXPathLocators: true,
            (string url, out string reason) => { reason = string.Empty; return true; });

        var testCase = new TestCase
        {
            OrganizationId = application.OrganizationId,
            ProjectId = project.Id,
            TestSuiteId = suite.Id,
            ApplicationId = application.Id,
            Reference = await NextReferenceAsync(project.Id, ct),
            Name = Truncate(journey.Name, 300),
            // The objective is stated from what was recorded rather than left blank: a test
            // whose purpose is unrecorded is one nobody will maintain.
            Objective = Truncate($"Reproduce the recorded journey: {journey.Name}.", 2000),
            Preconditions = Truncate(
                application.AuthStrategy == AuthenticationStrategy.None
                    ? "None."
                    : "The customer is signed in with the application's configured credentials.", 2000),
            ExpectedResults = Truncate(BuildExpectedResults(payload), 4000),
            Priority = TestPriority.Medium,
            Risk = RiskLevel.Medium,
            Tags = "recorded",
            Source = TestCaseSource.RecordedJourney,
            JourneyId = journey.Id,
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };
        _db.TestCases.Add(testCase);

        var order = 1;
        var assertionCount = 0;

        foreach (var step in payload.Steps.OrderBy(s => s.Order))
        {
            var action = new BrowserAction
            {
                Action = step.Action,
                Description = step.Description,
                Target = step.Target is null ? null : WithFallbacks(step.Target, step.Candidates),
                Value = MaskRecordedValue(step.Value, credentials),
                Url = step.Url,
                Expected = step.Expected,
                Attribute = step.Attribute,
                Count = step.Count
            };

            var validation = BrowserActionValidator.Validate(action, policy);
            if (!validation.IsValid)
            {
                // Dropped rather than stored: a step the engine cannot run would fail at
                // execution time for a reason already known at import time.
                warnings.Add($"Step {step.Order} (“{step.Description}”) was not imported: {string.Join("; ", validation.Errors)}");
                continue;
            }

            var testStep = new TestStep
            {
                OrganizationId = application.OrganizationId,
                TestCaseId = testCase.Id,
                Order = order++,
                Description = Truncate(step.Description, 1000),
                Action = step.Action,
                TargetJson = action.Target?.ToJson(),
                Value = Truncate(action.Value, 4000),
                Url = Truncate(step.Url, 2048),
                CreatedAt = _clock.UtcNow
            };
            _db.TestSteps.Add(testStep);

            if (IsAssertion(step.Action) && MapAssertion(step.Action) is { } assertionType)
            {
                assertionCount++;
                _db.Assertions.Add(new Assertion
                {
                    OrganizationId = application.OrganizationId,
                    TestStepId = testStep.Id,
                    Type = assertionType,
                    TargetJson = action.Target?.ToJson(),
                    // A count is an expectation like any other, so it travels in the same
                    // column; TestRunService reads it back when it builds the action.
                    ExpectedValue = Truncate(step.Count?.ToString() ?? step.Expected, 4000),
                    AttributeName = Truncate(step.Attribute, 200),
                    Description = Truncate(step.Annotation ?? step.Description, 1000),
                    CreatedAt = _clock.UtcNow
                });
            }
        }

        if (order == 1)
        {
            warnings.Add("No step in this journey could be imported, so no test case was created.");
            _db.TestCases.Remove(testCase);
            await _db.SaveChangesAsync(ct);
            return null;
        }

        if (assertionCount == 0)
        {
            // Stated plainly rather than silently accepted: a test that asserts nothing
            // cannot fail meaningfully, and the person who recorded it should know.
            warnings.Add(
                "This journey contains no assertions, so the test only proves the steps completed. " +
                "Use the recorder's “Add assertion” button, or add assertions to the generated test.");
        }

        await _db.SaveChangesAsync(ct);
        return testCase;
    }

    /// <summary>Attaches the recorder's alternative locators as fallbacks, so a generated
    /// test survives ordinary UI change without needing to heal at all.</summary>
    private static LocatorDescriptor WithFallbacks(LocatorDescriptor target, List<LocatorDescriptor>? candidates)
    {
        if (candidates is null || candidates.Count == 0) return target;

        var fallbacks = candidates
            .Where(c => c.Strategy != target.Strategy || c.Value != target.Value)
            .Take(3)
            .ToList();

        return fallbacks.Count == 0 ? target : target with { Fallbacks = fallbacks };
    }

    private static string BuildExpectedResults(RecordedJourneyPayload payload)
    {
        var assertions = payload.Steps
            .Where(s => IsAssertion(s.Action))
            .Select(s => $"- {s.Description}")
            .ToList();

        return assertions.Count > 0
            ? "The journey completes and:\n" + string.Join('\n', assertions)
            : "The journey completes without error. No assertions were recorded — add them to make this test meaningful.";
    }

    private async Task<TestSuite> ResolveSuiteAsync(Guid projectId, string applicationName, CancellationToken ct)
    {
        var name = $"{applicationName} — recorded";
        var suite = await _db.TestSuites.FirstOrDefaultAsync(s => s.ProjectId == projectId && s.Name == name, ct);
        if (suite is not null) return suite;

        suite = new TestSuite
        {
            // OrganizationId is stamped by the DbContext from the tenant context on save.
            // Reading it from the signed-in user instead would work only for callers that
            // have an HTTP request, and the autonomous agent does not have one.
            ProjectId = projectId,
            Name = name,
            Description = "Tests generated from journeys recorded with the browser extension.",
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };
        _db.TestSuites.Add(suite);
        await _db.SaveChangesAsync(ct);
        return suite;
    }

    private async Task<string> NextReferenceAsync(Guid projectId, CancellationToken ct)
    {
        var existing = await _db.TestCases
            .Where(tc => tc.ProjectId == projectId && tc.Reference.StartsWith("TC-"))
            .Select(tc => tc.Reference)
            .ToListAsync(ct);

        var highest = existing.Select(r => int.TryParse(r[3..], out var n) ? n : 0).DefaultIfEmpty(0).Max();
        return $"TC-{highest + 1:0000}";
    }

    /// <summary>A recorder marks passwords as secret references, but a value that merely
    /// looks like a credential is masked here as a second line of defence.</summary>
    private string MaskRecordedValue(string? value, ApplicationCredentials? credentials = null)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        if (value.StartsWith("${secret:", StringComparison.Ordinal)) return value;
        if (value.StartsWith("${data:", StringComparison.Ordinal)) return value;

        // The platform already holds this application's credentials, so a value equal to one
        // of them is a credential however innocuous the string looks. The shape-based check
        // below cannot recognise an arbitrary password; this can, and a journey written by
        // hand or by another tool is exactly where one arrives.
        if (credentials is not null)
        {
            if (Matches(value, credentials.Password)) return "${secret:app_password}";
            if (Matches(value, credentials.BearerToken)) return "${secret:app_bearer_token}";
        }

        var masked = _masker.MaskText(value);
        return masked.Contains(SecretMasker.Redacted, StringComparison.Ordinal)
            ? "${secret:app_password}"
            : value;
    }

    /// <summary>Ordinal comparison: a credential differing only in case is a different
    /// credential, and treating them as equal would replace a value that is not a secret.</summary>
    private static bool Matches(string value, string? credential)
        => !string.IsNullOrEmpty(credential) && string.Equals(value, credential, StringComparison.Ordinal);

    private static bool IsAssertion(BrowserActionType action) => (int)action >= 20 && (int)action < 90;

    /// <summary>The planned assertion that mirrors an assertion-typed step, or null when
    /// there is no honest equivalent.
    ///
    /// This used to fall back to <see cref="AssertionType.Visible"/> for anything it did not
    /// recognise, which turned an assertCount into a visibility check: the step counted
    /// correctly and the planned assertion beside it then failed on the very locator the
    /// count needed, because resolving a locator that matches three elements is an error
    /// (BUG-0017). A wrong assertion is worse than no assertion, so unmapped actions now
    /// produce none — the step itself still runs and still decides the verdict.</summary>
    private static AssertionType? MapAssertion(BrowserActionType action) => action switch
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
        _ => null
    };

    private static string Truncate(string? value, int max)
        => value is null ? string.Empty : value.Length <= max ? value : value[..max];
}
