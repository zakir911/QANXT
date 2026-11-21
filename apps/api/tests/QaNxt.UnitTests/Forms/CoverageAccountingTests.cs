using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Forms;
using AppEntity = QaNxt.Domain.Applications.Application;
using QaNxt.Domain.Applications;
using QaNxt.Domain.Common;
using QaNxt.Domain.Enums;
using QaNxt.Domain.Projects;
using QaNxt.Domain.Testing;
using QaNxt.Infrastructure.Persistence;
using Xunit;

namespace QaNxt.UnitTests.Forms;

/// <summary>What counts as having run.
///
/// Coverage is the share of an application's tests that executed. A blocked execution did
/// not execute: the worker sets that status when the test never started, and stores
/// "Preconditions were not met" or "Not run" as its reason. Counting it as executed put
/// tests that never opened a page into the numerator, so an application QA NXT could not
/// sign in to still reported coverage. These tests hold the line in both directions: a
/// blocked test is not coverage, and it does not disappear either.</summary>
public class CoverageAccountingTests
{
    private static readonly Guid OrgId = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly DateTimeOffset Noon = new(2026, 11, 21, 12, 0, 0, TimeSpan.Zero);

    private sealed class TestTenantContext : ITenantContext
    {
        private int _depth;
        public Guid? OrganizationId { get; private set; }
        public bool IsSystemContext => _depth > 0;
        public void SetOrganization(Guid organizationId) => OrganizationId = organizationId;
        public IDisposable EnterSystemContext(string reason) { _depth++; return new Scope(() => _depth--); }
        private sealed class Scope(Action onDispose) : IDisposable { public void Dispose() => onDispose(); }
    }

    private sealed class FixedClock : IClock { public DateTimeOffset UtcNow => Noon; }

    /// <summary>One form carrying one test per status given.</summary>
    private static (CoverageService Service, Guid ApplicationId) Create(params ExecutionStatus?[] statuses)
    {
        var tenant = new TestTenantContext();
        var options = new DbContextOptionsBuilder<QaNxtDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new QaNxtDbContext(options, tenant, new FixedClock());

        var project = new Project { OrganizationId = OrgId, Name = "Freight", Key = "FRT" };
        var application = new AppEntity
        {
            OrganizationId = OrgId, ProjectId = project.Id, Name = "Meridian Freight",
            BaseUrl = "http://127.0.0.1:4400", AllowedDomains = "127.0.0.1"
        };
        var form = new ApplicationForm
        {
            OrganizationId = OrgId, ApplicationId = application.Id, Name = "Book a shipment",
            Route = "/shipments/new", PageUrl = "http://127.0.0.1:4400/shipments/new",
            FormKey = "booking", IsPresent = true
        };
        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
            db.Applications.Add(application);
            db.ApplicationForms.Add(form);
            var index = 0;
            foreach (var status in statuses)
            {
                index++;
                db.TestCases.Add(new TestCase
                {
                    OrganizationId = OrgId, ProjectId = project.Id, ApplicationId = application.Id,
                    ApplicationFormId = form.Id, Name = $"test {index}", Category = TestCategory.Functional,
                    Lifecycle = TestCaseLifecycle.Active,
                    LastStatus = status,
                    LastExecutedAt = status is null ? null : Noon
                });
            }
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        return (new CoverageService(db), application.Id);
    }

    [Fact]
    public async Task A_blocked_test_is_not_counted_as_executed()
    {
        var (service, applicationId) = Create(ExecutionStatus.Passed, ExecutionStatus.Blocked, null);

        var coverage = (await service.ForApplicationAsync(applicationId)).Value!;

        coverage.Surface.ExecutedTests.Should().Be(1,
            "one test ran; one was blocked before it started and one has not been run at all");
        coverage.Surface.TestableTests.Should().Be(3);
    }

    [Fact]
    public async Task A_blocked_test_is_still_reported_in_its_own_column()
    {
        var (service, applicationId) = Create(ExecutionStatus.Passed, ExecutionStatus.Blocked, null);

        var form = (await service.ForApplicationAsync(applicationId)).Value!.Forms.Single();

        form.Blocked.Should().Be(1, "a test that could not run is reported, not dropped");
        form.NotRun.Should().Be(2, "the blocked one and the one never attempted");
        form.Executed.Should().Be(1);
    }

    /// <summary>An application nothing could sign in to reports no coverage, not partial
    /// coverage. Every test blocked is the shape that made this worth fixing.</summary>
    [Fact]
    public async Task An_application_whose_every_test_was_blocked_reports_no_coverage()
    {
        var (service, applicationId) = Create(ExecutionStatus.Blocked, ExecutionStatus.Blocked);

        var coverage = (await service.ForApplicationAsync(applicationId)).Value!;

        coverage.Surface.ExecutedTests.Should().Be(0);
        coverage.OverallCoveragePercent.Should().Be(0);
    }
}
