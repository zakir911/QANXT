import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type {
  ActionResultReport, ArtifactReport, DiscoveryCompletionReport, ExecutionCompletionReport
} from '@aira/shared-types';
import type { Logger } from '../util/logger.js';

/**
 * The worker's only channel back to the control plane.
 *
 * Every call carries the job-scoped token the job arrived with, so a worker can only
 * write results for the job it was given. Requests are retried on transient failures
 * because losing a completed run's results to one network blip would throw away real
 * browser work; they are never retried on a 4xx, which means the control plane refused
 * this request and will refuse it again.
 */

export interface ControlPlaneClientOptions {
  baseUrl: string;
  token: string;
  logger: Logger;
  maxAttempts?: number;
}

export class ControlPlaneError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly logger: Logger;
  private readonly maxAttempts: number;

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.logger = options.logger;
    this.maxAttempts = options.maxAttempts ?? 4;
  }

  // ---- Discovery -----------------------------------------------------------

  async discoveryStarted(runId: string, workerId: string): Promise<void> {
    await this.post(`/api/v1/worker/discovery/${runId}/started`, { workerId });
  }

  async discoveryProgress(runId: string, progress: {
    pagesVisited: number; pagesQueued: number; elementsFound: number;
    currentUrl?: string; message: string;
  }): Promise<void> {
    // Progress is advisory. Losing one update must never interrupt a crawl.
    try {
      await this.post(`/api/v1/worker/discovery/${runId}/progress`, progress, { attempts: 1 });
    } catch (error) {
      this.logger.debug('A discovery progress update could not be delivered', { error: String(error) });
    }
  }

  async discoveryComplete(runId: string, report: DiscoveryCompletionReport): Promise<void> {
    await this.post(`/api/v1/worker/discovery/${runId}/complete`, report);
  }

  // ---- Execution -----------------------------------------------------------

  async executionStarted(executionId: string, workerId: string): Promise<void> {
    await this.post(`/api/v1/worker/executions/${executionId}/started`, { workerId });
  }

  async executionAction(executionId: string, action: ActionResultReport): Promise<void> {
    try {
      await this.post(`/api/v1/worker/executions/${executionId}/actions`, action, { attempts: 2 });
    } catch (error) {
      // The action is also included in the completion report, so a dropped live update
      // costs the console a refresh, not the record.
      this.logger.debug('An action update could not be delivered', { error: String(error) });
    }
  }

  async executionComplete(executionId: string, report: ExecutionCompletionReport): Promise<void> {
    await this.post(`/api/v1/worker/executions/${executionId}/complete`, report);
  }

  // ---- Artifacts -----------------------------------------------------------

  /**
   * Uploads a local file and returns the key the store assigned. The worker never chooses
   * the key: the control plane owns where evidence lands.
   */
  async uploadArtifact(localPath: string, name: string, contentType: string): Promise<string> {
    const url = `${this.baseUrl}/api/v1/worker/artifacts`
      + `?name=${encodeURIComponent(name)}&contentType=${encodeURIComponent(contentType)}`;

    return this.withRetry(`upload ${name}`, this.maxAttempts, async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': contentType },
        body: Readable.toWeb(createReadStream(localPath)) as unknown as WebReadableStream<Uint8Array>,
        // Node's fetch requires duplex for a streaming body.
        duplex: 'half'
      } as RequestInit & { duplex: 'half' });

      await this.ensureOk(response, `upload ${name}`);
      const body = await response.json() as { storageKey: string };
      return body.storageKey;
    });
  }

  /**
   * The stored visual baseline for one check, or null when there is none yet.
   *
   * A 404 is the ordinary answer on a first run, and is returned as null rather than
   * thrown: "no baseline existed" is a verdict the caller reports, not an error.
   */
  async visualBaseline(executionId: string, query: {
    name: string; browser: string; width: number; height: number;
  }): Promise<Buffer | null> {
    const url = `${this.baseUrl}/api/v1/worker/executions/${executionId}/visual-baseline`
      + `?name=${encodeURIComponent(query.name)}&browser=${encodeURIComponent(query.browser)}`
      + `&width=${query.width}&height=${query.height}`;

    return this.withRetry(`read baseline ${query.name}`, this.maxAttempts, async () => {
      const response = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
      if (response.status === 404) return null;
      await this.ensureOk(response, `read baseline ${query.name}`);
      return Buffer.from(await response.arrayBuffer());
    });
  }

  /** Stores a capture as the baseline for one visual check. */
  async putVisualBaseline(executionId: string, query: {
    name: string; browser: string; width: number; height: number;
    imageWidth: number; imageHeight: number;
  }, png: Buffer): Promise<string> {
    const url = `${this.baseUrl}/api/v1/worker/executions/${executionId}/visual-baseline`
      + `?name=${encodeURIComponent(query.name)}&browser=${encodeURIComponent(query.browser)}`
      + `&width=${query.width}&height=${query.height}`
      + `&imageWidth=${query.imageWidth}&imageHeight=${query.imageHeight}`;

    return this.withRetry(`store baseline ${query.name}`, this.maxAttempts, async () => {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'image/png' },
        body: new Uint8Array(png)
      });
      await this.ensureOk(response, `store baseline ${query.name}`);
      const body = await response.json() as { storageKey: string };
      return body.storageKey;
    });
  }

  /**
   * Uploads every artifact in a report and rewrites its storage keys in place. Artifacts
   * that cannot be uploaded are dropped from the report rather than left pointing at a
   * path on a worker that is about to disappear.
   */
  async uploadArtifacts(artifacts: ArtifactReport[]): Promise<ArtifactReport[]> {
    const uploaded: ArtifactReport[] = [];

    for (const artifact of artifacts) {
      try {
        const key = await this.uploadArtifact(artifact.storageKey, artifact.name, artifact.contentType);
        uploaded.push({ ...artifact, storageKey: key });
      } catch (error) {
        this.logger.error('An artifact could not be uploaded and will not be referenced', error, {
          artifact: artifact.name
        });
      }
    }

    return uploaded;
  }

  // ---- Plumbing ------------------------------------------------------------

  private async post(path: string, body: unknown, options: { attempts?: number } = {}): Promise<void> {
    const attempts = options.attempts ?? this.maxAttempts;
    await this.withRetry(`POST ${path}`, attempts, async () => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      await this.ensureOk(response, path);
      return undefined;
    });
  }

  private async ensureOk(response: Response, what: string): Promise<void> {
    if (response.ok) return;
    const text = await response.text().catch(() => '');
    // 408, 429 and 5xx are worth another attempt; anything else is a decision, not a blip.
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    throw new ControlPlaneError(
      `${what} failed with ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`,
      response.status, retryable);
  }

  private async withRetry<T>(what: string, attempts: number, operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ControlPlaneError ? error.retryable : true;
        if (!retryable || attempt === attempts) break;

        const delay = Math.min(8000, 2 ** (attempt - 1) * 500);
        this.logger.warn(`${what} failed; retrying`, { attempt, attempts, delayMs: delay, error: String(error) });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}
