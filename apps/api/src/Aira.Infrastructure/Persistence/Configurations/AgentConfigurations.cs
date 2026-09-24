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
