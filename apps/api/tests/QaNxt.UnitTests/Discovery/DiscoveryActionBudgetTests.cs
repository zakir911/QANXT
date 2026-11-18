using FluentAssertions;
using QaNxt.Application.Discovery;
using QaNxt.Domain.Applications;
using QaNxt.Domain.Enums;
using Xunit;

namespace QaNxt.UnitTests.Discovery;

/// <summary>
/// A run has to be able to explain why it stopped.
///
/// DiscoveryService freezes the crawl budget onto the run, and says why in its own comment:
/// so a later configuration change cannot make a historical run unexplainable. It froze
/// three of the four dimensions. The fourth, the action budget, was read live from the
/// application at dispatch time and recorded nowhere.
///
/// It is also the one that binds in navigation mode. A crawl of a 137-screen application
/// stopped at 69 of 152 pages on "the 400-action budget was reached", with 88 of its 900
/// seconds unspent, and nothing on the run said what that budget had been. The run reported
/// a partial crawl and could not account for it.
///
/// These assert the shape of the record rather than driving the service, because what was
/// wrong was the record: the entity now carries the number, and the detail returns it.
/// </summary>
public class DiscoveryActionBudgetTests
{
    [Fact]
    public void A_run_records_the_action_budget_alongside_the_other_three()
    {
        var run = new DiscoveryRun
        {
            Status = DiscoveryStatus.Completed,
            MaxDepth = 6, MaxPages = 160, TimeoutSeconds = 900, MaxActions = 400
        };

        run.MaxActions.Should().Be(400,
            "the budget that stops a crawl has to be on the crawl's own record, or the run "
            + "cannot explain its own outcome");
    }

    /// <summary>
    /// The detail that a reader sees carries all four, so "why did this stop at 69 pages?"
    /// is answerable from one response.
    /// </summary>
    [Fact]
    public void The_run_detail_carries_every_budget_dimension()
    {
        var summary = new DiscoveryRunSummary(
            Guid.NewGuid(), Guid.NewGuid(), "Meridian Freight", DiscoveryStatus.PartiallyCompleted,
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch,
            PagesDiscovered: 69, ElementsDiscovered: 3000, ApiEndpointsDiscovered: 1,
            ConsoleErrorCount: 0, PagesBlockedByPolicy: 0, ErrorMessage: null, WorkerId: "w1");

        var detail = new DiscoveryRunDetail(summary, ProgressLog: "Stopped: the 400-action budget was reached.",
            MaxDepth: 6, MaxPages: 160, TimeoutSeconds: 900, MaxActions: 400);

        detail.MaxActions.Should().Be(400);
        // The point of the whole change: the log says what stopped it and the record says
        // what the limit was, so the two can be read together.
        detail.ProgressLog.Should().Contain(detail.MaxActions.ToString());
    }

    [Fact]
    public void A_start_request_can_set_the_action_budget_like_the_others()
    {
        var request = new StartDiscoveryRequest(Guid.NewGuid(), BrowserType.Chromium,
            MaxDepth: 6, MaxPages: 160, TimeoutSeconds: 900, MaxActions: 4000);

        request.MaxActions.Should().Be(4000,
            "a 137-screen application in navigation mode needs more than the 400 a small "
            + "site does, and a caller that knows this had no way to say so");
    }

    [Fact]
    public void Omitting_it_stays_valid_so_every_existing_caller_is_unaffected()
    {
        var request = new StartDiscoveryRequest(Guid.NewGuid(), BrowserType.Chromium,
            MaxDepth: null, MaxPages: null, TimeoutSeconds: null);

        request.MaxActions.Should().BeNull(
            "the application's own setting applies when the caller does not say, which is "
            + "what every caller did before this parameter existed");
    }
}
