using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using QaNxt.Domain.Applications;

namespace QaNxt.Infrastructure.Persistence.Configurations;

public class ApplicationConfiguration : IEntityTypeConfiguration<Domain.Applications.Application>
{
    public void Configure(EntityTypeBuilder<Domain.Applications.Application> b)
    {
        b.ToTable("applications");
        b.Property(x => x.Name).HasMaxLength(200).IsRequired();
        b.Property(x => x.BaseUrl).HasMaxLength(2048).IsRequired();
        b.Property(x => x.Description).HasMaxLength(2000);
        b.Property(x => x.AllowedDomains).HasMaxLength(2000);
        b.Property(x => x.ExcludedPaths).HasMaxLength(2000);
        b.Property(x => x.LoginUrl).HasMaxLength(2048);
        b.Property(x => x.LoginFlowJson).HasColumnType("jsonb");
        b.HasIndex(x => x.ProjectId);
        b.HasOne(x => x.Project).WithMany(p => p.Applications)
            .HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class DiscoveryRunConfiguration : IEntityTypeConfiguration<DiscoveryRun>
{
    public void Configure(EntityTypeBuilder<DiscoveryRun> b)
    {
        b.ToTable("discovery_runs");
        b.Property(x => x.WorkerId).HasMaxLength(100);
        b.HasIndex(x => new { x.ApplicationId, x.CreatedAt });
        b.HasIndex(x => x.Status);
        b.HasOne(x => x.Application).WithMany(a => a.DiscoveryRuns)
            .HasForeignKey(x => x.ApplicationId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class ApplicationPageConfiguration : IEntityTypeConfiguration<ApplicationPage>
{
    public void Configure(EntityTypeBuilder<ApplicationPage> b)
    {
        b.ToTable("application_pages");
        b.Property(x => x.Url).HasMaxLength(2048).IsRequired();
        b.Property(x => x.NormalizedUrl).HasMaxLength(2048).IsRequired();
        b.Property(x => x.Route).HasMaxLength(512);
        b.Property(x => x.Title).HasMaxLength(500);
        b.Property(x => x.ScreenshotArtifactKey).HasMaxLength(512);
        b.Property(x => x.DomArtifactKey).HasMaxLength(512);
        b.Property(x => x.AccessibilityArtifactKey).HasMaxLength(512);
        b.Property(x => x.VisibleTextExcerpt).HasMaxLength(8000);
        // One node per normalized URL per application: re-discovery updates rather than duplicates.
        b.HasIndex(x => new { x.ApplicationId, x.NormalizedUrl }).IsUnique();
        b.HasOne(x => x.Application).WithMany(a => a.Pages)
            .HasForeignKey(x => x.ApplicationId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne(x => x.ParentPage).WithMany()
            .HasForeignKey(x => x.ParentPageId).OnDelete(DeleteBehavior.NoAction);
    }
}

public class PageTransitionConfiguration : IEntityTypeConfiguration<PageTransition>
{
    public void Configure(EntityTypeBuilder<PageTransition> b)
    {
        b.ToTable("page_transitions");
        b.HasIndex(x => new { x.FromPageId, x.ToPageId, x.Action }).IsUnique();
        b.HasOne(x => x.FromPage).WithMany(p => p.OutgoingTransitions)
            .HasForeignKey(x => x.FromPageId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne(x => x.ToPage).WithMany()
            .HasForeignKey(x => x.ToPageId).OnDelete(DeleteBehavior.NoAction);
    }
}

public class ApplicationElementConfiguration : IEntityTypeConfiguration<ApplicationElement>
{
    public void Configure(EntityTypeBuilder<ApplicationElement> b)
    {
        b.ToTable("application_elements");
        b.Property(x => x.TagName).HasMaxLength(50).IsRequired();
        b.Property(x => x.AriaRole).HasMaxLength(60);
        b.Property(x => x.AccessibleName).HasMaxLength(500);
        b.Property(x => x.Text).HasMaxLength(1000);
        b.Property(x => x.Label).HasMaxLength(500);
        b.Property(x => x.Placeholder).HasMaxLength(500);
        b.Property(x => x.TestId).HasMaxLength(200);
        b.Property(x => x.ElementId).HasMaxLength(200);
        b.Property(x => x.Name).HasMaxLength(200);
        b.Property(x => x.Type).HasMaxLength(60);
        b.Property(x => x.Title).HasMaxLength(300);
        b.Property(x => x.Value).HasMaxLength(500);
        b.Property(x => x.CssSelector).HasMaxLength(1000);
        b.Property(x => x.XPath).HasMaxLength(1000);
        b.Property(x => x.DomPath).HasMaxLength(1000);
        b.Property(x => x.ParentSignature).HasMaxLength(500);
        b.Property(x => x.NeighbourText).HasMaxLength(1000);
        b.Property(x => x.AttributesJson).HasColumnType("jsonb");
        b.Property(x => x.PreferredLocatorJson).HasColumnType("jsonb");
        b.HasIndex(x => x.ApplicationPageId);
        // Healing scans candidates by role/name; this index keeps that lookup cheap.
        b.HasIndex(x => new { x.ApplicationPageId, x.AriaRole, x.AccessibleName });
        b.HasIndex(x => x.TestId);
        b.HasOne(x => x.Page).WithMany(p => p.Elements)
            .HasForeignKey(x => x.ApplicationPageId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class ApiEndpointConfiguration : IEntityTypeConfiguration<ApiEndpoint>
{
    public void Configure(EntityTypeBuilder<ApiEndpoint> b)
    {
        b.ToTable("api_endpoints");
        b.Property(x => x.Method).HasMaxLength(10).IsRequired();
        b.Property(x => x.UrlTemplate).HasMaxLength(2048).IsRequired();
        b.Property(x => x.SampleUrl).HasMaxLength(2048);
        b.Property(x => x.RequestContentType).HasMaxLength(120);
        b.Property(x => x.ResponseContentType).HasMaxLength(120);
        b.HasIndex(x => new { x.ApplicationId, x.Method, x.UrlTemplate }).IsUnique();
        b.HasOne(x => x.Application).WithMany(a => a.ApiEndpoints)
            .HasForeignKey(x => x.ApplicationId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class ApiContractConfiguration : IEntityTypeConfiguration<ApiContract>
{
    public void Configure(EntityTypeBuilder<ApiContract> b)
    {
        b.ToTable("api_contracts");
        b.Property(x => x.Method).HasMaxLength(10).IsRequired();
        b.Property(x => x.UrlTemplate).HasMaxLength(2048).IsRequired();
        b.Property(x => x.ResponseSchemaJson).HasColumnType("jsonb").IsRequired();
        b.Property(x => x.RequestSchemaJson).HasColumnType("jsonb");
        b.Property(x => x.ResponseContentType).HasMaxLength(120);
        b.Property(x => x.SourceSampleSha256).HasMaxLength(64);
        b.Property(x => x.Note).HasMaxLength(1000);
        // The comparison always asks for one endpoint's current baseline, and a filtered
        // index keeps that a single-row lookup however much history accumulates.
        b.HasIndex(x => new { x.ApplicationId, x.Method, x.UrlTemplate, x.IsBaseline });
        b.HasIndex(x => x.ApiEndpointId);
        b.HasOne(x => x.Application).WithMany()
            .HasForeignKey(x => x.ApplicationId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne(x => x.ApiEndpoint).WithMany()
            .HasForeignKey(x => x.ApiEndpointId).OnDelete(DeleteBehavior.SetNull);
    }
}

public class ApiContractChangeConfiguration : IEntityTypeConfiguration<ApiContractChange>
{
    public void Configure(EntityTypeBuilder<ApiContractChange> b)
    {
        b.ToTable("api_contract_changes");
        b.Property(x => x.Method).HasMaxLength(10).IsRequired();
        b.Property(x => x.UrlTemplate).HasMaxLength(2048).IsRequired();
        b.Property(x => x.Path).HasMaxLength(500).IsRequired();
        b.Property(x => x.BaselineType).HasMaxLength(120);
        b.Property(x => x.ObservedType).HasMaxLength(120);
        b.Property(x => x.Description).HasMaxLength(2000).IsRequired();
        b.Property(x => x.AcknowledgementNote).HasMaxLength(1000);
        // The gate asks "how many breaking changes did this run find?" on every evaluation.
        b.HasIndex(x => new { x.TestRunId, x.Kind });
        b.HasIndex(x => new { x.ApplicationId, x.DetectedAt });
        b.HasOne(x => x.BaselineContract).WithMany()
            .HasForeignKey(x => x.BaselineContractId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class JourneyConfiguration : IEntityTypeConfiguration<Journey>
{
    public void Configure(EntityTypeBuilder<Journey> b)
    {
        b.ToTable("journeys");
        b.Property(x => x.Name).HasMaxLength(300).IsRequired();
        b.Property(x => x.Description).HasMaxLength(2000);
        b.Property(x => x.RiskRationale).HasMaxLength(2000);
        b.Property(x => x.Tags).HasMaxLength(500);
        b.HasIndex(x => new { x.ApplicationId, x.RiskScore });
        b.HasOne(x => x.Application).WithMany(a => a.Journeys)
            .HasForeignKey(x => x.ApplicationId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class JourneyStepConfiguration : IEntityTypeConfiguration<JourneyStep>
{
    public void Configure(EntityTypeBuilder<JourneyStep> b)
    {
        b.ToTable("journey_steps");
        b.Property(x => x.Description).HasMaxLength(1000);
        b.Property(x => x.TargetJson).HasColumnType("jsonb");
        b.Property(x => x.Value).HasMaxLength(2000);
        b.Property(x => x.Url).HasMaxLength(2048);
        b.Property(x => x.Annotation).HasMaxLength(2000);
        b.Property(x => x.ExpectedResult).HasMaxLength(2000);
        b.Property(x => x.AttributeName).HasMaxLength(200);
        b.HasIndex(x => new { x.JourneyId, x.Order });
        b.HasOne(x => x.Journey).WithMany(j => j.Steps)
            .HasForeignKey(x => x.JourneyId).OnDelete(DeleteBehavior.Cascade);
    }
}
