using QaNxt.Domain.Common;

namespace QaNxt.Domain.Identity;

/// <summary>The tenant boundary. Everything a customer owns hangs off exactly one organization.</summary>
public class Organization : BaseEntity, ISoftDeletable
{
    public string Name { get; set; } = string.Empty;
    /// <summary>URL-safe unique identifier used in invitations and CLI profiles.</summary>
    public string Slug { get; set; } = string.Empty;
    public bool IsActive { get; set; } = true;
    public DateTimeOffset? DeletedAt { get; set; }

    /// <summary>Per-tenant ceiling on concurrent browser sessions, enforced when dispatching runs.</summary>
    public int MaxConcurrentExecutions { get; set; } = 4;
    /// <summary>0 disables budget enforcement; otherwise AI requests are refused past this monthly spend.</summary>
    public decimal MonthlyAiBudgetUsd { get; set; }

    public ICollection<User> Users { get; set; } = new List<User>();
    public ICollection<Projects.Project> Projects { get; set; } = new List<Projects.Project>();
}
