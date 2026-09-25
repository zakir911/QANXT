using Aira.Domain.Agent;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Aira.Infrastructure.Persistence.Configurations;

/// <summary>
/// The agent's record of what it did.
/// </summary>
/// <remarks>
/// Both tables are append-only in practice and read in run order, so both index on
/// (run, sequence) or (run, status) rather than on the clustered key. The column lengths are
/// generous because the whole point of these rows is that somebody reads the reasoning, and a
/// reason truncated at 200 characters is a reason nobody can act on.
/// </remarks>
public class AgentDecisionConfiguration : IEntityTypeConfiguration<AgentDecision>
{
    public void Configure(EntityTypeBuilder<AgentDecision> b)
    {
        b.ToTable("agent_decisions");
        b.HasIndex(x => new { x.AgentRunId, x.Sequence }).IsUnique();
        b.Property(x => x.Tool).HasMaxLength(100);
        b.Property(x => x.Summary).HasMaxLength(1000).IsRequired();
        b.Property(x => x.Reason).HasMaxLength(4000).IsRequired();
        b.Property(x => x.EvidenceJson).HasColumnType("jsonb").IsRequired();
        b.Property(x => x.Result).HasMaxLength(4000);
        b.Property(x => x.Denial).HasMaxLength(64);
        b.Property(x => x.Risk).HasMaxLength(32);
        b.Property(x => x.AiCostUsd).HasPrecision(12, 6);

        b.HasOne(x => x.AgentRun).WithMany(r => r.Decisions)
            .HasForeignKey(x => x.AgentRunId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class AgentApprovalConfiguration : IEntityTypeConfiguration<AgentApproval>
{
    public void Configure(EntityTypeBuilder<AgentApproval> b)
    {
        b.ToTable("agent_approvals");
        b.HasIndex(x => new { x.AgentRunId, x.Status });
        b.Property(x => x.Tool).HasMaxLength(100).IsRequired();
        b.Property(x => x.Reason).HasMaxLength(2000).IsRequired();
        b.Property(x => x.Proposal).HasMaxLength(4000).IsRequired();
        b.Property(x => x.EvidenceJson).HasColumnType("jsonb").IsRequired();
        b.Property(x => x.Risk).HasMaxLength(32).IsRequired();
        b.Property(x => x.ExpectedImpact).HasMaxLength(2000);
        b.Property(x => x.DecidedByEmail).HasMaxLength(320);
        // A justification is required to grant one; the length is here so that a real reason
        // fits rather than being trimmed into a shrug.
        b.Property(x => x.Justification).HasMaxLength(2000);

        b.HasOne(x => x.AgentRun).WithMany(r => r.Approvals)
            .HasForeignKey(x => x.AgentRunId).OnDelete(DeleteBehavior.Cascade);
    }
}

/// <summary>
/// The operator's standing description of an application.
/// </summary>
/// <remarks>
/// One row per application, enforced by a unique index rather than by callers remembering to
/// check: two rows of business context would mean two different answers to "what must never be
/// touched", and the planner would read whichever came back first.
/// </remarks>
public class ApplicationContextConfiguration : IEntityTypeConfiguration<ApplicationContext>
{
    public void Configure(EntityTypeBuilder<ApplicationContext> b)
    {
        b.ToTable("application_contexts");
        b.HasIndex(x => x.ApplicationId).IsUnique();
        b.Property(x => x.CriticalJourneys).HasMaxLength(20_000);
        b.Property(x => x.HighRiskAreas).HasMaxLength(20_000);
        b.Property(x => x.ExcludedAreas).HasMaxLength(20_000);
        b.Property(x => x.Notes).HasMaxLength(20_000);

        b.HasOne(x => x.Application).WithMany()
            .HasForeignKey(x => x.ApplicationId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class ApplicationMemoryConfiguration : IEntityTypeConfiguration<ApplicationMemory>
{
    public void Configure(EntityTypeBuilder<ApplicationMemory> b)
    {
        b.ToTable("application_memories");
        // One fact per (application, kind, subject). Seeing it again strengthens the row that
        // is there rather than adding a second one saying the same thing more recently.
        b.HasIndex(x => new { x.ApplicationId, x.Kind, x.Subject }).IsUnique();
        b.HasIndex(x => new { x.ApplicationId, x.LastSeenAt });
        b.Property(x => x.Subject).HasMaxLength(500).IsRequired();
        b.Property(x => x.Fact).HasMaxLength(4000).IsRequired();
    }
}
