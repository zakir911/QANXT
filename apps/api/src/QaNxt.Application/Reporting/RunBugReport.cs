namespace QaNxt.Application.Reporting;

/// <summary>Everything a developer needs to fix what one test run found, without asking QA:
/// where, how to reproduce with the exact values, what was expected and what happened, the
/// requests and responses, the console, the screenshots, and how to check the fix.
///
/// Failures are grouped the way defects are — by symptom and place — so twenty tests failing
/// on one crash are one bug with twenty affected tests. Failures that are not the
/// application's fault (a changed locator, an environment outage) are kept apart, so a
/// developer is never sent to fix a broken test.</summary>
public sealed record RunBugReport(
    ReportRun Run,
    IReadOnlyList<ReportBug> Bugs,
    IReadOnlyList<ReportOtherFailure> NotProductBugs,
    IReadOnlyList<ReportFlakyTest> PassedOnRetry,
    IReadOnlyList<ReportSkipGroup> Skipped,
    DateTimeOffset GeneratedAt,
    /// <summary>Pass and fail by testing type — functional, boundary, security and so on — so a
    /// reader sees which kinds of testing passed before reading any bug.</summary>
    IReadOnlyList<ReportTypeResult>? ByTestingType = null,
    /// <summary>The security scan run together with these tests, when there was one.</summary>
    ReportSecurityScan? Security = null);

public sealed record ReportTypeResult(string TestingType, int Tests, int Passed, int Failed, int Skipped, int Bugs, string Verdict);

public sealed record ReportSecurityScan(string Reference, string Status, string Profile, int ChecksExecuted, int ChecksSkipped,
    int RequestsBlocked, int Findings, string? Note);

public sealed record ReportRun(
    Guid Id, string Name, string Project, string? Environment, string? EnvironmentUrl,
    IReadOnlyList<ReportApplication> Applications, string Trigger, string Browser, string? BrowserVersion,
    DateTimeOffset? StartedAt, DateTimeOffset? CompletedAt, int DurationMs, string Status,
    int Total, int Passed, int Failed, int Skipped, int Blocked,
    string? CommitSha, string? Branch, string? BuildId, string? ApplicationBuild, string? ConsoleUrl);

public sealed record ReportApplication(string Name, string BaseUrl);

public sealed record ReportBug(
    string Key,
    Guid? DefectId, string? DefectReference, string? DefectStatus,
    string Title, string Severity, string Priority, string? Category,
    string Classification, int Confidence,
    string? Application, string? PageUrl, string? Form, string? Field, string? Endpoint,
    string Browser, string? BrowserVersion, string Viewport,
    DateTimeOffset? FirstSeenAt, int? Occurrences, string? RegressionTest,
    string Summary,
    IReadOnlyList<ReportStep> Steps,
    IReadOnlyDictionary<string, string>? TestData,
    string Expected, string Actual,
    ReportStep? FailingStep,
    string? PageText,
    string WhereToLook,
    IReadOnlyList<ReportExchange> Exchanges,
    string? Curl,
    IReadOnlyList<ReportConsoleLine> Console,
    IReadOnlyList<ReportA11yViolation> Accessibility,
    IReadOnlyList<ReportArtifact> Screenshots,
    IReadOnlyList<ReportArtifact> Attachments,
    IReadOnlyList<ReportAffectedTest> AffectedTests,
    string VerifyTheFix,
    Guid ExecutionId, string? ExecutionUrl);

public sealed record ReportStep(int Order, string Description, string? Url, string Status, string? Error, bool IsCheck);

public sealed record ReportExchange(string Method, string Url, int? StatusCode, int DurationMs,
    string? RequestHeaders, string? Request, string? Response, string? FailureText);

public sealed record ReportConsoleLine(string Level, string Message, string? Url, string? StackTrace);

public sealed record ReportA11yViolation(string Rule, string? Impact, string Help, string? HelpUrl, IReadOnlyList<string> Elements);

/// <summary>A stored artifact the report refers to. <see cref="StorageKey"/> never leaves the
/// server: the renderers embed or package the bytes and show only the caption and file name.</summary>
public sealed record ReportArtifact(Guid Id, string Kind, string FileName, string ContentType, long SizeBytes, string Caption,
    [property: System.Text.Json.Serialization.JsonIgnore] string StorageKey);

public sealed record ReportAffectedTest(string Reference, string Name, string? Field, string? Technique, string Actual,
    IReadOnlyDictionary<string, string>? TestData, Guid ExecutionId);

public sealed record ReportOtherFailure(string Reference, string Name, string Classification, string Message, string WhoActs, Guid ExecutionId);

public sealed record ReportFlakyTest(string Reference, string Name, int Attempts, string FirstFailure);

public sealed record ReportSkipGroup(string Reason, int Count, IReadOnlyList<string> Tests);

/// <summary>A downloadable rendering of the report.</summary>
public sealed record ReportFile(string FileName, string ContentType, byte[] Content);
