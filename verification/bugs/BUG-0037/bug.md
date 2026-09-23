# BUG-0037 — Every execution carried a correlation id that correlated with nothing

| | |
| --- | --- |
| **ID** | BUG-0037 |
| **Title** | `TestExecution.CorrelationId` was never assigned; a property initialiser generated a fresh Guid per row, so the id the API published and the CLI report printed matched no log line and no audit record |
| **Severity** | **HIGH** |
| **Found by** | Golden test OBS-003, which supplied a known correlation id when starting a run and read the execution back |
| **Environment** | See `verification/environment.md` |
| **Build** | `7f50d74` |
| **Component** | `apps/api/src/Aira.Domain/Testing/TestExecution.cs`, `apps/api/src/Aira.Application/Testing/TestRunService.cs` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

```
$ grep -rn '\.CorrelationId\s*=' --include=*.cs apps/api/src | grep -v Migrations
apps/api/src/Aira.Application/Audit/AuditQueryService.cs:91:  rows = rows.Where(e => e.CorrelationId == correlationId);
```

One match across the whole API, and it is a comparison. Nothing ever assigned
`TestExecution.CorrelationId`. The value came entirely from the property's own initialiser:

```csharp
public string CorrelationId { get; set; } = Guid.NewGuid().ToString("N");
```

OBS-003 supplied `golden-run-p8uf9o6aam` when starting a run and read the execution back:

```json
{
  "supplied": "golden-run-p8uf9o6aam",
  "executionCorrelationId": "67738c5887ae45d3af50b68347633d67"
}
```

## Why it matters

The job payload sent to the worker *did* carry the right id — `TestRunService` sets
`CorrelationId = _correlation.CorrelationId` on the dispatch payload — so the worker's own
log lines were correct all along. It was the stored execution that was wrong, and the stored
execution is what everything downstream reads:

- `GET /api/v1/testruns/{id}/executions` returns it.
- The CLI's JSON report publishes it as `executions[].correlationId`.
- `docs/observability.md`, written in CQ-10, told a reader that this id is "what ties a piece
  of evidence back to the log line that produced it".

All three were handing people an identifier that returned nothing. Someone following the
documented procedure — take the id from the report, grep the API log, query the audit trail —
would have got zero rows from each, concluded the logging was broken, and had no way to tell
that the id itself was the problem.

The documentation claim is the part worth dwelling on: I wrote it in CQ-10 from reading the
code, and the code looked right. The field existed, was typed, was surfaced, was documented,
and was populated. Nothing about it looked absent. That is exactly why the golden test
supplies a *known* id and demands it back, rather than checking that some id is present.

## Root cause

The property initialiser. A field that defaults to a plausible-looking generated value is
indistinguishable from one that was set correctly, so the missing assignment produced no
symptom anywhere — no null, no empty string, no exception, no warning.

## Fix

Two changes, because the rename alone would leave the trap in place for the next field.

**Assign it.** `TestRunService` now sets the execution's correlation id from the request
that asked for the run, matching the dispatch payload it already set:

```csharp
Status = ExecutionStatus.Queued,
Browser = run.Browser,
CorrelationId = _correlation.CorrelationId,
CreatedAt = _clock.UtcNow
```

**Remove the initialiser.** The default is now `string.Empty`:

```csharp
/// Deliberately not defaulted to a fresh Guid. It was, and because a generated id is
/// indistinguishable from a real one, nothing assigning it went unnoticed …
public string CorrelationId { get; set; } = string.Empty;
```

An empty correlation id is visibly missing. A plausible one is a lie, and a lie in a
diagnostic field costs more than a gap, because it is followed.

## Re-verification

OBS-003, which failed before the fix and passes after, against a real run through the queue
and a real browser:

```
PASS  OBS-003  A correlation id survives from the caller through the queue to the execution
               the worker ran — run passed; the execution carries correlation
               "golden-run-q7gwp9xqjf" (supplied "golden-run-q7gwp9xqjf")
```

OBS-002 covers the adjacent link — response header to audit record — and ISO-007 and AUD-*
cover the trail the id now leads to.
