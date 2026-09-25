using Aira.Application.Abstractions;
using Aira.Application.Agent;
using Aira.Application.Security;
using Aira.Domain.Enums;
using Aira.Domain.Projects;
using Aira.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using ApplicationEntity = Aira.Domain.Applications.Application;

namespace Aira.UnitTests.Agent;

/// <summary>
/// What a person tells the platform about their own application.
/// </summary>
/// <remarks>
/// <para>
/// Two things are being pinned. The exclusions must be honoured absolutely — an operator who
/// writes "never touch admin deletion" is not expressing a preference that a high enough risk
/// score can outvote. And the rest of it must remain advisory: nothing written in a free-text
/// box may widen what an unattended agent is permitted to do, because that box is reachable by
/// anyone who can edit an application.
/// </para>
/// </remarks>
public class ApplicationContextTests
{
    private static readonly Guid OrgId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly DateTimeOffset Noon = new(2026, 9, 24, 12, 0, 0, TimeSpan.Zero);

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

    private sealed class TestUser : ICurrentUser
    {
        private readonly HashSet<string> _permissions;
        public TestUser(params string[] permissions) => _permissions = new HashSet<string>(permissions);
        public Guid? UserId { get; } = Guid.Parse("33333333-3333-3333-3333-333333333333");
        public Guid? OrganizationId => OrgId;
        public string? Email => "qa.lead@example.test";
        public bool IsAuthenticated => true;
        public IReadOnlySet<string> Permissions => _permissions;
        public bool HasPermission(string permission) => _permissions.Contains(permission);
        public string? CorrelationId => null;
    }

    private sealed class SilentAudit : IAuditLogger
    {
        public Task LogAsync(AuditAction action, string entityType, Guid? entityId, string summary,
            object? changes = null, bool succeeded = true, Guid? organizationId = null,
            Guid? projectId = null, Guid? userId = null, string? userEmail = null,
            CancellationToken ct = default) => Task.CompletedTask;
    }

    private static (ApplicationContextService Service, Guid AppId) Create(params string[] permissions)
    {
        var tenant = new TestTenantContext();
        var options = new DbContextOptionsBuilder<AiraDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(
                Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new AiraDbContext(options, tenant, new FixedClock());

        var project = new Project { OrganizationId = OrgId, Name = "Retail Banking", Key = "BANK" };
        var application = new ApplicationEntity
        {
            OrganizationId = OrgId, Name = "Demo Bank", BaseUrl = "https://bank.example.test"
        };

        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
            db.SaveChanges();
            application.ProjectId = project.Id;
            db.Applications.Add(application);
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        var service = new ApplicationContextService(
            db, new TestUser(permissions), new SilentAudit(), new SecretMasker());
        return (service, application.Id);
    }

    private static ApplicationContextRequest Request(
        string? critical = "Payment\nLogin\nLoan application",
        string? highRisk = "Authentication\nPayments\nCustomer data",
        string? excluded = "/admin/delete",
        string? notes = "Staging only.")
        => new(critical, highRisk, excluded, notes);

    // -----------------------------------------------------------------------

    [Fact]
    public async Task An_application_nobody_has_described_has_empty_context_rather_than_an_error()
    {
        var (service, appId) = Create(Permissions.ApplicationRead);

        var result = await service.GetAsync(appId);

        // Absence is the answer. It is not an error, and it is emphatically not "nothing is
        // critical" — the planner has to be able to tell the two apart.
        result.IsSuccess.Should().BeTrue();
        result.Value!.CriticalJourneys.Should().BeEmpty();
        result.Value.ExcludedAreas.Should().BeEmpty();
    }

    [Fact]
    public async Task Setting_context_needs_permission_to_write_the_application()
    {
        var (service, appId) = Create(Permissions.ApplicationRead);

        var result = await service.SetAsync(appId, Request());

        // What is written here changes what an unattended agent prioritises and what it
        // refuses to touch. Read access to an application is not a reason to hold that.
        result.IsSuccess.Should().BeFalse();
        result.Error!.Message.Should().Contain("application:write");
    }

    [Fact]
    public async Task Context_is_stored_one_entry_per_line_and_normalised()
    {
        var (service, appId) = Create(Permissions.ApplicationWrite);

        var result = await service.SetAsync(appId, Request(critical: "  Payment \n\n PAYMENT \nLogin "));

        // Trimmed, lower-cased and de-duplicated, because matching is literal and an operator
        // should not have to think about whitespace to be obeyed.
        result.Value!.CriticalJourneys.Should().Equal("payment", "login");
    }

    [Fact]
    public async Task Setting_context_twice_updates_rather_than_adding_a_second_answer()
    {
        var (service, appId) = Create(Permissions.ApplicationWrite);

        await service.SetAsync(appId, Request(excluded: "/admin/delete"));
        await service.SetAsync(appId, Request(excluded: "/admin/delete\n/reports/export"));

        var stored = await service.GetAsync(appId);

        // Two rows of business context means two different answers to "what must never be
        // touched", and the planner would read whichever came back first.
        stored.Value!.ExcludedAreas.Should().Equal("/admin/delete", "/reports/export");
    }

    [Fact]
    public async Task An_excluded_area_matches_the_routes_underneath_it()
    {
        var (service, appId) = Create(Permissions.ApplicationWrite);
        await service.SetAsync(appId, Request(excluded: "/admin"));

        var context = (await service.GetAsync(appId)).Value!;

        // Prefix rather than exact. An exclusion that missed the child routes would be the
        // worst kind of near-miss: it reads as protection and is not.
        context.Excludes("/admin").Should().BeTrue();
        context.Excludes("/admin/users/42/delete").Should().BeTrue();
        context.Excludes("/administration").Should().BeTrue("a near match is refused too");
        context.Excludes("/payments").Should().BeFalse();
    }

    [Fact]
    public async Task Nothing_is_excluded_when_nobody_named_an_exclusion()
    {
        var (service, appId) = Create(Permissions.ApplicationWrite);
        await service.SetAsync(appId, Request(excluded: null));

        (await service.GetAsync(appId)).Value!.Excludes("/admin/delete").Should().BeFalse();
    }

    [Fact]
    public async Task Areas_a_person_named_are_recognised_as_critical()
    {
        var (service, appId) = Create(Permissions.ApplicationWrite);
        await service.SetAsync(appId, Request(critical: "payment", highRisk: "authentication"));

        var context = (await service.GetAsync(appId)).Value!;

        context.IsCritical("/payments/transfer").Should().BeTrue();
        context.IsCritical("/authentication/login").Should().BeTrue();
        context.IsCritical("/about").Should().BeFalse();
    }

    [Fact]
    public async Task A_credential_pasted_into_the_notes_is_masked()
    {
        var (service, appId) = Create(Permissions.ApplicationWrite);

        var result = await service.SetAsync(appId, Request(
            notes: "Sign in with password=Hunter2Hunter2 for the shared QA account."));

        // The person explaining why an area is sensitive is the one most likely to paste a
        // credential into the explanation.
        result.Value!.Notes.Should().NotContain("Hunter2Hunter2");
        result.Value.Notes.Should().Contain("REDACTED");
    }

    [Fact]
    public async Task The_number_of_entries_is_bounded()
    {
        var (service, appId) = Create(Permissions.ApplicationWrite);
        var many = string.Join('\n', Enumerable.Range(0, 500).Select(i => $"/area-{i}"));

        var result = await service.SetAsync(appId, Request(excluded: many));

        // A list long enough to be a denial of service against the planner is not a list
        // anybody wrote by hand.
        result.Value!.ExcludedAreas.Count.Should().BeLessOrEqualTo(100);
    }

    [Fact]
    public async Task Context_for_an_application_that_does_not_exist_is_refused()
    {
        var (service, _) = Create(Permissions.ApplicationWrite);

        (await service.SetAsync(Guid.NewGuid(), Request())).IsSuccess.Should().BeFalse();
        (await service.GetAsync(Guid.NewGuid())).IsSuccess.Should().BeFalse();
    }
}
