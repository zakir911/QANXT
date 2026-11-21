using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Discovery;
using QaNxt.Application.Security;
using QaNxt.Domain.Common;
using QaNxt.Domain.Applications;
using QaNxt.Domain.Enums;
using QaNxt.Infrastructure.Persistence;
using Xunit;

namespace QaNxt.UnitTests.Discovery;

/// <summary>
/// What becomes of a link the crawl refused to follow.
///
/// A crawl of a permit register approved all three permits in it by following
/// `&lt;a href="/approve.asp?id=1"&gt;Approve&lt;/a&gt;`. Refusing to follow such links was the fix,
/// and refusing silently would have been half of one: a GET that approves a permit is a
/// cross-site request forgery waiting for somebody to send the URL, and it is one of the
/// commonest real findings on an application built before anti-forgery tokens were normal.
///
/// It is recorded as a gap and not a finding, which is the distinction these tests are
/// about. Discovery saw the link; it did not see what the link does, because establishing
/// that means following it. Claiming the defect would be asserting what was not observed.
/// </summary>
public class StateChangingLinkGapTests
{
    private static readonly Guid OrgId = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly DateTimeOffset Noon = new(2026, 11, 21, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task A_refused_link_becomes_a_gap_that_says_what_was_seen_and_what_was_not()
    {
        var (service, db, runId) = Create();

        await service.CompleteAsync(runId, Completion(
            Link("http://127.0.0.1:4700/approve.asp?id=1", "Approve", "http://127.0.0.1:4700/list.asp")));

        var gap = db.CoverageGaps.Should().ContainSingle().Subject;
        gap.Category.Should().Be(TestCategory.Security);
        gap.Status.Should().Be(CoverageGapStatus.HumanRequired);
        gap.ApplicationFormId.Should().BeNull("this is about a link, not a form");
        gap.Missing.Should().Contain("/approve.asp?id=1");
        gap.Reason.Should().Contain("Approve").And.Contain("/list.asp");
        gap.Reason.Should().Contain("did not follow");
        gap.RecommendedAction.Should().Contain("anti-forgery");
    }

    /// <summary>
    /// A register of a thousand rows offers a thousand approve links. The crawler already
    /// reports one per route shape; this checks the ingest does not multiply them back out
    /// across runs either.
    /// </summary>
    [Fact]
    public async Task The_same_link_is_not_recorded_twice_when_discovery_runs_again()
    {
        var (service, db, runId) = Create();
        var completion = Completion(
            Link("http://127.0.0.1:4700/approve.asp?id=1", "Approve", "http://127.0.0.1:4700/list.asp"));

        await service.CompleteAsync(runId, completion);
        await service.CompleteAsync(runId, completion);

        db.CoverageGaps.Count().Should().Be(1);
    }

    [Fact]
    public async Task Two_different_links_are_two_gaps()
    {
        var (service, db, runId) = Create();

        await service.CompleteAsync(runId, Completion(
            Link("http://127.0.0.1:4700/approve.asp?id=1", "Approve", "http://127.0.0.1:4700/list.asp"),
            Link("http://127.0.0.1:4700/revoke.asp?id=3", "Revoke", "http://127.0.0.1:4700/list.asp")));

        db.CoverageGaps.Count().Should().Be(2);
    }

    [Fact]
    public async Task An_unnamed_link_is_still_recorded_and_reads_sensibly()
    {
        var (service, db, runId) = Create();

        await service.CompleteAsync(runId, Completion(
            Link("http://127.0.0.1:4700/delete.asp?id=9", null, "http://127.0.0.1:4700/list.asp")));

        var gap = db.CoverageGaps.Should().ContainSingle().Subject;
        gap.Reason.Should().StartWith("An unnamed link at /delete.asp?id=9");
    }

    [Fact]
    public async Task A_crawl_that_refused_nothing_records_no_gap()
    {
        var (service, db, runId) = Create();

        await service.CompleteAsync(runId, Completion());

        db.CoverageGaps.Should().BeEmpty();
    }

    // ---- harness ----------------------------------------------------------------

    private static StateChangingLinkPayload Link(string url, string? name, string foundOn)
        => new() { Url = url, AccessibleName = name, FoundOnUrl = foundOn };

    private static DiscoveryCompletionPayload Completion(params StateChangingLinkPayload[] links)
        => new()
        {
            Status = "completed", StartedAt = Noon, CompletedAt = Noon.AddMinutes(4),
            WorkerId = "worker-test", StateChangingLinks = links.ToList()
        };

    private static (DiscoveryIngestService Service, QaNxtDbContext Db, Guid RunId) Create()
    {
        var tenant = new TestTenantContext();
        var options = new DbContextOptionsBuilder<QaNxtDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(
                Microsoft.EntityFrameworkCore.Diagnostics.InMemoryEventId.TransactionIgnoredWarning))
            .Options;
        var db = new QaNxtDbContext(options, tenant, new FixedClock());

        var project = new QaNxt.Domain.Projects.Project
        {
            OrganizationId = OrgId, Name = "Ashfield Building Control", Key = "ASHF"
        };
        var application = new QaNxt.Domain.Applications.Application
        {
            OrganizationId = OrgId, Name = "Ashfield Building Control",
            BaseUrl = "http://127.0.0.1:4700/default.asp", AllowedDomains = "127.0.0.1"
        };
        var run = new DiscoveryRun
        {
            OrganizationId = OrgId, Status = DiscoveryStatus.Running,
            MaxDepth = 6, MaxPages = 40, TimeoutSeconds = 240, StartedAt = Noon
        };

        using (tenant.EnterSystemContext("seed"))
        {
            db.Projects.Add(project);
            db.SaveChanges();
            application.ProjectId = project.Id;
            db.Applications.Add(application);
            db.SaveChanges();
            run.ProjectId = project.Id;
            run.ApplicationId = application.Id;
            db.DiscoveryRuns.Add(run);
            db.SaveChanges();
        }
        tenant.SetOrganization(OrgId);

        var service = new DiscoveryIngestService(db, new FixedClock(), tenant,
            new SecretMasker(), new SilentEvents(),
            NullLogger<DiscoveryIngestService>.Instance);
        return (service, db, run.Id);
    }

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

    private sealed class SilentEvents : IExecutionEventPublisher
    {
        public Task PublishAsync(Guid organizationId, ExecutionEvent e, CancellationToken ct = default)
            => Task.CompletedTask;
    }
}
