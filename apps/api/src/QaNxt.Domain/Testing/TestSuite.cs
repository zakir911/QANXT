using QaNxt.Domain.Common;

namespace QaNxt.Domain.Testing;

public class TestSuite : BaseEntity, ITenantOwned, IAuditable, ISoftDeletable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Projects.Project? Project { get; set; }

    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string Tags { get; set; } = string.Empty;
    public bool IsRegressionSuite { get; set; }
    public Guid? OwnerUserId { get; set; }
    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }

    public ICollection<TestCase> TestCases { get; set; } = new List<TestCase>();
}
