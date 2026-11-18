using FluentAssertions;
using QaNxt.Domain.Applications;
using QaNxt.Domain.Enums;
using Xunit;

namespace QaNxt.UnitTests.Discovery;

/// <summary>
/// A crawl that is still inside its own budget is not stranded.
///
/// The sweep that ends abandoned discovery runs keyed on a fixed fifteen minutes regardless
/// of what the run was allowed to take. An application configured with a 900-second
/// exploration budget — fifteen minutes exactly, and the budget is settable up to two hours
/// — therefore had its crawls marked Failed at the moment they were legitimately finishing.
///
/// Observed on a 137-screen application: the crawl mapped 152 pages, uploaded its artifacts,
/// and the completion callback landed on a run the sweep had already declared stranded. The
/// pipeline read "status failed", read an empty model, and stopped. The run's error message
/// told whoever read it to go and look at a worker that had done nothing wrong.
///
/// Three earlier runs with the same budget survived only because their completion beat the
/// next one-minute sweep. A verdict that depends on winning a race with the thing it judges
/// is not a verdict.
/// </summary>
public class StrandedRunGraceTests
{
    private static readonly DateTimeOffset Start = new(2026, 3, 2, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Grace = TimeSpan.FromMinutes(15);

    private static DiscoveryRun Running(int timeoutSeconds) => new()
    {
        Status = DiscoveryStatus.Running, StartedAt = Start,
        TimeoutSeconds = timeoutSeconds, MaxDepth = 6, MaxPages = 160
    };

    [Fact]
    public void A_crawl_using_its_whole_fifteen_minute_budget_is_not_stranded()
    {
        var run = Running(900);

        // The moment the budget runs out, and a little past it while the worker finishes
        // uploading artifacts and posts its completion.
        run.IsStranded(Start.AddSeconds(900), Grace).Should().BeFalse();
        run.IsStranded(Start.AddSeconds(950), Grace).Should().BeFalse(
            "this is the case that was reaped: the crawl had mapped 152 pages and was "
            + "uploading when the sweep declared it abandoned");
    }

    [Fact]
    public void A_crawl_that_is_really_gone_is_still_reaped()
    {
        var run = Running(900);

        run.IsStranded(Start.AddSeconds(900 + 901), Grace).Should().BeTrue(
            "past its own budget AND the grace on top, nobody is coming back, and leaving "
            + "it Running for ever is what the sweep exists to prevent");
    }

    [Fact]
    public void A_two_hour_budget_is_honoured_rather_than_cut_at_the_grace_period()
    {
        var run = Running(7200);

        run.IsStranded(Start.AddMinutes(30), Grace).Should().BeFalse();
        run.IsStranded(Start.AddMinutes(119), Grace).Should().BeFalse();
        run.IsStranded(Start.AddMinutes(120 + 16), Grace).Should().BeTrue();
    }

    [Fact]
    public void The_default_budget_still_behaves_as_it_always_did()
    {
        // 600 seconds is the default, and it sits inside the grace period, which is why a
        // fixed cutoff looked correct for as long as nobody changed the budget.
        var run = Running(600);

        run.IsStranded(Start.AddMinutes(14), Grace).Should().BeFalse();
        run.IsStranded(Start.AddMinutes(26), Grace).Should().BeTrue();
    }

    [Fact]
    public void A_queued_run_is_measured_from_when_it_was_created()
    {
        // A run queued while no worker exists never gets a StartedAt, so measuring from
        // StartedAt alone would leave it queued for ever.
        var run = new DiscoveryRun
        {
            Status = DiscoveryStatus.Queued, StartedAt = null, CreatedAt = Start,
            TimeoutSeconds = 900, MaxDepth = 6, MaxPages = 160
        };

        run.IsStranded(Start.AddSeconds(950), Grace).Should().BeFalse();
        run.IsStranded(Start.AddSeconds(900 + 901), Grace).Should().BeTrue();
    }

    [Theory]
    [InlineData(DiscoveryStatus.Completed)]
    [InlineData(DiscoveryStatus.PartiallyCompleted)]
    [InlineData(DiscoveryStatus.Failed)]
    [InlineData(DiscoveryStatus.Cancelled)]
    public void A_run_that_already_finished_is_never_stranded(DiscoveryStatus status)
    {
        var run = Running(900);
        run.Status = status;

        run.IsStranded(Start.AddDays(7), Grace).Should().BeFalse(
            "a finished run is not reopened, however long ago it ran");
    }

    [Fact]
    public void A_nonsense_budget_does_not_make_a_run_immortal()
    {
        // Clamped at the API, but an entity read straight from an older row should not be
        // able to escape the sweep for ever by carrying a negative timeout.
        var run = Running(-1);

        run.IsStranded(Start.AddMinutes(16), Grace).Should().BeTrue();
    }
}
