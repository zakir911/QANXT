# BUG-0031 — A run could finish twice, doing all of its completion work twice

| | |
| --- | --- |
| **ID** | BUG-0031 |
| **Title** | Two executions finishing at the same moment both saw "every execution is done" and both ran the completion block: contract check, quality gate, completion event and notification, all twice |
| **Severity** | **HIGH** |
| **Found by** | Golden test NOT-002, which expected one notification for a failed run and received two identical ones |
| **Environment** | See `verification/environment.md` |
| **Build** | `3f071af` |
| **Component** | `apps/api/src/Aira.Application/Testing/ExecutionIngestService.cs` |
| **Reproduction rate** | Intermittent; 1 of 4 two-test runs in the notification suite |
| **Status** | Fixed and re-verified |

## What happens

```
[14:42:10 INF] Run 7a2d26b5-… finished: 1 passed, 1 failed, 0 healed; gate passed
[14:42:10 INF] Run 7a2d26b5-… finished: 1 passed, 1 failed, 0 healed; gate passed
```

One run, two completions, same second. The notification sink received two byte-identical
`RunFailed` deliveries for it.

## Why it matters

This predates notifications; notifications only made it visible. Everything in the
completion block ran twice:

| | Consequence of running twice |
| --- | --- |
| The quality gate | Evaluated twice. Wasted work, and any gate rule with a side effect would apply it twice. |
| The contract check | Run twice against the same evidence, so a breaking change could be recorded twice. |
| The `RunCompleted` event | Published twice, so a console watching the hub shows the run finishing twice. |
| `CompletedAt` and `DurationMs` | Overwritten by the second pass, so the recorded duration is slightly wrong. |
| Notifications | Two identical messages. |

The last is the one that would have been noticed, and the least important. A team receiving
two of everything learns to skim, which costs them the message that mattered.

## Root cause

A read-then-act race with no guard between the two:

```csharp
var finished = statuses.Count(s => s.Status is not (Queued or Pending or Running));
if (finished < statuses.Count)
{
    await _db.SaveChangesAsync(ct);
    return;
}

run.CompletedAt = _clock.UtcNow;
…
```

Every execution reports independently, and the worker runs them in parallel. When the last
two finish close enough together, both callbacks query the execution statuses after both
rows are already terminal, both compute `finished == statuses.Count`, and both proceed.
Nothing between the check and the work makes the second caller stop.

Two executions is the smallest run where this is possible, which is why a suite of
two-test runs surfaced it and months of larger runs did not obviously do so — with more
tests the window is the same size, but the odds of the *last two* landing inside it are
what they always were. It had simply never been looked for.

## Fix

The same compare-and-swap used to claim a schedule. Completion is claimed by being the
caller who moves `CompletedAt` from null to a value:

```csharp
var claimed = await _db.TestRuns
    .Where(r => r.Id == run.Id && r.CompletedAt == null)
    .ExecuteUpdateAsync(set => set
        .SetProperty(r => r.CompletedAt, completedAt)
        .SetProperty(r => r.Status, status)
        .SetProperty(r => r.DurationMs, duration), ct);

if (claimed == 0) return;   // another callback is finishing this run
```

The database serialises the two updates, so exactly one caller sees a row affected and goes
on to check contracts, evaluate the gate, publish the event and notify. No lock, no extra
table, correct for any number of API instances.

The counts are still written by both callers before the claim, which is deliberate: they
are idempotent — computed from the same query over the same rows — and writing them
unconditionally means the run's numbers are right even for the caller that loses the claim.

## Verification

NOT-002 requires exactly one `RunFailed` delivery for a two-test run. It saw two before the
fix and one after. The notification suite runs four multi-execution runs, which is what
made an intermittent race reproducible enough to see at all.
