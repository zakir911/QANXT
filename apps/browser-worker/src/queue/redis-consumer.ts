import { Redis } from 'ioredis';
import type { Logger } from '../util/logger.js';

/**
 * Redis Streams consumer.
 *
 * Consumer groups give competing workers, explicit acknowledgement, and — crucially —
 * recovery of jobs whose worker died mid-run. Delivery is at-least-once, so handlers must
 * be idempotent; the control plane's ingest paths are written that way deliberately.
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
  logger: Logger;
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
   */
  private async reclaimStale(count: number): Promise<QueuedJob[]> {
    try {
      const response = await this.redis.xautoclaim(
        this.options.queue, this.options.group, this.options.consumer,
        this.options.visibilityMs, '0-0', 'COUNT', count
      ) as [string, [string, string[]][], string[]];

      const entries = response[1] ?? [];
      if (entries.length === 0) return [];

      this.logger.warn('Reclaimed abandoned jobs from another consumer', {
        queue: this.options.queue, count: entries.length
      });
      return this.parse([[this.options.queue, entries]]);
    } catch (error) {
      this.logger.debug('Could not reclaim stale jobs', { error: String(error) });
      return [];
    }
  }

  async acknowledge(jobId: string): Promise<void> {
    await this.redis.xack(this.options.queue, this.options.group, jobId);
    // The durable record of what happened lives in PostgreSQL; the stream only needs to
    // hold work that has not been done.
    await this.redis.xdel(this.options.queue, jobId);
  }

  /** Leaves a job pending so another worker can pick it up after the visibility window. */
  async release(jobId: string, reason: string): Promise<void> {
    this.logger.warn('Releasing a job back to the queue', { jobId, reason });
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

  private parse(response: [string, [string, string[]][]][] | null): QueuedJob[] {
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
            deliveryCount: 1
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

function splitEndpoint(url: string): [string, number] {
  const withoutScheme = url.replace(/^redis:\/\//, '');
  const [host = 'localhost', port = '6379'] = withoutScheme.split(':');
  return [host, Number.parseInt(port, 10) || 6379];
}
