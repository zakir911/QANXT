using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Testing;

/// <summary>One test case executed once within a run (retries create new attempts).</summary>
public class TestExecution : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid TestRunId { get; set; }
    public TestRun? TestRun { get; set; }
    public Guid TestCaseId { get; set; }
    public TestCase? TestCase { get; set; }

    /// <summary>Version of the test case that ran; keeps history interpretable after edits.</summary>
    public int TestCaseVersion { get; set; }
    public int Attempt { get; set; } = 1;
    public ExecutionStatus Status { get; set; } = ExecutionStatus.Pending;

    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public int DurationMs { get; set; }

    public BrowserType Browser { get; set; } = BrowserType.Chromium;
    public string? BrowserVersion { get; set; }
    public string? WorkerId { get; set; }
    /// <summary>The id of the request that asked for this run, carried through the queue to
    /// the worker and onto every log line and audit record the work produces.</summary>
    /// <remarks>
    /// Deliberately not defaulted to a fresh Guid. It was, and because a generated id is
    /// indistinguishable from a real one, nothing assigning it went unnoticed: every
    /// execution carried an id that correlated with nothing, the API published it and the
    /// CLI report printed it, and following it found no log line and no audit record
    /// (BUG-0037). Empty is a visibly missing value; a plausible one is a lie.
    /// </remarks>
    public string CorrelationId { get; set; } = string.Empty;

    public int StepsTotal { get; set; }
    public int StepsPassed { get; set; }
    public int StepsFailed { get; set; }
    public int StepsHealed { get; set; }
    public int ConsoleErrorCount { get; set; }
    public int NetworkErrorCount { get; set; }

    /// <summary>Masked, engine-level message. The human-readable explanation lives in FailureAnalysis.</summary>
    public string? ErrorMessage { get; set; }
    public string? ErrorStack { get; set; }

    public ICollection<TestAction> Actions { get; set; } = new List<TestAction>();
    public ICollection<Evidence.Artifact> Artifacts { get; set; } = new List<Evidence.Artifact>();
}
