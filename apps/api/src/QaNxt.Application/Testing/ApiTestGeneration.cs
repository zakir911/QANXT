using QaNxt.Application.Abstractions;
using QaNxt.Application.Contracts;
using QaNxt.Domain.Applications;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace QaNxt.Application.Testing;

/// <summary>Deterministic API test generation from the observed inventory.
///
/// No model is involved, and that is the design rather than a shortcut. Everything these
/// tests assert is something QA NXT watched the application do: the status it answered, the
/// fields its response carried, whether it refused an unauthenticated caller. A model
/// asked to write the same tests would produce plausible assertions about fields that do
/// not exist, and a suite of plausible assertions is exactly the thing this whole product
/// is trying to replace.
///
/// Three kinds are generated, and each earns its place by being able to fail:
///
///  - **Positive** — the endpoint still answers as it did, with the fields it had. Fails
///    when the endpoint breaks or its response loses a field.
///  - **Unauthenticated** — an endpoint that required credentials still refuses without
///    them. Fails when authorization is removed, which is the failure nobody notices
///    because every signed-in test still passes.
///  - **Not found** — a templated endpoint asked for an identifier that does not exist
///    answers 404 rather than 500 or somebody else's data. Fails on an unhandled lookup
///    and on a missing ownership check.
///
/// Mutating endpoints are skipped unless explicitly asked for. A generated POST changes
/// the application's data, and nobody should receive one by accident.</summary>
public sealed partial class ApiTestService
{
    /// <summary>How much slower than observed a response may be before the generated
    /// positive test complains. Generous on purpose: this is a functional check that the
    /// endpoint still answers, not a performance measurement, and a test that fails
    /// because a laptop was busy teaches a team to ignore it.</summary>
    private const int ResponseTimeMultiple = 10;
    private const int ResponseTimeFloorMs = 2000;

    /// <summary>At most this many field assertions per generated positive test. A test that
    /// asserts forty fields fails for forty reasons and explains none of them.</summary>
    private const int MaxFieldAssertions = 4;

    public async Task<Result<GeneratedApiTests>> GenerateAsync(
        GenerateApiTestsRequest request, CancellationToken ct = default)
    {
        var application = await _db.Applications
            .FirstOrDefaultAsync(a => a.Id == request.ApplicationId, ct);
        if (application is null) return Error.NotFound("The application");

        var query = _db.ApiEndpoints.Where(e => e.ApplicationId == application.Id);
        if (request.ApiEndpointIds is { Length: > 0 })
            query = query.Where(e => request.ApiEndpointIds.Contains(e.Id));

        var endpoints = await query
            .OrderByDescending(e => e.TimesObserved)
            .ToListAsync(ct);

        if (endpoints.Count == 0)
        {
            return Error.Validation(
                "There are no discovered API endpoints for this application. Run discovery first — "
                + "generation writes tests about what the application was observed to do, so it has "
                + "nothing to write about until something has been observed.");
        }

        var notes = new List<string>();
        var created = new List<ApiTestSummary>();
        var skipped = 0;
        var budget = request.MaxTests ?? 200;

        // An endpoint that requires a session is tested through one. Which kind of session
        // depends on the application: a form login means the test needs a browser to sign
        // in, and saying so in the description keeps that visible to whoever reads the test.
        var inheritsSession = application.AuthStrategy is AuthenticationStrategy.FormLogin
            or AuthenticationStrategy.StorageState or AuthenticationStrategy.BearerToken
            or AuthenticationStrategy.BasicAuth;

        var suiteName = request.SuiteName ?? $"{application.Name} — API (generated)";

        foreach (var endpoint in endpoints)
        {
            if (created.Count >= budget)
            {
                notes.Add($"Stopped at {budget} tests. Raise maxTests, or generate for specific endpoints.");
                break;
            }

            if (ApiRequestValidator.MutatingMethods.Contains(endpoint.Method.ToUpperInvariant())
                && !request.IncludeMutating)
            {
                skipped++;
                notes.Add($"{endpoint.Method} {endpoint.UrlTemplate}: skipped because it changes data. "
                    + "Pass includeMutating to generate a test for it, and read it before running it.");
                continue;
            }

            var shape = ApiSchemaShape.Infer(endpoint.ResponseSampleJson);
            var status = endpoint.LastStatusCode ?? 200;

            if (request.IncludePositive)
            {
                var test = await GenerateOneAsync(
                    request, application, suiteName,
                    PositiveTest(endpoint, shape, status, inheritsSession), ct);
                if (test.IsSuccess) created.Add(test.Value!);
                else notes.Add($"{endpoint.Method} {endpoint.UrlTemplate} (positive): {test.Error!.Message}");
            }

            if (request.IncludeUnauthenticated && endpoint.RequiresAuthentication && created.Count < budget)
            {
                var test = await GenerateOneAsync(
                    request, application, suiteName, UnauthenticatedTest(endpoint), ct);
                if (test.IsSuccess) created.Add(test.Value!);
                else notes.Add($"{endpoint.Method} {endpoint.UrlTemplate} (unauthenticated): {test.Error!.Message}");
            }

            if (request.IncludeNotFound && HasPlaceholder(endpoint.UrlTemplate) && created.Count < budget)
            {
                var test = await GenerateOneAsync(
                    request, application, suiteName,
                    NotFoundTest(endpoint, inheritsSession), ct);
                if (test.IsSuccess) created.Add(test.Value!);
                else notes.Add($"{endpoint.Method} {endpoint.UrlTemplate} (not found): {test.Error!.Message}");
            }
        }

        if (created.Count == 0)
        {
            return Error.Validation(
                "No API tests could be generated from these endpoints. "
                + string.Join(" ", notes.Take(5)));
        }

        var suiteId = created[0].TestSuiteId;

        await _audit.LogAsync(AuditAction.TestCaseCreated, "TestSuite", suiteId,
            $"{created.Count} API test(s) generated from {endpoints.Count} observed endpoint(s) "
            + $"for {application.Name}.",
            projectId: application.ProjectId, ct: ct);

        return Result<GeneratedApiTests>.Success(new GeneratedApiTests(
            suiteId, created[0].TestSuiteName, endpoints.Count, skipped, created.Count, created, notes));
    }

    /// <summary>Stores one generated test through the ordinary authoring path, so a
    /// generated test is validated exactly as a hand-written one is. A generator that
    /// bypassed validation would be the one place tests that cannot fail could still get
    /// in.</summary>
    private Task<Result<ApiTestSummary>> GenerateOneAsync(
        GenerateApiTestsRequest request, Domain.Applications.Application application,
        string suiteName, (string Name, string Objective, TestPriority Priority, string Tags,
            ApiTestStepRequest Step) plan,
        CancellationToken ct)
        => CreateAsync(new CreateApiTestRequest(
            ProjectId: application.ProjectId,
            ApplicationId: application.Id,
            TestSuiteId: request.TestSuiteId,
            SuiteName: suiteName,
            Name: plan.Name,
            Objective: plan.Objective,
            Priority: plan.Priority,
            Risk: plan.Priority == TestPriority.Critical ? RiskLevel.Critical : RiskLevel.Medium,
            Tags: plan.Tags,
            RequirementReference: null,
            Steps: new[] { plan.Step }), ct);

    private static (string, string, TestPriority, string, ApiTestStepRequest) PositiveTest(
        ApiEndpoint endpoint, ApiSchemaShape? shape, int status, bool inheritsSession)
    {
        var assertions = new List<ApiAssertionRequest>
        {
            new(AssertionType.HttpStatusEquals, status.ToString(),
                Description: $"The endpoint still answers {status}, as it did when it was observed"),
            new(AssertionType.ResponseTimeUnderMs, ResponseTimeLimit(endpoint).ToString(),
                Description: $"The response arrives within {ResponseTimeLimit(endpoint)}ms "
                    + $"(ten times the {endpoint.AverageDurationMs}ms observed, floored at {ResponseTimeFloorMs}ms)")
        };

        foreach (var path in AssertablePaths(shape).Take(MaxFieldAssertions))
        {
            assertions.Add(new ApiAssertionRequest(
                AssertionType.ResponseJsonPathExists, Subject: path,
                Description: $"\"{path}\" is still present in the response"));
        }

        var mode = endpoint.RequiresAuthentication && inheritsSession
            ? ApiAuthMode.InheritSession
            : ApiAuthMode.None;

        return (
            $"{endpoint.Method} {endpoint.UrlTemplate} answers as observed",
            $"The endpoint answers {status} with the fields it carried when discovery saw it "
            + $"{endpoint.TimesObserved} time(s)."
            + (mode == ApiAuthMode.InheritSession
                ? " Runs through a signed-in session, so it needs a browser to sign in."
                : string.Empty),
            endpoint.RequiresAuthentication ? TestPriority.High : TestPriority.Medium,
            "api,generated,smoke",
            new ApiTestStepRequest(
                $"{endpoint.Method} {endpoint.UrlTemplate}",
                new ApiRequestDescriptor
                {
                    Method = endpoint.Method,
                    Path = PathOf(endpoint.SampleUrl, endpoint.UrlTemplate),
                    Auth = new ApiAuthDescriptor { Mode = mode }
                },
                assertions));
    }

    private static (string, string, TestPriority, string, ApiTestStepRequest) UnauthenticatedTest(
        ApiEndpoint endpoint)
    {
        return (
            $"{endpoint.Method} {endpoint.UrlTemplate} refuses an unauthenticated caller",
            "The endpoint was observed to require authentication. This asserts it still does. "
            + "Authorization being removed is the failure nobody notices, because every "
            + "signed-in test carries on passing.",
            TestPriority.Critical,
            "api,generated,security",
            new ApiTestStepRequest(
                $"{endpoint.Method} {endpoint.UrlTemplate} with no credentials",
                new ApiRequestDescriptor
                {
                    Method = endpoint.Method,
                    Path = PathOf(endpoint.SampleUrl, endpoint.UrlTemplate),
                    Auth = new ApiAuthDescriptor { Mode = ApiAuthMode.None },
                    // The refusal is the expected result, so it must not also be the failure.
                    FailOnErrorStatus = false
                },
                new[]
                {
                    new ApiAssertionRequest(
                        AssertionType.ResponseStatusIn, "401,403",
                        Description: "The endpoint refuses a caller with no credentials")
                }));
    }

    private static (string, string, TestPriority, string, ApiTestStepRequest) NotFoundTest(
        ApiEndpoint endpoint, bool inheritsSession)
    {
        // A deliberately absent identifier. Not a random one: a test has to be reproducible,
        // and a value that could conceivably exist would make the test's own meaning depend
        // on the application's data.
        const string Absent = "qanxt-nonexistent-0000";
        var path = SubstitutePlaceholders(PathOf(endpoint.SampleUrl, endpoint.UrlTemplate), Absent);

        var mode = endpoint.RequiresAuthentication && inheritsSession
            ? ApiAuthMode.InheritSession
            : ApiAuthMode.None;

        return (
            $"{endpoint.Method} {endpoint.UrlTemplate} answers 404 for an identifier that does not exist",
            "An identifier nothing owns should produce a not-found, not a server error and not "
            + "another customer's data. This fails on an unhandled lookup and on a missing "
            + "ownership check.",
            TestPriority.High,
            "api,generated,negative",
            new ApiTestStepRequest(
                $"{endpoint.Method} {path}",
                new ApiRequestDescriptor
                {
                    Method = endpoint.Method,
                    Path = path,
                    Auth = new ApiAuthDescriptor { Mode = mode },
                    FailOnErrorStatus = false
                },
                new[]
                {
                    new ApiAssertionRequest(
                        AssertionType.ResponseStatusIn, "400,404",
                        Description: "An identifier that does not exist produces a not-found, "
                            + "not a server error")
                }));
    }

    private static int ResponseTimeLimit(ApiEndpoint endpoint) =>
        Math.Max(ResponseTimeFloorMs, endpoint.AverageDurationMs * ResponseTimeMultiple);

    /// <summary>Response paths worth asserting on, in the assertion grammar.
    ///
    /// Shallow scalars first: <c>accounts[0].id</c> tells someone more when it fails than
    /// <c>data.meta.pagination.links.next.href</c>, and a shallow path is also the one most
    /// likely to be part of the endpoint's actual contract rather than an incidental
    /// detail. Structural paths are skipped — asserting that an object is an object is not
    /// a test.</summary>
    private static IEnumerable<string> AssertablePaths(ApiSchemaShape? shape)
    {
        if (shape is null) return Array.Empty<string>();

        return shape.Fields
            .Where(field => field.Value is not ("object" or "array" or "null" or "unknown"))
            .Where(field => field.Key != "$" && !field.Key.Contains("['", StringComparison.Ordinal))
            .Select(field => ToAssertionPath(field.Key))
            .Where(path => path.Length > 0)
            .OrderBy(path => path.Count(c => c == '.'))
            .ThenBy(path => path.Length)
            .ToList();
    }

    /// <summary>Converts a shape path to an assertion path: <c>$.accounts[].id</c> becomes
    /// <c>accounts[0].id</c>. The shape folds every array element into one entry; an
    /// assertion has to name a specific one, and the first is the only one a response is
    /// guaranteed to have if it has any.</summary>
    private static string ToAssertionPath(string shapePath)
    {
        var path = shapePath.StartsWith("$.", StringComparison.Ordinal) ? shapePath[2..] : shapePath;
        return path.Replace("[]", "[0]", StringComparison.Ordinal);
    }

    private static bool HasPlaceholder(string template) =>
        template.Contains('{') && template.Contains('}');

    private static string SubstitutePlaceholders(string path, string value) =>
        System.Text.RegularExpressions.Regex.Replace(path, @"\{[^}]+\}", value);

    /// <summary>The request path to use: the observed sample URL's path when there is one,
    /// because it has real identifiers in it and will therefore actually resolve. The
    /// template is the fallback, and a template with placeholders left in is what the
    /// not-found test wants anyway.</summary>
    private static string PathOf(string sampleUrl, string template)
    {
        if (!string.IsNullOrWhiteSpace(sampleUrl) && Uri.TryCreate(sampleUrl, UriKind.Absolute, out var uri))
        {
            return uri.PathAndQuery;
        }
        return template.StartsWith('/') ? template : $"/{template}";
    }
}
