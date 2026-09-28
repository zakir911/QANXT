using QaNxt.Application.Agent;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Agent;

/// <summary>
/// What the application can do, against what is tested.
/// </summary>
/// <remarks>
/// The report these produce decides what the agent writes tests for, so every way it could
/// mislead is a way the agent wastes its budget or misses the thing that mattered. Two of
/// those ways are pinned hardest: a dimension that does not apply being reported as a gap, and
/// a test that has never run being reported as coverage.
/// </remarks>
public class TestGapModelTests
{
    private static Capability Page(string id, bool auth = true, bool input = true,
        bool state = false, bool critical = false)
        => new(id, "page", auth, state, input, critical);

    private static Capability Endpoint(string id, bool state = true)
        => new(id, "endpoint", true, state, true);

    private static CoverageSignal Signal(
        string id, TestDimension dimension, int defined, int executed, bool assessable = true)
        => new(id, dimension, defined, executed, assessable);

    // ---- Which dimensions apply ---------------------------------------------

    [Fact]
    public void An_endpoint_has_no_accessibility_or_visual_dimension()
    {
        var endpoint = Endpoint("POST /api/transfers");

        TestGapModel.Applies(endpoint, TestDimension.Accessibility).Should().BeFalse();
        TestGapModel.Applies(endpoint, TestDimension.Visual).Should().BeFalse();
        TestGapModel.Applies(endpoint, TestDimension.Api).Should().BeTrue();
        TestGapModel.Applies(endpoint, TestDimension.Ui).Should().BeFalse();
    }

    [Fact]
    public void A_page_has_no_api_dimension_of_its_own()
    {
        TestGapModel.Applies(Page("/dashboard"), TestDimension.Api).Should().BeFalse();
        TestGapModel.Applies(Page("/dashboard"), TestDimension.Ui).Should().BeTrue();
    }

    [Fact]
    public void Security_applies_to_everything()
    {
        // Even a static page carries headers. "Nothing to attack here" is a conclusion a scan
        // reaches, never an assumption a planner makes on the application's behalf.
        TestGapModel.Applies(Page("/about", auth: false, input: false), TestDimension.Security)
            .Should().BeTrue();
        TestGapModel.Applies(Endpoint("GET /api/health"), TestDimension.Security)
            .Should().BeTrue();
    }

    [Fact]
    public void A_dimension_that_does_not_apply_is_absent_rather_than_reported_either_way()
    {
        var report = TestGapModel.Analyse(
            new[] { Endpoint("POST /api/transfers") }, Array.Empty<CoverageSignal>());

        var dimensions = report.Capabilities.Single().Dimensions.Select(d => d.Dimension);

        // Reporting accessibility as an uncovered gap on an endpoint buries the real gaps under
        // work nobody should do; reporting it as covered would be a lie. Absent is the answer.
        dimensions.Should().BeEquivalentTo(new[] { TestDimension.Api, TestDimension.Security });
    }

    // ---- Classification ------------------------------------------------------

    [Fact]
    public void A_capability_with_no_tests_is_not_covered()
    {
        var report = TestGapModel.Analyse(
            new[] { Page("/payments") }, Array.Empty<CoverageSignal>());

        var coverage = report.Capabilities.Single();
        coverage.HasGaps.Should().BeTrue();
        coverage.Gaps.Should().Contain(TestDimension.Ui);
        coverage.Dimensions.Should().OnlyContain(d => d.State == CoverageState.NotCovered);
    }

    [Fact]
    public void Tests_that_exist_and_have_never_run_are_unknown_rather_than_covered()
    {
        var report = TestGapModel.Analyse(
            new[] { Page("/payments") },
            new[] { Signal("/payments", TestDimension.Ui, defined: 4, executed: 0) });

        var ui = report.Capabilities.Single().Dimensions
            .Single(d => d.Dimension == TestDimension.Ui);

        // The case that turns a suite nobody executes into a green square. Four tests that
        // have never run establish nothing about the application, and saying so is the only
        // honest answer available.
        ui.State.Should().Be(CoverageState.Unknown);
        ui.Why.Should().Contain("none has ever run");
        report.Capabilities.Single().Gaps.Should().NotContain(TestDimension.Ui,
            "unknown is not a gap either — inventing work is the other way to be wrong");
    }

    [Fact]
    public void Some_of_the_tests_having_run_is_partial_coverage()
    {
        var report = TestGapModel.Analyse(
            new[] { Page("/payments") },
            new[] { Signal("/payments", TestDimension.Ui, defined: 4, executed: 2) });

        report.Capabilities.Single().Dimensions
            .Single(d => d.Dimension == TestDimension.Ui)
            .State.Should().Be(CoverageState.PartiallyCovered);
    }

    [Fact]
    public void All_the_tests_having_run_is_coverage()
    {
        var report = TestGapModel.Analyse(
            new[] { Page("/payments") },
            new[] { Signal("/payments", TestDimension.Ui, defined: 4, executed: 4) });

        report.Capabilities.Single().Dimensions
            .Single(d => d.Dimension == TestDimension.Ui)
            .State.Should().Be(CoverageState.Covered);
    }

    [Fact]
    public void A_dimension_that_could_not_be_assessed_is_unknown_and_is_not_a_gap()
    {
        var report = TestGapModel.Analyse(
            new[] { Page("/payments") },
            new[] { Signal("/payments", TestDimension.Visual, 0, 0, assessable: false) });

        var visual = report.Capabilities.Single().Dimensions
            .Single(d => d.Dimension == TestDimension.Visual);

        visual.State.Should().Be(CoverageState.Unknown);
        // Unknown is not a tidier NotCovered. As a gap it invents work; as coverage it invents
        // safety. It gets its own answer and its own count.
        visual.Why.Should().Contain("not the same as");
        report.Unknown.Should().BeGreaterThan(0);
    }

    // ---- The summary ---------------------------------------------------------

    [Fact]
    public void The_summary_always_says_the_denominator_is_what_discovery_reached()
    {
        var report = TestGapModel.Analyse(new[] { Page("/payments") }, Array.Empty<CoverageSignal>());

        // The qualifier that keeps a coverage number honest. An application is larger than its
        // crawl, and a percentage with no denominator stated invites the wrong reading.
        report.Summary.Should().Contain("discovery reached");
        report.Summary.Should().Contain("absent from this report rather than covered by it");
    }

    [Fact]
    public void No_discovered_capabilities_is_not_reported_as_full_coverage()
    {
        var report = TestGapModel.Analyse(Array.Empty<Capability>(), Array.Empty<CoverageSignal>());

        // Zero capabilities and zero gaps is arithmetically "nothing uncovered", which is the
        // most dangerous true sentence this model could produce.
        report.Summary.Should().Contain("not a statement that the application is fully covered");
    }

    [Fact]
    public void A_gap_in_something_a_person_called_critical_is_named_in_the_summary()
    {
        var report = TestGapModel.Analyse(
            new[] { Page("/payments", critical: true), Page("/about", critical: false) },
            Array.Empty<CoverageSignal>());

        report.Summary.Should().Contain("business-critical");
    }

    [Fact]
    public void Counts_are_over_applicable_dimensions_rather_than_over_capabilities()
    {
        var report = TestGapModel.Analyse(
            new[] { Page("/payments"), Endpoint("POST /api/transfers") },
            new[]
            {
                Signal("/payments", TestDimension.Ui, 2, 2),
                Signal("POST /api/transfers", TestDimension.Api, 1, 1)
            });

        // A page has four applicable dimensions and an endpoint has two, so the denominator is
        // six rather than two. Counting capabilities instead would make one covered dimension
        // read as a covered capability.
        (report.Covered + report.PartiallyCovered + report.NotCovered + report.Unknown)
            .Should().Be(6);
        report.Covered.Should().Be(2);
        report.NotCovered.Should().Be(4);
    }
}
