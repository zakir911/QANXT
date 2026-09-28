using QaNxt.Application.Scheduling;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Scheduling;

/// <summary>
/// A scheduler that fires at the wrong time is worse than no scheduler: the nightly
/// regression everyone relies on silently stops covering the night. These pin the
/// semantics, including the two that surprise people — crontab's day rule and what happens
/// when the clocks change.
/// </summary>
public class CronExpressionTests
{
    private static readonly TimeZoneInfo Utc = TimeZoneInfo.Utc;
    private static readonly TimeZoneInfo London = TimeZoneInfo.FindSystemTimeZoneById("Europe/London");

    private static DateTimeOffset Next(string expression, string from, TimeZoneInfo? zone = null)
    {
        var cron = CronExpression.Parse(expression);
        var next = cron.NextOccurrence(DateTimeOffset.Parse(from), zone ?? Utc);
        next.Should().NotBeNull($"\"{expression}\" should have an occurrence after {from}");
        return next!.Value;
    }

    // -----------------------------------------------------------------------
    // The ordinary cases
    // -----------------------------------------------------------------------

    [Theory]
    [InlineData("0 2 * * *", "2026-03-10T01:00:00Z", "2026-03-10T02:00:00Z")]   // later today
    [InlineData("0 2 * * *", "2026-03-10T03:00:00Z", "2026-03-11T02:00:00Z")]   // tomorrow
    [InlineData("*/15 * * * *", "2026-03-10T10:07:00Z", "2026-03-10T10:15:00Z")]
    [InlineData("30 9 * * 1", "2026-03-10T10:00:00Z", "2026-03-16T09:30:00Z")]  // next Monday
    [InlineData("0 0 1 * *", "2026-03-10T10:00:00Z", "2026-04-01T00:00:00Z")]   // first of the month
    [InlineData("0 0 29 2 *", "2026-03-01T00:00:00Z", "2028-02-29T00:00:00Z")]  // next leap year
    public void Finds_the_next_occurrence(string expression, string from, string expected)
        => Next(expression, from).Should().Be(DateTimeOffset.Parse(expected));

    [Fact]
    public void The_next_occurrence_is_strictly_after_the_time_given()
    {
        // Otherwise recording a fire time and asking for the next one returns the same
        // minute, and the schedule runs twice.
        Next("0 2 * * *", "2026-03-10T02:00:00Z").Should().Be(DateTimeOffset.Parse("2026-03-11T02:00:00Z"));
    }

    [Theory]
    [InlineData("0 2 * * *")]
    [InlineData("*/15 * * * *")]
    [InlineData("0,30 9-17 * * mon-fri")]
    public void Every_expression_is_stable_when_asked_twice(string expression)
    {
        var first = Next(expression, "2026-03-10T01:00:00Z");
        var again = Next(expression, "2026-03-10T01:00:00Z");
        again.Should().Be(first);
    }

    // -----------------------------------------------------------------------
    // Syntax
    // -----------------------------------------------------------------------

    [Theory]
    [InlineData("0,30 * * * *", "2026-03-10T10:05:00Z", "2026-03-10T10:30:00Z")]
    [InlineData("10-40/10 * * * *", "2026-03-10T10:05:00Z", "2026-03-10T10:10:00Z")]
    [InlineData("10-40/10 * * * *", "2026-03-10T10:10:00Z", "2026-03-10T10:20:00Z")]
    [InlineData("0 0 * jan *", "2026-03-10T10:00:00Z", "2027-01-01T00:00:00Z")]
    [InlineData("0 0 * * sun", "2026-03-10T10:00:00Z", "2026-03-15T00:00:00Z")]
    public void Understands_lists_ranges_steps_and_names(string expression, string from, string expected)
        => Next(expression, from).Should().Be(DateTimeOffset.Parse(expected));

    [Fact]
    public void Sunday_is_both_zero_and_seven_as_crontab_says()
    {
        Next("0 0 * * 7", "2026-03-10T10:00:00Z")
            .Should().Be(Next("0 0 * * 0", "2026-03-10T10:00:00Z"));
    }

    [Fact]
    public void A_bare_value_with_a_step_runs_to_the_end_of_the_range()
    {
        // 10/15 in the minute field is 10, 25, 40, 55 — not just 10.
        Next("10/15 * * * *", "2026-03-10T10:12:00Z").Should().Be(DateTimeOffset.Parse("2026-03-10T10:25:00Z"));
    }

    // -----------------------------------------------------------------------
    // Crontab's day rule
    // -----------------------------------------------------------------------

    [Fact]
    public void Restricting_both_day_fields_matches_either_not_both()
    {
        // This is crontab's rule and it surprises people: "0 0 13 * fri" is the 13th of
        // every month AND every Friday, not only Friday the 13th. Pinned so that nobody
        // "fixes" it into an intersection and quietly halves a schedule's coverage.
        var cron = CronExpression.Parse("0 0 13 * fri");
        var next = cron.NextOccurrence(DateTimeOffset.Parse("2026-03-10T10:00:00Z"), Utc);

        // 13 March 2026 is a Friday, so take a start after it to prove the OR: the next
        // occurrence from the 14th is Friday the 20th, not 13 April.
        var afterTheThirteenth = cron.NextOccurrence(DateTimeOffset.Parse("2026-03-14T00:00:00Z"), Utc);

        next.Should().Be(DateTimeOffset.Parse("2026-03-13T00:00:00Z"));
        afterTheThirteenth.Should().Be(DateTimeOffset.Parse("2026-03-20T00:00:00Z"));
    }

    [Fact]
    public void Restricting_only_one_day_field_uses_that_one()
    {
        Next("0 0 15 * *", "2026-03-16T00:00:00Z").Should().Be(DateTimeOffset.Parse("2026-04-15T00:00:00Z"));
        Next("0 0 * * wed", "2026-03-10T00:00:00Z").Should().Be(DateTimeOffset.Parse("2026-03-11T00:00:00Z"));
    }

    // -----------------------------------------------------------------------
    // Time zones
    // -----------------------------------------------------------------------

    [Fact]
    public void A_local_time_stays_local_across_a_daylight_saving_change()
    {
        // 02:30 London is 02:30 GMT in winter and 02:30 BST in summer — a different
        // instant, the same local time. A scheduler that walked instants would drift an
        // hour every spring and the nightly run would land in the working day.
        var winter = Next("30 2 * * *", "2026-01-15T00:00:00Z", London);
        var summer = Next("30 2 * * *", "2026-06-15T00:00:00Z", London);

        TimeZoneInfo.ConvertTime(winter, London).TimeOfDay.Should().Be(new TimeSpan(2, 30, 0));
        TimeZoneInfo.ConvertTime(summer, London).TimeOfDay.Should().Be(new TimeSpan(2, 30, 0));
        winter.Offset.Should().Be(TimeSpan.Zero);
        summer.Offset.Should().Be(TimeSpan.FromHours(1));
    }

    [Fact]
    public void A_time_that_does_not_exist_when_the_clocks_go_forward_is_skipped()
    {
        // London jumps 01:00 → 02:00 on 29 March 2026, so 01:30 never happens that day.
        // The occurrence is the next day, not an invented instant.
        var next = Next("30 1 * * *", "2026-03-28T02:00:00Z", London);
        next.Should().Be(DateTimeOffset.Parse("2026-03-30T01:30:00+01:00"));
    }

    [Fact]
    public void A_time_that_happens_twice_when_the_clocks_go_back_fires_once()
    {
        // London repeats 01:00–02:00 on 25 October 2026. Firing twice would run the same
        // nightly regression twice and file every difference as a change.
        var first = Next("30 1 * * *", "2026-10-24T12:00:00Z", London);
        first.Should().Be(DateTimeOffset.Parse("2026-10-25T01:30:00+01:00"));

        // Asking again from just after the first occurrence must not return the repeat.
        var second = Next("30 1 * * *", "2026-10-25T00:31:00Z", London);
        second.Should().Be(DateTimeOffset.Parse("2026-10-26T01:30:00+00:00"));
    }

    // -----------------------------------------------------------------------
    // What it refuses, and how it says so
    // -----------------------------------------------------------------------

    [Theory]
    [InlineData("", "required")]
    [InlineData("0 2 * *", "five fields")]
    [InlineData("0 0 2 * * *", "seconds")]
    [InlineData("@daily", "0 0 * * *")]
    [InlineData("60 * * * *", "range of 0 to 59")]
    [InlineData("* 24 * * *", "range of 0 to 23")]
    [InlineData("0 0 32 * *", "range of 1 to 31")]
    [InlineData("0 0 * 13 *", "range of 1 to 12")]
    [InlineData("0 0 * * 8", "range of 0 to 7")]
    [InlineData("0 0 L * *", "not a value")]
    [InlineData("0 0 * * fri#2", "not a value")]
    [InlineData("*/0 * * * *", "step")]
    [InlineData("40-10 * * * *", "backwards")]
    public void Refuses_what_it_cannot_honour_and_says_what_is_wrong(string expression, string expectedInProblem)
    {
        CronExpression.TryParse(expression, out var parsed, out var problem).Should().BeFalse();
        parsed.Should().BeNull();
        problem.Should().NotBeNull();
        problem!.Should().Contain(expectedInProblem);
    }

    [Fact]
    public void An_expression_that_can_never_fire_returns_no_occurrence_rather_than_searching_for_ever()
    {
        // 30 February parses — every field is in range — and has no occurrence. The caller
        // needs to be told, or a schedule sits armed and enabled and never runs.
        var cron = CronExpression.Parse("0 0 30 2 *");
        cron.NextOccurrence(DateTimeOffset.Parse("2026-03-10T00:00:00Z"), Utc).Should().BeNull();
    }

    [Fact]
    public void The_expression_is_kept_exactly_as_written()
    {
        // The console shows it back to whoever typed it; normalising it would mean showing
        // them something they did not write.
        CronExpression.Parse("0,30 9-17 * * mon-fri").Expression.Should().Be("0,30 9-17 * * mon-fri");
    }
}
