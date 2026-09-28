using Aira.Application.Security;
using Aira.Domain.Enums;

namespace Aira.Application.Agent;

/// <summary>
/// How dangerous an action is, independent of who is asking.
/// </summary>
/// <remarks>
/// Deliberately parallel to the security engine's risk ladder, and for the same reason: the
/// declared risk sets a floor that a caller can raise and never lower. An agent that could
/// describe a deletion as an observation would have no policy at all.
/// </remarks>
public enum AgentActionRisk
{
    /// <summary>Reads. Nothing about the application changes.</summary>
    Observation = 0,
    /// <summary>Drives the application the way a user would, without changing stored state.</summary>
    Interaction = 1,
    /// <summary>Leaves something behind: a submitted form, a created record, a queued job.</summary>
    StateChanging = 2,
    /// <summary>Cannot be assumed reversible.</summary>
    Destructive = 3
}

/// <summary>
/// One action the agent is allowed to take, declared rather than discovered.
/// </summary>
/// <remarks>
/// <para>
/// The registry exists so that "what may the agent do" has exactly one answer, written down,
/// that can be read without following call chains. Before it, every capability was a direct
/// service call and the risk of an action lived in the head of whoever wrote the phase.
/// </para>
/// <para>
/// A tool is not an implementation. It is the declaration a policy is checked against — the
/// name, what it takes, what it returns, how dangerous it is, which permission the run must
/// carry, which environments it may touch, and whether it has to leave an audit entry. The
/// implementation stays where it already is; nothing here reimplements discovery, test
/// generation, execution or scanning.
/// </para>
/// </remarks>
public sealed record AgentTool(
    string Name,
    string Purpose,
    /// <summary>The fields the action takes, as a name → description map. A schema a person
    /// can read; the deterministic executors validate their own input as they always did.</summary>
    IReadOnlyDictionary<string, string> Input,
    IReadOnlyDictionary<string, string> Output,
    AgentActionRisk Risk,
    /// <summary>The permission the run's initiator must hold. Null means the agent's own
    /// <c>agent:run</c> is enough.</summary>
    string? RequiredPermission,
    /// <summary>Where this may be used. Production is absent from almost everything on
    /// purpose.</summary>
    IReadOnlySet<EnvironmentKind> AllowedEnvironments,
    /// <summary>Whether using this has to leave an entry in the audit trail.</summary>
    bool AuditRequired)
{
    public bool PermitsEnvironment(EnvironmentKind kind) => AllowedEnvironments.Contains(kind);
}

/// <summary>
/// Every action the agent may take. There is no other list.
/// </summary>
/// <remarks>
/// <para>
/// An agent that can call anything on the platform is bounded by nothing, whatever its
/// configuration says. So the loop reaches the platform through <see cref="Resolve"/> and a
/// tool the registry does not name cannot be used — not "should not", cannot, because there
/// is no entry to check a policy against and an unknown tool is refused.
/// </para>
/// <para>
/// The environments are the interesting column. Almost nothing lists Production, and the two
/// entries that do are reads. Nothing that changes state, and nothing that tests security,
/// can name a production environment here — which means the refusal happens before any
/// permission is consulted, and an operator who holds every permission still cannot point a
/// destructive action at production through the agent.
/// </para>
/// </remarks>
public static class AgentToolRegistry
{
    private static IReadOnlySet<EnvironmentKind> NonProduction { get; } =
        new HashSet<EnvironmentKind>
        {
            EnvironmentKind.Development, EnvironmentKind.Qa,
            EnvironmentKind.Staging, EnvironmentKind.Uat
        };

    private static IReadOnlySet<EnvironmentKind> Anywhere { get; } =
        new HashSet<EnvironmentKind>(Enum.GetValues<EnvironmentKind>());

    private static Dictionary<string, string> Fields(params (string Name, string Meaning)[] fields)
        => fields.ToDictionary(f => f.Name, f => f.Meaning);

    public static IReadOnlyList<AgentTool> All { get; } = new List<AgentTool>
    {
        // ---- Browser ---------------------------------------------------------
        new("browser.navigate", "Open a URL inside the application under test.",
            Fields(("url", "An absolute URL within the application's allowed domains.")),
            Fields(("status", "The HTTP status the page returned."),
                   ("finalUrl", "Where it ended up after redirects.")),
            AgentActionRisk.Interaction, null, NonProduction, AuditRequired: false),

        new("browser.click", "Click an element.",
            Fields(("locator", "How to find the element."),
                   ("description", "What the element is, for the trail.")),
            Fields(("navigated", "Whether the click caused a navigation.")),
            AgentActionRisk.Interaction, null, NonProduction, AuditRequired: false),

        new("browser.type", "Type into a field.",
            Fields(("locator", "How to find the field."),
                   ("valueRef", "A reference to test data. Never a literal credential.")),
            Fields(("accepted", "Whether the field took the value.")),
            AgentActionRisk.Interaction, null, NonProduction, AuditRequired: false),

        new("browser.select", "Choose an option from a select.",
            Fields(("locator", "How to find the control."), ("option", "The option to choose.")),
            Fields(("selected", "What ended up selected.")),
            AgentActionRisk.Interaction, null, NonProduction, AuditRequired: false),

        // Uploading leaves something behind, and what it leaves is a file. Rated above the
        // other browser verbs for that reason rather than for how it is implemented.
        new("browser.upload", "Attach a file to a file input.",
            Fields(("locator", "The file input."),
                   ("fixture", "A named fixture from the test data set. Never an arbitrary path.")),
            Fields(("accepted", "Whether the input took the file.")),
            AgentActionRisk.StateChanging, Permissions.TestWrite, NonProduction, AuditRequired: true),

        new("browser.capture", "Capture evidence: screenshot, DOM, console, network.",
            Fields(("kind", "screenshot | dom | console | network | trace")),
            Fields(("artifactId", "Where the evidence was stored.")),
            AgentActionRisk.Observation, null, Anywhere, AuditRequired: false),

        new("browser.inspect", "Read the current page without touching it.",
            Fields(("scope", "page | elements | forms | links")),
            Fields(("observation", "A structured description of what is there.")),
            AgentActionRisk.Observation, null, Anywhere, AuditRequired: false),

        // ---- API -------------------------------------------------------------
        new("api.request", "Issue an HTTP request to an application endpoint.",
            Fields(("method", "The verb. The verb sets the risk floor."),
                   ("path", "The endpoint, within the application's allowed domains."),
                   ("bodyRef", "A reference to test data, never a literal secret.")),
            Fields(("status", "The response status."), ("exchangeId", "The stored exchange.")),
            AgentActionRisk.StateChanging, Permissions.ExecutionRun, NonProduction, AuditRequired: true),

        new("api.inspect", "Read a stored contract or a previous exchange.",
            Fields(("endpointId", "The endpoint to read.")),
            Fields(("contract", "The contract as discovery recorded it.")),
            AgentActionRisk.Observation, null, Anywhere, AuditRequired: false),

        // ---- Security --------------------------------------------------------
        // The agent selects; the security engine decides. This tool queues a scan through the
        // existing launcher, which re-checks the scope, the profile, the permissions and the
        // environment. There is no path from here to issuing a security request directly.
        new("security.scan", "Ask the security engine to scan an authorized application.",
            Fields(("applicationId", "The application, which must carry an enabled scope."),
                   ("checks", "Optional narrowing. The full implied set stays the denominator.")),
            Fields(("securityScanId", "The queued scan."), ("gate", "Its verdict once reported.")),
            AgentActionRisk.StateChanging, Permissions.SecurityScan, NonProduction, AuditRequired: true),

        new("security.validateScope", "Read what an application has authorized.",
            Fields(("applicationId", "The application.")),
            Fields(("scope", "The scope, or the fact that there is none.")),
            AgentActionRisk.Observation, Permissions.SecurityRead, Anywhere, AuditRequired: false),

        // ---- Platform --------------------------------------------------------
        new("application.discover", "Start a bounded crawl of the application.",
            Fields(("applicationId", "The application."), ("maxPages", "Bound."), ("maxDepth", "Bound.")),
            Fields(("discoveryRunId", "The crawl."), ("pages", "How many it reached.")),
            AgentActionRisk.Interaction, Permissions.DiscoveryRun, NonProduction, AuditRequired: true),

        // Reading only. It compares what discovery found against what tests exist, and every
        // number it produces is a count of stored rows — so a gap it reports is a gap in the
        // platform's own records, never an assertion about the application itself.
        new("coverage.analyse", "Compare what the application can do against what is tested.",
            Fields(("applicationId", "The application."),
                   ("dimensions", "Which dimensions apply to each capability.")),
            Fields(("gaps", "Capability and dimension pairs nothing covers."),
                   ("unknown", "Pairs the platform could not decide either way.")),
            AgentActionRisk.Observation, Permissions.TestRead, Anywhere, AuditRequired: true),

        // Reading only. It groups failures the platform already recorded; it decides nothing
        // about them and raises no defect.
        new("failure.correlate", "Group failures that appear to share one cause.",
            Fields(("testRunId", "The run whose failures to group.")),
            Fields(("groups", "Causes, each with the failures underneath it and a confidence."),
                   ("ungrouped", "Failures that matched nothing. Listed, never hidden.")),
            AgentActionRisk.Observation, Permissions.TestRead, Anywhere, AuditRequired: true),

        new("test.generate", "Create test cases for an area that lacks coverage.",
            Fields(("target", "The page, endpoint or journey."), ("kind", "ui | api | security")),
            Fields(("testCaseIds", "What was created."), ("skippedAsDuplicate", "What was not, and why.")),
            AgentActionRisk.Observation, Permissions.TestGenerate, Anywhere, AuditRequired: true),

        new("test.execute", "Run test cases that already exist.",
            Fields(("testCaseIds", "What to run."), ("environmentId", "Where.")),
            Fields(("testRunId", "The run."), ("verdicts", "What each test returned.")),
            AgentActionRisk.StateChanging, Permissions.ExecutionRun, NonProduction, AuditRequired: true),

        new("test.retry", "Re-run tests that already ran, to separate a flake from a failure.",
            Fields(("executionIds", "Which executions to repeat.")),
            Fields(("verdicts", "What they returned the second time.")),
            AgentActionRisk.StateChanging, Permissions.ExecutionRun, NonProduction, AuditRequired: true),

        new("evidence.capture", "Store an artifact against a run.",
            Fields(("kind", "What it is."), ("payloadRef", "Where the bytes came from.")),
            Fields(("artifactId", "Where it was stored.")),
            AgentActionRisk.Observation, null, Anywhere, AuditRequired: false),

        new("report.generate", "Produce a report from what has been recorded.",
            Fields(("kind", "release | autonomous-qa")),
            Fields(("reportId", "The report."), ("path", "Where it was written.")),
            AgentActionRisk.Observation, null, Anywhere, AuditRequired: true)
    };

    private static readonly Dictionary<string, AgentTool> ByName =
        All.ToDictionary(t => t.Name, StringComparer.Ordinal);

    /// <summary>The tool with this name, or null. An unknown name is a refusal, never a
    /// pass-through: a registry with a default case is a registry that can be talked past.</summary>
    public static AgentTool? Resolve(string name) =>
        ByName.TryGetValue(name, out var tool) ? tool : null;

    public static IReadOnlyCollection<string> Names => ByName.Keys;
}
