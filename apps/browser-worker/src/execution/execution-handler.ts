import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionJob } from '@qa-nxt/shared-types';
import { ControlPlaneClient } from '../api/control-plane-client.js';
import { createBaselineStore } from './baseline-store.js';
import type { BrowserPool } from '../browser/browser-pool.js';
import type { WorkerConfig } from '../config.js';
import type { Logger } from '../util/logger.js';
import { TestExecutor } from './executor.js';

/**
 * Runs one test execution and reports it.
 *
 * The result is delivered whatever happened — pass, fail, blocked or error. A worker that
 * quietly drops a run leaves an execution stuck in Running forever, which reads to a user
 * as a platform that lost their test rather than a test that failed.
 */
export async function handleExecutionJob(
  job: ExecutionJob,
  pool: BrowserPool,
  config: WorkerConfig,
  parentLogger: Logger,
  signal?: AbortSignal
): Promise<void> {
  const logger = parentLogger.child({
    executionId: job.executionId,
    testCaseId: job.testCaseId,
    correlationId: job.correlationId,
    tenantId: job.organizationId,
    projectId: job.projectId
  });

  const client = new ControlPlaneClient({
    baseUrl: job.callbackBaseUrl,
    token: job.callbackToken,
    logger
  });

  const artifactRoot = await mkdtemp(join(tmpdir(), `qanxt-exec-${job.executionId}-`));

  try {
    await client.executionStarted(job.executionId, config.workerId);
    logger.info('Starting execution', { testCase: job.testCaseName, browser: job.browser, attempt: job.attempt });

    const executor = new TestExecutor(pool, logger);
    const report = await executor.execute(job, {
      workerId: config.workerId,
      artifactRoot,
      onActionCompleted: action => client.executionAction(job.executionId, action),
      // Baselines outlive a run, so they live in the control plane rather than beside the
      // run's evidence. The three images a reviewer needs on a difference are ordinary
      // artifacts; only the agreed appearance is kept separately.
      visualStore: createBaselineStore(client, job)
    }, signal);

    report.artifacts = await client.uploadArtifacts(report.artifacts);
    await client.executionComplete(job.executionId, report);

    logger.info('Execution complete', {
      status: report.status,
      durationMs: report.durationMs,
      stepsPassed: report.stepsPassed,
      stepsFailed: report.stepsFailed,
      stepsHealed: report.stepsHealed
    });
  } finally {
    await rm(artifactRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
