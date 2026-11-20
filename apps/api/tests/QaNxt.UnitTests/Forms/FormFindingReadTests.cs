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

/// <summary>Reading a structural finding, rather than counting it.
///
/// The engine records a message, a code, a severity and a field for every finding it reads
/// off a form's structure. Coverage exposed the count alone, so a user could see that a form
/// had one finding and had no way to learn what it said short of querying the database. These
/// tests cover the read that closes that: it exists, it says what the engine said, and the
/// worst findings come first.</summary>
public class FormFindingReadTests
{
    private static readonly Guid OrgId = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly DateTimeOffset Noon = new(2026, 11, 20, 12, 0, 0, TimeSpan.Zero);

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

    private static (CoverageService Service, Guid ApplicationId) Create(params (string Code, string Severity, string Message, string? Field)[] findings)
    {
        var tenant = new TestTenantContext();
        var options = new DbContextOptionsBuilder<QaNxtDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new QaNxtDbContext(options, tenant, new FixedClock());

        var project = new Project { OrganizationId = OrgId, Name = "Clinic", Key = "CLIN" };
        var application = new AppEntity
        {
            OrganizationId = OrgId, ProjectId = project.Id, Name = "Clinic Scheduler",
            BaseUrl = "http://127.0.0.1:4600/schedule", AllowedDomains = "127.0.0.1"
        };
        var form = new ApplicationForm
        {
            OrganizationId = OrgId, ApplicationId = application.Id, Name = "Patients",
            Route = "/patients", PageUrl = "http://127.0.0.1:4600/patients",
            FormKey = "search", IsPresent = true
        };
        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
            db.Applications.Add(application);
            db.ApplicationForms.Add(form);
            foreach (var (code, severity, message, field) in findings)
            {
                db.FormFindings.Add(new FormFinding
                {
                    OrganizationId = OrgId, ApplicationId = application.Id, ApplicationFormId = form.Id,
                    Kind = FormFindingKind.SecurityIndicator, Code = code, Severity = severity,
                    Message = message, FieldKey = field
                });
            }
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        return (new CoverageService(db), application.Id);
    }

    [Fact]
    public async Task A_findings_read_says_what_the_engine_said_not_how_many()
    {
        var (service, applicationId) = Create(
            ("reflects-input", "serious", "The search term is written back into the page as markup.", "reference"));

        var result = await service.FindingsAsync(applicationId);

        result.IsSuccess.Should().BeTrue();
        var finding = result.Value!.Should().ContainSingle().Subject;
        finding.Message.Should().Be("The search term is written back into the page as markup.");
        finding.Code.Should().Be("reflects-input");
        finding.Severity.Should().Be("serious");
        finding.FieldKey.Should().Be("reference");
        finding.FormName.Should().Be("Patients");
        finding.Route.Should().Be("/patients");
        finding.Kind.Should().Be(nameof(FormFindingKind.SecurityIndicator));
    }

    [Fact]
    public async Task The_worst_findings_come_first()
    {
        var (service, applicationId) = Create(
            ("no-autocomplete", "info", "No autocomplete hint.", "a"),
            ("password-over-get", "serious", "A password travels in the query string.", "b"),
            ("unlabelled", "warning", "An input with no label.", "c"));

        var findings = (await service.FindingsAsync(applicationId)).Value!;

        findings.Select(f => f.Severity).Should().Equal("serious", "warning", "info");
    }

    [Fact]
    public async Task An_application_with_no_findings_reads_as_empty_rather_than_missing()
    {
        var (service, applicationId) = Create();

        var result = await service.FindingsAsync(applicationId);

        result.IsSuccess.Should().BeTrue();
        result.Value!.Should().BeEmpty();
    }

    [Fact]
    public async Task An_application_that_does_not_exist_is_not_found()
    {
        var (service, _) = Create();

        var result = await service.FindingsAsync(Guid.NewGuid());

        result.IsSuccess.Should().BeFalse();
    }
}
