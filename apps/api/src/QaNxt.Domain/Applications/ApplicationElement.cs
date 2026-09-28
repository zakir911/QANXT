using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Applications;

/// <summary>An interactive or semantically meaningful element on a page. The stored
/// signals are exactly the ones the locator engine scores against, so healing can
/// compare a broken locator with every element ever seen on that page.</summary>
public class ApplicationElement : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ApplicationPageId { get; set; }
    public ApplicationPage? Page { get; set; }

    public ElementKind Kind { get; set; } = ElementKind.Unknown;
    public string TagName { get; set; } = string.Empty;

    // ---- Semantic signals ---------------------------------------------------
    public string? AriaRole { get; set; }
    public string? AccessibleName { get; set; }
    public string? Text { get; set; }
    public string? Label { get; set; }
    public string? Placeholder { get; set; }
    public string? TestId { get; set; }
    public string? ElementId { get; set; }
    public string? Name { get; set; }
    public string? Type { get; set; }
    public string? Title { get; set; }
    public string? Value { get; set; }

    // ---- Structural signals -------------------------------------------------
    /// <summary>Best-effort CSS path; used only as a last-resort locator.</summary>
    public string? CssSelector { get; set; }
    public string? XPath { get; set; }
    /// <summary>Tag chain from the document root, used for ancestry similarity.</summary>
    public string? DomPath { get; set; }
    public string? ParentSignature { get; set; }
    /// <summary>Accessible names of nearby elements, used for neighbourhood similarity.</summary>
    public string? NeighbourText { get; set; }

    // ---- Geometry (viewport-relative at capture time) ------------------------
    public int BoundingX { get; set; }
    public int BoundingY { get; set; }
    public int BoundingWidth { get; set; }
    public int BoundingHeight { get; set; }

    public bool IsVisible { get; set; } = true;
    public bool IsEnabled { get; set; } = true;
    public bool IsRequired { get; set; }
    /// <summary>Stable-looking attributes (data-*, aria-*) serialized as JSON.</summary>
    public string? AttributesJson { get; set; }
    /// <summary>Preferred locator expressed in the platform's own locator grammar.</summary>
    public string? PreferredLocatorJson { get; set; }
    /// <summary>0-100 heuristic: how resistant the preferred locator is to UI change.</summary>
    public int StabilityScore { get; set; }

    public DateTimeOffset LastSeenAt { get; set; }
}
