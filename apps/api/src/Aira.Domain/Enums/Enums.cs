namespace Aira.Domain.Enums;

/// <summary>Built-in roles. Roles are stored as rows so customers can add their own,
/// but these seven are seeded and referenced by the permission matrix.</summary>
public enum SystemRole
{
    SuperAdmin = 0,
    OrganizationAdmin = 1,
    ProjectAdmin = 2,
    QaLead = 3,
    QaEngineer = 4,
    Developer = 5,
    Viewer = 6
}

public enum UserStatus { Invited = 0, Active = 1, Suspended = 2, Disabled = 3 }

public enum AuthenticationStrategy
{
    /// <summary>The application needs no login.</summary>
    None = 0,
    /// <summary>Username/password typed into a form, described declaratively.</summary>
    FormLogin = 1,
    /// <summary>Playwright storage state (cookies + localStorage) supplied up front.</summary>
    StorageState = 2,
    /// <summary>A bearer token injected as an Authorization header.</summary>
    BearerToken = 3,
    /// <summary>HTTP basic authentication.</summary>
    BasicAuth = 4
}

public enum DiscoveryStatus { Queued = 0, Running = 1, Completed = 2, Failed = 3, Cancelled = 4, PartiallyCompleted = 5 }

public enum ElementKind
{
    Unknown = 0, Link = 1, Button = 2, TextInput = 3, PasswordInput = 4, NumberInput = 5,
    DateInput = 6, FileInput = 7, Checkbox = 8, Radio = 9, Select = 10, TextArea = 11,
    Form = 12, Table = 13, Dialog = 14, Menu = 15, Tab = 16, Navigation = 17,
    Heading = 18, Image = 19, Alert = 20, Text = 21
}

public enum PageKind { Unknown = 0, Login = 1, Dashboard = 2, List = 3, Detail = 4, Form = 5, Report = 6, Settings = 7, Error = 8 }

public enum TestCaseSource { Manual = 0, AiGenerated = 1, RecordedJourney = 2, Imported = 3 }

public enum TestPriority { Critical = 0, High = 1, Medium = 2, Low = 3 }

public enum RiskLevel { Critical = 0, High = 1, Medium = 2, Low = 3 }

/// <summary>Verbs the execution engine understands. AI-authored plans are validated
/// against exactly this closed set before anything touches a browser.</summary>
public enum BrowserActionType
{
    Navigate = 0, Click = 1, DoubleClick = 2, Fill = 3, Select = 4, Check = 5, Uncheck = 6,
    Hover = 7, Press = 8, Upload = 9, Download = 10, Wait = 11, Screenshot = 12, Scroll = 13,
    AssertText = 20, AssertVisible = 21, AssertHidden = 22, AssertUrl = 23, AssertValue = 24,
    AssertCount = 25, AssertAttribute = 26, AssertEnabled = 27, AssertDisabled = 28,
    /// <summary>Only permitted when the project explicitly allows scripting AND the caller
    /// holds the execution:script permission. Rejected by default.</summary>
    ExecuteScript = 90
}

public enum AssertionType
{
    TextEquals = 0, TextContains = 1, Visible = 2, Hidden = 3, UrlEquals = 4, UrlContains = 5,
    ValueEquals = 6, CountEquals = 7, AttributeEquals = 8, Enabled = 9, Disabled = 10,
    HttpStatusEquals = 11, NoConsoleErrors = 12
}

public enum ExecutionStatus
{
    Pending = 0, Queued = 1, Running = 2,
    Passed = 10, Failed = 11, Skipped = 12, Blocked = 13, Healed = 14, Flaky = 15,
    TimedOut = 16, Cancelled = 17, Error = 18
}

public enum RunTrigger { Manual = 0, Scheduled = 1, Cicd = 2, Api = 3, Agent = 4 }

public enum BrowserType { Chromium = 0, Firefox = 1, Webkit = 2 }

public enum ArtifactKind
{
    Screenshot = 0, Video = 1, Trace = 2, Har = 3, DomSnapshot = 4, AccessibilityTree = 5,
    ConsoleLog = 6, NetworkLog = 7, Download = 8, Report = 9, Other = 10
}

/// <summary>Deterministic classification produced by the failure analyser. The AI may
/// refine the explanation but may not invent a category outside this set.</summary>
public enum FailureCategory
{
    Unknown = 0,
    ApplicationDefect = 1,
    TestDefect = 2,
    EnvironmentDefect = 3,
    LocatorChange = 4,
    TimingIssue = 5,
    NetworkIssue = 6,
    AuthenticationIssue = 7,
    DataIssue = 8,
    ThirdPartyDependency = 9
}

public enum HealingPolicy { Never = 0, Suggest = 1, Auto = 2 }

public enum HealingOutcome { Proposed = 0, Applied = 1, Rejected = 2, Approved = 3, Reverted = 4, Failed = 5 }

public enum DefectStatus { Proposed = 0, Open = 1, Triaged = 2, InProgress = 3, Resolved = 4, Rejected = 5, Duplicate = 6 }

public enum DefectSeverity { Blocker = 0, Critical = 1, Major = 2, Minor = 3, Trivial = 4 }

public enum LlmProviderKind { Local = 0, OpenAi = 1, Anthropic = 2, Gemini = 3 }

public enum AiRequestKind
{
    TestPlanGeneration = 0, TestCaseGeneration = 1, FailureAnalysis = 2, RootCauseAnalysis = 3,
    LocatorHealing = 4, JourneyNaming = 5, RiskAssessment = 6, DefectProposal = 7,
    QualityInsight = 8, ElementSemantics = 9
}

public enum AiRequestStatus { Pending = 0, Succeeded = 1, Failed = 2, SchemaRejected = 3, CacheHit = 4, BudgetExceeded = 5 }

public enum IntegrationKind { GitHubActions = 0, AzureDevOps = 1, Jira = 2, Slack = 3, Webhook = 4 }

public enum QualityGateOperator { LessThan = 0, LessThanOrEqual = 1, GreaterThan = 2, GreaterThanOrEqual = 3, Equal = 4, NotEqual = 5 }

public enum QualityGateMetric
{
    PassRatePercent = 0, FailedCount = 1, CriticalFailedCount = 2, FlakyCount = 3,
    NewFailureCount = 4, HighConfidenceDefectCount = 5, CriticalJourneyFailedCount = 6,
    HealedCount = 7, AverageDurationMs = 8,
    // Added for continuous quality. Each is measured from stored results; a metric nothing
    // can measure yet is not added, because a rule over an always-zero value reads like a
    // guarantee and is not one.
    HighFailedCount = 9, MediumFailedCount = 10, FlakyRatePercent = 11,
    ApiFailedCount = 12, ContractBreakingChangeCount = 13, SecurityFailedCount = 14,
    RegressionFailedCount = 15, BlockedCount = 16
}

/// <summary>What a failing rule should do to the pipeline.
///
/// REVIEW exists because "a person must look at this" is a real third answer, and folding it
/// into either PASS or FAIL loses information a release decision needs. A rule that heals
/// tests is the obvious case: the journey completed, so failing the build would be wrong,
/// and passing silently would hide that a locator was rewritten.</summary>
public enum QualityGateAction { Fail = 0, Review = 1, Warn = 2 }

/// <summary>Where an application is deployed. Production is refused by default and needs a
/// deliberate, recorded authorization on the environment itself.</summary>
public enum EnvironmentKind { Development = 0, Qa = 1, Staging = 2, Uat = 3, Production = 4 }

/// <summary>The gate's verdict for a whole run.</summary>
public enum QualityGateOutcome { Pass = 0, Review = 1, Fail = 2 }

/// <summary>What a project wants to happen when a test only passed because a locator was
/// repaired. Configurable because the right answer differs between a team that wants speed
/// and a team that wants every rewrite seen.</summary>
public enum SelfHealingGatePolicy
{
    /// <summary>A healed test counts as a pass and nothing is said about it in the gate.</summary>
    Pass = 0,
    /// <summary>Counts as a pass, and the gate records a warning naming the healed tests.</summary>
    PassWithWarning = 1,
    /// <summary>The gate returns REVIEW: the build need not stop, but a person must look.</summary>
    RequireReview = 2,
    /// <summary>The gate fails. For teams that treat any silent locator change as a defect.</summary>
    Fail = 3
}

/// <summary>Where a bounded agent pass has got to.</summary>
public enum AgentPhase
{
    Pending = 0, Exploring = 1, Modelling = 2, Prioritizing = 3, Generating = 4,
    Executing = 5, Investigating = 6, Proposing = 7, Done = 8
}

public enum AgentRunStatus { Queued = 0, Running = 1, Completed = 2, Failed = 3, Cancelled = 4, Stopped = 5 }

/// <summary>What an agent concluded. Every one of these is a proposal for a person.</summary>
public enum AgentFindingKind
{
    CoverageGap = 0, RiskArea = 1, SuspectedDefect = 2, Regression = 3,
    UnstableTest = 4, BrokenLocator = 5, Observation = 6
}

public enum JourneySource { Discovered = 0, Recorded = 1, Manual = 2, AiProposed = 3 }

public enum TestDataKind { Static = 0, Generated = 1, Random = 2, SeededRandom = 3, SecretReference = 4, EnvironmentSpecific = 5 }

public enum AuditAction
{
    Login = 0, LoginFailed = 1, Logout = 2, UserCreated = 3, UserUpdated = 4, RoleChanged = 5,
    OrganizationCreated = 6, ProjectCreated = 7, ProjectUpdated = 8, ProjectDeleted = 9,
    ApplicationCreated = 10, ApplicationUpdated = 11, DiscoveryStarted = 12,
    TestCaseCreated = 13, TestCaseUpdated = 14, TestCaseDeleted = 15,
    TestRunStarted = 16, TestRunCompleted = 17, HealingProposed = 18, HealingApproved = 19,
    HealingRejected = 20, HealingApplied = 21, AiGeneration = 22, IntegrationConfigured = 23,
    SecretConfigured = 24, ConfigurationChanged = 25, QualityGateChanged = 26, DefectCreated = 27,
    AgentRunStarted = 28, AgentRunCompleted = 29
}
