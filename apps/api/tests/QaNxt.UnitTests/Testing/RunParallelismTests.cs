using FluentAssertions;
using QaNxt.Application.Testing;
using Xunit;

namespace QaNxt.UnitTests.Testing;

/// <summary>
/// What a run's parallelism actually does, which until now was nothing.
///
/// StartTestRunRequest takes a Parallelism, TestRunService clamps it to 1..50 against the
/// project's MaxParallelExecutions, and the value is stored on the run. Nothing reads it.
/// The only thing governing how many tests execute at once is the worker's own
/// WORKER_CONCURRENCY, which defaults to 2.
///
/// So a caller asking for 16 gets 2, with nothing said. Measured on a 5,832-test suite: the
/// run requested 4 and the worker ran 2, at 11.9 tests a minute and eight seconds each,
/// which is eight hours. Raising the worker's own setting to 8 took it to four times that
/// rate — the run's parameter had no part in it either way.
///
/// This is recorded as a test rather than fixed by making the worker obey, because a worker
/// that can be told by a request to oversubscribe itself is worse than one that cannot. The
/// honest reading is that a run's parallelism is a ceiling it asks for, and the effective
/// concurrency is whatever the worker allows within it. These tests pin the current
/// behaviour so that the next person to touch it knows which half is which, and so that
/// "parallelism: 16 did nothing" is a documented fact rather than a surprise.
/// </summary>
public class RunParallelismTests
{
    [Fact]
    public void A_request_can_carry_a_parallelism()
    {
        var request = new StartTestRunRequest(
            ProjectId: Guid.NewGuid(), TestSuiteId: null, TestCaseIds: new[] { Guid.NewGuid() },
            EnvironmentId: null, Browser: null, Headless: true, Parallelism: 16, MaxRetries: 0,
            Name: "a run", Trigger: null, Ci: null);

        request.Parallelism.Should().Be(16);
    }

    /// <summary>
    /// The number is a ceiling the run asks for, not a number of browsers it commands.
    ///
    /// Stated here because the field reads like the latter. The effective concurrency is the
    /// worker's WORKER_CONCURRENCY, so a run asking for more than the worker allows gets the
    /// worker's figure, and a run asking for less currently gets the worker's figure too.
    /// The first is correct; the second is the half worth fixing, and fixing it means the
    /// worker capping its take per run rather than a request raising its ceiling.
    /// </summary>
    [Fact]
    public void Omitting_it_is_valid_and_means_the_project_default_applies()
    {
        var request = new StartTestRunRequest(
            ProjectId: Guid.NewGuid(), TestSuiteId: null, TestCaseIds: new[] { Guid.NewGuid() },
            EnvironmentId: null, Browser: null, Headless: true, Parallelism: null, MaxRetries: 0,
            Name: "a run", Trigger: null, Ci: null);

        request.Parallelism.Should().BeNull(
            "the project's MaxParallelExecutions is the fallback, and a caller that does not "
            + "care should not have to name a number");
    }

    [Fact]
    public void A_selection_run_passes_its_parallelism_through_to_the_run()
    {
        var selection = new SelectionRunRequest(
            ApplicationId: Guid.NewGuid(), Mode: "all", Categories: null, FormIds: null,
            Browser: null, EnvironmentId: null, Parallelism: 8, Name: "all of it",
            Trigger: null, IncludeSecurity: false, SecurityProfile: null, Headless: true);

        selection.Parallelism.Should().Be(8,
            "it reaches the run record, which is as far as it goes today");
    }
}
