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
/// A run summary must not report fewer pages than the crawl found.
///
/// Two consecutive runs against a 137-screen application both reported "2 pages" while the
/// stored model held 150 and the declared-screen count — 103 of 134 — was right. The crawl
/// was correct every time; the number on the run was not, and the run summary is the first
/// place anyone looks.
///
/// The worker reports progress without waiting for the answer: the callback returns the
/// promise and the crawler drops it. Dozens are in flight at once and arrive in whatever
/// order the network delivers them, so an early update saying two pages can land after a
/// later one saying a hundred and fifty, and after the completion that ended the run.
///
/// Guarded in the control plane rather than by making the worker wait, because ordering a
/// best-effort feed over the network is not something the worker can promise.
/// </summary>
public class DiscoveryProgressOrderingTests
{
    private static readonly Guid OrgId = Guid.Parse("33333333-3333-3333-3333-333333333333");

    [Fact]
    public async Task A_progress_update_that_arrives_late_does_not_lower_the_page_count()
    {
        var (service, db, runId) = Create();

        await service.RecordProgressAsync(runId, Progress(2, "Explored /"));
        await service.RecordProgressAsync(runId, Progress(150, "Explored /admin/audit"));
        // The straggler: issued first, delivered last.
        await service.RecordProgressAsync(runId, Progress(2, "Explored /"));

        var run = await db.DiscoveryRuns.AsNoTracking().FirstAsync(r => r.Id == runId);
        run.PagesDiscovered.Should().Be(150,
            "the crawl had reached 150 pages and a stale update cannot un-reach them");
    }

    [Fact]
    public async Task A_progress_update_after_the_run_finished_is_ignored()
    {
        var (service, db, runId) = Create();

        await service.RecordProgressAsync(runId, Progress(150, "Explored /admin/audit"));

        // The run ends, as the completion callback would end it.
        var finishing = await db.DiscoveryRuns.FirstAsync(r => r.Id == runId);
        finishing.Status = DiscoveryStatus.PartiallyCompleted;
        finishing.CompletedAt = Noon;
        finishing.PagesDiscovered = 150;
        await db.SaveChangesAsync();

        await service.RecordProgressAsync(runId, Progress(2, "Explored /"));

        var run = await db.DiscoveryRuns.AsNoTracking().FirstAsync(r => r.Id == runId);
        run.PagesDiscovered.Should().Be(150);
        run.Status.Should().Be(DiscoveryStatus.PartiallyCompleted,
            "a finished run is not reopened by a late update");
    }

    [Fact]
    public async Task Progress_still_raises_the_count_while_the_run_is_going()
    {
        var (service, db, runId) = Create();

        await service.RecordProgressAsync(runId, Progress(2, "Explored /"));
        await service.RecordProgressAsync(runId, Progress(44, "Explored /shipments"));

        var run = await db.DiscoveryRuns.AsNoTracking().FirstAsync(r => r.Id == runId);
        run.PagesDiscovered.Should().Be(44, "guarding against going backwards must not "
            + "freeze the figure: a live crawl has to be able to report what it has reached");
    }

    [Fact]
    public async Task Every_progress_message_is_still_appended_to_the_log()
    {
        var (service, db, runId) = Create();

        await service.RecordProgressAsync(runId, Progress(150, "Explored /admin/audit"));
        await service.RecordProgressAsync(runId, Progress(2, "Explored /"));

        var run = await db.DiscoveryRuns.AsNoTracking().FirstAsync(r => r.Id == runId);
        run.ProgressLog.Should().Contain("Explored /admin/audit");
        run.ProgressLog.Should().Contain("Explored /",
            "the count is guarded, not the log: what the crawler said it did is evidence "
            + "and dropping a line would hide the out-of-order delivery this fixes");
    }

    // ---- harness ----------------------------------------------------------

    private static readonly DateTimeOffset Noon = new(2026, 3, 2, 12, 0, 0, TimeSpan.Zero);

    private static DiscoveryProgressPayload Progress(int pagesVisited, string message)
        => new(PagesVisited: pagesVisited, PagesQueued: 0, ElementsFound: pagesVisited * 40,
               CurrentUrl: null, Message: message);

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
