using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Testing;

namespace QaNxt.Application.Testing;

public sealed record TestVersionView(int Version, string ChangeSummary, DateTimeOffset At, Guid? ChangedByUserId, JsonElement Snapshot);

public sealed record VersionComparison(int From, int To, IReadOnlyList<string> Differences);

public sealed record BulkResult(int Changed, IReadOnlyList<string> Problems);

public interface ITestRepositoryService
{
    Task<Result<Guid>> DuplicateAsync(Guid testCaseId, string? name, CancellationToken ct = default);
    Task<Result> SetLifecycleAsync(Guid testCaseId, TestCaseLifecycle lifecycle, CancellationToken ct = default);
    Task<Result<BulkResult>> BulkLifecycleAsync(Guid projectId, Guid[] testCaseIds, TestCaseLifecycle lifecycle, CancellationToken ct = default);
    Task<Result<BulkResult>> BulkTagAsync(Guid projectId, Guid[] testCaseIds, string tag, bool remove, CancellationToken ct = default);
    Task<Result<IReadOnlyList<TestVersionView>>> VersionsAsync(Guid testCaseId, CancellationToken ct = default);
    Task<Result<VersionComparison>> CompareAsync(Guid testCaseId, int from, int to, CancellationToken ct = default);
    /// <summary>Records the current version before an edit, so the edit can be compared and undone.</summary>
    Task SnapshotBeforeEditAsync(TestCase testCase, string summary, CancellationToken ct = default);
}

/// <summary>A test repository rather than a heap of tests: lifecycle, copies, tags, bulk
/// changes and a history of every version that ran.</summary>
public sealed class TestRepositoryService : ITestRepositoryService
{
    private readonly IQaNxtDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IClock _clock;
    private readonly IAuditLogger _audit;

    public TestRepositoryService(IQaNxtDbContext db, ICurrentUser currentUser, IClock clock, IAuditLogger audit)
    {
        _db = db;
        _currentUser = currentUser;
        _clock = clock;
        _audit = audit;
    }

    public static async Task<string> NextReferenceAsync(IQaNxtDbContext db, Guid projectId, CancellationToken ct)
    {
        var references = await db.TestCases.IgnoreQueryFilters()
            .Where(tc => tc.ProjectId == projectId && tc.Reference.StartsWith("TC-"))
            .Select(tc => tc.Reference).ToListAsync(ct);
        var next = references.Select(r => int.TryParse(r[3..], out var n) ? n : 0).DefaultIfEmpty(0).Max() + 1;
        return $"TC-{next:0000}";
    }

    /// <summary>A copy of a test with its steps and assertions, as a new test with no history.</summary>
    public static TestCase Copy(TestCase source, Guid suiteId, string reference, Guid? userId, DateTimeOffset at)
    {
        var copy = new TestCase
        {
            OrganizationId = source.OrganizationId, ProjectId = source.ProjectId, TestSuiteId = suiteId,
            ApplicationId = source.ApplicationId, JourneyId = source.JourneyId, Reference = reference,
            Name = source.Name, Objective = source.Objective, Preconditions = source.Preconditions,
            ExpectedResults = source.ExpectedResults, Kind = source.Kind, Priority = source.Priority, Risk = source.Risk,
            Tags = source.Tags, Source = TestCaseSource.Manual, TestDataSetId = source.TestDataSetId,
            Category = source.Category, Technique = source.Technique, AutomationStatus = source.AutomationStatus,
            ApplicationFormId = source.ApplicationFormId, FieldKey = source.FieldKey, CoverageKeysJson = source.CoverageKeysJson,
            TestDataJson = source.TestDataJson, EvidenceRequirements = source.EvidenceRequirements,
            RequirementReference = source.RequirementReference, CreatedByUserId = userId, CreatedAt = at
        };
        copy.SetLifecycle(TestCaseLifecycle.Active);
        foreach (var step in source.Steps.OrderBy(s => s.Order))
        {
            var stepCopy = new TestStep
            {
                OrganizationId = source.OrganizationId, TestCaseId = copy.Id, Order = step.Order, Description = step.Description,
                Action = step.Action, TargetJson = step.TargetJson, Value = step.Value, Url = step.Url,
                ApiRequestJson = step.ApiRequestJson, TimeoutMs = step.TimeoutMs, IsCritical = step.IsCritical,
                ContinueOnFailure = step.ContinueOnFailure, CreatedAt = at
            };
            foreach (var assertion in step.Assertions)
            {
                stepCopy.Assertions.Add(new Assertion
                {
                    OrganizationId = source.OrganizationId, TestStepId = stepCopy.Id, Type = assertion.Type,
                    TargetJson = assertion.TargetJson, ExpectedValue = assertion.ExpectedValue, AttributeName = assertion.AttributeName,
                    Negate = assertion.Negate, IsSoft = assertion.IsSoft, Description = assertion.Description, CreatedAt = at
                });
            }
            copy.Steps.Add(stepCopy);
        }
        return copy;
    }

    public async Task<Result<Guid>> DuplicateAsync(Guid testCaseId, string? name, CancellationToken ct = default)
    {
        var source = await _db.TestCases.Include(tc => tc.Steps).ThenInclude(s => s.Assertions).FirstOrDefaultAsync(tc => tc.Id == testCaseId, ct);
        if (source is null) return Error.NotFound("The test case");
        var copy = Copy(source, source.TestSuiteId, await NextReferenceAsync(_db, source.ProjectId, ct), _currentUser.UserId, _clock.UtcNow);
        copy.Name = string.IsNullOrWhiteSpace(name) ? Truncate($"{source.Name} (copy)", 300) : Truncate(name.Trim(), 300);
        // A copy is a person's test from now on, so it is never regenerated over.
        copy.GenerationKey = null;
        copy.SetLifecycle(TestCaseLifecycle.Draft);
        _db.TestCases.Add(copy);
        await _db.SaveChangesAsync(ct);
        await _audit.LogAsync(AuditAction.TestCaseCreated, nameof(TestCase), copy.Id,
            $"{copy.Reference} duplicated from {source.Reference}.", projectId: source.ProjectId, ct: ct);
        return Result<Guid>.Success(copy.Id);
    }

    public async Task<Result> SetLifecycleAsync(Guid testCaseId, TestCaseLifecycle lifecycle, CancellationToken ct = default)
    {
        var testCase = await _db.TestCases.FirstOrDefaultAsync(tc => tc.Id == testCaseId, ct);
        if (testCase is null) return Result.Failure(Error.NotFound("The test case"));
        var previous = testCase.Lifecycle;
        testCase.SetLifecycle(lifecycle);
        testCase.UpdatedByUserId = _currentUser.UserId;
        await _db.SaveChangesAsync(ct);
        await _audit.LogAsync(AuditAction.TestCaseUpdated, nameof(TestCase), testCase.Id,
            $"{testCase.Reference} moved from {previous} to {lifecycle}.", projectId: testCase.ProjectId, ct: ct);
        return Result.Success();
    }

    public async Task<Result<BulkResult>> BulkLifecycleAsync(Guid projectId, Guid[] testCaseIds, TestCaseLifecycle lifecycle, CancellationToken ct = default)
    {
        var cases = await _db.TestCases.Where(tc => tc.ProjectId == projectId && testCaseIds.Contains(tc.Id)).ToListAsync(ct);
        foreach (var testCase in cases)
        {
            testCase.SetLifecycle(lifecycle);
            testCase.UpdatedByUserId = _currentUser.UserId;
        }
        await _db.SaveChangesAsync(ct);
        var problems = testCaseIds.Except(cases.Select(c => c.Id)).Select(id => $"{id}: not found in this project.").ToList();
        await _audit.LogAsync(AuditAction.TestCaseUpdated, nameof(TestCase), null,
            $"{cases.Count} test case(s) moved to {lifecycle}.", projectId: projectId, ct: ct);
        return Result<BulkResult>.Success(new BulkResult(cases.Count, problems));
    }

    public async Task<Result<BulkResult>> BulkTagAsync(Guid projectId, Guid[] testCaseIds, string tag, bool remove, CancellationToken ct = default)
    {
        tag = tag.Trim().Replace(",", string.Empty);
        if (tag.Length == 0) return Error.Validation("A tag cannot be empty.");
        var cases = await _db.TestCases.Where(tc => tc.ProjectId == projectId && testCaseIds.Contains(tc.Id)).ToListAsync(ct);
        foreach (var testCase in cases)
        {
            var tags = testCase.Tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
            if (remove) tags.RemoveAll(t => t.Equals(tag, StringComparison.OrdinalIgnoreCase));
            else if (!tags.Contains(tag, StringComparer.OrdinalIgnoreCase)) tags.Add(tag);
            testCase.Tags = Truncate(string.Join(',', tags), 500);
        }
        await _db.SaveChangesAsync(ct);
        return Result<BulkResult>.Success(new BulkResult(cases.Count, Array.Empty<string>()));
    }

    public async Task<Result<IReadOnlyList<TestVersionView>>> VersionsAsync(Guid testCaseId, CancellationToken ct = default)
    {
        var testCase = await _db.TestCases.Include(tc => tc.Steps).ThenInclude(s => s.Assertions).FirstOrDefaultAsync(tc => tc.Id == testCaseId, ct);
        if (testCase is null) return Error.NotFound("The test case");
        var stored = await _db.TestCaseVersions.Where(v => v.TestCaseId == testCaseId).OrderBy(v => v.Version).ToListAsync(ct);
        var views = stored.Select(v => new TestVersionView(v.Version, v.ChangeSummary, v.CreatedAt, v.ChangedByUserId, JsonDocument.Parse(v.SnapshotJson).RootElement.Clone())).ToList();
        views.Add(new TestVersionView(testCase.Version, "Current version", testCase.UpdatedAt ?? testCase.CreatedAt, testCase.UpdatedByUserId,
            JsonSerializer.SerializeToElement(TestCaseHistory.Describe(testCase))));
        return Result<IReadOnlyList<TestVersionView>>.Success(views);
    }

    public async Task<Result<VersionComparison>> CompareAsync(Guid testCaseId, int from, int to, CancellationToken ct = default)
    {
        var versions = await VersionsAsync(testCaseId, ct);
        if (!versions.IsSuccess) return Result<VersionComparison>.Failure(versions.Error!);
        var a = versions.Value!.LastOrDefault(v => v.Version == from);
        var b = versions.Value!.LastOrDefault(v => v.Version == to);
        if (a is null || b is null) return Error.NotFound($"Version {(a is null ? from : to)}");

        var differences = new List<string>();
        foreach (var property in new[] { "Name", "Objective", "Preconditions", "ExpectedResults", "Priority", "Risk", "Tags", "Category", "Technique", "Lifecycle" })
        {
            var left = Read(a.Snapshot, property);
            var right = Read(b.Snapshot, property);
            if (left != right) differences.Add($"{property}: \"{left}\" → \"{right}\"");
        }
        var stepsA = Steps(a.Snapshot);
        var stepsB = Steps(b.Snapshot);
        for (var i = 0; i < Math.Max(stepsA.Count, stepsB.Count); i++)
        {
            var left = i < stepsA.Count ? stepsA[i] : null;
            var right = i < stepsB.Count ? stepsB[i] : null;
            if (left == right) continue;
            differences.Add(left is null ? $"Step {i + 1} added: {right}" : right is null ? $"Step {i + 1} removed: {left}" : $"Step {i + 1}: {left} → {right}");
        }
        return Result<VersionComparison>.Success(new VersionComparison(from, to, differences));

        static string Read(JsonElement e, string name) => e.TryGetProperty(name, out var v) ? v.ToString() : string.Empty;
        static List<string> Steps(JsonElement e) => e.TryGetProperty("Steps", out var steps)
            ? steps.EnumerateArray().Select(s => $"{s.GetProperty("Action")} {s.GetProperty("Description")} [{(s.TryGetProperty("Value", out var v) ? v.ToString() : string.Empty)}]").ToList()
            : new List<string>();
    }

    public async Task SnapshotBeforeEditAsync(TestCase testCase, string summary, CancellationToken ct = default)
    {
        if (!_db.TestSteps.Local.Any(s => s.TestCaseId == testCase.Id))
            await _db.TestSteps.Where(s => s.TestCaseId == testCase.Id).Include(s => s.Assertions).LoadAsync(ct);
        if (await _db.TestCaseVersions.AnyAsync(v => v.TestCaseId == testCase.Id && v.Version == testCase.Version, ct)) return;
        _db.TestCaseVersions.Add(TestCaseHistory.SnapshotOf(testCase, summary, _currentUser.UserId, _clock.UtcNow));
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];
}
