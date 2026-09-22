using System.Globalization;

namespace Aira.Application.Scheduling;

/// <summary>
/// A five-field cron expression, and the next time it is due.
/// </summary>
/// <remarks>
/// Written here rather than taken from a package because the whole of what AIRA needs is
/// "when does this next fire, in this time zone", the semantics have to be pinned by our
/// own tests either way, and a scheduler that silently disagrees with the crontab a team
/// already has is worse than no scheduler. Everything it supports is standard crontab:
///
///   <c>minute hour day-of-month month day-of-week</c>
///
///   <c>*</c>         every value
///   <c>5</c>         one value
///   <c>1-5</c>       a range, inclusive
///   <c>1,3,15</c>    a list
///   <c>*&#47;15</c>  every 15th value from the start of the range
///   <c>10-40/5</c>   every 5th value within a range
///   <c>mon</c>, <c>jan</c>  three-letter names, for day-of-week and month
///
/// Day-of-week accepts 0 and 7 for Sunday, as crontab does. When both day-of-month and
/// day-of-week are restricted, a day matching <em>either</em> is due — which is crontab's
/// behaviour and surprises people, so it is stated here and pinned by a test rather than
/// left for someone to discover on a Sunday.
///
/// Deliberately not supported: seconds, <c>@yearly</c> and friends, <c>L</c>, <c>W</c>, <c>#</c>.
/// Each is rejected with a message naming what is wrong, because a schedule that silently
/// means something other than what was typed will fire at the wrong time for months.
/// </remarks>
public sealed class CronExpression
{
    private readonly bool[] _minutes = new bool[60];
    private readonly bool[] _hours = new bool[24];
    private readonly bool[] _daysOfMonth = new bool[32];   // 1-31
    private readonly bool[] _months = new bool[13];        // 1-12
    private readonly bool[] _daysOfWeek = new bool[7];     // 0 = Sunday
    private bool _dayOfMonthRestricted;
    private bool _dayOfWeekRestricted;

    public string Expression { get; }

    private CronExpression(string expression) => Expression = expression;

    /// <summary>The furthest ahead a search will look before giving up.</summary>
    /// <remarks>
    /// Four years covers every expression that can ever fire, including 29 February, and
    /// bounds one that never can — <c>0 0 30 2 *</c> parses fine and has no occurrence.
    /// Without a bound that search does not terminate.
    /// </remarks>
    private const int SearchLimitDays = 366 * 4;

    public static bool TryParse(string? expression, out CronExpression? parsed, out string? problem)
    {
        parsed = null;
        problem = null;

        if (string.IsNullOrWhiteSpace(expression))
        {
            problem = "A cron expression is required.";
            return false;
        }

        var text = expression.Trim();

        if (text.StartsWith('@'))
        {
            problem = $"\"{text}\" is not supported. Write it out as five fields — "
                + "@daily is \"0 0 * * *\", @hourly is \"0 * * * *\".";
            return false;
        }

        var fields = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (fields.Length != 5)
        {
            problem = fields.Length == 6
                ? "This looks like a six-field expression with seconds. AIRA schedules have a "
                  + "resolution of one minute, so write five fields: minute hour day-of-month month day-of-week."
                : $"A cron expression has five fields (minute hour day-of-month month day-of-week); this has {fields.Length}.";
            return false;
        }

        var result = new CronExpression(text);

        if (!Fill(fields[0], 0, 59, null, result._minutes, "minute", out problem)) return false;
        if (!Fill(fields[1], 0, 23, null, result._hours, "hour", out problem)) return false;
        if (!Fill(fields[2], 1, 31, null, result._daysOfMonth, "day-of-month", out problem)) return false;
        if (!Fill(fields[3], 1, 12, Months, result._months, "month", out problem)) return false;
        if (!Fill(fields[4], 0, 7, Days, result._daysOfWeek, "day-of-week", out problem)) return false;

        // "Restricted" means the field is anything other than a bare star. It decides which
        // of crontab's two day rules applies, so it is taken from the text rather than
        // inferred from the filled set — "*/1" fills every day and is still a star.
        result._dayOfMonthRestricted = fields[2] != "*";
        result._dayOfWeekRestricted = fields[4] != "*";

        parsed = result;
        return true;
    }

    /// <summary>Parses or throws. For call sites that have already validated the input.</summary>
    public static CronExpression Parse(string expression)
        => TryParse(expression, out var parsed, out var problem)
            ? parsed!
            : throw new FormatException(problem);

    /// <summary>
    /// The first minute strictly after <paramref name="after"/> at which this is due, in
    /// <paramref name="timeZone"/>, returned as an instant.
    /// </summary>
    /// <remarks>
    /// Strictly after, so that recording a fire time and asking for the next one cannot
    /// return the same minute and run a schedule twice.
    ///
    /// The search walks local minutes and converts each back to an instant, rather than
    /// walking instants. That is what makes "every day at 02:30 in London" mean 02:30 in
    /// London on both sides of a daylight-saving change. Two consequences are deliberate:
    /// a local time that does not exist on the day the clocks go forward is skipped, and
    /// one that happens twice when they go back fires on the first occurrence only.
    /// </remarks>
    public DateTimeOffset? NextOccurrence(DateTimeOffset after, TimeZoneInfo timeZone)
    {
        var local = TimeZoneInfo.ConvertTime(after, timeZone);
        // Start at the next whole minute: within-minute precision is not part of the model,
        // and starting at the current one would return a time already past.
        var candidate = new DateTime(local.Year, local.Month, local.Day, local.Hour, local.Minute, 0,
            DateTimeKind.Unspecified).AddMinutes(1);

        var limit = candidate.AddDays(SearchLimitDays);

        while (candidate < limit)
        {
            if (!_months[candidate.Month])
            {
                candidate = new DateTime(candidate.Year, candidate.Month, 1).AddMonths(1);
                continue;
            }
            if (!DayMatches(candidate))
            {
                candidate = candidate.Date.AddDays(1);
                continue;
            }
            if (!_hours[candidate.Hour])
            {
                candidate = candidate.Date.AddHours(candidate.Hour + 1);
                continue;
            }
            if (!_minutes[candidate.Minute])
            {
                candidate = candidate.AddMinutes(1);
                continue;
            }

            // A local time inside a spring-forward gap never happens; skip the whole gap
            // rather than inventing an instant for it.
            if (timeZone.IsInvalidTime(candidate))
            {
                candidate = candidate.AddMinutes(1);
                continue;
            }

            // When a local time happens twice, take the first of the two in real time —
            // which is the one with the *larger* offset, since a bigger offset means the
            // same wall clock is reached at an earlier instant. Taking the smaller one
            // would fire an hour late and then, on the next search, fire again.
            var offset = timeZone.IsAmbiguousTime(candidate)
                ? timeZone.GetAmbiguousTimeOffsets(candidate).Max()
                : timeZone.GetUtcOffset(candidate);

            return new DateTimeOffset(candidate, offset);
        }

        // Parsed, and can never happen — 31 February, say. Returning null lets the caller
        // say so rather than leaving a schedule that looks armed and never fires.
        return null;
    }

    /// <summary>Crontab's day rule: restricting both fields means either may match.</summary>
    private bool DayMatches(DateTime candidate)
    {
        var dayOfMonth = _daysOfMonth[candidate.Day];
        var dayOfWeek = _daysOfWeek[(int)candidate.DayOfWeek];

        if (_dayOfMonthRestricted && _dayOfWeekRestricted) return dayOfMonth || dayOfWeek;
        if (_dayOfMonthRestricted) return dayOfMonth;
        if (_dayOfWeekRestricted) return dayOfWeek;
        return true;
    }

    // -----------------------------------------------------------------------
    // Parsing
    // -----------------------------------------------------------------------

    private static readonly string[] Days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    private static readonly string[] Months =
        ["", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

    private static bool Fill(string field, int min, int max, string[]? names, bool[] into,
        string what, out string? problem)
    {
        problem = null;

        foreach (var part in field.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            var step = 1;
            var body = part;

            var slash = part.IndexOf('/');
            if (slash >= 0)
            {
                body = part[..slash];
                var stepText = part[(slash + 1)..];
                if (!int.TryParse(stepText, NumberStyles.None, CultureInfo.InvariantCulture, out step) || step < 1)
                {
                    problem = $"\"{stepText}\" is not a step in the {what} field. A step is a whole number of 1 or more.";
                    return false;
                }
            }

            int from, to;
            if (body == "*")
            {
                from = min;
                to = max;
            }
            else
            {
                var dash = body.IndexOf('-');
                if (dash > 0)
                {
                    if (!Value(body[..dash], min, max, names, what, out from, out problem)) return false;
                    if (!Value(body[(dash + 1)..], min, max, names, what, out to, out problem)) return false;
                    if (to < from)
                    {
                        problem = $"\"{body}\" runs backwards in the {what} field.";
                        return false;
                    }
                }
                else
                {
                    if (!Value(body, min, max, names, what, out from, out problem)) return false;
                    // A bare value with a step means "from here to the end of the range",
                    // which is what crontab does with 10/5.
                    to = slash >= 0 ? max : from;
                }
            }

            for (var value = from; value <= to; value += step)
            {
                // Sunday is both 0 and 7 in crontab; the array only has a slot for 0.
                into[value == 7 && max == 7 ? 0 : value] = true;
            }
        }

        if (!into.Any(set => set))
        {
            problem = $"The {what} field matches nothing.";
            return false;
        }

        return true;
    }

    private static bool Value(string text, int min, int max, string[]? names, string what,
        out int value, out string? problem)
    {
        problem = null;
        value = 0;

        if (names is not null)
        {
            var index = Array.FindIndex(names, name =>
                name.Length > 0 && string.Equals(name, text, StringComparison.OrdinalIgnoreCase));
            if (index >= 0) { value = index; return true; }
        }

        if (!int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value))
        {
            problem = $"\"{text}\" is not a value in the {what} field."
                + (names is null ? string.Empty : $" Names like {names.First(n => n.Length > 0)} are accepted.");
            return false;
        }

        if (value < min || value > max)
        {
            problem = $"{value} is outside the {what} field's range of {min} to {max}.";
            return false;
        }

        return true;
    }
}
