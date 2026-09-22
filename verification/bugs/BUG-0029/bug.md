# BUG-0029 — Every schedule in a named time zone failed with a 500

| | |
| --- | --- |
| **ID** | BUG-0029 |
| **Title** | `NextRunAt` was stored with the schedule's local UTC offset, which PostgreSQL's `timestamptz` refuses, so creating any schedule outside UTC threw |
| **Severity** | **HIGH** |
| **Found by** | Golden tests SCH-006 and SCH-007, on the first execution of the scheduling suite |
| **Environment** | See `verification/environment.md` |
| **Build** | `b6e6354` |
| **Component** | `apps/api/src/Aira.Application/Scheduling/ScheduleService.cs` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

```
POST /api/v1/schedules
{"projectId":"…","name":"Debug3","cronExpression":"30 2 * * *","timeZone":"Europe/London"}

HTTP/1.1 500 Internal Server Error
System.ArgumentException: Cannot write DateTimeOffset with Offset=01:00:00 to PostgreSQL
type 'timestamp with time zone', only offset 0 (UTC) is supported.
```

The same request with `"timeZone":"UTC"` succeeds. So does one in London in January, when
the offset happens to be zero — which is the part that would have made this miserable to
find in production: it works all winter and breaks on the last Sunday in March.

## Why it matters

Named time zones are not an edge case here; they are the recommended way to write a
schedule, and `docs/scheduling.md` says so:

> Set one. `--timezone Europe/London` means 02:00 London in January and 02:00 London in
> July… Left as UTC, a 02:00 nightly drifts to 03:00 local every summer.

So the documented, recommended path was the broken one. Every schedule created outside UTC
— or created in a zone whose offset was non-zero at that moment — returned a 500 and was
not stored. Nothing was silently wrong; it simply did not work.

It also affected the runner, which writes the same field on every fire. A schedule created
during winter would have started failing when the clocks changed, counted three failures,
and disabled itself overnight with "Disabled after 3 consecutive failures".

## Root cause

`CronExpression.NextOccurrence` returns a `DateTimeOffset` carrying the offset in force at
that local time, which is the right thing for it to return: the offset is how the caller
knows whether 01:30 on a clocks-back night is the first or second occurrence, and the
preview endpoint uses exactly that to show "02:30+01:00".

`ScheduleService` then stored the value straight onto the entity. Npgsql maps
`DateTimeOffset` to `timestamptz`, which stores an instant and therefore accepts only
offset zero. The two are not in conflict — the instant is the same either way — but the
conversion has to be explicit and was not.

The compiler cannot catch it, and neither can a unit test against an in-memory or SQLite
provider, because only Npgsql enforces the rule. It needed a write to a real PostgreSQL,
which is what the golden suite does.

## Fix

`ToUniversalTime()` where the value is stored, in both the create and update paths:

```csharp
NextRunAt = validated.Value.NextRunAt.ToUniversalTime(),
```

and in the runner's claim.

The preview endpoint is deliberately left returning the local offset. It exists for a
person to read, and `2026-06-15T02:30:00+01:00` answers "is that 02:30 London?" where the
UTC form does not. Stored values are instants; displayed values are local. The two now
differ on purpose rather than by accident, and a comment at each site says which is which.

## Verification

SCH-006 creates a `30 2 * * *` Europe/London schedule and requires five ascending
occurrences all at 02:30 local — which cannot pass unless the schedule was stored at all.
SCH-007 creates one through the CLI. Both failed before the fix and pass after it.
