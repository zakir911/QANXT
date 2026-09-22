using Aira.Api.Authorization;
using Aira.Application.Abstractions;
using Aira.Application.Contracts;
using Aira.Application.Security;
using Aira.Application.Testing;
using Aira.Domain.Common;
using Aira.Domain.Enums;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Aira.Api.Controllers;

/// <summary>Test suites and cases: what exists, what it does, and where it came from.</summary>
[RequirePermission(Permissions.TestRead)]
public sealed class TestCasesController : ApiControllerBase
{
    private readonly IAiraDbContext _db;
    private readonly ITestGenerationService _generation;
    private readonly IApiTestService _apiTests;
    private readonly IClock _clock;
    private readonly ICurrentUser _currentUser;
    private readonly IAuditLogger _audit;

    public TestCasesController(IAiraDbContext db, ITestGenerationService generation,
        IApiTestService apiTests, IClock clock, ICurrentUser currentUser, IAuditLogger audit)
    {
        _db = db;
        _generation = generation;
        _apiTests = apiTests;
        _clock = clock;
        _currentUser = currentUser;
        _audit = audit;
    }

    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] Guid? projectId, [FromQuery] Guid? testSuiteId,
        [FromQuery] TestPriority? priority, [FromQuery] string? tag,
        [FromQuery] TestCaseKind? kind, CancellationToken ct)
    {
        var query = _db.TestCases.AsQueryable();
        if (projectId is not null) query = query.Where(tc => tc.ProjectId == projectId);
        if (testSuiteId is not null) query = query.Where(tc => tc.TestSuiteId == testSuiteId);
        if (priority is not null) query = query.Where(tc => tc.Priority == priority);
        if (kind is not null) query = query.Where(tc => tc.Kind == kind);
        if (!string.IsNullOrWhiteSpace(tag)) query = query.Where(tc => tc.Tags.Contains(tag));

        return Ok(await query
            .OrderBy(tc => tc.Reference)
            .Select(tc => new
            {
                id = tc.Id, tc.Reference, tc.Name, tc.Objective, kind = tc.Kind,
                priority = tc.Priority, risk = tc.Risk,
                tc.Tags, source = tc.Source, tc.IsEnabled, tc.Version, tc.TestSuiteId,
                suiteName = tc.TestSuite!.Name, tc.ExecutionCount, tc.PassCount, tc.FailCount,
                tc.HealCount, tc.FlakinessScore, tc.LastExecutedAt, lastStatus = tc.LastStatus,
                tc.AverageDurationMs, stepCount = _db.TestSteps.Count(s => s.TestCaseId == tc.Id),
                isAiGenerated = tc.Source == TestCaseSource.AiGenerated
            })
            .ToListAsync(ct));
    }

    /// <summary>One test case with its steps and assertions — the reviewable form.</summary>
    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id, CancellationToken ct)
    {
        var testCase = await _db.TestCases.FirstOrDefaultAsync(tc => tc.Id == id, ct);
        if (testCase is null) return Problem(Error.NotFound("The test case"));

        var steps = await _db.TestSteps
            .Where(s => s.TestCaseId == id)
            .OrderBy(s => s.Order)
            .Include(s => s.Assertions)
            .ToListAsync(ct);

        var data = testCase.TestDataSetId is null
            ? null
            : await _db.TestDataFields
                .Where(f => f.TestDataSetId == testCase.TestDataSetId)
                .Select(f => new { f.Key, kind = f.Kind, f.IsSensitive, value = f.IsSensitive ? null : f.Value })
                .ToListAsync(ct);

        return Ok(new
        {
            testCase.Id, testCase.Reference, testCase.Name, testCase.Objective, testCase.Preconditions,
            testCase.ExpectedResults, kind = testCase.Kind,
            priority = testCase.Priority, risk = testCase.Risk, testCase.Tags,
            source = testCase.Source, testCase.IsEnabled, testCase.Version, testCase.RequirementReference,
            testCase.GeneratedByAiRequestId, testCase.TestSuiteId, testCase.ApplicationId,
            statistics = new
            {
                testCase.ExecutionCount, testCase.PassCount, testCase.FailCount, testCase.HealCount,
                testCase.FlakinessScore, testCase.AverageDurationMs, testCase.LastExecutedAt,
                lastStatus = testCase.LastStatus
            },
            testData = data,
            steps = steps.Select(s => new
            {
                s.Id, s.Order, s.Description, action = s.Action,
                target = LocatorDescriptor.FromJson(s.TargetJson),
                targetDescription = LocatorDescriptor.FromJson(s.TargetJson)?.Describe(),
                s.Value, s.Url, s.TimeoutMs, s.IsCritical, s.ContinueOnFailure, s.HealCount,
                // The stored request, parsed back into its shape rather than handed over
                // as a JSON string, so a reader of an API test sees the same structure its
                // author wrote.
                apiRequest = ApiRequestValidator.Deserialize(s.ApiRequestJson),
                assertions = s.Assertions.Select(a => new
                {
                    a.Id, type = a.Type, target = LocatorDescriptor.FromJson(a.TargetJson),
                    a.ExpectedValue, a.AttributeName, a.Negate, a.IsSoft, a.Description
                })
            })
        });
    }

    /// <summary>Generates test cases from the discovered application model.</summary>
    [HttpPost("generate")]
    [RequirePermission(Permissions.TestGenerate)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Generate([FromBody] GenerateTestsRequest request, CancellationToken ct)
        => FromResult(await _generation.GenerateAsync(request, ct));

    /// <summary>Authors an API test: one or more HTTP requests with assertions over their
    /// responses. It is stored as an ordinary test case, so it runs in the same runs, under
    /// the same quality gates, with the same evidence as a UI test.</summary>
    [HttpPost("api-tests")]
    [RequirePermission(Permissions.TestWrite)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> CreateApiTest([FromBody] CreateApiTestRequest request, CancellationToken ct)
        => FromResult(await _apiTests.CreateAsync(request, ct));

    public sealed record UpdateTestCaseBody(
        string? Name, string? Objective, string? Preconditions, string? ExpectedResults,
        TestPriority? Priority, RiskLevel? Risk, string? Tags, bool? IsEnabled);

    [HttpPatch("{id:guid}")]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> Update(Guid id, [FromBody] UpdateTestCaseBody body, CancellationToken ct)
    {
        var testCase = await _db.TestCases.FirstOrDefaultAsync(tc => tc.Id == id, ct);
        if (testCase is null) return Problem(Error.NotFound("The test case"));

        if (body.Name is not null) testCase.Name = body.Name.Trim();
        if (body.Objective is not null) testCase.Objective = body.Objective.Trim();
        if (body.Preconditions is not null) testCase.Preconditions = body.Preconditions.Trim();
        if (body.ExpectedResults is not null) testCase.ExpectedResults = body.ExpectedResults.Trim();
        if (body.Priority is not null) testCase.Priority = body.Priority.Value;
        if (body.Risk is not null) testCase.Risk = body.Risk.Value;
        if (body.Tags is not null) testCase.Tags = body.Tags.Trim();
        if (body.IsEnabled is not null) testCase.IsEnabled = body.IsEnabled.Value;

        testCase.UpdatedByUserId = _currentUser.UserId;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.TestCaseUpdated, "TestCase", testCase.Id,
            $"Test case {testCase.Reference} updated.", projectId: testCase.ProjectId, ct: ct);

        return NoContent();
    }

    public sealed record UpdateStepBody(string? Description, LocatorDescriptor? Target, string? Value, int? TimeoutMs);

    /// <summary>Edits one step's locator or value. Changing a step bumps the case version,
    /// so a past execution always describes the test that actually ran.</summary>
    [HttpPatch("{id:guid}/steps/{stepId:guid}")]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> UpdateStep(Guid id, Guid stepId, [FromBody] UpdateStepBody body, CancellationToken ct)
    {
        var step = await _db.TestSteps.FirstOrDefaultAsync(s => s.Id == stepId && s.TestCaseId == id, ct);
        if (step is null) return Problem(Error.NotFound("The test step"));

        var testCase = await _db.TestCases.FirstOrDefaultAsync(tc => tc.Id == id, ct);
        if (testCase is null) return Problem(Error.NotFound("The test case"));

        if (body.Description is not null) step.Description = body.Description.Trim();
        if (body.Target is not null) step.TargetJson = body.Target.ToJson();
        if (body.Value is not null)
        {
            if (LooksLikeCredential(body.Value))
                return Problem(Error.Validation("Credential-like literals are not permitted in a step value; use a ${secret:name} reference."));
            step.Value = body.Value;
        }
        if (body.TimeoutMs is not null) step.TimeoutMs = body.TimeoutMs;

        testCase.Version++;
        testCase.UpdatedByUserId = _currentUser.UserId;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.TestCaseUpdated, "TestStep", step.Id,
            $"Step {step.Order} of {testCase.Reference} updated.", projectId: testCase.ProjectId, ct: ct);

        return NoContent();
    }

    /// <summary>Disables a test rather than deleting it, so its execution history and any
    /// defects raised from it stay interpretable.</summary>
    [HttpDelete("{id:guid}")]
    [RequirePermission(Permissions.TestDelete)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var testCase = await _db.TestCases.FirstOrDefaultAsync(tc => tc.Id == id, ct);
        if (testCase is null) return Problem(Error.NotFound("The test case"));

        testCase.DeletedAt = _clock.UtcNow;
        testCase.IsEnabled = false;
        testCase.UpdatedByUserId = _currentUser.UserId;
        await _db.SaveChangesAsync(ct);

        await _audit.LogAsync(AuditAction.TestCaseDeleted, "TestCase", testCase.Id,
            $"Test case {testCase.Reference} deleted.", projectId: testCase.ProjectId, ct: ct);

        return NoContent();
    }

    private static bool LooksLikeCredential(string value)
    {
        if (value.StartsWith("${secret:", StringComparison.Ordinal)) return false;
        var lowered = value.ToLowerInvariant();
        return lowered.Contains("password=") || lowered.Contains("apikey=") || lowered.Contains("bearer ");
    }
}

/// <summary>Suites, for grouping cases and running them together.</summary>
[Route("api/v1/test-suites")]
[RequirePermission(Permissions.TestRead)]
public sealed class TestSuitesController : ApiControllerBase
{
    private readonly IAiraDbContext _db;
    private readonly IClock _clock;
    private readonly ICurrentUser _currentUser;

    public TestSuitesController(IAiraDbContext db, IClock clock, ICurrentUser currentUser)
    {
        _db = db;
        _clock = clock;
        _currentUser = currentUser;
    }

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] Guid? projectId, CancellationToken ct)
    {
        var query = _db.TestSuites.AsQueryable();
        if (projectId is not null) query = query.Where(s => s.ProjectId == projectId);

        return Ok(await query
            .OrderBy(s => s.Name)
            .Select(s => new
            {
                s.Id, s.Name, s.Description, s.Tags, s.IsRegressionSuite, s.ProjectId, s.CreatedAt,
                caseCount = _db.TestCases.Count(tc => tc.TestSuiteId == s.Id),
                enabledCaseCount = _db.TestCases.Count(tc => tc.TestSuiteId == s.Id && tc.IsEnabled)
            })
            .ToListAsync(ct));
    }

    public sealed record CreateSuiteBody(Guid ProjectId, string Name, string? Description, string? Tags, bool? IsRegressionSuite);

    [HttpPost]
    [RequirePermission(Permissions.TestWrite)]
    public async Task<IActionResult> Create([FromBody] CreateSuiteBody body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.Name)) return Problem(Error.Validation("A suite name is required."));
        if (!await _db.Projects.AnyAsync(p => p.Id == body.ProjectId, ct))
            return Problem(Error.NotFound("The project"));

        var suite = new Aira.Domain.Testing.TestSuite
        {
            OrganizationId = _currentUser.OrganizationId!.Value,
            ProjectId = body.ProjectId,
            Name = body.Name.Trim(),
            Description = body.Description?.Trim() ?? string.Empty,
            Tags = body.Tags?.Trim() ?? string.Empty,
            IsRegressionSuite = body.IsRegressionSuite ?? false,
            CreatedByUserId = _currentUser.UserId,
            CreatedAt = _clock.UtcNow
        };

        _db.TestSuites.Add(suite);
        await _db.SaveChangesAsync(ct);
        return Ok(new { suite.Id, suite.Name });
    }
}
