using Aira.Domain.Common;

namespace Aira.Domain.Agent;

/// <summary>
/// What a person knows about the application that the platform cannot observe.
/// </summary>
/// <remarks>
/// <para>
/// Discovery can see that <c>/payments</c> exists and that it posts to an API. It cannot see
/// that payments are the thing the business would stop trading over, that the loan module is
/// two weeks from launch and nobody cares about it yet, or that the admin deletion endpoint
/// must never be exercised because it cascades into a shared fixture that three other teams
/// depend on. Those facts exist only in somebody's head, and without them a risk model is
/// guessing at the thing that matters most.
/// </para>
/// <para>
/// So this is the operator's input into planning, and it is treated as exactly that: it
/// <strong>steers prioritisation and narrows scope</strong>. It never widens what the agent is
/// allowed to do. Writing "test everything including production" here does nothing at all —
/// the policy engine and the security scope are the only things that decide that, and neither
/// of them reads this table.
/// </para>
/// <para>
/// The exclusions are the exception to "advisory": <see cref="ExcludedAreas"/> is honoured
/// absolutely. A person saying "never touch this" is the one instruction here that can only
/// ever make the agent do less.
/// </para>
/// </remarks>
public class ApplicationContext : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid ApplicationId { get; set; }
    public Applications.Application? Application { get; set; }

    /// <summary>Journeys the business would stop trading over, one per line.</summary>
    public string CriticalJourneys { get; set; } = string.Empty;

    /// <summary>Areas where a defect would be expensive, one per line. Raises risk; does not
    /// authorize anything.</summary>
    public string HighRiskAreas { get; set; } = string.Empty;

    /// <summary>
    /// Routes, endpoints or areas the agent must never exercise, one per line.
    /// </summary>
    /// <remarks>
    /// Honoured absolutely rather than weighed. An operator who writes "admin deletion" here
    /// is not expressing a preference that a sufficiently high risk score can outvote.
    /// </remarks>
    public string ExcludedAreas { get; set; } = string.Empty;

    /// <summary>Anything else worth knowing, in the operator's words.</summary>
    public string Notes { get; set; } = string.Empty;

    /// <summary>Who said so, and when. Context with no author is folklore.</summary>
    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
}

/// <summary>
/// Something the platform learned about an application and expects to still be true.
/// </summary>
/// <remarks>
/// <para>
/// Each agent pass currently starts from nothing but the knowledge graph, which means it
/// re-derives the same conclusions every time and cannot notice that it derived something
/// different last week. Memory is where a fact survives between passes.
/// </para>
/// <para>
/// Three properties keep it from becoming a liability. A fact carries <em>where it came
/// from</em>, so a later reader can tell an observation from an inference. It carries
/// <em>when it was last confirmed</em>, so a stale fact can be aged out rather than believed
/// for ever. And it is never treated as authority: the agent re-checks what it acts on, and
/// memory only changes what it looks at first.
/// </para>
/// <para>
/// <strong>What is never stored here:</strong> credentials, tokens, keys or any secret. The
/// value is masked on the way in, and the masking is asserted by a test rather than left to
/// whoever writes the next caller.
/// </para>
/// </remarks>
public class ApplicationMemory : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ApplicationId { get; set; }

    /// <summary>What kind of fact this is.</summary>
    public ApplicationMemoryKind Kind { get; set; }

    /// <summary>What it is about — a route, an endpoint, a test reference, a journey name.</summary>
    public string Subject { get; set; } = string.Empty;

    /// <summary>The fact itself, in words.</summary>
    public string Fact { get; set; } = string.Empty;

    /// <summary>Where it came from. An inference and an observation are not the same fact.</summary>
    public ApplicationMemoryProvenance Provenance { get; set; }

    /// <summary>0-100. Never 100: a platform that is certain has stopped checking.</summary>
    public int Confidence { get; set; }

    /// <summary>The run that last confirmed this, for a reader who wants the decision behind it.</summary>
    public Guid? LastConfirmedByRunId { get; set; }
    public DateTimeOffset FirstSeenAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }

    /// <summary>How many passes have seen this. A fact seen once is a guess with a timestamp.</summary>
    public int TimesSeen { get; set; } = 1;
}

public enum ApplicationMemoryKind
{
    /// <summary>Something about the application itself: a route exists, an endpoint needs a session.</summary>
    ApplicationFact = 0,
    /// <summary>A journey the platform believes the application supports.</summary>
    BusinessJourney = 1,
    /// <summary>A defect somebody confirmed.</summary>
    KnownDefect = 2,
    /// <summary>A test that has been unreliable.</summary>
    UnstableTest = 3,
    /// <summary>A security finding, by reference. Never the finding's detail.</summary>
    SecurityFinding = 4,
    /// <summary>An environment somebody authorized.</summary>
    ApprovedEnvironment = 5,
    /// <summary>A test data set that worked.</summary>
    ApprovedTestData = 6,
    /// <summary>How previous passes behaved: what tended to fail, what tended to be slow.</summary>
    ExecutionPattern = 7
}

/// <summary>
/// Where a remembered fact came from.
/// </summary>
/// <remarks>
/// The distinction the brief cares about, and the one that decides whether a fact may be acted
/// on. An observation was seen happening. A user-provided fact was asserted by a person. An
/// inference is the platform's own guess from structure, and is never treated as confirmed
/// functionality.
/// </remarks>
public enum ApplicationMemoryProvenance
{
    Observed = 0,
    UserProvided = 1,
    Inferred = 2
}
