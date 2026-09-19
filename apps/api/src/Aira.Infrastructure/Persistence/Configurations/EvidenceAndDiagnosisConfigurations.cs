using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Aira.Domain.Ai;
using Aira.Domain.Audit;
using Aira.Domain.Diagnosis;
using Aira.Domain.Evidence;

namespace Aira.Infrastructure.Persistence.Configurations;

public class ArtifactConfiguration : IEntityTypeConfiguration<Artifact>
{
    public void Configure(EntityTypeBuilder<Artifact> b)
    {
        b.ToTable("artifacts");
        b.Property(x => x.Name).HasMaxLength(300).IsRequired();
        b.Property(x => x.StorageKey).HasMaxLength(512).IsRequired();
        b.Property(x => x.ContentType).HasMaxLength(120).IsRequired();
        b.Property(x => x.Sha256).HasMaxLength(64);
        b.Property(x => x.MetadataJson).HasColumnType("jsonb");
        b.HasIndex(x => x.TestExecutionId);
        b.HasIndex(x => x.TestActionId);
        b.HasIndex(x => x.DiscoveryRunId);
        // Retention sweeps scan by expiry.
        b.HasIndex(x => x.ExpiresAt);
    }
}

public class NetworkEventConfiguration : IEntityTypeConfiguration<NetworkEvent>
{
    public void Configure(EntityTypeBuilder<NetworkEvent> b)
    {
        b.ToTable("network_events");
        b.Property(x => x.Method).HasMaxLength(10).IsRequired();
        b.Property(x => x.Url).HasMaxLength(2048).IsRequired();
        b.Property(x => x.ResourceType).HasMaxLength(40);
        b.Property(x => x.RequestHeadersJson).HasColumnType("jsonb");
        b.Property(x => x.ResponseHeadersJson).HasColumnType("jsonb");
        b.Property(x => x.RequestBodyExcerpt).HasMaxLength(8000);
        b.Property(x => x.ResponseBodyExcerpt).HasMaxLength(8000);
        b.Property(x => x.FailureText).HasMaxLength(1000);
        b.HasIndex(x => x.TestExecutionId);
        b.HasIndex(x => x.DiscoveryRunId);
    }
}

public class ConsoleEventConfiguration : IEntityTypeConfiguration<ConsoleEvent>
{
    public void Configure(EntityTypeBuilder<ConsoleEvent> b)
    {
        b.ToTable("console_events");
        b.Property(x => x.Level).HasMaxLength(20).IsRequired();
        b.Property(x => x.Message).HasMaxLength(8000).IsRequired();
        b.Property(x => x.StackTrace).HasMaxLength(20000);
        b.Property(x => x.Url).HasMaxLength(2048);
        b.HasIndex(x => new { x.TestExecutionId, x.Level });
        b.HasIndex(x => x.DiscoveryRunId);
    }
}

public class FailureConfiguration : IEntityTypeConfiguration<Failure>
{
    public void Configure(EntityTypeBuilder<Failure> b)
    {
        b.ToTable("failures");
        b.Property(x => x.RawMessage).HasMaxLength(8000).IsRequired();
        b.Property(x => x.RawStack).HasMaxLength(20000);
        b.Property(x => x.Signature).HasMaxLength(64).IsRequired();
        // Clustering recurring failures is a signature lookup within a project.
        b.HasIndex(x => new { x.ProjectId, x.Signature });
        b.HasIndex(x => new { x.ProjectId, x.Category, x.LastSeenAt });
        b.HasIndex(x => x.TestExecutionId);
        b.HasOne(x => x.TestExecution).WithMany()
            .HasForeignKey(x => x.TestExecutionId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class FailureAnalysisConfiguration : IEntityTypeConfiguration<FailureAnalysis>
{
    public void Configure(EntityTypeBuilder<FailureAnalysis> b)
    {
        b.ToTable("failure_analyses");
        b.Property(x => x.Summary).HasMaxLength(1000).IsRequired();
        b.Property(x => x.LikelyCause).HasMaxLength(4000);
        b.Property(x => x.Evidence).HasMaxLength(8000);
        b.Property(x => x.SuggestedAction).HasMaxLength(4000);
        b.Property(x => x.EvidenceRefsJson).HasColumnType("jsonb");
        b.Property(x => x.Model).HasMaxLength(100);
        b.HasIndex(x => x.FailureId).IsUnique();
        b.HasOne(x => x.Failure).WithOne(f => f.Analysis)
            .HasForeignKey<FailureAnalysis>(x => x.FailureId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class LocatorCandidateConfiguration : IEntityTypeConfiguration<LocatorCandidate>
{
    public void Configure(EntityTypeBuilder<LocatorCandidate> b)
    {
        b.ToTable("locator_candidates");
        b.Property(x => x.Strategy).HasMaxLength(40).IsRequired();
        b.Property(x => x.Value).HasMaxLength(1000).IsRequired();
        b.Property(x => x.AccessibleName).HasMaxLength(500);
        b.Property(x => x.DescriptorJson).HasColumnType("jsonb");
        b.Property(x => x.ScoreBreakdownJson).HasColumnType("jsonb");
        b.HasIndex(x => new { x.TestStepId, x.Rank });
        b.HasIndex(x => x.HealingEventId);
        b.HasOne(x => x.TestStep).WithMany(s => s.LocatorCandidates)
            .HasForeignKey(x => x.TestStepId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class HealingEventConfiguration : IEntityTypeConfiguration<HealingEvent>
{
    public void Configure(EntityTypeBuilder<HealingEvent> b)
    {
        b.ToTable("healing_events");
        b.Property(x => x.OriginalLocatorJson).HasColumnType("jsonb");
        b.Property(x => x.HealedLocatorJson).HasColumnType("jsonb");
        b.Property(x => x.ScoreBreakdownJson).HasColumnType("jsonb");
        b.Property(x => x.EvidenceRefsJson).HasColumnType("jsonb");
        b.Property(x => x.Reason).HasMaxLength(2000);
        b.Property(x => x.ReviewComment).HasMaxLength(2000);
        b.Property(x => x.ApplicationBuildRef).HasMaxLength(200);
        b.HasIndex(x => new { x.ProjectId, x.Outcome, x.OccurredAt });
        b.HasIndex(x => x.TestStepId);
    }
}

public class DefectConfiguration : IEntityTypeConfiguration<Defect>
{
    public void Configure(EntityTypeBuilder<Defect> b)
    {
        b.ToTable("defects");
        b.Property(x => x.Title).HasMaxLength(300).IsRequired();
        b.Property(x => x.Description).HasMaxLength(8000);
        b.Property(x => x.StepsToReproduce).HasMaxLength(8000);
        b.Property(x => x.ExpectedBehaviour).HasMaxLength(4000);
        b.Property(x => x.ActualBehaviour).HasMaxLength(4000);
        b.Property(x => x.EvidenceRefsJson).HasColumnType("jsonb");
        b.Property(x => x.ExternalKey).HasMaxLength(100);
        b.Property(x => x.ExternalUrl).HasMaxLength(2048);
        b.HasIndex(x => new { x.ProjectId, x.Status, x.Severity });
        b.HasOne(x => x.Failure).WithMany(f => f.Defects)
            .HasForeignKey(x => x.FailureId).OnDelete(DeleteBehavior.SetNull);
    }
}

public class AiRequestConfiguration : IEntityTypeConfiguration<AiRequest>
{
    public void Configure(EntityTypeBuilder<AiRequest> b)
    {
        b.ToTable("ai_requests");
        b.Property(x => x.Model).HasMaxLength(100).IsRequired();
        b.Property(x => x.PromptHash).HasMaxLength(64).IsRequired();
        b.Property(x => x.SystemPromptExcerpt).HasMaxLength(8000);
        b.Property(x => x.UserPromptExcerpt).HasMaxLength(16000);
        b.Property(x => x.ResponseSchemaName).HasMaxLength(100);
        b.Property(x => x.ErrorMessage).HasMaxLength(4000);
        b.Property(x => x.CorrelationId).HasMaxLength(64);
        b.Property(x => x.EstimatedCostUsd).HasPrecision(12, 6);
        // Cache lookups and monthly spend rollups.
        b.HasIndex(x => new { x.OrganizationId, x.PromptHash });
        b.HasIndex(x => new { x.OrganizationId, x.CreatedAt });
        b.HasOne(x => x.Response).WithOne(r => r.Request)
            .HasForeignKey<AiResponse>(x => x.AiRequestId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class AiResponseConfiguration : IEntityTypeConfiguration<AiResponse>
{
    public void Configure(EntityTypeBuilder<AiResponse> b)
    {
        b.ToTable("ai_responses");
        b.Property(x => x.RawContent).HasMaxLength(200000);
        b.Property(x => x.StructuredJson).HasColumnType("jsonb");
        b.Property(x => x.SchemaErrors).HasMaxLength(8000);
        b.Property(x => x.FinishReason).HasMaxLength(60);
        b.HasIndex(x => x.AiRequestId).IsUnique();
    }
}

public class AuditLogConfiguration : IEntityTypeConfiguration<AuditLog>
{
    public void Configure(EntityTypeBuilder<AuditLog> b)
    {
        b.ToTable("audit_logs");
        b.Property(x => x.EntityType).HasMaxLength(100).IsRequired();
        b.Property(x => x.Summary).HasMaxLength(2000).IsRequired();
        b.Property(x => x.UserEmail).HasMaxLength(320);
        b.Property(x => x.ChangesJson).HasColumnType("jsonb");
        b.Property(x => x.IpAddress).HasMaxLength(64);
        b.Property(x => x.UserAgent).HasMaxLength(400);
        b.Property(x => x.CorrelationId).HasMaxLength(64);
        b.HasIndex(x => new { x.OrganizationId, x.OccurredAt });
        b.HasIndex(x => new { x.EntityType, x.EntityId });
        b.HasIndex(x => x.Action);
    }
}
