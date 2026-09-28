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

## COR-005 reports an authorization problem instead of a front-end one, once in eight runs

**Observed.** The full golden run immediately after the QA NXT rename
(`2026-09-28T12-09-52Z`) reported one failure:

```
critical COR-005  2 API call(s), 0 failed;
                  authenticationIssue at 85%: "The session was not authorised."
```

COR-005 drives a journey that opens the dashboard with `FAULT_WRONG_BALANCE` enabled, where
every request succeeds and the total on the page is wrong. It expects the diagnosis to be
`applicationDefect` — "The API answered correctly and the page showed something else." On
this run it got `authenticationIssue` instead.

**What is established.** The test has now run eight times on record: seven passes and this one
failure, the failure being the only run after the rename. Re-running the correlation suite
against the same renamed build three times produced three passes, with the expected
`applicationDefect at 80%` each time. The rename's diff against the banking lab
(`test-lab/banking-app/server.js`) changes prose only — the product name in a title, a body
string and an error page — and touches no cookie, session or authentication path. The
classification differs while the assertion about failed calls does not: `failedCalls.length
=== 0` held on the failing run too, so the 401 the classifier reasoned from was not among the
API calls the run recorded.

**What is not established.** Why it happened on that run. The suite passes in isolation, so
the trigger involves state left by something earlier in a full run rather than anything in
the correlation suite itself. Nothing here identifies what that state is.

**Not fixed, and not called a flake.** One failure in eight is a real observation about a
critical test, and a test that occasionally attributes a front-end defect to authorization is
worth understanding rather than re-running until it is green. What can be said today is that
it is not the rename: the rename changed no authentication code the lab uses, and the test
passes repeatedly on the renamed build. Investigating the ordering dependency is its own
piece of work.
