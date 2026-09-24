using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Aira.Domain.Security;

namespace Aira.Infrastructure.Persistence.Configurations;

public class SecurityScopeConfiguration : IEntityTypeConfiguration<SecurityScope>
{
    public void Configure(EntityTypeBuilder<SecurityScope> b)
    {
        b.ToTable("security_scopes");

        // One scope per application, enforced in the schema rather than in a service. Two
        // scopes for one application would mean two answers to "what did somebody authorize",
        // and whichever one a query happened to load would decide what the scanner could do.
        b.HasIndex(x => x.ApplicationId).IsUnique();

        b.Property(x => x.AllowedDomains).HasMaxLength(2000);
        b.Property(x => x.AllowedApiDomains).HasMaxLength(2000);
        b.Property(x => x.AllowedPaths).HasMaxLength(2000);
        b.Property(x => x.BlockedPaths).HasMaxLength(2000);

        // Long enough for a real authorization: who agreed, on whose behalf, for what window.
        // A 200-character limit would push people towards "approved by Sam" and that is not
        // an authorization anybody could rely on later.
        b.Property(x => x.AuthorizationNote).HasMaxLength(4000);

        b.HasOne(x => x.Application).WithMany()
            .HasForeignKey(x => x.ApplicationId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne(x => x.Environment).WithMany()
            .HasForeignKey(x => x.EnvironmentId).OnDelete(DeleteBehavior.SetNull);
    }
}

public class SecurityScanConfiguration : IEntityTypeConfiguration<SecurityScan>
{
    public void Configure(EntityTypeBuilder<SecurityScan> b)
    {
        b.ToTable("security_scans");
        b.Property(x => x.Reference).HasMaxLength(64).IsRequired();
        b.Property(x => x.Status).HasMaxLength(32).IsRequired();
        b.Property(x => x.AuthorizationNote).HasMaxLength(4000);
        b.Property(x => x.ScopeSnapshotJson).HasColumnType("jsonb");

        b.HasIndex(x => new { x.OrganizationId, x.Reference }).IsUnique();
        b.HasIndex(x => new { x.ApplicationId, x.StartedAt });

        b.HasMany(x => x.Findings).WithOne(x => x.SecurityScan)
            .HasForeignKey(x => x.SecurityScanId).OnDelete(DeleteBehavior.SetNull);
    }
}

public class SecurityFindingConfiguration : IEntityTypeConfiguration<SecurityFinding>
{
    public void Configure(EntityTypeBuilder<SecurityFinding> b)
    {
        b.ToTable("security_findings");
        b.Property(x => x.Fingerprint).HasMaxLength(64).IsRequired();
        b.Property(x => x.Reference).HasMaxLength(64).IsRequired();
        b.Property(x => x.Title).HasMaxLength(500).IsRequired();
        b.Property(x => x.Category).HasMaxLength(120).IsRequired();
        b.Property(x => x.TestId).HasMaxLength(120);
        b.Property(x => x.Endpoint).HasMaxLength(1024);
        b.Property(x => x.HttpMethod).HasMaxLength(10);
        b.Property(x => x.Parameter).HasMaxLength(200);
        b.Property(x => x.ObservedAsRole).HasMaxLength(120);
        b.Property(x => x.Cwe).HasMaxLength(20);
        b.Property(x => x.CweConfidence).HasMaxLength(20);
        b.Property(x => x.OwaspApiCategory).HasMaxLength(20);
        b.Property(x => x.OwaspWebCategory).HasMaxLength(20);
        b.Property(x => x.OwaspEdition).HasMaxLength(20);
        b.Property(x => x.SeverityFactorsJson).HasColumnType("jsonb");
        b.Property(x => x.Description).HasMaxLength(4000);
        b.Property(x => x.Impact).HasMaxLength(4000);
        b.Property(x => x.Remediation).HasMaxLength(4000);
        b.Property(x => x.ReproductionSteps).HasMaxLength(8000);
        b.Property(x => x.EvidencePath).HasMaxLength(512);
        b.Property(x => x.DispositionNote).HasMaxLength(4000);

        // The fingerprint is unique per application, not per scan. The same flaw found again
        // updates the row rather than creating a second one, which is what makes first-seen,
        // last-seen and regression mean anything. Without this constraint a re-scan would
        // produce N copies and every one of them would look new.
        b.HasIndex(x => new { x.ApplicationId, x.Fingerprint }).IsUnique();
        b.HasIndex(x => new { x.OrganizationId, x.Status });
        b.HasIndex(x => x.SecurityScanId);
    }
}

public class SecurityScanFindingConfiguration : IEntityTypeConfiguration<SecurityScanFinding>
{
    public void Configure(EntityTypeBuilder<SecurityScanFinding> b)
    {
        b.ToTable("security_scan_findings");

        // One row per finding per scan. A retried delivery must not double-count a finding
        // into a scan's own record of what it saw.
        b.HasIndex(x => new { x.SecurityScanId, x.SecurityFindingId }).IsUnique();
        b.HasIndex(x => x.SecurityFindingId);

        b.HasOne(x => x.SecurityScan).WithMany()
            .HasForeignKey(x => x.SecurityScanId).OnDelete(DeleteBehavior.Cascade);
        // Cascade rather than SetNull: a link to a finding that no longer exists says a scan
        // reported something and cannot say what, which is worse than not being there.
        b.HasOne(x => x.SecurityFinding).WithMany()
            .HasForeignKey(x => x.SecurityFindingId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class SecurityBlockedRequestConfiguration : IEntityTypeConfiguration<SecurityBlockedRequest>
{
    public void Configure(EntityTypeBuilder<SecurityBlockedRequest> b)
    {
        b.ToTable("security_blocked_requests");
        b.Property(x => x.Url).HasMaxLength(2048).IsRequired();
        b.Property(x => x.HttpMethod).HasMaxLength(10).IsRequired();
        b.Property(x => x.Explanation).HasMaxLength(1000);
        b.Property(x => x.TestId).HasMaxLength(120);
        b.HasIndex(x => x.SecurityScanId);
    }
}
