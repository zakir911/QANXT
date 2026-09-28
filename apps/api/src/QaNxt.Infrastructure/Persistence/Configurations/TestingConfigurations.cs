using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using QaNxt.Domain.Testing;

namespace QaNxt.Infrastructure.Persistence.Configurations;

public class TestSuiteConfiguration : IEntityTypeConfiguration<TestSuite>
{
    public void Configure(EntityTypeBuilder<TestSuite> b)
    {
        b.ToTable("test_suites");
        b.Property(x => x.Name).HasMaxLength(200).IsRequired();
        b.Property(x => x.Description).HasMaxLength(2000);
        b.Property(x => x.Tags).HasMaxLength(500);
        b.HasIndex(x => x.ProjectId);
        b.HasOne(x => x.Project).WithMany(p => p.TestSuites)
            .HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class VisualBaselineConfiguration : IEntityTypeConfiguration<VisualBaseline>
{
    public void Configure(EntityTypeBuilder<VisualBaseline> b)
    {
        b.ToTable("visual_baselines");
        b.Property(x => x.Name).HasMaxLength(200).IsRequired();
        b.Property(x => x.StorageKey).HasMaxLength(500).IsRequired();

        // The identity of a baseline. Unique because a second row for the same test, name,
        // browser and viewport would make "the baseline" ambiguous, and whichever one the
        // query happened to return would decide whether a run passed.
        b.HasIndex(x => new { x.TestCaseId, x.Name, x.Browser, x.ViewportWidth, x.ViewportHeight })
            .IsUnique();
    }
}

public class TestCaseConfiguration : IEntityTypeConfiguration<TestCase>
{
    public void Configure(EntityTypeBuilder<TestCase> b)
    {
        b.ToTable("test_cases");
        b.Property(x => x.Reference).HasMaxLength(60).IsRequired();
        b.Property(x => x.Name).HasMaxLength(300).IsRequired();
        b.Property(x => x.Objective).HasMaxLength(2000);
        b.Property(x => x.Preconditions).HasMaxLength(2000);
        b.Property(x => x.ExpectedResults).HasMaxLength(4000);
        b.Property(x => x.Tags).HasMaxLength(500);
        b.Property(x => x.RequirementReference).HasMaxLength(500);
        b.HasIndex(x => new { x.ProjectId, x.Reference }).IsUnique();
        b.HasIndex(x => x.TestSuiteId);
        // Dashboard queries slice by status and recency constantly.
        b.HasIndex(x => new { x.ProjectId, x.LastStatus, x.LastExecutedAt });
        // Regression selection and the gate's API metric both ask "which of these are API
        // tests?" over a whole project.
        b.HasIndex(x => new { x.ProjectId, x.Kind });
        b.HasOne(x => x.TestSuite).WithMany(s => s.TestCases)
            .HasForeignKey(x => x.TestSuiteId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne(x => x.TestDataSet).WithMany()
            .HasForeignKey(x => x.TestDataSetId).OnDelete(DeleteBehavior.SetNull);
    }
}

public class TestStepConfiguration : IEntityTypeConfiguration<TestStep>
{
    public void Configure(EntityTypeBuilder<TestStep> b)
    {
        b.ToTable("test_steps");
        b.Property(x => x.Description).HasMaxLength(1000);
        b.Property(x => x.TargetJson).HasColumnType("jsonb");
        b.Property(x => x.ApiRequestJson).HasColumnType("jsonb");
        b.Property(x => x.Value).HasMaxLength(4000);
        b.Property(x => x.Url).HasMaxLength(2048);
        b.HasIndex(x => new { x.TestCaseId, x.Order });
        b.HasOne(x => x.TestCase).WithMany(c => c.Steps)
            .HasForeignKey(x => x.TestCaseId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class AssertionConfiguration : IEntityTypeConfiguration<Assertion>
{
    public void Configure(EntityTypeBuilder<Assertion> b)
    {
        b.ToTable("assertions");
        b.Property(x => x.TargetJson).HasColumnType("jsonb");
        b.Property(x => x.ExpectedValue).HasMaxLength(4000);
        // Wide enough for a JSON path as well as an HTML attribute name: a response
        // assertion stores its path here, and the validator caps a path at 200.
        b.Property(x => x.AttributeName).HasMaxLength(200);
        b.Property(x => x.Description).HasMaxLength(1000);
        b.HasIndex(x => x.TestStepId);
        b.HasOne(x => x.TestStep).WithMany(s => s.Assertions)
            .HasForeignKey(x => x.TestStepId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class TestDataSetConfiguration : IEntityTypeConfiguration<TestDataSet>
{
    public void Configure(EntityTypeBuilder<TestDataSet> b)
    {
        b.ToTable("test_data_sets");
        b.Property(x => x.Name).HasMaxLength(200).IsRequired();
        b.Property(x => x.Description).HasMaxLength(1000);
        b.HasIndex(x => new { x.ProjectId, x.Name }).IsUnique();
    }
}

public class TestDataFieldConfiguration : IEntityTypeConfiguration<TestDataField>
{
    public void Configure(EntityTypeBuilder<TestDataField> b)
    {
        b.ToTable("test_data_fields");
        b.Property(x => x.Key).HasMaxLength(100).IsRequired();
        b.Property(x => x.Value).HasMaxLength(4000);
        b.Property(x => x.GeneratorJson).HasColumnType("jsonb");
        b.HasIndex(x => new { x.TestDataSetId, x.Key }).IsUnique();
        b.HasOne(x => x.TestDataSet).WithMany(d => d.Fields)
            .HasForeignKey(x => x.TestDataSetId).OnDelete(DeleteBehavior.Cascade);
    }
}

public class TestRunConfiguration : IEntityTypeConfiguration<TestRun>
{
    public void Configure(EntityTypeBuilder<TestRun> b)
    {
        b.ToTable("test_runs");
        b.Property(x => x.Name).HasMaxLength(300).IsRequired();
        b.Property(x => x.CiProvider).HasMaxLength(60);
        b.Property(x => x.CiBuildId).HasMaxLength(200);
        b.Property(x => x.CiCommitSha).HasMaxLength(64);
        b.Property(x => x.CiBranch).HasMaxLength(200);
        b.Property(x => x.ApplicationBuildRef).HasMaxLength(200);
        b.Property(x => x.QualityGateSummaryJson).HasColumnType("jsonb");
        b.HasIndex(x => new { x.ProjectId, x.CreatedAt });
        b.HasIndex(x => x.Status);
    }
}

public class TestExecutionConfiguration : IEntityTypeConfiguration<TestExecution>
{
    public void Configure(EntityTypeBuilder<TestExecution> b)
    {
        b.ToTable("test_executions");
        b.Property(x => x.CorrelationId).HasMaxLength(64).IsRequired();
        b.Property(x => x.WorkerId).HasMaxLength(100);
        b.Property(x => x.BrowserVersion).HasMaxLength(60);
        b.Property(x => x.ErrorMessage).HasMaxLength(4000);
        b.Property(x => x.ErrorStack).HasMaxLength(20000);
        b.HasIndex(x => new { x.TestRunId, x.Status });
        b.HasIndex(x => new { x.TestCaseId, x.CreatedAt });
        b.HasIndex(x => x.CorrelationId);
        b.HasOne(x => x.TestRun).WithMany(r => r.Executions)
            .HasForeignKey(x => x.TestRunId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne(x => x.TestCase).WithMany()
            .HasForeignKey(x => x.TestCaseId).OnDelete(DeleteBehavior.Restrict);
    }
}

public class TestActionConfiguration : IEntityTypeConfiguration<TestAction>
{
    public void Configure(EntityTypeBuilder<TestAction> b)
    {
        b.ToTable("test_actions");
        b.Property(x => x.Description).HasMaxLength(1000);
        b.Property(x => x.Url).HasMaxLength(2048);
        b.Property(x => x.LocatorUsedJson).HasColumnType("jsonb");
        b.Property(x => x.LocatorAlternativesJson).HasColumnType("jsonb");
        b.Property(x => x.MaskedValue).HasMaxLength(2000);
        b.Property(x => x.ErrorMessage).HasMaxLength(4000);
        b.HasIndex(x => new { x.TestExecutionId, x.Order });
        b.HasOne(x => x.TestExecution).WithMany(e => e.Actions)
            .HasForeignKey(x => x.TestExecutionId).OnDelete(DeleteBehavior.Cascade);
    }
}
