using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Scheduling;

/// <summary>
/// How a schedule decides which tests it covers.
/// </summary>
/// <remarks>
/// The matching itself lives in the runner and is exercised end to end by golden test
/// SCH-002. What is pinned here is the rule that makes it correct: a tag is matched whole,
/// never as a substring. A schedule for "api" that also picked up everything tagged
/// "apiv2" would quietly run twice the work every night, and the only symptom would be a
/// nightly that got slower.
/// </remarks>
public class ScheduleSelectionTests
{
    /// <summary>The runner's rule, extracted so it can be stated once and tested.</summary>
    private static bool Matches(string? testCaseTags, string? scheduleTags)
    {
        var wanted = (scheduleTags ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(tag => tag.ToLowerInvariant())
            .ToHashSet();

        if (wanted.Count == 0) return true;

        return (testCaseTags ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(tag => wanted.Contains(tag.ToLowerInvariant()));
    }

    [Theory]
    [InlineData("smoke,critical", "smoke", true)]
    [InlineData("smoke,critical", "critical", true)]
    [InlineData("smoke,critical", "accounts", false)]
    [InlineData("smoke", "smoke,accounts", true)]
    public void A_tag_selection_matches_any_of_the_wanted_tags(string testTags, string scheduleTags, bool expected)
        => Matches(testTags, scheduleTags).Should().Be(expected);

    [Theory]
    [InlineData("apiv2", "api")]
    [InlineData("api", "apiv2")]
    [InlineData("smoketest", "smoke")]
    public void A_tag_is_matched_whole_and_never_as_a_substring(string testTags, string scheduleTags)
    {
        // A LIKE '%api%' would match both of these. The symptom of getting it wrong is a
        // nightly run that is slower than it should be, which nobody investigates.
        Matches(testTags, scheduleTags).Should().BeFalse();
    }

    [Theory]
    [InlineData("SMOKE", "smoke")]
    [InlineData("smoke", "SMOKE")]
    [InlineData(" smoke , critical ", "critical")]
    public void Case_and_surrounding_space_do_not_change_the_answer(string testTags, string scheduleTags)
        => Matches(testTags, scheduleTags).Should().BeTrue();

    [Theory]
    [InlineData("smoke")]
    [InlineData("")]
    [InlineData(null)]
    public void No_tag_restriction_means_every_test(string? testTags)
    {
        // An unrestricted schedule is "run everything in the project", which is what a
        // nightly usually is. An untagged test must not be excluded by accident.
        Matches(testTags, null).Should().BeTrue();
        Matches(testTags, "").Should().BeTrue();
    }

    [Fact]
    public void A_test_with_no_tags_is_left_out_of_a_tag_restricted_schedule()
        => Matches("", "smoke").Should().BeFalse();
}
