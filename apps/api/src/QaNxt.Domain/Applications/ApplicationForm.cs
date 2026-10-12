using QaNxt.Domain.Common;

namespace QaNxt.Domain.Applications;

/// <summary>A form discovered on a page: the unit a tester reasons about, and the unit the
/// form-level test generator works from.
///
/// The fields, buttons and observed dependencies are kept whole as JSON rather than spread
/// over tables, because they are always read together and never queried apart — and keeping
/// them as discovery reported them means a later generator change can re-read exactly what
/// the crawler saw. The summary columns exist for listing and counting.</summary>
public class ApplicationForm : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ApplicationId { get; set; }
    public Guid ApplicationPageId { get; set; }
    public ApplicationPage? Page { get; set; }
    public Guid? DiscoveryRunId { get; set; }

    /// <summary>The form's identity on its page: its id or name, or its position.</summary>
    public string FormKey { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Route { get; set; } = string.Empty;
    public string PageUrl { get; set; } = string.Empty;

    public string? Action { get; set; }
    public string Method { get; set; } = "get";
    public bool HasFormElement { get; set; } = true;
    public bool NoValidate { get; set; }
    public bool HasCsrfToken { get; set; }
    public bool IsMultiStep { get; set; }
    public int GroupCount { get; set; } = 1;
    public int FieldCount { get; set; }
    public int RequiredFieldCount { get; set; }
    public int DependencyCount { get; set; }

    /// <summary>The whole discovered form: fields with constraints and locators, buttons,
    /// and what each answer was observed to change.</summary>
    public string ModelJson { get; set; } = "{}";

    /// <summary>A hash of what a test depends on — fields, constraints, buttons,
    /// dependencies — so a later discovery can say which forms changed.</summary>
    public string ModelHash { get; set; } = string.Empty;
    /// <summary>When the form last changed shape. Drives impacted-test regression.</summary>
    public DateTimeOffset? ChangedAt { get; set; }

    /// <summary>Whether the latest discovery still found it. A form that has gone keeps its
    /// row, so its tests and coverage history are not orphaned.</summary>
    public bool IsPresent { get; set; } = true;
    public DateTimeOffset LastSeenAt { get; set; }
}
