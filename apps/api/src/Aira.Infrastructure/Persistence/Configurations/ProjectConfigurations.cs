using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Aira.Domain.Projects;

namespace Aira.Infrastructure.Persistence.Configurations;

public class ProjectConfiguration : IEntityTypeConfiguration<Project>
{
    public void Configure(EntityTypeBuilder<Project> b)
    {
        b.ToTable("projects");
        b.Property(x => x.Name).HasMaxLength(200).IsRequired();
        b.Property(x => x.Key).HasMaxLength(40).IsRequired();
        b.Property(x => x.Description).HasMaxLength(2000);
        b.Property(x => x.AiModel).HasMaxLength(100);
        b.HasIndex(x => new { x.OrganizationId, x.Key }).IsUnique();
        b.HasOne(x => x.Organization).WithMany(o => o.Projects)
            .HasForeignKey(x => x.OrganizationId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class EnvironmentConfiguration : IEntityTypeConfiguration<Domain.Projects.Environment>
{
    public void Configure(EntityTypeBuilder<Domain.Projects.Environment> b)
    {
        b.ToTable("environments");
        b.Property(x => x.Name).HasMaxLength(100).IsRequired();
        b.Property(x => x.BaseUrl).HasMaxLength(2048).IsRequired();
        b.Property(x => x.Key).HasMaxLength(40).IsRequired();
        b.Property(x => x.ApiBaseUrl).HasMaxLength(2048);
        b.Property(x => x.AllowedDomains).HasMaxLength(2048);
        b.Property(x => x.ProductionAuthorizationNote).HasMaxLength(1000);
        b.HasIndex(x => new { x.ProjectId, x.Name }).IsUnique();
        // The key is what `--environment` takes, so it has to be unambiguous per project.
        b.HasIndex(x => new { x.ProjectId, x.Key }).IsUnique();
        b.HasOne(x => x.Project).WithMany(p => p.Environments)
            .HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class QualityGateRuleConfiguration : IEntityTypeConfiguration<QualityGateRule>
{
    public void Configure(EntityTypeBuilder<QualityGateRule> b)
    {
        b.ToTable("quality_gate_rules");
        b.Property(x => x.Name).HasMaxLength(200).IsRequired();
        b.Property(x => x.Threshold).HasPrecision(12, 2);
        b.Property(x => x.Environment).HasMaxLength(40);
        b.Property(x => x.Message).HasMaxLength(500);
        b.HasIndex(x => x.ProjectId);
        b.HasOne(x => x.Project).WithMany(p => p.QualityGateRules)
            .HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class IntegrationConfiguration : IEntityTypeConfiguration<Integration>
{
    public void Configure(EntityTypeBuilder<Integration> b)
    {
        b.ToTable("integrations");
        b.Property(x => x.Name).HasMaxLength(200).IsRequired();
        b.Property(x => x.SettingsJson).HasColumnType("jsonb");
        b.HasIndex(x => new { x.ProjectId, x.Kind });
        b.HasOne(x => x.Project).WithMany().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class ScheduleConfiguration : IEntityTypeConfiguration<Schedule>
{
    public void Configure(EntityTypeBuilder<Schedule> b)
    {
        b.ToTable("schedules");
        b.Property(x => x.Name).HasMaxLength(200).IsRequired();
        b.Property(x => x.CronExpression).HasMaxLength(120).IsRequired();
        b.Property(x => x.TimeZone).HasMaxLength(64);
        b.HasIndex(x => new { x.IsEnabled, x.NextRunAt });
    }
}

public class ChangeImpactRuleConfiguration : IEntityTypeConfiguration<ChangeImpactRule>
{
    public void Configure(EntityTypeBuilder<ChangeImpactRule> b)
    {
        b.ToTable("change_impact_rules");
        b.Property(x => x.PathPattern).HasMaxLength(500).IsRequired();
        b.Property(x => x.Value).HasMaxLength(500);
        b.Property(x => x.Notes).HasMaxLength(1000);
        // Every selection reads the whole enabled set for a project, once.
        b.HasIndex(x => new { x.ProjectId, x.IsEnabled });
        b.HasOne(x => x.Project).WithMany()
            .HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
    }
}
