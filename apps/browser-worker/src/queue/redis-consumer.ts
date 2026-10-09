import { Redis } from 'ioredis';
import type { Logger } from '../util/logger.js';

/**
 * Redis Streams consumer.
 *
 * Consumer groups give competing workers, explicit acknowledgement, and — crucially —
 * recovery of jobs whose worker died mid-run. Delivery is at-least-once, so handlers must
 * be idempotent; the control plane's ingest paths are written that way deliberately.
 *
 * At-least-once is not the same as forever, and it used to be. Reclaim read entries with
 * XAUTOCLAIM, which reports no delivery count, so `deliveryCount` was hardcoded to 1 and
 * nothing could tell a first attempt from a hundredth. A job that could never succeed — a
 * browser binary that is not installed is the one that proved it — was re-delivered to this
 * same consumer every visibility window, forever, with no backoff.
 *
 * Three things fix that, and all three are needed:
 *
 *  - Reclaim goes through XPENDING, which does report the real delivery count, and then
 *    XCLAIM. One extra round trip buys the number everything else depends on.
 *  - Each attempt waits longer than the last, so a job failing on a transient fault stops
 *    occupying a worker slot at full speed.
 *  - After `maxAttempts` the job is moved to a dead-letter stream and acknowledged, so the
 *    queue is not blocked by work nobody can do. Handlers that already know retrying is
 *    pointless can say so immediately and skip the budget entirely.
 */

export interface QueuedJob {
  id: string;
  type: string;
  payload: unknown;
  deliveryCount: number;
}

export interface ConsumerOptions {
  redisUrl: string;
  queue: string;
  group: string;
  consumer: string;
  /** How long a job may be held before another worker may reclaim it. */
  visibilityMs: number;
  blockMs: number;
  /**
   * How many deliveries a job gets before it is dead-lettered. The default is deliberately
   * small: a job that has failed five times on different workers is not going to pass on the
   * sixth, and the run it belongs to has been reporting Running throughout.
   */
  maxAttempts?: number;
  logger: Logger;
}

/** Why a job left the queue without succeeding. */
export interface DeadLetter {
  jobId: string;
  deliveryCount: number;
  reason: string;
  permanent: boolean;
}

export class RedisStreamConsumer {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private groupReady = false;
  private closing = false;

  constructor(private readonly options: ConsumerOptions) {
    this.logger = options.logger;
    const [host, port] = splitEndpoint(options.redisUrl);
    this.redis = new Redis({
      host,
      port,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt: number) => Math.min(attempt * 500, 10_000),
      lazyConnect: false
    });

    this.redis.on('error', (error: unknown) => this.logger.warn('Redis connection error', { error: String(error) }));
  }

  async ensureGroup(): Promise<void> {
    if (this.groupReady) return;
    try {
      // "0" rather than "$": a newly created group should pick up work already waiting,
      // not silently skip everything queued before the first worker started.
      await this.redis.xgroup('CREATE', this.options.queue, this.options.group, '0', 'MKSTREAM');
      this.logger.info('Created the consumer group', { queue: this.options.queue, group: this.options.group });
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
    this.groupReady = true;
  }

  /** Reads new jobs, first reclaiming any abandoned by a dead consumer. */
  async read(count: number): Promise<QueuedJob[]> {
    await this.ensureGroup();

    const reclaimed = await this.reclaimStale(count);
    if (reclaimed.length > 0) return reclaimed;

    const response = await this.redis.xreadgroup(
      'GROUP', this.options.group, this.options.consumer,
      'COUNT', count,
      'BLOCK', this.options.blockMs,
      'STREAMS', this.options.queue, '>'
    ) as [string, [string, string[]][]][] | null;

    return this.parse(response);
  }

  /**
   * Takes over entries whose consumer has been silent longer than the visibility window.
   * Without this, a worker that crashes mid-run leaves its job pending forever.
   *
   * XPENDING rather than XAUTOCLAIM because only XPENDING reports how many times an entry
   * has already been delivered, and without that number there is no retry budget, no
   * backoff, and no way to stop a doomed job cycling forever. The extra round trip is the
   * price of knowing which attempt this is.
   */
  private async reclaimStale(count: number): Promise<QueuedJob[]> {
    try {
      // Ask for more than we need: entries still inside their backoff are skipped below,
      // and asking for exactly `count` would let a few backing-off entries hide the ones
      // that are ready.
      const pending = await this.redis.xpending(
        this.options.queue, this.options.group,
        'IDLE', this.options.visibilityMs,
        '-', '+', count * 4
      ) as [string, string, number, number][];

      if (!Array.isArray(pending) || pending.length === 0) return [];

      const ready: string[] = [];
      const attempts = new Map<string, number>();

      for (const entry of pending) {
        const [id, , idleMs, deliveryCount] = entry;
        if (typeof id !== 'string') continue;

        // XPENDING reports deliveries that have already happened. XCLAIM below increments
        // the counter, so the attempt the handler is about to make is `delivered + 1`.
        // Getting this off by one makes the budget and the backoff both wrong by an attempt.
        const delivered = Number(deliveryCount) || 1;
        const attempt = delivered + 1;

        if (delivered >= this.maxAttempts) {
          // Out of budget. Dead-lettered here rather than handed back to a handler: the
          // handler has already failed this job `maxAttempts` times and has nothing new to
          // try, and leaving it pending would keep it in this loop forever.
          await this.deadLetter({
            jobId: id,
            deliveryCount: delivered,
            reason:
              `The job failed on ${delivered} deliveries, which is its limit of `
              + `${this.maxAttempts}. It was not retried again.`,
            permanent: false
          });
          continue;
        }

        // The required idle grows with the attempt about to be made: the first retry waits
        // one visibility window, the next two, and so on.
        if (Number(idleMs) < this.backoffMsFor(attempt)) continue;

        ready.push(id);
        attempts.set(id, attempt);
        if (ready.length >= count) break;
      }

      if (ready.length === 0) return [];

      const claimed = await this.redis.xclaim(
        this.options.queue, this.options.group, this.options.consumer,
        this.options.visibilityMs, ...ready
      ) as [string, string[]][];

      const entries = (claimed ?? []).filter(entry => Array.isArray(entry) && entry[1] != null);
      if (entries.length === 0) return [];

      this.logger.warn('Reclaimed jobs no consumer finished', {
        queue: this.options.queue,
        count: entries.length,
        attempts: entries.map(([id]) => `${id}:${attempts.get(id) ?? 1}`)
      });

      return this.parse([[this.options.queue, entries]], attempts);
    } catch (error) {
      this.logger.debug('Could not reclaim stale jobs', { error: String(error) });
      return [];
    }
  }

  /** Attempts allowed before a job is dead-lettered. */
  private get maxAttempts(): number {
    return Math.max(1, this.options.maxAttempts ?? 5);
  }

  /**
   * How long an entry must sit idle before this attempt. Doubles each delivery and is capped,
   * so a job failing on a transient fault backs off instead of spinning, and one failing for
   * a settled reason wastes a fraction of the worker time it used to.
   */
  private backoffMsFor(attempt: number): number {
    const base = this.options.visibilityMs;
    // attempt 2 (the first retry) waits one window, attempt 3 two, attempt 4 four. Capped
    // so a long-lived queue cannot push a job's next attempt beyond a quarter of an hour.
    const doublings = Math.min(Math.max(attempt - 2, 0), 5);
    return Math.min(base * 2 ** doublings, 15 * 60_000);
  }

  /**
   * Moves a job out of the queue and into a record of what could not be done.
   *
   * Acknowledged and deleted from the live stream so it stops being re-delivered, and copied
   * to `<queue>:dead` so it is not simply lost — a job that vanishes silently is the other
   * half of the same dishonesty as a run that reports Running forever. The dead-letter stream
   * is capped: it is for diagnosis, not for storage.
   */
  async deadLetter(letter: DeadLetter): Promise<void> {
    const entry = await this.redis
      .xrange(this.options.queue, letter.jobId, letter.jobId)
      .catch(() => [] as [string, string[]][]);

    const fields = entry[0]?.[1] ?? [];
    const payload = fieldValue(fields, 'payload') ?? '';
    const type = fieldValue(fields, 'type') ?? 'unknown';

    try {
      await this.redis.xadd(
        `${this.options.queue}:dead`, 'MAXLEN', '~', '1000', '*',
        'type', type,
        'payload', payload,
        'reason', letter.reason,
        'permanent', letter.permanent ? '1' : '0',
        'deliveryCount', String(letter.deliveryCount),
        'failedAt', new Date().toISOString(),
        'consumer', this.options.consumer
      );
    } catch (error) {
      // Failing to record the dead letter must not leave the job cycling. The acknowledge
      // below still runs, and this is logged loudly enough to notice.
      this.logger.error('Could not write a dead-letter entry', error, { jobId: letter.jobId });
    }

    await this.acknowledge(letter.jobId);

    this.logger.error(
      `A ${this.options.queue} job will not be retried`,
      new Error(letter.reason),
      {
        jobId: letter.jobId,
        deliveryCount: letter.deliveryCount,
        permanent: letter.permanent,
        deadLetterStream: `${this.options.queue}:dead`
      }
    );
  }

  async acknowledge(jobId: string): Promise<void> {
    await this.redis.xack(this.options.queue, this.options.group, jobId);
    // The durable record of what happened lives in PostgreSQL; the stream only needs to
    // hold work that has not been done.
    await this.redis.xdel(this.options.queue, jobId);
  }

  /**
   * Leaves a job pending so it is re-delivered after its backoff.
   *
   * Nothing is sent to Redis here, which is the point: not acknowledging is what keeps the
   * entry in the pending list, and `reclaimStale` is what decides when it comes back and
   * whether it has any budget left. The log line says which attempt this was so the pattern
   * is visible without reading Redis.
   */
  async release(jobId: string, reason: string, deliveryCount = 1): Promise<void> {
    const next = this.backoffMsFor(deliveryCount + 1);

    this.logger.warn('Releasing a job back to the queue', {
      jobId,
      reason,
      attempt: deliveryCount,
      of: this.maxAttempts,
      retryInMs: next
    });
  }

  async depth(): Promise<number> {
    try {
      return await this.redis.xlen(this.options.queue);
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.redis.quit().catch(() => this.redis.disconnect());
  }

  get isClosing(): boolean { return this.closing; }

  /** Deliveries a job gets before it is dead-lettered, for callers deciding on a failure. */
  get attemptLimit(): number { return this.maxAttempts; }

  private parse(
    response: [string, [string, string[]][]][] | null,
    attempts?: Map<string, number>
  ): QueuedJob[] {
    if (!response) return [];
    const jobs: QueuedJob[] = [];

    for (const [, entries] of response) {
      for (const [id, fields] of entries) {
        const values = new Map<string, string>();
        for (let i = 0; i < fields.length; i += 2) {
          const key = fields[i];
          const value = fields[i + 1];
          if (key !== undefined && value !== undefined) values.set(key, value);
        }

        const payloadRaw = values.get('payload');
        if (!payloadRaw) {
          this.logger.warn('Discarding a queue entry with no payload', { jobId: id });
          continue;
        }

        try {
          jobs.push({
            id,
            type: values.get('type') ?? 'unknown',
            payload: JSON.parse(payloadRaw),
            // A fresh read is attempt 1; a reclaim knows the real number from XPENDING.
            // This was hardcoded to 1 for both, which is why nothing could ever count.
            deliveryCount: attempts?.get(id) ?? 1
          });
        } catch (error) {
          // A malformed entry will never parse, so retrying it forever would block the
          // queue. It is dropped loudly instead.
          this.logger.error('Discarding a queue entry whose payload is not valid JSON', error, { jobId: id });
        }
      }
    }

    return jobs;
  }
}

/** Reads one field out of a Redis stream entry's flat [key, value, key, value] array. */
function fieldValue(fields: string[], key: string): string | undefined {
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === key) return fields[i + 1];
  }
  return undefined;
}

function splitEndpoint(url: string): [string, number] {
  const withoutScheme = url.replace(/^redis:\/\//, '');
  const [host = 'localhost', port = '6379'] = withoutScheme.split(':');
  return [host, Number.parseInt(port, 10) || 6379];
}
