# Defects observed outside the golden suites

These were found while running the platform during the autonomous-QA work, not by a test.
They are recorded here rather than fixed, because each is outside the phase that found it.
Nothing here is a golden-test failure; nothing here is verified by a test either.

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
stale-job reclaim sweep. Six such jobs were still in `aira:security` at the end of this
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
