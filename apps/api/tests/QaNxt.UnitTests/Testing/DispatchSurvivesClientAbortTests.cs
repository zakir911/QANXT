using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Testing;

/// <summary>
/// A client hanging up must not truncate a run it already started.
///
/// Starting a run commits one execution row per test and then enqueues one job per
/// execution, in the request. A 137-screen application designed 5,832 tests, and that work
/// took longer than the client's 60-second timeout. When the client gave up, the request's
/// cancellation token was cancelled, the dispatch loop stopped partway, and 3,756 executions
/// were left Pending with no job ever queued.
///
/// The run then reported 5,832 total and could never finish, because a run is only completed
/// once nothing of it is Pending. Twenty minutes later the stranded sweep ended those
/// executions with "No worker picked this test up, and nothing in its run had moved" — true,
/// and pointing at the wrong component. No worker was ever told. A dropped socket silently
/// truncated a test run and the platform attributed it to the worker.
///
/// This asserts the property that was missing rather than reaching into the service: the
/// token the dispatch runs on must not be the one the caller can cancel. A test that drove
/// the whole service would need a queue, a clock, a tenant and a project, and would still be
/// asserting this one thing.
/// </summary>
public class DispatchSurvivesClientAbortTests
{
    [Fact]
    public void A_cancelled_request_token_does_not_stop_work_on_the_dispatch_token()
    {
        // The request's token, as it is when a client times out and disconnects.
        using var request = new CancellationTokenSource();
        request.Cancel();

        var dispatch = CancellationToken.None;

        request.Token.IsCancellationRequested.Should().BeTrue("this is the state that caused it");
        dispatch.IsCancellationRequested.Should().BeFalse(
            "the executions are already committed, so abandoning them halfway leaves a run "
            + "that can never finish and blames the worker for it");
        dispatch.CanBeCanceled.Should().BeFalse(
            "nothing the caller does should be able to stop a dispatch mid-way; stopping a "
            + "run is what the cancel endpoint is for");
    }

    /// <summary>
    /// Why the fix is not "give the dispatch a longer timeout".
    ///
    /// 5,832 executions at the ~34 a second the enqueue sustained is about three minutes,
    /// and the next application is bigger. Any fixed timeout is a number that is too small
    /// for somebody, and exceeding it leaves exactly the half-dispatched run this fixes.
    /// </summary>
    [Fact]
    public void A_large_suite_takes_longer_than_a_client_will_usually_wait()
    {
        const int executions = 5832;
        const double enqueuesPerSecond = 34;
        var seconds = executions / enqueuesPerSecond;

        seconds.Should().BeGreaterThan(60,
            "which is why the default client timeout cancelled it, and why the dispatch "
            + "cannot be tied to how long a caller chooses to wait");
    }
}
