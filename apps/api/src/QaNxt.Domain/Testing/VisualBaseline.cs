using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;

namespace QaNxt.Domain.Testing;

/// <summary>
/// The agreed appearance of one part of one test, to compare later runs against.
/// </summary>
/// <remarks>
/// <para>
/// A baseline is identity plus an image, and the identity is the interesting half. It is
/// keyed by test case, name, browser and viewport because each of those genuinely changes
/// how a page looks: a baseline taken in Chromium at 1280 wide says nothing about Firefox
/// at 375, and comparing across either would report a difference on every run until
/// somebody switched the check off.
/// </para>
/// <para>
/// The name defaults to the step's order but can be set explicitly, and that matters more
/// than it sounds: without it, inserting a step renumbers every baseline below it and they
/// all appear to be new.
/// </para>
/// <para>
/// Who approved it and when are stored, because accepting a new appearance is a decision.
/// A baseline nobody can account for is one nobody can trust, and "it has always looked
/// like that" is not an answer if the platform cannot say since when.
/// </para>
/// </remarks>
public class VisualBaseline : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid TestCaseId { get; set; }
    public TestCase? TestCase { get; set; }

    /// <summary>What this baseline is of, within its test.</summary>
    public string Name { get; set; } = string.Empty;

    public BrowserType Browser { get; set; } = BrowserType.Chromium;
    public int ViewportWidth { get; set; }
    public int ViewportHeight { get; set; }

    /// <summary>Where the image is in the artifact store.</summary>
    public string StorageKey { get; set; } = string.Empty;
    public int Width { get; set; }
    public int Height { get; set; }
    public long SizeBytes { get; set; }

    /// <summary>Who accepted this appearance, and when.</summary>
    /// <remarks>
    /// Null for the first capture, which nobody approved — it became the baseline because
    /// there was nothing to compare against. That is a meaningful distinction: an
    /// unapproved baseline records what the page happened to look like the first time, not
    /// what anybody decided it should look like.
    /// </remarks>
    public Guid? ApprovedByUserId { get; set; }
    public DateTimeOffset? ApprovedAt { get; set; }

    /// <summary>The run whose capture became this baseline.</summary>
    public Guid? SourceTestRunId { get; set; }
}
