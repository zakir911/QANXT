using Aira.Domain.Common;

namespace Aira.Domain.Applications;

/// <summary>An API call observed while driving the UI, linked back to the UI action that
/// caused it. This is the seed for API test generation.</summary>
public class ApiEndpoint : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ApplicationId { get; set; }
    public Application? Application { get; set; }

    public string Method { get; set; } = "GET";
    public string UrlTemplate { get; set; } = string.Empty;   // /api/accounts/{id}
    public string SampleUrl { get; set; } = string.Empty;
    public int TimesObserved { get; set; } = 1;
    public int? LastStatusCode { get; set; }
    public int AverageDurationMs { get; set; }
    /// <summary>Masked request body sample (secrets and PII removed at capture).</summary>
    public string? RequestSampleJson { get; set; }
    /// <summary>Masked response body sample.</summary>
    public string? ResponseSampleJson { get; set; }
    public string? RequestContentType { get; set; }
    public string? ResponseContentType { get; set; }
    public bool RequiresAuthentication { get; set; }
    public Guid? TriggeredByPageId { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }
}
