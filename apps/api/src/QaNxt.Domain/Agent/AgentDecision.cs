using QaNxt.Domain.Common;

namespace QaNxt.Domain.Agent;

/// <summary>
/// One decision the agent made, and everything needed to disagree with it later.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="AgentStep"/> already records the phases a pass went through. A step is too
/// coarse to answer the question a reader actually has, which is never "did it prioritise"
/// but "why did it choose <em>that</em>, and what was it looking at when it did".
/// </para>
/// <para>
/// So a decision carries the tool it used, the reason in words, the evidence behind the
/// reason, and what came back. It also carries whether a model was consulted and what that
/// cost — because "the agent decided" and "a model suggested and the agent accepted" are
/// different facts, and the second one is the one a reader should treat sceptically.
/// </para>
/// <para>
/// Nothing here is written by a model. The reason and the evidence are assembled by the
/// platform from what it already holds; a model's contribution, when there is one, is
/// recorded as an input rather than as the record itself.
/// </para>
/// </remarks>
public class AgentDecision : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid AgentRunId { get; set; }
    public AgentRun? AgentRun { get; set; }

    /// <summary>Order within the run. Monotonic, so a timeline needs no sorting heuristics.</summary>
    public int Sequence { get; set; }

    /// <summary>The phase this happened in, so a decision can be placed on the timeline.</summary>
    public Domain.Enums.AgentPhase Phase { get; set; }

    /// <summary>The registered tool this decision was about, or null for a decision that
    /// took no action — choosing not to do something is a decision worth recording.</summary>
    public string? Tool { get; set; }

    /// <summary>What was decided, in a sentence.</summary>
    public string Summary { get; set; } = string.Empty;

    /// <summary>Why. Not a score: the reasoning, in words somebody can argue with.</summary>
    public string Reason { get; set; } = string.Empty;

    /// <summary>
    /// What the reason rests on, as a JSON array of named facts.
    /// </summary>
    /// <remarks>
    /// Required by the platform rather than by the database: a decision with no evidence is an
    /// opinion, and this phase's whole claim is that the agent's conclusions can be checked.
    /// The service refuses to record one without it.
    /// </remarks>
    public string EvidenceJson { get; set; } = "[]";

    /// <summary>What happened when the decision was acted on, if it was.</summary>
    public string? Result { get; set; }

    /// <summary>Whether the policy guard allowed it, and where it stopped if not.</summary>
    public bool Allowed { get; set; } = true;
    public string? Denial { get; set; }

    /// <summary>The risk the action was judged at, after the tool's floor was applied.</summary>
    public string? Risk { get; set; }

    /// <summary>
    /// The person behind this decision, where one made it rather than the agent.
    /// </summary>
    /// <remarks>
    /// A typed column rather than a line of evidence, because evidence is masked on the way in
    /// and the masker cannot tell an identifier from a credential — a bare GUID is a perfectly
    /// good shape for an API key, so one written into prose comes back redacted. Weakening the
    /// masker to preserve it would trade a real protection for a convenience. An id in its own
    /// column is never free text and never masked, so the trail stays complete.
    /// </remarks>
    public Guid? ActorUserId { get; set; }

    /// <summary>The model call behind this, if any. Null means the decision was deterministic
    /// — which is the majority and is meant to be.</summary>
    public Guid? AiRequestId { get; set; }
    public decimal AiCostUsd { get; set; }

    public DateTimeOffset OccurredAt { get; set; }
}

/// <summary>
/// A point where the agent stopped and asked.
/// </summary>
/// <remarks>
/// <para>
/// The policy guard refuses a high-risk action with <c>ApprovalRequired</c>, which is not a
/// refusal so much as a question. This is where the question is kept until somebody answers
/// it, and it is deliberately a record rather than a blocking call: an agent that waits with
/// a browser open for a person to come back is an agent that holds a worker hostage.
/// </para>
/// <para>
/// A request nobody answers is not an approval. It expires with the run and what it would
/// have done is reported as not done, which is the safe direction and the honest one.
/// </para>
/// </remarks>
public class AgentApproval : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid AgentRunId { get; set; }
    public AgentRun? AgentRun { get; set; }

    /// <summary>The tool the agent wants to use.</summary>
    public string Tool { get; set; } = string.Empty;

    /// <summary>Why approval is required, in the guard's own words.</summary>
    public string Reason { get; set; } = string.Empty;

    /// <summary>What the agent proposes to do.</summary>
    public string Proposal { get; set; } = string.Empty;

    /// <summary>What it rests on, same shape as a decision's evidence.</summary>
    public string EvidenceJson { get; set; } = "[]";

    /// <summary>The risk that triggered the question.</summary>
    public string Risk { get; set; } = string.Empty;

    /// <summary>What a person expects to happen if they say yes.</summary>
    public string? ExpectedImpact { get; set; }

    public AgentApprovalStatus Status { get; set; } = AgentApprovalStatus.Pending;

    /// <summary>Who answered, and what they said. A justification is required to grant one:
    /// an approval with nobody's name and no reason is indistinguishable from the control
    /// being switched off.</summary>
    public Guid? DecidedByUserId { get; set; }
    public string? DecidedByEmail { get; set; }
    public string? Justification { get; set; }
    public DateTimeOffset? DecidedAt { get; set; }
}

public enum AgentApprovalStatus
{
    Pending = 0,
    Granted = 1,
    Refused = 2,
    /// <summary>The run ended before anybody answered. Not an approval, and not a refusal.</summary>
    Expired = 3
}
