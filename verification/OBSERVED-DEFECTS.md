# Defects observed outside the golden suites

These were found while running the platform during the autonomous-QA work, not by a test.
Two are recorded and not fixed, because each is outside the phase that found it. The third
was fixed, because it was a wrong answer on a security report and that is not something to
write down and leave.

The two defects the Verdaccio pilot found in the agent itself are in
`pilot/PILOT-REPORT.md`, next to what the pass got right.

## A worker job whose completion is refused stays pending, with no attempt count

**Observed.** During this session the worker's security-scan completion callback was refused:

```
error  A security job failed and will be retried by another consumer
       /api/v1/worker/security/{id}/completed failed with 401
warn   Releasing a job back to the queue
```

The 401 is the per-job worker token being rejected — these jobs had sat in the queue across
an API restart and a two-hour gap, so the token had expired. That part is the system working:
a stale token should not be honoured.

What is not right is what happens next. `RedisConsumer.release()`
(`apps/browser-worker/src/queue/redis-consumer.ts`) logs the release and does nothing else:

```ts
/** Leaves a job pending so another worker can pick it up after the visibility window. */
async release(jobId: string, reason: string): Promise<void> {
  this.logger.warn('Releasing a job back to the queue', { jobId, reason });
}
```

There is no attempt counter, no backoff and no dead-letter. A job that can never succeed —
an expired token is not something a retry refreshes — is left pending and is eligible for the
stale-job reclaim sweep. Six such jobs were still in `qanxt:security` at the end of this
session.

**What is established:** the refusal, the absence of an attempt count in `release()`, and six
jobs left pending.

**What is NOT established:** that such a job is reclaimed and re-executed indefinitely. The
sweep was observed firing once, and each scan id in the log shows a single execution. The
worry — that a scan which can never report would re-issue its traffic against the target
application on every reclaim — is plausible from the code and was **not** reproduced.

**Not fixed.** The fix is small (an attempt count and a dead-letter, or refusing to re-lease a
job whose token is already expired) and belongs with the worker queue rather than with the
autonomous agent. Recorded so it is not lost.

## The worker loses its queue consumer when Redis restarts

**Observed.** Restarting Redis underneath a running worker left the worker alive and idle: a
discovery job queued afterwards sat unclaimed until the worker process was restarted by hand.
The worker logged nothing about the lost connection.

**Impact in practice:** anything queued between the Redis restart and the worker restart waits
indefinitely rather than failing. In this session it stalled a golden run for several minutes
until the worker was restarted.

**Not fixed.** Reconnecting a stream consumer after its Redis connection drops, and saying so
in the log when it happens, is worker work rather than agent work.

## Failure analysis blames the session when the evidence it needs has not arrived

**How this was found.** COR-005 failed on the full golden run after the QA NXT rename, and
again on the next one. An earlier version of this entry said it was "not the rename" and
filed it as a single observation in eight runs. Both halves of that were too thin, and the
second was wrong about the sample: COR-005 has now been read across all eighteen recorded
runs, and it has failed three times — once on `2026-09-22T07-20-51Z`, which is six days
before the rename.

**What COR-005 asserts.** A journey opens the lab bank's dashboard with `FAULT_WRONG_BALANCE`
enabled: every request succeeds and the total rendered on the page is wrong. The diagnosis
should be `applicationDefect` — "The API answered correctly and the page showed something
else." On the failing runs it was `authenticationIssue` at 85% — "The session was not
authorised." — which sends a reader to the account and the session lifetime for a defect that
is in the rendering.

**The mechanism, as far as the evidence carries it.** `FailureAnalysisService` builds
`AuthErrorCount` from every network event in the execution:

```csharp
AuthErrorCount: completion.NetworkEvents.Count(n => n.StatusCode is 401 or 403),
```

That is execution-wide, not step-wide. A single-page application asks "is anyone signed in?"
as it loads and is answered 401 when nobody is, so an execution that begins signed out
carries a 401 that has nothing to do with the step that later failed.
`DeterministicFailureClassifier` has a rule for exactly this case, and it is ordered ahead of
the authorization rule:

```csharp
if (api.EveryCallDuringFailingStepSucceeded && IsAssertionFailure(input.FailingAction, lowered))
```

On the failing runs it did not fire, and the verdict fell through to the authorization rule,
whose guard only excludes locator misses (`!IsLocatorMiss(lowered)`) — a narrower exclusion
than this case needs, since an assertion on text is not a locator miss.

**Established.** Three failures in eighteen runs, one of them pre-rename. The stored evidence
for the failing runs lists two API calls for the failing step, both 200, so had the
correlation been present at classification time the earlier rule would have matched. The
analysis text on those runs cites only "1 request(s) returned 401 or 403" and never mentions
the step's own calls, while passing runs cite "2 API call(s) during the failing step". The
rename changed no authentication path: its diff against the browser worker is import paths
and one temp-directory default, and against the banking lab it is prose only.

**Inferred, not established.** That the correlation was absent when the classifier ran —
a race between analysis and the linking of network events to the actions that made them,
which would explain why this appears under the load of a full run and not when the
correlation suite runs alone (three passes in a row that way). Nothing here proves the
ordering; it is the explanation that fits, and it should be confirmed before anything is
changed on the strength of it.

**Not fixed here, and not a flake.** A classifier that answers confidently from evidence it
does not have is a worse failure than one that says it cannot tell, and this one answers
with the wrong department. It is a correctness defect in failure attribution, it predates
the rename, and changing the precedence of failure classification deserves its own change
with its own verification rather than riding along with a product rename.
