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

    /// <summary>What a failure of this rule does: fail the pipeline, ask for review, or warn.
    /// `IsBlocking` is kept so existing rows keep working — a blocking rule defaults to Fail
    /// and a non-blocking one to Warn — but Action is what the evaluator reads.</summary>
    public QualityGateAction Action { get; set; } = QualityGateAction.Fail;

    /// <summary>Applies only in this environment when set; applies everywhere when null. A
    /// team can demand 100% on staging and tolerate more on a development deployment.</summary>
    public string? Environment { get; set; }

    /// <summary>Shown to whoever has to act on the rule firing. Falls back to the
    /// evaluator's own explanation when empty.</summary>
    public string? Message { get; set; }
    public Guid? CreatedByUserId { get; set; }
    public Guid? UpdatedByUserId { get; set; }
}
