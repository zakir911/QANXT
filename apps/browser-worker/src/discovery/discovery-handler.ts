import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryCompletionReport, DiscoveryJob } from '@qa-nxt/shared-types';
import { ControlPlaneClient } from '../api/control-plane-client.js';
import type { BrowserPool } from '../browser/browser-pool.js';
import type { WorkerConfig } from '../config.js';
import type { Logger } from '../util/logger.js';
import { classifyFailure } from '../queue/permanent-failure.js';
import { Crawler } from './crawler.js';

/**
 * Runs one discovery job: crawl the application, upload the evidence, hand the map back.
 *
 * Artifacts are uploaded before the report is sent so that the report never references a
 * file that does not exist in the store — a page node pointing at a screenshot on a
 * worker that has since been recycled is worse than one with no screenshot at all.
 *
 * Any failure after the run was marked running is reported back before it is rethrown.
 * Previously there was no catch at all: a browser that would not launch threw straight past
 * this function, the control plane was never told, and the run it had just marked Running
 * stayed that way indefinitely while the queue re-delivered the job forever. The throw is
 * still needed — the queue decides whether to retry — but the user finds out either way.
 */
export async function handleDiscoveryJob(
  job: DiscoveryJob,
  pool: BrowserPool,
  config: WorkerConfig,
  parentLogger: Logger,
  signal?: AbortSignal
): Promise<void> {
  const logger = parentLogger.child({
    discoveryRunId: job.discoveryRunId,
    correlationId: job.correlationId,
    tenantId: job.organizationId,
    projectId: job.projectId
  });

  const client = new ControlPlaneClient({
    baseUrl: job.callbackBaseUrl,
    token: job.callbackToken,
    logger
  });

  const artifactDir = await mkdtemp(join(tmpdir(), `qanxt-discovery-${job.discoveryRunId}-`));

  try {
    await client.discoveryStarted(job.discoveryRunId, config.workerId);
    logger.info('Starting discovery', { baseUrl: job.baseUrl, maxPages: job.budget.maxPages });

    const context = await pool.createContext(job.browser, {
      defaultTimeoutMs: config.actionTimeoutMs,
      navigationTimeoutMs: config.navigationTimeoutMs
    });

    let report: DiscoveryCompletionReport;
    try {
      const crawler = new Crawler(context, {
        baseUrl: job.baseUrl,
        budget: job.budget,
        auth: job.auth,
        artifactDir,
        navigationTimeoutMs: config.navigationTimeoutMs,
        onProgress: (message, visited, queued) => client.discoveryProgress(job.discoveryRunId, {
          pagesVisited: visited, pagesQueued: queued, elementsFound: 0, message
        })
      }, logger);

      report = await crawler.run(job.discoveryRunId, config.workerId, signal);
    } finally {
      await context.close().catch(() => undefined);
    }

    await uploadPageArtifacts(report, artifactDir, client, logger);

    await client.discoveryComplete(job.discoveryRunId, report);
    logger.info('Discovery complete', {
      status: report.status,
      pages: report.pages.length,
      apiEndpoints: report.apiEndpoints.length
    });
  } catch (error) {
    const verdict = classifyFailure(error);

    // Reported on a best effort: if the control plane is the thing that is unreachable this
    // will fail too, and the run is then reconciled by the API's own sweep. Losing the
    // report must not replace the original error with a reporting error.
    try {
      await client.discoveryFailed(
        job.discoveryRunId, verdict.reason, verdict.permanent, config.workerId);
    } catch (reportFailure) {
      logger.error('The discovery failure could not be reported to the control plane',
        reportFailure, { originalReason: verdict.reason });
    }

    throw error;
  } finally {
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Replaces each page's local file names with the keys the artifact store assigned. */
async function uploadPageArtifacts(
  report: DiscoveryCompletionReport,
  artifactDir: string,
  client: ControlPlaneClient,
  logger: Logger
): Promise<void> {
  for (const page of report.pages) {
    page.screenshotKey = await upload(page.screenshotKey, 'image/png');
    page.domKey = await upload(page.domKey, 'text/html');
    page.accessibilityKey = await upload(page.accessibilityKey, 'application/json');
  }

  async function upload(fileName: string | undefined, contentType: string): Promise<string | undefined> {
    if (!fileName) return undefined;
    try {
      return await client.uploadArtifact(join(artifactDir, fileName), fileName, contentType);
    } catch (error) {
      // A missing screenshot must not cost us the page it belongs to.
      logger.warn('A discovery artifact could not be uploaded', { fileName, error: String(error) });
      return undefined;
    }
  }
}
