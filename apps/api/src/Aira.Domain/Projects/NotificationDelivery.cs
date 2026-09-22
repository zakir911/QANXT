using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Projects;

/// <summary>
/// One attempt to tell somebody something, and what came of it.
/// </summary>
/// <remarks>
/// Recorded because "did anyone actually get told?" is a question that gets asked after an
/// incident, and an answer of "the code calls Send" is not one. A notification that
/// silently fails is worse than no notification, since the team has stopped watching the
/// thing it was supposed to watch for them.
///
/// It holds no part of the message's credentials and no URL: the integration is referenced
/// by id, and whoever needs the target can look it up with the permission that requires.
/// </remarks>
public class NotificationDelivery : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Guid IntegrationId { get; set; }
    public Integration? Integration { get; set; }

    public NotificationEventKind Event { get; set; }
    public IntegrationKind Channel { get; set; }

    /// <summary>The run this was about, when it was about one.</summary>
    public Guid? TestRunId { get; set; }

    /// <summary>The one-line title as sent, so the record shows what was said.</summary>
    public string Title { get; set; } = string.Empty;

    public bool Delivered { get; set; }
    public int? StatusCode { get; set; }

    /// <summary>Why it failed, in the receiver's own words where there were any.</summary>
    public string? Detail { get; set; }

    /// <summary>How many attempts this row represents, including the first.</summary>
    public int Attempts { get; set; } = 1;

    public DateTimeOffset AttemptedAt { get; set; }
}
