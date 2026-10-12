using System.Text.Json;
using QaNxt.Domain.Testing;

namespace QaNxt.Application.Testing;

/// <summary>Snapshots of a test case, so two versions can be compared and an execution can
/// always be read against the test that actually ran.</summary>
public static class TestCaseHistory
{
    public static TestCaseVersion SnapshotOf(TestCase testCase, string summary, Guid? userId, DateTimeOffset at) => new()
    {
        OrganizationId = testCase.OrganizationId,
        TestCaseId = testCase.Id,
        Version = testCase.Version,
        ChangeSummary = summary.Length <= 1000 ? summary : summary[..1000],
        ChangedByUserId = userId,
        SnapshotJson = JsonSerializer.Serialize(Describe(testCase)),
        CreatedAt = at
    };

    /// <summary>A test case as plain data: what a version comparison reads.</summary>
    public static object Describe(TestCase testCase) => new
    {
        testCase.Reference, testCase.Name, testCase.Objective, testCase.Preconditions, testCase.ExpectedResults,
        Priority = testCase.Priority.ToString(), Risk = testCase.Risk.ToString(), testCase.Tags,
        Category = testCase.Category?.ToString(), testCase.Technique, Lifecycle = testCase.Lifecycle.ToString(),
        testCase.Version,
        Steps = testCase.Steps.OrderBy(s => s.Order).Select(s => new
        {
            s.Order, s.Description, Action = s.Action.ToString(), s.TargetJson, s.Value, s.Url,
            Assertions = s.Assertions.Select(a => new { Type = a.Type.ToString(), a.ExpectedValue, a.AttributeName, a.Negate })
        })
    };
}
