import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { RedisStreamConsumer } from '../src/queue/redis-consumer.js';
import { Logger } from '../src/util/logger.js';

/**
 * The retry budget, against a real Redis stream rather than a mock.
 *
 * The whole defect lived in real XPENDING/XCLAIM semantics: reclaim used XAUTOCLAIM, which
 * does not report a delivery count, so `deliveryCount` was hardcoded to 1 and a job that
 * could never succeed cycled forever. A mock that returns whatever we tell it would have
 * agreed with the broken code, so these tests drive the actual commands.
 *
 * Requires a Redis on REDIS_TEST_PORT (6399 by default). Skipped, loudly, when there is
 * none — a silently skipped test is one nobody notices has stopped running.
 */
const PORT = Number(process.env.REDIS_TEST_PORT ?? 6399);
const URL = `redis://127.0.0.1:${PORT}`;

// Probed at module load, not in beforeAll: describe.skipIf is evaluated while the file is
// being collected, which happens before any hook runs. Deciding in beforeAll left the real
// suite skipped and the "no Redis" guard failing, with nothing actually exercised.
const probe = new Redis({
  host: '127.0.0.1', port: PORT, lazyConnect: true,
  retryStrategy: () => null, maxRetriesPerRequest: 1
});

const reachable = await probe.connect().then(() => probe.ping()).then(() => true).catch(() => false);

afterAll(async () => {
  await probe.quit().catch(() => probe.disconnect());
});

const streams: string[] = [];
const consumers: RedisStreamConsumer[] = [];

afterEach(async () => {
  for (const consumer of consumers.splice(0)) await consumer.close().catch(() => undefined);
  if (reachable) {
    for (const stream of streams.splice(0)) {
      await probe.del(stream, `${stream}:dead`).catch(() => undefined);
    }
  }
});

const logger = new Logger({ level: 'error' } as never);

function makeConsumer(queue: string, overrides: Partial<{ visibilityMs: number; maxAttempts: number }> = {}) {
  streams.push(queue);
  const consumer = new RedisStreamConsumer({
    redisUrl: URL,
    queue,
    group: 'test-group',
    consumer: 'test-consumer',
    visibilityMs: overrides.visibilityMs ?? 1,
    blockMs: 10,
    maxAttempts: overrides.maxAttempts ?? 3,
    logger
  });
  consumers.push(consumer);
  return consumer;
}

const unique = (name: string) => `test:${name}:${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!reachable)('the retry budget', () => {
  it('reports attempt 1 on a first delivery and the real count on a reclaim', async () => {
    const queue = unique('counts');
    const consumer = makeConsumer(queue, { visibilityMs: 1 });
    await consumer.ensureGroup();
    await probe.xadd(queue, '*', 'type', 'discovery', 'payload', JSON.stringify({ a: 1 }));

    const first = await consumer.read(5);
    expect(first).toHaveLength(1);
    // A fresh read is genuinely the first attempt.
    expect(first[0]!.deliveryCount).toBe(1);

    // Not acknowledged, so it stays pending and becomes reclaimable.
    await new Promise(resolve => setTimeout(resolve, 20));

    const second = await consumer.read(5);
    expect(second).toHaveLength(1);
    // This is the assertion the old code could not pass: XAUTOCLAIM gave no count, so this
    // was hardcoded to 1 forever and no budget could ever be spent.
    expect(second[0]!.deliveryCount).toBe(2);

    await new Promise(resolve => setTimeout(resolve, 30));
    const third = await consumer.read(5);
    expect(third[0]?.deliveryCount).toBe(3);
  });

  it('dead-letters a job once it is out of budget, and stops re-delivering it', async () => {
    const queue = unique('budget');
    const consumer = makeConsumer(queue, { visibilityMs: 1, maxAttempts: 2 });
    await consumer.ensureGroup();
    await probe.xadd(queue, '*', 'type', 'discovery', 'payload', JSON.stringify({ doomed: true }));

    // Burn the budget: read, never acknowledge, let it go stale, read again.
    for (let i = 0; i < 4; i += 1) {
      await consumer.read(5);
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    // One more read is what notices the budget is spent and dead-letters it.
    await consumer.read(5);

    const dead = await probe.xrange(`${queue}:dead`, '-', '+');
    expect(dead.length).toBeGreaterThan(0);

    const fields = dead[0]![1];
    expect(fields).toContain('payload');
    expect(JSON.parse(fields[fields.indexOf('payload') + 1]!)).toEqual({ doomed: true });
    expect(fields[fields.indexOf('reason') + 1]).toContain('limit');

    // And it is gone from the live stream, so it cannot occupy a worker slot again.
    expect(await probe.xlen(queue)).toBe(0);
    expect(await consumer.read(5)).toHaveLength(0);
  });

  it('backs off: a job is not re-delivered the instant its visibility window passes', async () => {
    const queue = unique('backoff');
    // 200ms window. Attempt 2 waits 1x (200ms), attempt 3 waits 2x (400ms).
    const consumer = makeConsumer(queue, { visibilityMs: 200, maxAttempts: 9 });
    await consumer.ensureGroup();
    await probe.xadd(queue, '*', 'type', 'discovery', 'payload', '{}');

    expect(await consumer.read(5)).toHaveLength(1);

    // Well inside the first backoff: nothing should come back yet.
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(await consumer.read(5)).toHaveLength(0);

    // Past it: delivery 2.
    await new Promise(resolve => setTimeout(resolve, 200));
    const second = await consumer.read(5);
    expect(second).toHaveLength(1);
    expect(second[0]!.deliveryCount).toBe(2);

    // Delivery 3 has to wait longer than delivery 2 did. 250ms was enough last time.
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(await consumer.read(5)).toHaveLength(0);
  });

  it('dead-letters a permanent failure immediately, whatever budget is left', async () => {
    const queue = unique('permanent');
    const consumer = makeConsumer(queue, { visibilityMs: 50, maxAttempts: 9 });
    await consumer.ensureGroup();
    await probe.xadd(queue, '*', 'type', 'discovery', 'payload', JSON.stringify({ n: 7 }));

    const [job] = await consumer.read(5);
    expect(job).toBeDefined();

    await consumer.deadLetter({
      jobId: job!.id,
      deliveryCount: job!.deliveryCount,
      reason: 'The browser Playwright needs is not installed on this worker.',
      permanent: true
    });

    const dead = await probe.xrange(`${queue}:dead`, '-', '+');
    expect(dead).toHaveLength(1);
    const fields = dead[0]![1];
    expect(fields[fields.indexOf('permanent') + 1]).toBe('1');
    expect(fields[fields.indexOf('deliveryCount') + 1]).toBe('1');

    // Never comes back, even though 8 attempts were nominally left.
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(await consumer.read(5)).toHaveLength(0);
  });

  it('acknowledges a successful job without writing a dead letter', async () => {
    const queue = unique('ack');
    const consumer = makeConsumer(queue, { visibilityMs: 10 });
    await consumer.ensureGroup();
    await probe.xadd(queue, '*', 'type', 'discovery', 'payload', '{}');

    const [job] = await consumer.read(5);
    await consumer.acknowledge(job!.id);

    await new Promise(resolve => setTimeout(resolve, 40));
    expect(await consumer.read(5)).toHaveLength(0);
    expect(await probe.exists(`${queue}:dead`)).toBe(0);
  });
});

describe.skipIf(reachable)('the retry budget (skipped)', () => {
  it('needs a Redis on REDIS_TEST_PORT to run at all', () => {
    // Visible in the output so a missing Redis reads as "not verified" rather than "passed".
    expect(reachable).toBe(false);
  });
});
