using Aira.Domain.Common;
using Aira.Domain.Enums;

namespace Aira.Domain.Projects;

/// <summary>One configurable pipeline-blocking rule, evaluated against a completed run.</summary>
public class QualityGateRule : BaseEntity, ITenantOwned, IAuditable
{
    public Guid OrganizationId { get; set; }
    public Guid ProjectId { get; set; }
    public Project? Project { get; set; }

    public string Name { get; set; } = string.Empty;
    public QualityGateMetric Metric { get; set; }
    public QualityGateOperator Operator { get; set; }
    public decimal Threshold { get; set; }
    public bool IsBlocking { get; set; } = true;
    public bool IsEnabled { get; set; } = true;
    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
}
