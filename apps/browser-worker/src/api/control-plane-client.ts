import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type {
  ActionResultReport, ArtifactReport, DiscoveryCompletionReport, ExecutionCompletionReport
} from '@qa-nxt/shared-types';
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
  /**
   * What this client may ask for a fresh token for, when the one it was handed has
   * expired. Both are needed, plus the fleet's shared secret; without them the client
   * simply cannot renew, and a refusal stays a refusal.
   */
  job?: { id: string; scope: 'execution' | 'discovery' | 'security' };
  workerSecret?: string;
}

export class ControlPlaneError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly maxAttempts: number;
  private readonly job: ControlPlaneClientOptions['job'];
  private readonly workerSecret: string | undefined;

  /**
   * Mutable, because a job's callback token can expire before the job is ever picked up.
   * A run that designs more tests than the fleet can finish inside one token's life used
   * to be unfinishable: the credential was stamped when the job was queued, and queue time
   * depends on the size of the suite and the size of the fleet, neither of which the
   * control plane knows when it stamps it. The client now replaces an expired token rather
   * than carrying a dead one to the end of its retry budget.
   */
  private token: string;

  /** One renewal per client, and a client serves one job. A second 401 is a real refusal. */
  private renewalTried = false;

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.logger = options.logger;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.job = options.job;
    this.workerSecret = options.workerSecret;
  }

  // ---- Security ------------------------------------------------------------

  /**
   * Reports what a security scan did and what it found.
   *
   * The control plane refuses a finding with no exchange behind it and refuses a scan against
   * an application with no enabled scope, so this can be rejected with a 4xx — which is not
   * retried, because it will be refused again. A worker that kept retrying a refused scan
   * would turn one defect into a loop.
   */
  async securityScanCompleted(scanId: string, report: unknown): Promise<void> {
    await this.post(`/api/v1/worker/security/${scanId}/completed`, report);
  }

  // ---- Discovery -----------------------------------------------------------

  async discoveryStarted(runId: string, workerId: string): Promise<void> {
    await this.post(`/api/v1/worker/discovery/${runId}/started`, { workerId });
  }

  /**
   * Reports progress, and returns whatever the control plane says to do next.
   *
   * The figures are advisory and losing one must never interrupt a crawl, so any failure
   * here answers "carry on". The answer itself is not advisory: it is how a cancelled run
   * reaches a crawl that is already in flight, and the only such channel there is.
   */
  async discoveryProgress(runId: string, progress: {
    pagesVisited: number; pagesQueued: number; elementsFound: number;
    currentUrl?: string; message: string;
  }): Promise<{ shouldStop: boolean; reason?: string }> {
    try {
      const ack = await this.postForJson<{ shouldStop?: boolean; reason?: string }>(
        `/api/v1/worker/discovery/${runId}/progress`, progress, { attempts: 1 });
      return { shouldStop: ack?.shouldStop === true, ...(ack?.reason ? { reason: ack.reason } : {}) };
    } catch (error) {
      // A blip in the progress feed is not an instruction to stop crawling.
      this.logger.debug('A discovery progress update could not be delivered', { error: String(error) });
      return { shouldStop: false };
    }
  }

  async discoveryComplete(runId: string, report: DiscoveryCompletionReport): Promise<void> {
    await this.post(`/api/v1/worker/discovery/${runId}/complete`, report);
  }

  /**
   * Reports a crawl this worker could not finish.
   *
   * `permanent` means retrying cannot help, so the control plane ends the run now rather
   * than leaving it on Running until a sweep decides nobody is coming back. Delivering this
   * is the difference between a user seeing why a run stopped and a user watching a spinner
   * that never stops.
   */
  async discoveryFailed(
    runId: string, reason: string, permanent: boolean, workerId: string
  ): Promise<void> {
    await this.post(`/api/v1/worker/discovery/${runId}/failed`, { reason, permanent, workerId });
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

  /**
   * POSTs and reads the answer, for the one endpoint whose answer the worker acts on.
   *
   * Separate from `post` rather than making that generic: every other caller discards the
   * body, and a response that will not parse is not a reason to fail a delivery that the
   * server accepted.
   */
  private async postForJson<T>(path: string, body: unknown, options: { attempts?: number } = {}): Promise<T | undefined> {
    const attempts = options.attempts ?? this.maxAttempts;
    return await this.withRetry(`POST ${path}`, attempts, async () => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      await this.ensureOk(response, path);
      return await response.json().then(value => value as T).catch(() => undefined);
    });
  }

  /**
   * Exchanges the fleet's shared secret for a fresh token for this job.
   *
   * Returns false, quietly, whenever renewal is not possible: no secret configured, no job
   * identified, the control plane unreachable, or — the case that matters — the job is no
   * longer one that may report. A worker must not be able to talk its way back into a run
   * that has finished, so a refusal here is final and the original 401 stands.
   */
  private async renewToken(): Promise<boolean> {
    if (this.renewalTried) return false;
    this.renewalTried = true;

    if (!this.job || !this.workerSecret) {
      this.logger.debug('A callback token expired and this client has no way to renew it');
      return false;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/worker/jobs/${this.job.id}/token`, {
        method: 'POST',
        headers: { 'x-worker-secret': this.workerSecret, 'content-type': 'application/json' },
        body: JSON.stringify({ scope: this.job.scope })
      });

      if (!response.ok) {
        this.logger.warn('The control plane would not renew this job\'s callback token', {
          status: response.status, jobId: this.job.id
        });
        return false;
      }

      // Never logged, never stored anywhere but here.
      const body = await response.json() as { token?: unknown };
      if (typeof body?.token !== 'string' || body.token.length === 0) return false;

      this.token = body.token;
      this.logger.info('Renewed an expired callback token', { jobId: this.job.id });
      return true;
    } catch (error) {
      this.logger.warn('Could not reach the control plane to renew a callback token', {
        error: String(error)
      });
      return false;
    }
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

        // A 401 means the token, not the request, was refused. Replace it and try the same
        // call again without spending an attempt: the first try established that the
        // control plane is reachable and that the only thing wrong was the credential.
        if (error instanceof ControlPlaneError && error.status === 401 && await this.renewToken()) {
          attempt--;
          continue;
        }

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
