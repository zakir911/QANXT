# Scheduled regression

A pipeline covers what changed. A schedule covers what did not.

Nobody commits on the night a certificate expires, a dependency rots, or a third party
changes an endpoint under you. Nothing triggers, so nothing runs, and the first person to
find out is a customer. A schedule is the answer to that: the same tests, on a clock,
against a real deployment.

```bash
aira schedule add --name "Nightly regression" --cron "0 2 * * *" --timezone Europe/London
aira schedule add --name "Smoke, hourly" --cron "0 * * * *" --tags smoke
aira schedule list
aira schedule preview <id>
```

## Writing the expression

Five fields, as crontab: `minute hour day-of-month month day-of-week`.

| | |
| --- | --- |
| `0 2 * * *` | every day at 02:00 |
| `*/15 * * * *` | every fifteen minutes |
| `0 2 * * mon-fri` | weekdays at 02:00 |
| `0 */4 * * *` | every four hours |
| `0 0 1 * *` | the first of every month |

Supported: `*`, a value, `a-b`, `a,b,c`, `*/n`, `a-b/n`, and three-letter names for months
and days. Sunday is 0 or 7.

Not supported, and refused rather than silently reinterpreted: seconds, `@daily` and the
other shorthands, `L`, `W`, `#`. A schedule that means something other than what was typed
fires at the wrong time for months before anybody notices.

Two things catch people out, so both are pinned by tests:

- **Restricting both day fields matches either, not both.** `0 0 13 * fri` is the 13th of
  every month *and* every Friday — not Friday the 13th. That is crontab's rule.
- **An expression can be valid and never occur.** `0 0 30 2 *` parses and no date matches
  it. AIRA refuses it at creation rather than leaving a schedule that looks armed.

## Time zones

Set one. `--timezone Europe/London` means 02:00 London in January and 02:00 London in July,
which are different instants. Left as UTC, a 02:00 nightly drifts to 03:00 local every
summer for anyone not on UTC, and eventually lands in somebody's working day.

Across a daylight-saving change:

- A local time that does not exist when the clocks go forward is **skipped**. There is no
  01:30 in London on the day it jumps to 02:00, so that night has no run.
- A local time that happens twice when they go back fires **once**, on the first of the two.
  Firing twice would run the same regression twice and report every difference as
  instability.

`aira schedule preview <id>` prints the next few occurrences. It is worth a look before
waiting a night to discover the expression meant something else.

## What a schedule runs

By default, every enabled test in the project. Narrow it with `--tags` (any test carrying
any of those tags) or `--suite`. Tags are matched whole: a schedule for `api` does not pick
up tests tagged `apiv2`.

`--environment` decides which deployment it runs against, and matters for the same reasons
it matters in a pipeline — the environment carries the base URL, the allowed domains, the
rate limit and the production guard.

**A schedule against unauthorized production is refused when you create it**, not at three
in the morning. Being told at the keyboard is the difference between a message somebody
reads and a message nobody does.

## When something goes wrong

A schedule that cannot start a run counts a failure. After three in a row it disables
itself and records why, and the reason is shown by `aira schedule list`:

```
off  Nightly regression  7d0c…
     0 2 * * * (Europe/London)
     Disabled after 3 consecutive failures. Last reason: it matched no tests
```

Three rather than one, because a platform restart should not turn off the nightly
regression; three in a row is not bad luck. Re-enabling clears the count and the reason:

```bash
aira schedule enable <id>
```

The alternative — retrying for ever — produces a log line every hour that nobody reads, for
a schedule that has not run in a month.

## Two things that are easy to get wrong, and how AIRA handles them

**Two API instances must not both fire the same schedule.** Claiming one is a
compare-and-swap on its next-run time: each instance tries to move it forward with a
conditional update, and only the instance whose update changed a row goes on to start the
run. No lock, no leader election, no extra table, and correct for any number of instances
because the database serialises the updates itself. Without it, a two-instance deployment
runs every nightly twice and reports the differences between the two as flakiness.

**Missed occurrences are skipped, not replayed.** The next fire time is computed from now,
not from the time that was missed. An API that was down for a day comes back and runs the
nightly once. Replaying would queue twenty-four hourly runs at once and bury whatever was
actually wrong.

## Turning it off

`Scheduling:Enabled=false` stops the runner entirely. Worth setting on any deployment that
shares a database with a real one, so a developer's machine cannot start runs against
somebody else's project overnight.

## Verification

Golden suite `scheduling` (SCH-001…SCH-007) runs against the live platform: a schedule is
created through the API, the background runner picks it up on its own sweep, and the run it
starts is read back. Nothing calls the runner directly or simulates a tick — if the
background service is not running, the suite fails.

```bash
node verification/golden-tests/run.mjs --suite scheduling
```

It takes about three minutes, and that is not a defect. Three of the seven tests wait for a
real schedule to fire, which means waiting for a real minute boundary plus up to the
runner's thirty-second sweep. Shortening the sweep for the suite would mean verifying a
configuration nobody runs.

The cron evaluator has its own unit tests covering the day rule, both daylight-saving
edges, and every expression it refuses.

Building this found two defects, both of which only an execution could find:

- **BUG-0029** — the next-run time was stored with the schedule's local UTC offset, which
  PostgreSQL's `timestamptz` refuses, so creating any schedule outside UTC returned a 500.
  The recommended path was the broken one, and it would have worked all winter in London
  and broken on the last Sunday in March.
- **BUG-0030** — `aira schedule` read `AIRA_ENVIRONMENT_ID` directly instead of using the
  helper that already handled it, so an exported-but-empty variable — the normal state of
  one a pipeline declares and does not set — made every command fail with an opaque
  model-binding error.
