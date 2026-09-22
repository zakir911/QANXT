using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Projects;

/// <summary>What a change to a file in the application's repository is taken to affect.
///
/// AIRA does not know how anybody's source tree is laid out, and guessing is how change
/// impact analysis becomes a plausible-sounding way to skip the test that would have caught
/// the bug. So a team says: files under <c>src/pages/accounts/</c> affect the
/// <c>/accounts</c> route; files under <c>src/api/payments/</c> affect
/// <c>/api/payments</c>; files under <c>src/lib/</c> affect everything.
///
/// Rules are optional. Without them AIRA still matches changed paths against the routes and
/// endpoints it has discovered, using the file and directory names — but it reports those
/// matches as inferred rather than declared, because they are. A rule is the difference
/// between "this is what the team says these files touch" and "these words looked
/// similar".</summary>
public class ChangeImpactRule : BaseEntity, ITenantOwned
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Project? Project { get; set; }

    /// <summary>A glob against the repository-relative path: <c>src/pages/accounts/**</c>.
    /// Matched case-insensitively, with <c>*</c> stopping at a separator and <c>**</c>
    /// crossing them.</summary>
    public string PathPattern { get; set; } = string.Empty;

    public ImpactKind Kind { get; set; } = ImpactKind.Route;

    /// <summary>The route, endpoint template, tag or test reference this affects. Ignored
    /// for <see cref="ImpactKind.Everything"/>.</summary>
    public string Value { get; set; } = string.Empty;

    /// <summary>Why this rule exists, in the team's own words. It appears in the selection
    /// report beside the tests it caused to run.</summary>
    public string? Notes { get; set; }

    public bool IsEnabled { get; set; } = true;

    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
}
