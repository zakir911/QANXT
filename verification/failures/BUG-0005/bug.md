# BUG-0005 — An execution abandoned by a worker is never reconciled

| | |
| --- | --- |
| **ID** | BUG-0005 |
| **Title** | A test execution left in `Running` by a worker that dropped it stays `Running` forever; the run never reaches a verdict |
| **Severity** | **HIGH** |
| **Found by** | CONC-001, independent operations suite |
| **Environment** | See `verification/environment.md` |
| **Build** | `db15fa6` |
| **Component** | `apps/api/src/Aira.Application/Testing/` — no abandonment reaper |
| **Reproduction rate** | 1 of 1 observed, and reachable by any worker interruption |
| **Status** | **Fixed and verified** |

## Steps

1. Cause a worker to drop a claimed execution. BUG-0004 does it under concurrency; killing a
   worker mid-execution does it directly.
2. Query the run.

## Expected

The execution is eventually reclaimed and retried, or marked as failed with a reason. A run
must reach a verdict; a caller waiting on it — a CI pipeline, the CLI, the console — cannot
wait forever.

## Actual

```sql
select status, started_at, completed_at, worker_id from test_executions where id = '83718af6-…';
 status |          started_at           | completed_at |  worker_id
      2 | 2026-09-20 16:22:55.147796+00 |              | worker-5390
```

Status 2 is `Running`. `completed_at` is NULL seven minutes later. The worker reports
`inFlight: 0` and `queueDepth: 0`, so nothing is working on it and nothing will.

The parent run is likewise stuck: `CONC 7` has `completed_at` NULL and `passed_count` 0.

## Why this is separate from BUG-0004

Fixing the rate limiter removes one cause. It does not remove the class: a worker that is
killed, loses its network, or crashes mid-execution leaves exactly the same stranded row.
The platform already reconciles this for **discovery** runs —
`DiscoveryService.IsAbandoned` reaps in-flight runs that have gone quiet — and for **queue
messages**, which the worker reclaims with `XAUTOCLAIM`. Executions have neither.

## Fix

Reconcile executions the way discovery runs are: an execution whose worker has not reported
progress within a heartbeat window is marked failed with a plain reason, and its run is
completed so callers stop waiting.


## Fix applied

`Aira.Api.Services.StrandedExecutionReaper`, a hosted service that sweeps every minute for
executions still `Running` or `Queued` past a grace period (`Execution:StrandedAfterMinutes`,
default 10). Each is ended as `Error` with a plain reason, and its run is completed once no
execution in it is still in flight.

The message is written for whoever reads it next:

> No worker reported on this execution for over 10 minutes. It was claimed by a worker that
> stopped responding, so the platform has ended it rather than leaving the run unfinished.
> This is a platform or infrastructure problem, not a failure of the application under test.

That last sentence matters: without it, a stranded execution reads like an application
defect and somebody goes looking for one.

## Verification after the fix

The execution stranded by BUG-0004 — `83718af6-…`, stuck for over ten minutes — was
reclaimed by the first sweep after the reaper was deployed:

```
  name  | status | blocked_count | completed
 CONC 7 |     18 |             1 | t
```

Status 18 is `Error`; `blocked_count` 1; `completed_at` set. Before the fix the same row read
`status 2` (Running), `blocked_count 0`, `completed_at` NULL.
