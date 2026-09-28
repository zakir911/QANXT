namespace QaNxt.Application.Agent;

/// <summary>The dimensions a capability can be tested along.</summary>
public enum TestDimension { Ui = 0, Api = 1, Security = 2, Accessibility = 3, Visual = 4 }

/// <summary>
/// How well one dimension of one capability is covered.
/// </summary>
/// <remarks>
/// <c>Unknown</c> is not a tidier <c>NotCovered</c>. It means the platform could not establish
/// whether coverage exists — the tests are there but have never run, or the dimension cannot be
/// assessed from what was discovered. Collapsing it into either neighbour is how a coverage
/// report starts lying: as a gap it invents work, as coverage it invents safety.
/// </remarks>
public enum CoverageState { Covered = 0, PartiallyCovered = 1, NotCovered = 2, Unknown = 3 }

/// <summary>Something the application can do, as far as the platform can tell.</summary>
public sealed record Capability(
    string Identifier,
    string Kind,
    bool RequiresAuthentication,
    bool ChangesState,
    bool TakesInput,
    /// <summary>Whether a person called this business-critical.</summary>
    bool BusinessCritical = false);

/// <summary>What exists for a capability along one dimension.</summary>
public sealed record CoverageSignal(
    string CapabilityIdentifier,
    TestDimension Dimension,
    int TestsDefined,
    int TestsEverExecuted,
    /// <summary>Whether the platform was able to assess this at all.</summary>
    bool Assessable = true);

public sealed record DimensionCoverage(
    TestDimension Dimension, CoverageState State, int TestsDefined, int TestsExecuted, string Why);

public sealed record CapabilityCoverage(
    Capability Capability,
    IReadOnlyList<DimensionCoverage> Dimensions,
    /// <summary>Dimensions that apply to this capability and are not covered at all.</summary>
    IReadOnlyList<TestDimension> Gaps)
{
    public bool HasGaps => Gaps.Count > 0;
}

public sealed record TestGapReport(
    IReadOnlyList<CapabilityCoverage> Capabilities,
    int Covered, int PartiallyCovered, int NotCovered, int Unknown,
    string Summary);

/// <summary>
/// What the application can do, against what is tested.
/// </summary>
/// <remarks>
/// <para>
/// A pure function over two lists: the capabilities discovery found, and the coverage signals
/// the platform holds. No database, no clock, no model — so the answer for a given input is
/// the same every time and the interesting cases can be written down as tests rather than
/// reproduced by seeding a stack.
/// </para>
/// <para>
/// The part that earns its place is <see cref="Applies"/>. A gap is only a gap if the dimension
/// means anything for that capability: an API endpoint has no accessibility, a page that takes
/// no input has little to say about injection, and reporting either as an uncovered gap would
/// bury the real ones under work nobody should do. Reporting a dimension as covered when it
/// does not apply would be worse still.
/// </para>
/// </remarks>
public static class TestGapModel
{
    /// <summary>
    /// Whether a dimension is worth assessing for a capability.
    /// </summary>
    /// <remarks>
    /// Stated as rules rather than left implicit, because every one of them is arguable and a
    /// reader should be able to argue with it. Security applies to everything: even a static
    /// page carries headers, and "nothing to attack here" is a conclusion a scan reaches rather
    /// than an assumption a planner makes.
    /// </remarks>
    public static bool Applies(Capability capability, TestDimension dimension)
    {
        var isEndpoint = capability.Kind.Equals("endpoint", StringComparison.OrdinalIgnoreCase);
        return dimension switch
        {
            TestDimension.Ui => !isEndpoint,
            TestDimension.Api => isEndpoint,
            TestDimension.Security => true,
            // A person has to be able to use it before accessibility means anything.
            TestDimension.Accessibility => !isEndpoint,
            // Comparing screenshots of something with no stable appearance is noise.
            TestDimension.Visual => !isEndpoint,
            _ => false
        };
    }

    public static TestGapReport Analyse(
        IReadOnlyList<Capability> capabilities, IReadOnlyList<CoverageSignal> signals)
    {
        var byCapability = signals
            .GroupBy(s => s.CapabilityIdentifier, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.OrdinalIgnoreCase);

        var results = new List<CapabilityCoverage>();

        foreach (var capability in capabilities)
        {
            var dimensions = new List<DimensionCoverage>();
            var gaps = new List<TestDimension>();

            foreach (var dimension in Enum.GetValues<TestDimension>())
            {
                if (!Applies(capability, dimension)) continue;

                var signal = byCapability.TryGetValue(capability.Identifier, out var list)
                    ? list.FirstOrDefault(s => s.Dimension == dimension)
                    : null;

                var (state, why) = Classify(signal);
                dimensions.Add(new DimensionCoverage(
                    dimension, state, signal?.TestsDefined ?? 0, signal?.TestsEverExecuted ?? 0, why));

                if (state == CoverageState.NotCovered) gaps.Add(dimension);
            }

            results.Add(new CapabilityCoverage(capability, dimensions, gaps));
        }

        var all = results.SelectMany(r => r.Dimensions).ToList();
        return new TestGapReport(
            results,
            all.Count(d => d.State == CoverageState.Covered),
            all.Count(d => d.State == CoverageState.PartiallyCovered),
            all.Count(d => d.State == CoverageState.NotCovered),
            all.Count(d => d.State == CoverageState.Unknown),
            Summarise(results, all));
    }

    private static (CoverageState State, string Why) Classify(CoverageSignal? signal)
    {
        if (signal is null)
            return (CoverageState.NotCovered, "No test covers this capability along this dimension.");

        if (!signal.Assessable)
            return (CoverageState.Unknown,
                "Coverage could not be established. This is not the same as there being none, "
                + "and it is not the same as there being some.");

        if (signal.TestsDefined == 0)
            return (CoverageState.NotCovered, "No test covers this capability along this dimension.");

        // Tests that exist and have never run describe an intention rather than a result.
        // Reporting them as coverage is how a suite nobody executes becomes a green square.
        if (signal.TestsEverExecuted == 0)
            return (CoverageState.Unknown,
                $"{signal.TestsDefined} test(s) exist but none has ever run, so what they "
                + "establish about this capability is unknown.");

        if (signal.TestsEverExecuted < signal.TestsDefined)
            return (CoverageState.PartiallyCovered,
                $"{signal.TestsEverExecuted} of {signal.TestsDefined} test(s) have run.");

        return (CoverageState.Covered,
            $"{signal.TestsDefined} test(s) cover this and all of them have run.");
    }

    private static string Summarise(
        IReadOnlyList<CapabilityCoverage> capabilities, IReadOnlyList<DimensionCoverage> all)
    {
        if (capabilities.Count == 0)
            return "No capabilities were discovered, so there is nothing to compare coverage "
                 + "against. This is not a statement that the application is fully covered.";

        var withGaps = capabilities.Where(c => c.HasGaps).ToList();
        var criticalGaps = withGaps.Count(c => c.Capability.BusinessCritical);

        var summary =
            $"{capabilities.Count} capability(ies) assessed across {all.Count} applicable "
            + $"dimension(s): {all.Count(d => d.State == CoverageState.Covered)} covered, "
            + $"{all.Count(d => d.State == CoverageState.PartiallyCovered)} partial, "
            + $"{all.Count(d => d.State == CoverageState.NotCovered)} not covered, "
            + $"{all.Count(d => d.State == CoverageState.Unknown)} unknown.";

        if (criticalGaps > 0)
            summary += $" {criticalGaps} of the capabilities with gaps were called "
                     + "business-critical by a person.";

        // The qualifier belongs on every one of these. The denominator is what discovery
        // walked, and an application is larger than its crawl.
        return summary + " Coverage is measured against what discovery reached; anything it "
             + "did not reach is absent from this report rather than covered by it.";
    }
}
