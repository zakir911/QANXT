import { describe, expect, it, vi } from 'vitest';
import { isMissingGroup, RedisStreamConsumer } from '../src/queue/redis-consumer.js';

/**
 * A worker that loses its stream must get it back without being restarted.
 *
 * Observed on a running worker after its Redis was cleared: every read answered
 *
 *   NOGROUP No such key 'qanxt:discovery' or consumer group 'qanxt-workers' in XREADGROUP
 *
 * 93 times in forty seconds, with no recovery and no job taken. ensureGroup() latched a
 * `groupReady` flag on its first success and returned early for the life of the process, so
 * once the group was gone it was never re-created. Redis restarted without persistence, a
 * failover to a replica that never had the stream, and a flushed development instance all
 * land here. The control plane's own client re-creates the stream when it enqueues, so work
 * keeps arriving, nothing runs, and the only symptom is a log line.
 */
describe('a consumer whose group disappears', () => {
  const options = {
    redisUrl: 'localhost:6379',
    queue: 'qanxt:discovery', group: 'qanxt-workers', consumer: 'worker-1',
    blockMs: 10, visibilityMs: 60_000
  };

  /** ioredis surfaces the server's error as a ReplyError whose message starts NOGROUP. */
  const nogroup = () => Object.assign(new Error(
    "NOGROUP No such key 'qanxt:discovery' or consumer group 'qanxt-workers' in XREADGROUP"
  ), { name: 'ReplyError' });

  const job = [[options.queue, [['1-0', ['type', 'discovery', 'payload', JSON.stringify({ jobId: 'j1' })]]]]];

  /**
   * The constructor opens a real connection, so the stub replaces it afterwards and the
   * real one is closed. Stubbing the four commands this path uses is deliberate: the
   * behaviour under test is what the consumer does with a NOGROUP reply, and a real Redis
   * cannot be made to lose a stream mid-read on demand.
   */
  function consumerWith(redis: Record<string, unknown>) {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const consumer = new RedisStreamConsumer({ ...options, logger } as never);
    const real = (consumer as unknown as { redis: { disconnect(): void } }).redis;
    real.disconnect();
    (consumer as unknown as { redis: unknown }).redis = redis;
    return { consumer, logger };
  }

  it('re-creates the group and returns the job instead of failing', async () => {
    let reads = 0;
    const xgroup = vi.fn().mockResolvedValue('OK');
    const { consumer, logger } = consumerWith({
      xgroup,
      xpending: vi.fn().mockResolvedValue([]),
      xreadgroup: vi.fn().mockImplementation(() => {
        reads += 1;
        return reads === 1 ? Promise.reject(nogroup()) : Promise.resolve(job);
      }),
      on: vi.fn()
    });

    const jobs = await consumer.read(1);

    expect(jobs.map(j => (j.payload as { jobId: string }).jobId)).toEqual(['j1']);
    expect(jobs.map(j => j.type)).toEqual(['discovery']);
    expect(xgroup).toHaveBeenCalledTimes(2); // once at start, once after the NOGROUP
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('re-creating'), expect.anything());
  });

  it('gives up after one re-creation rather than looping on a real fault', async () => {
    const { consumer } = consumerWith({
      xgroup: vi.fn().mockResolvedValue('OK'),
      xpending: vi.fn().mockResolvedValue([]),
      xreadgroup: vi.fn().mockRejectedValue(nogroup()),
      on: vi.fn()
    });

    await expect(consumer.read(1)).rejects.toThrow(/NOGROUP/);
  });

  it('does not treat an unrelated Redis error as a missing group', async () => {
    const xgroup = vi.fn().mockResolvedValue('OK');
    const { consumer } = consumerWith({
      xgroup,
      xpending: vi.fn().mockResolvedValue([]),
      xreadgroup: vi.fn().mockRejectedValue(new Error('READONLY You cannot write against a read only replica')),
      on: vi.fn()
    });

    await expect(consumer.read(1)).rejects.toThrow(/READONLY/);
    expect(xgroup).toHaveBeenCalledTimes(1);
  });

  it('recognises the code, not the surrounding message', () => {
    expect(isMissingGroup(new Error('NOGROUP No such key'))).toBe(true);
    expect(isMissingGroup('NOGROUP')).toBe(true);
    expect(isMissingGroup(new Error('BUSYGROUP Consumer Group name already exists'))).toBe(false);
    // The word has to stand alone: a job id or payload mentioning it is not an error code.
    expect(isMissingGroup(new Error('job NOGROUPING failed'))).toBe(false);
  });
});
