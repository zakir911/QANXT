using Aira.Application.Abstractions;
using Aira.Application.Agent;
using Aira.Application.Security;
using Aira.Domain.Agent;
using Aira.Domain.Enums;
using Aira.Domain.Projects;
using Aira.Infrastructure.Persistence;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using ApplicationEntity = Aira.Domain.Applications.Application;

namespace Aira.UnitTests.Agent;

/// <summary>
/// What the platform remembers between passes, and what it refuses to remember.
/// </summary>
/// <remarks>
/// Memory is the part of this phase most likely to become a liability rather than an asset:
/// a stale fact believed for ever, an inference hardening into a claim, or a credential
/// surviving in a table nobody thinks of as sensitive. Each of those has a test here.
/// </remarks>
public class ApplicationMemoryTests
{
    private static readonly Guid OrgId = Guid.Parse("11111111-1111-1111-1111-111111111111");

    private sealed class TestTenantContext : ITenantContext
    {
        private int _depth;
        public Guid? OrganizationId { get; private set; }
        public bool IsSystemContext => _depth > 0;
        public void SetOrganization(Guid organizationId) => OrganizationId = organizationId;
        public IDisposable EnterSystemContext(string reason) { _depth++; return new Scope(() => _depth--); }
        private sealed class Scope(Action onDispose) : IDisposable { public void Dispose() => onDispose(); }
    }

    /// <summary>A clock a test can move, because everything about ageing is about time passing.</summary>
    private sealed class MovableClock : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = new(2026, 9, 24, 12, 0, 0, TimeSpan.Zero);
        public void Advance(TimeSpan by) => UtcNow = UtcNow.Add(by);
    }

    private static (ApplicationMemoryService Service, AiraDbContext Db, MovableClock Clock, Guid AppId)
        Create()
    {
        var tenant = new TestTenantContext();
        var clock = new MovableClock();
        var options = new DbContextOptionsBuilder<AiraDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(
                Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new AiraDbContext(options, tenant, clock);

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

        return (new ApplicationMemoryService(db, clock, new SecretMasker()), db, clock, application.Id);
    }

    private static RememberRequest Fact(
        string subject = "/payments",
        string fact = "The payments page needs a session and posts to /api/transfers.",
        ApplicationMemoryProvenance provenance = ApplicationMemoryProvenance.Observed,
        int confidence = 70)
        => new(ApplicationMemoryKind.ApplicationFact, subject, fact, provenance, confidence);

    // -----------------------------------------------------------------------

    [Fact]
    public async Task A_fact_is_remembered_with_where_it_came_from()
    {
        var (service, db, _, appId) = Create();

        await service.RememberAsync(appId, Fact());

        var stored = await db.ApplicationMemories.SingleAsync();
        stored.Subject.Should().Be("/payments");
        stored.Provenance.Should().Be(ApplicationMemoryProvenance.Observed);
        stored.TimesSeen.Should().Be(1);
    }

    [Fact]
    public async Task Seeing_a_fact_again_strengthens_the_row_rather_than_adding_another()
    {
        var (service, db, clock, appId) = Create();

        await service.RememberAsync(appId, Fact());
        clock.Advance(TimeSpan.FromDays(1));
        await service.RememberAsync(appId, Fact());

        var stored = await db.ApplicationMemories.SingleAsync();
        stored.TimesSeen.Should().Be(2);
        stored.LastSeenAt.Should().Be(clock.UtcNow);
        stored.FirstSeenAt.Should().BeBefore(stored.LastSeenAt);
    }

    [Fact]
    public async Task Confidence_never_reaches_certainty_however_often_a_fact_is_seen()
    {
        var (service, db, _, appId) = Create();

        for (var i = 0; i < 100; i++) await service.RememberAsync(appId, Fact(confidence: 95));

        // A platform that is certain about an application it last looked at weeks ago has
        // stopped checking. The cap is the cheapest way to keep that from being expressible.
        (await db.ApplicationMemories.SingleAsync())
            .Confidence.Should().BeLessOrEqualTo(ApplicationMemoryService.MaxConfidence);
        ApplicationMemoryService.MaxConfidence.Should().BeLessThan(100);
    }

    [Fact]
    public async Task Provenance_improves_when_a_guess_turns_out_to_be_observable()
    {
        var (service, db, _, appId) = Create();

        await service.RememberAsync(appId, Fact(provenance: ApplicationMemoryProvenance.Inferred));
        await service.RememberAsync(appId, Fact(provenance: ApplicationMemoryProvenance.Observed));

        (await db.ApplicationMemories.SingleAsync())
            .Provenance.Should().Be(ApplicationMemoryProvenance.Observed);
    }

    [Fact]
    public async Task Provenance_never_degrades_back_to_a_guess()
    {
        var (service, db, _, appId) = Create();

        await service.RememberAsync(appId, Fact(provenance: ApplicationMemoryProvenance.Observed));
        await service.RememberAsync(appId, Fact(provenance: ApplicationMemoryProvenance.Inferred));

        // A later pass that only managed to infer something does not unsee the pass that
        // watched it happen. The earlier sighting did not stop having occurred.
        (await db.ApplicationMemories.SingleAsync())
            .Provenance.Should().Be(ApplicationMemoryProvenance.Observed);
    }

    [Fact]
    public async Task A_credential_in_a_remembered_fact_is_masked_before_it_is_stored()
    {
        var (service, db, _, appId) = Create();

        await service.RememberAsync(appId, Fact(
            fact: "Signing in posts authorization: Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb"));

        // Memory is a table nobody thinks of as sensitive, which is exactly why a secret that
        // reaches it would sit there unnoticed across every future pass.
        var stored = await db.ApplicationMemories.SingleAsync();
        stored.Fact.Should().NotContain("eyJhbGciOiJIUzI1NiJ9");
        stored.Fact.Should().Contain("REDACTED");
    }

    [Fact]
    public async Task A_fact_nothing_has_confirmed_lately_is_reported_stale_rather_than_hidden()
    {
        var (service, _, clock, appId) = Create();
        await service.RememberAsync(appId, Fact());

        clock.Advance(TimeSpan.FromDays(ApplicationMemoryService.StaleAfterDays + 1));

        var fresh = await service.RecallAsync(appId);
        var everything = await service.RecallAsync(appId, includeStale: true);

        // Ordinary recall leaves it out, so a plan is not built on something last seen weeks
        // ago. Asking for everything still shows it, flagged — "we used to believe this and
        // have not seen it lately" is information, and silence is not.
        fresh.Should().BeEmpty();
        everything.Should().ContainSingle().Which.IsStale.Should().BeTrue();
    }

    [Fact]
    public async Task Forgetting_is_a_separate_act_and_takes_much_longer_than_going_stale()
    {
        var (service, db, clock, appId) = Create();
        await service.RememberAsync(appId, Fact());

        clock.Advance(TimeSpan.FromDays(ApplicationMemoryService.StaleAfterDays + 1));
        (await service.ForgetStaleAsync(appId)).Should().Be(0,
            "something stale is not yet something wrong");

        clock.Advance(TimeSpan.FromDays(ApplicationMemoryService.StaleAfterDays * 2));
        (await service.ForgetStaleAsync(appId)).Should().Be(1);
        (await db.ApplicationMemories.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Recall_can_be_narrowed_to_one_kind_of_fact()
    {
        var (service, _, _, appId) = Create();

        await service.RememberAsync(appId, Fact());
        await service.RememberAsync(appId, new RememberRequest(
            ApplicationMemoryKind.UnstableTest, "TC-0042",
            "Failed 5 of the last 20 runs with no code change.",
            ApplicationMemoryProvenance.Observed, 80));

        var unstable = await service.RecallAsync(appId, ApplicationMemoryKind.UnstableTest);

        unstable.Should().ContainSingle().Which.Subject.Should().Be("TC-0042");
    }

    [Fact]
    public async Task A_fact_with_no_subject_or_no_content_is_refused()
    {
        var (service, _, _, appId) = Create();

        var noSubject = async () => await service.RememberAsync(appId, Fact(subject: "  "));
        var noFact = async () => await service.RememberAsync(appId, Fact(fact: ""));

        await noSubject.Should().ThrowAsync<ArgumentException>();
        await noFact.Should().ThrowAsync<ArgumentException>();
    }

    [Fact]
    public async Task Recall_puts_the_best_established_facts_first()
    {
        var (service, _, _, appId) = Create();

        await service.RememberAsync(appId, Fact(subject: "/about", confidence: 20));
        await service.RememberAsync(appId, Fact(subject: "/payments", confidence: 90));

        (await service.RecallAsync(appId)).First().Subject.Should().Be("/payments");
    }
}
