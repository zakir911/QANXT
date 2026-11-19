using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using QaNxt.Application.Abstractions;
using QaNxt.Application.Discovery;
using QaNxt.Application.Security;
using QaNxt.Domain.Applications;
using QaNxt.Domain.Enums;
using QaNxt.Infrastructure.Persistence;
using Xunit;

namespace QaNxt.UnitTests.Discovery;

/// <summary>
/// Cancelling a run has to reach the crawl that is already running.
///
/// It did not. The run row was marked cancelled and the crawl carried on opening pages and
/// pressing controls until it ran out of budget. Measured on this project's own test lab: a
/// run cancelled at 01:46 was still mapping pages at 02:00, fourteen minutes later, and the
/// only thing that eventually stopped it was its own clock. On a real application that means
/// the tool keeps touching somebody's system after being told to stop, which is the one
/// thing this product promises it will not do.
///
/// The progress feed is the only channel that exists between a crawl in flight and the
/// control plane, so the answer to it is where the instruction belongs.
/// </summary>
public class CancelReachesTheCrawlTests
{
    private static readonly Guid OrgId = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly DateTimeOffset Noon = new(2026, 3, 2, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task A_cancelled_run_tells_the_crawl_to_stop()
    {
        var (service, db, runId) = Create();

        var carryOn = await service.RecordProgressAsync(runId, Progress(10));
        carryOn.Value!.ShouldStop.Should().BeFalse("the run is still in flight");

        await Cancel(db, runId);

        var stop = await service.RecordProgressAsync(runId, Progress(11));
        stop.Value!.ShouldStop.Should().BeTrue();
        stop.Value!.Reason.Should().Contain("Cancelled",
            "the crawl records why it stopped, so the run does not just trail off");
    }

    [Theory]
    [InlineData(DiscoveryStatus.Completed)]
    [InlineData(DiscoveryStatus.PartiallyCompleted)]
    [InlineData(DiscoveryStatus.Failed)]
    [InlineData(DiscoveryStatus.Cancelled)]
    public async Task Any_run_that_is_no_longer_in_flight_tells_the_crawl_to_stop(DiscoveryStatus finished)
    {
        // Not only cancellation. A crawl whose run something else already finished — the
        // stranded-run sweep, a second worker's completion — is just as much a crawl that
        // should not still be exploring an application.
        var (service, db, runId) = Create();

        var run = await db.DiscoveryRuns.FirstAsync(r => r.Id == runId);
        run.Status = finished;
        run.CompletedAt = Noon;
        await db.SaveChangesAsync();

        var answer = await service.RecordProgressAsync(runId, Progress(12));

        answer.Value!.ShouldStop.Should().BeTrue();
    }

    [Fact]
    public async Task A_live_run_is_never_told_to_stop()
    {
        // The cost of getting this wrong is a crawl that abandons itself part way through
        // and reports a partial model as if that were the application.
        var (service, _, runId) = Create();

        foreach (var pages in new[] { 1, 5, 50, 500 })
        {
            var answer = await service.RecordProgressAsync(runId, Progress(pages));
            answer.Value!.ShouldStop.Should().BeFalse($"the run is still running at {pages} pages");
        }
    }

    [Fact]
    public async Task Progress_for_a_run_the_control_plane_never_heard_of_is_a_failure()
    {
        var (service, _, _) = Create();

        var answer = await service.RecordProgressAsync(Guid.NewGuid(), Progress(1));

        answer.IsSuccess.Should().BeFalse(
            "a crawl reporting against a run that does not exist is not something to wave through");
    }

    // ---- harness ----------------------------------------------------------

    private static async Task Cancel(QaNxtDbContext db, Guid runId)
    {
        var run = await db.DiscoveryRuns.FirstAsync(r => r.Id == runId);
        run.Status = DiscoveryStatus.Cancelled;
        run.CompletedAt = Noon;
        await db.SaveChangesAsync();
    }

    private static DiscoveryProgressPayload Progress(int pagesVisited)
        => new(PagesVisited: pagesVisited, PagesQueued: 0, ElementsFound: pagesVisited * 40,
               CurrentUrl: null, Message: $"Explored page {pagesVisited}");

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
            OrganizationId = OrgId, Name = "Meridian Freight", Key = "FRGT"
        };
        var application = new QaNxt.Domain.Applications.Application
        {
            OrganizationId = OrgId, Name = "Meridian Freight",
            BaseUrl = "http://127.0.0.1:4400", AllowedDomains = "127.0.0.1"
        };
        var run = new DiscoveryRun
        {
            OrganizationId = OrgId, Status = DiscoveryStatus.Running,
            MaxDepth = 6, MaxPages = 160, TimeoutSeconds = 900, StartedAt = Noon
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
