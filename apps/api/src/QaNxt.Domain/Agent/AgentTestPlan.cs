using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Agent;

/// <summary>
/// What the agent proposes to test, before it tests anything.
/// </summary>
/// <remarks>
/// <para>
/// The agent used to generate and run in one motion. That is fine when it produces fifteen
/// tests and wrong at any scale worth having: a pass that decides to run two thousand tests
/// against a shared environment is a decision somebody should have made, and by the time the
/// run is finished it has been made for them.
/// </para>
/// <para>
/// So the plan is an object with a life of its own. It is proposed with its reasoning, a
/// person approves it, changes it or rejects it, and only an approved plan is executed. The
/// numbers in it are estimates and are labelled as estimates — an estimate presented as a
/// fact is how "this will take four minutes" becomes a forty-minute outage.
/// </para>
/// </remarks>
public class AgentTestPlan : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid AgentRunId { get; set; }
    public AgentRun? AgentRun { get; set; }
    public Guid ApplicationId { get; set; }

    public AgentPlanStatus Status { get; set; } = AgentPlanStatus.Proposed;

    /// <summary>What the pass is for, in the operator's words.</summary>
    public string Objective { get; set; } = string.Empty;

    /// <summary>What discovery found, so a reader can see what the plan was drawn from.</summary>
    public int PagesDiscovered { get; set; }
    public int EndpointsDiscovered { get; set; }
    public int JourneysKnown { get; set; }
    public int RolesKnown { get; set; }

    /// <summary>The plan in a paragraph, assembled by the platform rather than a model.</summary>
    public string Summary { get; set; } = string.Empty;

    /// <summary>
    /// Everything this plan will not cover, named rather than left to be inferred from absence.
    /// </summary>
    /// <remarks>
    /// The half of a plan that people skip. A plan listing 27 security tests reads as
    /// thorough; the same plan saying it covers none of the admin area because a person
    /// excluded it reads accurately.
    /// </remarks>
    public string NotCovered { get; set; } = string.Empty;

    public Guid? DecidedByUserId { get; set; }
    public string? DecidedByEmail { get; set; }
    public DateTimeOffset? DecidedAt { get; set; }
    /// <summary>Why a person changed or rejected it. Kept because a plan somebody halved is a
    /// decision about coverage, and decisions about coverage need reasons.</summary>
    public string? DecisionNote { get; set; }

    public ICollection<AgentTestPlanItem> Items { get; set; } = new List<AgentTestPlanItem>();
}

/// <summary>One category of testing in a proposed plan.</summary>
public class AgentTestPlanItem : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid AgentTestPlanId { get; set; }
    public AgentTestPlan? AgentTestPlan { get; set; }

    public AgentPlanCategory Category { get; set; }

    /// <summary>How many tests this category would contribute.</summary>
    public int TestCount { get; set; }

    /// <summary>How many of those do not exist yet and would be generated.</summary>
    public int ToGenerate { get; set; }

    /// <summary>Why this category is in the plan. Not a score: the reasoning.</summary>
    public string Why { get; set; } = string.Empty;

    public RiskLevel Risk { get; set; } = RiskLevel.Medium;

    /// <summary>What this category covers, in the plan's own terms.</summary>
    public string Coverage { get; set; } = string.Empty;

    /// <summary>
    /// A rough wall-clock estimate, in seconds.
    /// </summary>
    /// <remarks>
    /// Always described as an estimate wherever it is shown. It is derived from how long tests
    /// of this kind have taken on this application before, and where there is no history it
    /// falls back to a default that is deliberately pessimistic.
    /// </remarks>
    public int EstimatedSeconds { get; set; }

    /// <summary>Whether the estimate rests on this application's own history or on a default.</summary>
    public bool EstimateFromHistory { get; set; }

    /// <summary>What running this could do to the application under test.</summary>
    public string PotentialImpact { get; set; } = string.Empty;

    /// <summary>Whether this category is in the plan as it now stands. A person can switch a
    /// category off without rejecting the whole plan.</summary>
    public bool Included { get; set; } = true;
}

public enum AgentPlanStatus
{
    /// <summary>Waiting for a person.</summary>
    Proposed = 0,
    /// <summary>A person approved it, possibly after changing it.</summary>
    Approved = 1,
    /// <summary>A person said no. The run ends without executing.</summary>
    Rejected = 2,
    /// <summary>The run ended before anybody answered. Not an approval.</summary>
    Expired = 3
}

public enum AgentPlanCategory
{
    Smoke = 0,
    CriticalJourney = 1,
    Api = 2,
    Security = 3,
    Accessibility = 4,
    Visual = 5,
    Regression = 6,
    Exploratory = 7
}
