import { createServer } from 'node:http';
import type { DiscoveryJob, ExecutionJob, SecurityScanJob } from '@qa-nxt/shared-types';
import { QUEUE_NAMES } from '@qa-nxt/shared-types';
import { BrowserPool } from './browser/browser-pool.js';
import { loadConfig, type WorkerConfig } from './config.js';
import { handleDiscoveryJob } from './discovery/discovery-handler.js';
import { handleExecutionJob } from './execution/execution-handler.js';
import { handleSecurityScanJob } from './security/security-handler.js';
import { RedisStreamConsumer, type QueuedJob } from './queue/redis-consumer.js';
import { Logger } from './util/logger.js';

/**
 * Browser worker entry point.
 *
 * The worker is stateless: it holds browsers and nothing else. Scaling out means starting
 * another process in the same consumer group. Shutdown is graceful — in-flight runs are
 * given time to report their results, because a browser run that completes and is then
 * thrown away is worse than one that never started.
 */

const config = loadConfig();
const logger = new Logger(config.logLevel, { workerId: config.workerId });

const pool = new BrowserPool(config.headless, logger);
const inFlight = new Set<Promise<void>>();
const abort = new AbortController();
let shuttingDown = false;

const discoveryConsumer = new RedisStreamConsumer({
  redisUrl: config.redisUrl,
  queue: QUEUE_NAMES.discovery,
  group: 'qanxt-workers',
  consumer: config.workerId,
  visibilityMs: config.jobVisibilityMs,
  blockMs: config.pollIntervalMs,
  logger: logger.child({ queue: QUEUE_NAMES.discovery })
});

const executionConsumer = new RedisStreamConsumer({
  redisUrl: config.redisUrl,
  queue: QUEUE_NAMES.execution,
  group: 'qanxt-workers',
  consumer: config.workerId,
  visibilityMs: config.jobVisibilityMs,
  blockMs: config.pollIntervalMs,
  logger: logger.child({ queue: QUEUE_NAMES.execution })
});

/**
 * Security scans get their own consumer.
 *
 * Sharing the execution queue would mean a long scan sitting behind a test run a pipeline is
 * waiting on, or the reverse. They are different work with different latencies, and the
 * concurrency budget is shared across all three so a scan cannot starve the others either.
 */
const securityConsumer = new RedisStreamConsumer({
  redisUrl: config.redisUrl,
  queue: QUEUE_NAMES.security,
  group: 'qanxt-workers',
  consumer: config.workerId,
  visibilityMs: config.jobVisibilityMs,
  blockMs: config.pollIntervalMs,
  logger: logger.child({ queue: QUEUE_NAMES.security })
});

async function main(): Promise<void> {
  logger.info('Browser worker starting', {
    controlPlane: config.controlPlaneUrl,
    concurrency: config.concurrency,
    browser: config.defaultBrowser,
    headless: config.headless
  });

  startHealthEndpoint(config, logger);

  // Discovery and execution are consumed in parallel so a long crawl never starves the
  // test runs a pipeline is waiting on.
  await Promise.all([
    consume(discoveryConsumer, 'discovery', job => handleDiscoveryJob(job as DiscoveryJob, pool, config, logger, abort.signal)),
    consume(executionConsumer, 'execution', job => handleExecutionJob(job as ExecutionJob, pool, config, logger, abort.signal)),
    // The pool is passed but rarely used: every check but xss.dom is decided from a response,
    // and a browser is opened only when a scan actually asks for one.
    consume(securityConsumer, 'security', job => handleSecurityScanJob(job as SecurityScanJob, pool, config, logger, abort.signal))
  ]);
}

async function consume(
  consumer: RedisStreamConsumer,
  kind: string,
  handle: (payload: unknown) => Promise<void>
): Promise<void> {
  while (!shuttingDown) {
    try {
      const capacity = config.concurrency - inFlight.size;
      if (capacity <= 0) {
        await sleep(250);
        continue;
      }

      const jobs = await consumer.read(capacity);
      for (const job of jobs) {
        const work = runJob(consumer, kind, job, handle);
        inFlight.add(work);
        void work.finally(() => inFlight.delete(work));
      }
    } catch (error) {
      if (shuttingDown) break;
      logger.error(`The ${kind} consumer loop failed; retrying shortly`, error);
      await sleep(2000);
    }
  }
}

async function runJob(
  consumer: RedisStreamConsumer,
  kind: string,
  job: QueuedJob,
  handle: (payload: unknown) => Promise<void>
): Promise<void> {
  const started = Date.now();
  try {
    await handle(job.payload);
    await consumer.acknowledge(job.id);
    logger.info(`Finished a ${kind} job`, { jobId: job.id, durationMs: Date.now() - started });
  } catch (error) {
    // The job stays pending. After the visibility window another worker reclaims it,
    // which is the right behaviour for a crashed browser or a transient network fault.
    logger.error(`A ${kind} job failed and will be retried by another consumer`, error, {
      jobId: job.id, durationMs: Date.now() - started
    });
    await consumer.release(job.id, error instanceof Error ? error.message : String(error));
  }
}

/** A liveness and readiness endpoint so an orchestrator can see the worker is healthy. */
function startHealthEndpoint(config: WorkerConfig, logger: Logger): void {
  const port = Number(process.env.WORKER_HEALTH_PORT ?? 9091);
  const server = createServer(async (req, res) => {
    if (req.url === '/live') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'alive', workerId: config.workerId }));
      return;
    }

    if (req.url === '/health' || req.url === '/ready') {
      const depth = await discoveryConsumer.depth().catch(() => -1);
      const healthy = depth >= 0 && !shuttingDown;
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: healthy ? 'ready' : 'not-ready',
        workerId: config.workerId,
        inFlight: inFlight.size,
        capacity: config.concurrency,
        queueDepth: depth
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => logger.info('Worker health endpoint listening', { port }));
  server.unref();
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { signal, inFlight: inFlight.size });

  // Give in-flight runs a chance to report their results before the browsers go away.
  const grace = Number(process.env.WORKER_SHUTDOWN_GRACE_MS ?? 30_000);
  const deadline = Date.now() + grace;
  while (inFlight.size > 0 && Date.now() < deadline) await sleep(250);

  if (inFlight.size > 0) {
    logger.warn('Aborting runs that did not finish within the grace period', { remaining: inFlight.size });
    abort.abort();
    await sleep(2000);
  }

  await pool.close();
  await discoveryConsumer.close();
  await executionConsumer.close();
  await securityConsumer.close();
  logger.info('Shutdown complete');
  process.exit(0);
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', reason => logger.error('Unhandled promise rejection', reason));

main().catch(error => {
  logger.error('The worker failed to start', error);
  process.exit(1);
});
