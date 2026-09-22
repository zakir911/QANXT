using Aira.Application.Abstractions;
using Aira.Application.Applications;
using Aira.Application.Contracts;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Aira.Domain.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Aira.Application.Testing;

/// <summary>One assertion over a response.
///
/// <paramref name="Subject"/> is the JSON path for the <c>responseJsonPath*</c> types and
/// the header name for <c>responseHeaderEquals</c>; the other types do not use it. One
/// field rather than two, because it is stored in one column, and pretending otherwise in
/// the contract would only move the confusion.</summary>
public sealed record ApiAssertionRequest(
    AssertionType Type,
    string? Expected = null,
    string? Subject = null,
    bool Negate = false,
    bool IsSoft = false,
    string? Description = null);

public sealed record ApiTestStepRequest(
    string Description,
    ApiRequestDescriptor Request,
    IReadOnlyList<ApiAssertionRequest>? Assertions = null,
    bool ContinueOnFailure = false);

public sealed record CreateApiTestRequest(
    Guid ProjectId,
    Guid? ApplicationId,
    Guid? TestSuiteId,
    string? SuiteName,
    string Name,
    string? Objective,
    TestPriority? Priority,
    RiskLevel? Risk,
    string? Tags,
    string? RequirementReference,
    IReadOnlyList<ApiTestStepRequest> Steps);

public sealed record ApiTestSummary(
    Guid TestCaseId, string Reference, string Name, Guid TestSuiteId, string TestSuiteName,
    int StepCount, int AssertionCount, IReadOnlyList<string> Notes);

/// <summary>Generates API tests from the endpoints discovery has observed.
///
/// <paramref name="IncludeMutating"/> is false by default and stays that way unless a caller
/// asks: a generated <c>POST</c> or <c>DELETE</c> against an application changes that
/// application's data, and nobody should get one by accident.</summary>
public sealed record GenerateApiTestsRequest(
    Guid ApplicationId,
    Guid[]? ApiEndpointIds = null,
    Guid? TestSuiteId = null,
    string? SuiteName = null,
    bool IncludePositive = true,
    /// <summary>For an endpoint that requires authentication, a test that calls it with no
    /// credentials and requires a refusal.</summary>
    bool IncludeUnauthenticated = true,
    /// <summary>For a templated endpoint, a test that asks for an identifier that does not
    /// exist and requires a 404 rather than a 500 or somebody else's data.</summary>
    bool IncludeNotFound = true,
    bool IncludeMutating = false,
    int? MaxTests = null);

public sealed record GeneratedApiTests(
    Guid TestSuiteId, string TestSuiteName,
    int EndpointsConsidered, int EndpointsSkipped, int TestsCreated,
    IReadOnlyList<ApiTestSummary> Tests,
    IReadOnlyList<string> Notes);

public interface IApiTestService
{
    Task<Result<ApiTestSummary>> CreateAsync(CreateApiTestRequest request, CancellationToken ct = default);
    Task<Result<GeneratedApiTests>> GenerateAsync(GenerateApiTestsRequest request, CancellationToken ct = default);
}

/// <summary>Authors API tests.
///
/// An API test is stored as an ordinary <see cref="TestCase"/> whose steps use the
/// <c>ApiRequest</c> verb. That is the whole design decision: runs, retries, evidence,
/// failure analysis, quality gates, reports and the CLI already work on test cases, and
/// none of them needed changing to gain API testing. What is added here is authoring and
/// the validation that keeps an API test honest:
///
///  - Every request is validated against <see cref="ApiRequestValidator"/> with the
///    application's real allowlist, so a test cannot be saved that AIRA would refuse to
///    run or that points outside the authorization boundary.
///  - Every assertion must be one the executor can evaluate against a response. A page
///    assertion attached to an API step is rejected rather than stored, because a stored
///    assertion that cannot be evaluated is a test that cannot fail — which is what
///    BUG-0016 and BUG-0017 both were.
///  - A test with no assertions at all is refused for the same reason.</summary>
public sealed partial class ApiTestService : IApiTestService
{
    /// <summary>Assertion types the executor evaluates against a response. Mirrors
    /// `RESPONSE_ASSERTION_TYPES` in the worker; the contract test keeps the enum itself in
    /// step between the two languages.</summary>
    public static readonly IReadOnlySet<AssertionType> ResponseAssertions = new HashSet<AssertionType>
    {
        AssertionType.HttpStatusEquals, AssertionType.ResponseStatusIn,
        AssertionType.ResponseTimeUnderMs, AssertionType.ResponseBodyContains,
        AssertionType.ResponseJsonPathEquals, AssertionType.ResponseJsonPathExists,
        AssertionType.ResponseJsonPathMatches, AssertionType.ResponseHeaderEquals
    };

    /// <summary>Types whose subject is a JSON path.</summary>
    private static readonly IReadOnlySet<AssertionType> PathAssertions = new HashSet<AssertionType>
    {
        AssertionType.ResponseJsonPathEquals, AssertionType.ResponseJsonPathExists,
        AssertionType.ResponseJsonPathMatches
    };

    /// <summary>Types that need an expected value to compare against.</summary>
    private static readonly IReadOnlySet<AssertionType> ValueAssertions = new HashSet<AssertionType>
    {
        AssertionType.HttpStatusEquals, AssertionType.ResponseStatusIn,
        AssertionType.ResponseTimeUnderMs, AssertionType.ResponseBodyContains,
        AssertionType.ResponseJsonPathEquals, AssertionType.ResponseJsonPathMatches,
        AssertionType.ResponseHeaderEquals
    };

    private readonly IAiraDbContext _db;
    private readonly ITargetPolicy _targetPolicy;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;
    private readonly ILogger<ApiTestService> _logger;

    public ApiTestService(IAiraDbContext db, ITargetPolicy targetPolicy, ICurrentUser currentUser,
        IClock clock, IAuditLogger audit, ILogger<ApiTestService> logger)
    {
        _db = db;
        _targetPolicy = targetPolicy;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
        _logger = logger;
    }

    public async Task<Result<ApiTestSummary>> CreateAsync(CreateApiTestRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return Error.Validation("An API test needs a name.");

        if (request.Steps is null || request.Steps.Count == 0)
            return Error.Validation("An API test needs at least one request.");

        if (request.Steps.Count > 50)
            return Error.Validation("An API test is limited to 50 requests.");

        var project = await _db.Projects.FirstOrDefaultAsync(p => p.Id == request.ProjectId, ct);
        if (project is null) return Error.NotFound("The project");

        var application = request.ApplicationId is null
            ? await _db.Applications.FirstOrDefaultAsync(a => a.ProjectId == project.Id, ct)
            : await _db.Applications.FirstOrDefaultAsync(a => a.Id == request.ApplicationId && a.ProjectId == project.Id, ct);

        if (application is null)
            return Error.Validation("This project has no application to test. Register one first.");

        // The allowlist includes every environment's API base URL as well as the
        // application's own, so a test written against the QA API is not rejected because
        // the default environment happens to be elsewhere.
        var apiBaseUrls = await _db.Environments
            .Where(e => e.ProjectId == project.Id && e.ApiBaseUrl != null)
            .Select(e => e.ApiBaseUrl!)
            .ToListAsync(ct);

        var allowlist = ApplicationService.ParseAllowlist(
            application.AllowedDomains, application.BaseUrl, apiBaseUrls.ToArray());

        var policy = new BrowserActionPolicy(
            project.AllowScriptExecution,
            AllowXPathLocators: true,
            (string url, out string reason) => _targetPolicy.IsAllowed(url, allowlist, out reason));

        var notes = new List<string>();
        var errors = new List<string>();
        var totalAssertions = 0;

        for (var index = 0; index < request.Steps.Count; index++)
        {
            var step = request.Steps[index];
            var label = $"Request {index + 1}";

            if (step.Request is null)
            {
                errors.Add($"{label} has no request description.");
                continue;
            }

            var validation = ApiRequestValidator.Validate(step.Request, policy);
            foreach (var error in validation.Errors) errors.Add($"{label}: {error}");

            var assertions = step.Assertions ?? Array.Empty<ApiAssertionRequest>();
            totalAssertions += assertions.Count;
            foreach (var problem in AssertionProblems(assertions)) errors.Add($"{label}: {problem}");

            if (assertions.Count == 0 && step.Request.FailOnErrorStatus == false)
            {
                // Nothing would make this step fail: error statuses are tolerated and
                // nothing is checked. Saying so is the point of refusing it.
                errors.Add($"{label} has no assertions and tolerates error statuses, so no result "
                    + "could make it fail. Add an assertion, or let an error status fail the step.");
            }
            else if (assertions.Count == 0)
            {
                notes.Add($"{label} asserts only that the call succeeds. "
                    + "Consider asserting a status or a field so a wrong-but-successful response is caught.");
            }

            if (ApiRequestValidator.IsMutating(step.Request))
            {
                notes.Add($"{label} is a {step.Request.Method.ToUpperInvariant()}, so it changes data. "
                    + "It will be refused in any environment that does not permit destructive tests.");
            }
        }

        if (totalAssertions == 0)
            errors.Add("This test asserts nothing. A test that cannot fail is not a test.");

        if (errors.Count > 0)
        {
            // Every problem, not the first one: an author fixing an API test one message
            // per round trip is how tests end up written to whatever the tool accepted.
            return Error.Validation(
                $"This API test cannot be saved as written ({errors.Count} problem(s)).",
                new Dictionary<string, string[]> { ["requests"] = errors.ToArray() });
        }

        var suite = await ResolveSuiteAsync(project.Id, request, application.Name, ct);
        var reference = await NextReferenceAsync(project.Id, ct);

        var testCase = new TestCase
        {
            ProjectId = project.Id,
            TestSuiteId = suite.Id,
            ApplicationId = application.Id,
            Reference = reference,
            Name = Truncate(request.Name.Trim(), 300),
            Objective = Truncate(request.Objective ?? string.Empty, 2000),
            Preconditions = string.Empty,
            ExpectedResults = string.Empty,
            Kind = TestCaseKind.Api,
            Priority = request.Priority ?? TestPriority.Medium,
            Risk = request.Risk ?? RiskLevel.Medium,
            Tags = Truncate(MergeTags(request.Tags), 500),
            Source = TestCaseSource.Manual,
            RequirementReference = Truncate(request.RequirementReference, 500),
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };
        _db.TestCases.Add(testCase);

        var order = 1;
        var storedAssertions = 0;

        foreach (var step in request.Steps)
        {
            var testStep = new TestStep
            {
                TestCaseId = testCase.Id,
                Order = order++,
                Description = Truncate(Describe(step), 1000),
                Action = BrowserActionType.ApiRequest,
                ApiRequestJson = ApiRequestValidator.Serialize(Normalize(step.Request)),
                TimeoutMs = step.Request.TimeoutMs,
                IsCritical = !step.ContinueOnFailure,
                ContinueOnFailure = step.ContinueOnFailure,
                CreatedAt = _clock.UtcNow
            };
            _db.TestSteps.Add(testStep);

            foreach (var assertion in step.Assertions ?? Array.Empty<ApiAssertionRequest>())
            {
                _db.Assertions.Add(new Assertion
                {
                    TestStepId = testStep.Id,
                    Type = assertion.Type,
                    ExpectedValue = Truncate(assertion.Expected, 4000),
                    AttributeName = Truncate(assertion.Subject, 200),
                    Negate = assertion.Negate,
                    IsSoft = assertion.IsSoft,
                    Description = Truncate(assertion.Description ?? DescribeAssertion(assertion), 1000),
                    CreatedAt = _clock.UtcNow
                });
                storedAssertions++;
            }
        }

        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.TestCaseCreated, "TestCase", testCase.Id,
            $"API test {testCase.Reference} created with {request.Steps.Count} request(s) "
            + $"and {storedAssertions} assertion(s).",
            projectId: project.Id, ct: ct);

        _logger.LogInformation("API test {Reference} created for project {ProjectId}.", testCase.Reference, project.Id);

        return Result<ApiTestSummary>.Success(new ApiTestSummary(
            testCase.Id, testCase.Reference, testCase.Name, suite.Id, suite.Name,
            request.Steps.Count, storedAssertions, notes));
    }

    /// <summary>Everything wrong with a step's assertions, named individually rather than
    /// as a single "invalid assertions".</summary>
    private static IEnumerable<string> AssertionProblems(IReadOnlyList<ApiAssertionRequest> assertions)
    {
        foreach (var assertion in assertions)
        {
            if (!Enum.IsDefined(typeof(AssertionType), assertion.Type))
            {
                yield return "an assertion has an unrecognised type.";
                continue;
            }

            if (!ResponseAssertions.Contains(assertion.Type))
            {
                yield return $"'{Camel(assertion.Type.ToString())}' is a page assertion and cannot be "
                    + "evaluated against an HTTP response. Use a response assertion instead.";
                continue;
            }

            if (PathAssertions.Contains(assertion.Type))
            {
                if (string.IsNullOrWhiteSpace(assertion.Subject))
                    yield return $"'{Camel(assertion.Type.ToString())}' needs a JSON path in 'subject'.";
                else if (!ApiRequestValidator.IsJsonPath(assertion.Subject!))
                    yield return $"'{assertion.Subject}' is not a supported JSON path. "
                        + "Use names, dots and [n] indexes.";
            }

            if (assertion.Type == AssertionType.ResponseHeaderEquals && string.IsNullOrWhiteSpace(assertion.Subject))
                yield return "'responseHeaderEquals' needs a header name in 'subject'.";

            if (ValueAssertions.Contains(assertion.Type) && assertion.Expected is null)
                yield return $"'{Camel(assertion.Type.ToString())}' needs an expected value.";

            if (assertion.Type == AssertionType.HttpStatusEquals
                && !(int.TryParse(assertion.Expected, out var status) && status is >= 100 and <= 599))
            {
                yield return $"'{assertion.Expected}' is not an HTTP status code.";
            }

            if (assertion.Type == AssertionType.ResponseTimeUnderMs
                && (!int.TryParse(assertion.Expected, out var limit) || limit <= 0))
            {
                yield return $"'{assertion.Expected}' is not a millisecond limit.";
            }

            if (assertion.Type == AssertionType.ResponseJsonPathMatches
                && assertion.Expected is not null
                && !IsValidRegex(assertion.Expected))
            {
                yield return $"'{assertion.Expected}' is not a valid regular expression.";
            }
        }
    }

    /// <summary>A pattern the executor will be able to compile at run time. Checked here
    /// rather than left to fail during execution, where it would read as a test failure
    /// rather than as a mistake in the test.</summary>
    private static bool IsValidRegex(string pattern)
    {
        try
        {
            _ = new System.Text.RegularExpressions.Regex(pattern);
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    /// <summary>Fills in the defaults the executor would otherwise have to guess.</summary>
    private static ApiRequestDescriptor Normalize(ApiRequestDescriptor request) => request with
    {
        Method = (request.Method ?? "GET").Trim().ToUpperInvariant(),
        Path = request.Path.Trim(),
        // An unstated auth mode means "whatever session this test has", which for a
        // browserless API test is nothing. Storing the resolved value keeps the intent
        // visible in the test rather than implied by the runner's default.
        Auth = request.Auth ?? new ApiAuthDescriptor { Mode = ApiAuthMode.None }
    };

    private async Task<TestSuite> ResolveSuiteAsync(
        Guid projectId, CreateApiTestRequest request, string applicationName, CancellationToken ct)
    {
        if (request.TestSuiteId is not null)
        {
            var existing = await _db.TestSuites
                .FirstOrDefaultAsync(s => s.Id == request.TestSuiteId && s.ProjectId == projectId, ct);
            if (existing is not null) return existing;
        }

        var name = request.SuiteName?.Trim();
        if (string.IsNullOrEmpty(name)) name = $"{applicationName} — API";

        var suite = await _db.TestSuites.FirstOrDefaultAsync(s => s.ProjectId == projectId && s.Name == name, ct);
        if (suite is not null) return suite;

        suite = new TestSuite
        {
            ProjectId = projectId,
            Name = name,
            Description = "API tests.",
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };
        _db.TestSuites.Add(suite);
        await _db.SaveChangesAsync(ct);
        return suite;
    }

    /// <summary>References are project-wide and share the TC- sequence with UI tests, so
    /// "TC-0042" identifies one test whatever kind it is.</summary>
    private async Task<string> NextReferenceAsync(Guid projectId, CancellationToken ct)
    {
        var existing = await _db.TestCases
            .Where(tc => tc.ProjectId == projectId && tc.Reference.StartsWith("TC-"))
            .Select(tc => tc.Reference)
            .ToListAsync(ct);

        var highest = existing
            .Select(r => int.TryParse(r[3..], out var n) ? n : 0)
            .DefaultIfEmpty(0)
            .Max();

        return $"TC-{highest + 1:0000}";
    }

    private static string Describe(ApiTestStepRequest step)
    {
        if (!string.IsNullOrWhiteSpace(step.Description)) return step.Description.Trim();
        return $"{(step.Request.Method ?? "GET").ToUpperInvariant()} {step.Request.Path}";
    }

    private static string DescribeAssertion(ApiAssertionRequest assertion) => assertion.Type switch
    {
        AssertionType.HttpStatusEquals => $"The response status is {assertion.Expected}",
        AssertionType.ResponseStatusIn => $"The response status is within {assertion.Expected}",
        AssertionType.ResponseTimeUnderMs => $"The response arrives within {assertion.Expected}ms",
        AssertionType.ResponseBodyContains => $"The response body contains \"{assertion.Expected}\"",
        AssertionType.ResponseJsonPathEquals => $"{assertion.Subject} is {assertion.Expected}",
        AssertionType.ResponseJsonPathExists => $"{assertion.Subject} is present",
        AssertionType.ResponseJsonPathMatches => $"{assertion.Subject} matches /{assertion.Expected}/",
        AssertionType.ResponseHeaderEquals => $"The {assertion.Subject} header is \"{assertion.Expected}\"",
        _ => Camel(assertion.Type.ToString())
    };

    /// <summary>Every API test carries the 'api' tag, so selecting them needs no knowledge
    /// of the kind column — including from a CLI that filters on tags.</summary>
    private static string MergeTags(string? tags)
    {
        var parts = (tags ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToList();
        if (!parts.Contains("api", StringComparer.OrdinalIgnoreCase)) parts.Insert(0, "api");
        return string.Join(',', parts.Distinct(StringComparer.OrdinalIgnoreCase));
    }

    private static string Camel(string value) =>
        value.Length == 0 ? value : char.ToLowerInvariant(value[0]) + value[1..];

    private static string Truncate(string? value, int max)
        => value is null ? string.Empty : value.Length <= max ? value : value[..max];
}
