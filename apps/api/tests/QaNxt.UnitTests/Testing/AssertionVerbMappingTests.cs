using FluentAssertions;
using QaNxt.Application.Contracts;
using QaNxt.Domain.Enums;
using Xunit;

namespace QaNxt.UnitTests.Testing;

/// <summary>
/// Every assertion verb has to map to an assertion the worker can evaluate as written.
///
/// The generator synthesises an assertion record for a step whose action is an assertion
/// verb, so a report can count what a test asserted. The mapping ended in
///
///     _ => AssertionType.Visible
///
/// and Visible needs a target locator. A form oracle carries none — its verb is the check —
/// so every such step failed at execution with "This action requires a target locator but
/// none was supplied." on an application that was behaving perfectly. 63 of the first 65
/// failures in a 532-case run, once one scenario started using assertNoServerError.
///
/// All thirteen oracles reached that arm. The ones nothing generated yet were waiting to do
/// the same thing the moment they were used, which is why this is tested across the whole
/// enum rather than for the one verb that exposed it.
///
/// The mapping is reached through the public conversion rather than called directly, because
/// a test that calls a private mapper proves the mapper right and not the generator.
/// </summary>
public class AssertionVerbMappingTests
{
    /// <summary>Assertions that read an element, and therefore cannot stand without a
    /// locator. A verb that carries no target must never map to one of these.</summary>
    private static readonly HashSet<AssertionType> NeedsALocator = new()
    {
        AssertionType.Visible, AssertionType.Hidden, AssertionType.TextEquals,
        AssertionType.TextContains, AssertionType.ValueEquals, AssertionType.CountEquals,
        AssertionType.AttributeEquals, AssertionType.Enabled, AssertionType.Disabled
    };

    /// <summary>The form oracles: self-asserting verbs that take no target of their own.
    /// Read from the enum rather than listed, so a new one is covered the day it is added.</summary>
    public static TheoryData<BrowserActionType> SelfAssertingVerbs()
    {
        var data = new TheoryData<BrowserActionType>();
        foreach (var action in Enum.GetValues<BrowserActionType>())
        {
            if (!BrowserActionVerbs.IsAssertion(action)) continue;
            // The classic assert verbs do take a target and an expected value; they are
            // mapped explicitly and are not what this guards.
            if ((int)action < 50) continue;
            data.Add(action);
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(SelfAssertingVerbs))]
    public void A_self_asserting_verb_does_not_map_to_an_assertion_that_needs_a_locator(
        BrowserActionType action)
    {
        var mapped = Map(action);

        NeedsALocator.Should().NotContain(mapped,
            $"{action} is a form oracle: its own verb is the check and it carries no target, "
            + $"so mapping it to {mapped} makes every step using it fail at execution for "
            + "want of a locator, on an application that is behaving correctly");

        mapped.Should().Be(AssertionType.StepVerdict,
            $"{action} fails its own step when it finds a problem, and StepVerdict is the "
            + "record that says so");
    }

    [Fact]
    public void The_classic_assert_verbs_still_map_to_their_own_assertion_types()
    {
        // Guarding the default must not flatten the verbs that genuinely carry an expected
        // value: an assertUrl recorded as StepVerdict would stop reporting what it checked.
        Map(BrowserActionType.AssertUrl).Should().Be(AssertionType.UrlContains);
        Map(BrowserActionType.AssertText).Should().Be(AssertionType.TextContains);
        Map(BrowserActionType.AssertVisible).Should().Be(AssertionType.Visible);
        Map(BrowserActionType.AssertHidden).Should().Be(AssertionType.Hidden);
        Map(BrowserActionType.AssertValue).Should().Be(AssertionType.ValueEquals);
        Map(BrowserActionType.AssertCount).Should().Be(AssertionType.CountEquals);
        Map(BrowserActionType.AssertAttribute).Should().Be(AssertionType.AttributeEquals);
        Map(BrowserActionType.AssertEnabled).Should().Be(AssertionType.Enabled);
        Map(BrowserActionType.AssertDisabled).Should().Be(AssertionType.Disabled);
    }

    /// <summary>
    /// The two mappings in the codebase have to agree.
    ///
    /// FormTestingService had this right and TestGenerationService did not, which is how a
    /// wrong default survived: the behaviour was correct wherever anybody looked.
    /// </summary>
    [Theory]
    [MemberData(nameof(SelfAssertingVerbs))]
    public void Both_services_agree_about_a_self_asserting_verb(BrowserActionType action)
    {
        Map(action).Should().Be(MapInFormTesting(action),
            "two mappings for the same question that disagree means one of them is wrong "
            + "and the bug lives wherever the wrong one is used");
    }

    /// <summary>FormTestingService calls its mapper AssertionFor and returns null for a
    /// non-assertion verb, where the generator's returns a value for every action. Named
    /// here rather than renamed in either service: the point is that the two answers agree,
    /// not that they share a signature.</summary>
    private static AssertionType? MapInFormTesting(BrowserActionType action)
        => (AssertionType?)Invoke("QaNxt.Application.Forms.FormTestingService", "AssertionFor", action);

    private static AssertionType Map(BrowserActionType action)
        => (AssertionType)Invoke("QaNxt.Application.Testing.TestGenerationService",
            "MapAssertionType", action)!;

    private static object? Invoke(string typeName, string methodName, BrowserActionType action)
    {
        var type = typeof(BrowserActionVerbs).Assembly.GetType(typeName)
            ?? throw new InvalidOperationException($"{typeName} was not found.");
        var method = type.GetMethod(methodName,
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)
            ?? throw new InvalidOperationException($"{typeName}.{methodName} was not found.");
        return method.Invoke(null, new object[] { action });
    }
}
