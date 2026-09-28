using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Applications;

/// <summary>The agreed shape of one endpoint's response, kept so that a later response can
/// be compared against it.
///
/// A contract is a stored observation, not a declaration. It is inferred from a response
/// the application actually gave — while crawling it, or while an API test called it — which
/// is why it can exist for an API nobody has written a specification for. A team that does
/// have a specification can declare one instead; the comparison does not care where the
/// baseline came from, only that somebody accepted it.
///
/// Baselines are versioned rather than overwritten. "The contract changed and someone
/// accepted the change" is a decision with a date and an author, and a table that keeps
/// only the current shape cannot answer when it moved.</summary>
public class ApiContract : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ApplicationId { get; set; }
    public Application? Application { get; set; }

    /// <summary>The inventory entry this describes. Kept nullable so a contract can be
    /// declared for an endpoint discovery has not seen yet.</summary>
    public Guid? ApiEndpointId { get; set; }
    public ApiEndpoint? ApiEndpoint { get; set; }

    public string Method { get; set; } = "GET";
    public string UrlTemplate { get; set; } = string.Empty;

    /// <summary>The status the baseline response carried, so a 200 becoming a 500 is a
    /// contract change rather than only a test failure.</summary>
    public int? StatusCode { get; set; }

    /// <summary>Serialized <c>ApiSchemaShape</c>: a flat map of JSON path to type.</summary>
    public string ResponseSchemaJson { get; set; } = string.Empty;
    public string? RequestSchemaJson { get; set; }
    public string? ResponseContentType { get; set; }

    /// <summary>Hash of the masked sample the shape was inferred from, so a baseline can be
    /// traced to the exact response that produced it.</summary>
    public string? SourceSampleSha256 { get; set; }

    public ApiContractSource Source { get; set; } = ApiContractSource.Discovery;
    public Guid? DiscoveryRunId { get; set; }
    public Guid? TestRunId { get; set; }

    /// <summary>1 for the first baseline of an endpoint, incrementing each time a new one
    /// is accepted.</summary>
    public int Version { get; set; } = 1;

    /// <summary>Exactly one contract per endpoint is the baseline others are compared
    /// against. The rest are history.</summary>
    public bool IsBaseline { get; set; } = true;

    public Guid? AcceptedByUserId { get; set; }
    public DateTimeOffset? AcceptedAt { get; set; }
    public string? Note { get; set; }
}

/// <summary>One difference between a baseline contract and a response observed later,
/// classified by what it means for a caller.
///
/// Stored rather than computed on demand because a quality gate has to be reproducible: the
/// decision a gate made about a release must still be explainable after the application has
/// moved on and the comparison would come out differently.</summary>
public class ApiContractChange : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ApplicationId { get; set; }
    public Guid? ApiEndpointId { get; set; }

    public Guid BaselineContractId { get; set; }
    public ApiContract? BaselineContract { get; set; }

    public string Method { get; set; } = "GET";
    public string UrlTemplate { get; set; } = string.Empty;

    public ContractChangeKind Kind { get; set; }
    /// <summary>The JSON path that moved, in the same grammar the response assertions use.
    /// <c>$status</c> for a status-code change, <c>$</c> for the body as a whole.</summary>
    public string Path { get; set; } = string.Empty;
    public string? BaselineType { get; set; }
    public string? ObservedType { get; set; }
    /// <summary>What this means for a caller, in a sentence.</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>The run whose evidence this was detected in, so the gate for that run can
    /// count it and a report can show where it came from.</summary>
    public Guid? TestRunId { get; set; }
    public Guid? DiscoveryRunId { get; set; }

    /// <summary>Set when someone has looked at this and decided it is fine. An acknowledged
    /// change still counts in its own run's gate — that decision is already made — but it
    /// does not keep failing later ones.</summary>
    public bool IsAcknowledged { get; set; }
    public Guid? AcknowledgedByUserId { get; set; }
    public DateTimeOffset? AcknowledgedAt { get; set; }
    public string? AcknowledgementNote { get; set; }

    public DateTimeOffset DetectedAt { get; set; }
}
