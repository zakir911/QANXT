import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserContext, ConsoleMessage, Page, Request, Response } from 'playwright';
import type {
  ApiResponseRecord, ArtifactReport, ConsoleEventReport, NetworkEventReport
} from '@qa-nxt/shared-types';
import type { SecretMasker } from '../security/masker.js';
import type { Logger } from '../util/logger.js';

/**
 * Collects everything needed to explain, later, what the browser actually did.
 *
 * Evidence is captured at the moment it exists and masked before it touches disk: a
 * screenshot, DOM snapshot or HAR taken from a signed-in session routinely contains
 * tokens, names and balances, and masking only at upload time would mean the plaintext
 * had already been written.
 */
export class EvidenceCollector {
  private readonly artifacts: ArtifactReport[] = [];
  private readonly consoleEvents: ConsoleEventReport[] = [];
  private readonly networkEvents: NetworkEventReport[] = [];
  private currentActionOrder: number | undefined;
  /** When each request left, so a response's duration is honest when the browser's own
   *  timing is not yet complete at the moment the response event fires. */
  private readonly requestStartedAt = new WeakMap<Request, number>();
  /** Responses still being recorded. An assertion about the network waits for them. */
  private readonly pending = new Set<Promise<void>>();
  /** Document and API requests that have left and not yet finished or failed. */
  private readonly inFlight = new Set<Request>();

  constructor(
    private readonly directory: string,
    private readonly masker: SecretMasker,
    private readonly logger: Logger
  ) {}

  /** Tags subsequent evidence with the action that produced it. */
  setCurrentAction(order: number | undefined): void {
    this.currentActionOrder = order;
  }

  attach(page: Page): void {
    page.on('console', (message: ConsoleMessage) => {
      const type = message.type();
      if (type !== 'error' && type !== 'warning') return;
      this.consoleEvents.push({
        level: type === 'error' ? 'error' : 'warn',
        message: this.masker.maskText(message.text()).slice(0, 8000),
        url: safeUrl(page),
        occurredAt: new Date().toISOString(),
        actionOrder: this.currentActionOrder
      });
    });

    page.on('pageerror', error => {
      this.consoleEvents.push({
        level: 'pageerror',
        message: this.masker.maskText(error.message).slice(0, 8000),
        stackTrace: this.masker.maskText(error.stack ?? '').slice(0, 20_000),
        url: safeUrl(page),
        occurredAt: new Date().toISOString(),
        actionOrder: this.currentActionOrder
      });
    });

    page.on('requestfailed', request => {
      this.networkEvents.push({
        method: request.method(),
        url: this.masker.maskText(request.url()).slice(0, 2000),
        resourceType: request.resourceType(),
        durationMs: 0,
        requestSizeBytes: request.postData()?.length ?? 0,
        responseSizeBytes: 0,
        isFailed: true,
        failureText: request.failure()?.errorText ?? 'The request failed.',
        occurredAt: new Date().toISOString(),
        actionOrder: this.currentActionOrder
      });
    });

    page.on('request', (request: Request) => {
      this.requestStartedAt.set(request, Date.now());
      if (['document', 'xhr', 'fetch'].includes(request.resourceType())) this.inFlight.add(request);
    });
    page.on('requestfinished', (request: Request) => { this.inFlight.delete(request); });
    page.on('requestfailed', (request: Request) => { this.inFlight.delete(request); });

    page.on('response', (response: Response) => {
      const recording = this.recordResponse(response).catch(error =>
        this.logger.debug('Could not record a response', { error: String(error) }));
      this.pending.add(recording);
      void recording.finally(() => this.pending.delete(recording));
    });
  }

  private async recordResponse(response: Response): Promise<void> {
    const request = response.request();
    const resourceType = request.resourceType();
    // Documents and API calls carry meaning; images, fonts and stylesheets are noise that
    // would bury the evidence that matters.
    if (!['document', 'xhr', 'fetch'].includes(resourceType)) return;

    const timing = request.timing();
    // Playwright reports -1 for phases that never happened (a cached response has no
    // request start); falling back keeps the duration honest rather than reporting 0.
    // When the response event fires before the body has finished, responseEnd is still -1;
    // the time from the request leaving to the response arriving is then the honest
    // figure. Reporting 0 instead made a three-second submission look instantaneous.
    const started = this.requestStartedAt.get(request);
    const durationMs = timing.responseEnd > 0
      ? Math.max(0, Math.round(timing.responseEnd - Math.max(0, timing.requestStart)))
      : started !== undefined ? Math.max(0, Date.now() - started) : 0;
    const contentType = response.headers()['content-type'] ?? '';
    let responseBody: string | undefined;

    if (contentType.includes('json') || contentType.includes('text/plain')) {
      try {
        const text = await response.text();
        responseBody = this.masker.maskJson(text).slice(0, 8000);
      } catch {
        // Bodies are not always retrievable (redirects, aborted requests). The event is
        // still worth keeping without one.
      }
    }

    const postData = request.postData();
    this.networkEvents.push({
      method: request.method(),
      url: this.masker.maskText(response.url()).slice(0, 2000),
      resourceType,
      statusCode: response.status(),
      durationMs,
      requestSizeBytes: postData?.length ?? 0,
      responseSizeBytes: Number(response.headers()['content-length'] ?? 0),
      requestHeaders: this.masker.maskHeaders(request.headers()),
      responseHeaders: this.masker.maskHeaders(response.headers()),
      requestBodyExcerpt: postData ? this.masker.maskJson(postData).slice(0, 8000) : undefined,
      responseBodyExcerpt: responseBody,
      isFailed: response.status() >= 400,
      occurredAt: new Date().toISOString(),
      actionOrder: this.currentActionOrder
    });
  }

  /**
   * Records a request the API runner performed.
   *
   * It is stored as a network event rather than as a new kind of thing, because it is one:
   * the same table already holds the calls the browser made, tagged with the action that
   * caused them. Keeping both in one place is what lets a report say "this UI step failed
   * and here is the API call underneath it" without a second join, and it means API
   * evidence appears in the existing reports, the existing console and the existing
   * correlation logic with nothing added.
   *
   * The record arrives already masked — masking here would be too late, because the caller
   * has the unmasked values.
   */
  recordApiExchange(record: ApiResponseRecord): void {
    this.networkEvents.push({
      method: record.requestMethod,
      url: record.requestUrl.slice(0, 2000),
      // Distinguishes a call QA NXT made deliberately from one the page happened to make.
      resourceType: 'apiTest',
      statusCode: record.transportError ? undefined : record.statusCode,
      durationMs: record.durationMs,
      requestSizeBytes: record.requestBodyExcerpt ? Buffer.byteLength(record.requestBodyExcerpt) : 0,
      responseSizeBytes: record.responseSizeBytes,
      requestHeaders: record.requestHeaders,
      responseHeaders: record.responseHeaders,
      requestBodyExcerpt: record.requestBodyExcerpt,
      responseBodyExcerpt: record.responseBodyExcerpt,
      isFailed: record.transportError !== undefined || record.statusCode >= 400,
      failureText: record.transportError,
      occurredAt: new Date().toISOString(),
      actionOrder: this.currentActionOrder
    });
  }

  /** Writes the full exchange as a file, so a failure can be read without the database. */
  async writeApiExchange(name: string, record: ApiResponseRecord): Promise<ArtifactReport | undefined> {
    try {
      await mkdir(this.directory, { recursive: true });
      const fileName = `${safeName(name)}.http.json`;
      const path = join(this.directory, fileName);
      await writeFile(path, JSON.stringify(record, null, 2), 'utf8');
      return this.register('other', fileName, path, 'application/json', true);
    } catch (error) {
      this.logger.warn('Could not write an API exchange', { name, error: String(error) });
      return undefined;
    }
  }

  async screenshot(page: Page, name: string, fullPage = false): Promise<ArtifactReport | undefined> {
    try {
      await mkdir(this.directory, { recursive: true });
      const fileName = `${safeName(name)}.png`;
      const path = join(this.directory, fileName);
      await page.screenshot({ path, fullPage, animations: 'disabled' });
      return this.register('screenshot', fileName, path, 'image/png', false);
    } catch (error) {
      this.logger.warn('Screenshot failed', { name, error: String(error) });
      return undefined;
    }
  }

  async domSnapshot(page: Page, name: string): Promise<ArtifactReport | undefined> {
    try {
      await mkdir(this.directory, { recursive: true });
      const fileName = `${safeName(name)}.html`;
      const path = join(this.directory, fileName);
      await writeFile(path, this.masker.maskText(await page.content()), 'utf8');
      return this.register('domSnapshot', fileName, path, 'text/html', true);
    } catch (error) {
      this.logger.warn('DOM snapshot failed', { name, error: String(error) });
      return undefined;
    }
  }

  async accessibilitySnapshot(page: Page, name: string): Promise<ArtifactReport | undefined> {
    try {
      const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
      if (!snapshot) return undefined;
      await mkdir(this.directory, { recursive: true });
      const fileName = `${safeName(name)}.a11y.json`;
      const path = join(this.directory, fileName);
      await writeFile(path, this.masker.maskJson(JSON.stringify(snapshot, null, 2)), 'utf8');
      return this.register('accessibilityTree', fileName, path, 'application/json', true);
    } catch (error) {
      this.logger.warn('Accessibility snapshot failed', { name, error: String(error) });
      return undefined;
    }
  }

  /** Registers a file Playwright itself wrote (trace, video, HAR). */
  async registerExternal(kind: ArtifactReport['kind'], fileName: string, path: string, contentType: string): Promise<ArtifactReport | undefined> {
    try {
      return await this.register(kind, fileName, path, contentType, false);
    } catch (error) {
      this.logger.warn('Could not register an artifact', { fileName, error: String(error) });
      return undefined;
    }
  }

  /** Writes the console and network logs as artifacts of their own. */
  async writeLogs(prefix: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });

    if (this.consoleEvents.length > 0) {
      const fileName = `${safeName(prefix)}.console.json`;
      const path = join(this.directory, fileName);
      await writeFile(path, JSON.stringify(this.consoleEvents, null, 2), 'utf8');
      await this.register('consoleLog', fileName, path, 'application/json', true);
    }

    if (this.networkEvents.length > 0) {
      const fileName = `${safeName(prefix)}.network.json`;
      const path = join(this.directory, fileName);
      await writeFile(path, JSON.stringify(this.networkEvents, null, 2), 'utf8');
      await this.register('networkLog', fileName, path, 'application/json', true);
    }
  }

  private async register(
    kind: ArtifactReport['kind'], name: string, path: string, contentType: string, isMasked: boolean
  ): Promise<ArtifactReport> {
    const info = await stat(path);
    const artifact: ArtifactReport = {
      kind,
      name,
      // The key is assigned by the artifact store on upload; until then the local path
      // stands in so the uploader knows what to send.
      storageKey: path,
      contentType,
      sizeBytes: info.size,
      sha256: await hashFile(path),
      isMasked,
      actionOrder: this.currentActionOrder
    };
    this.artifacts.push(artifact);
    return artifact;
  }

  /**
   * Waits until every request that has left has come back, and every response has been
   * recorded — bounded, because a long-poll or a stream never finishes.
   *
   * The page's own "network idle" is not enough: it is a load state, reached once, and asking
   * for it again after a submission resolves at once. An assertion about what a submission
   * sent then ran while the submission was still in flight and counted nothing, which hid a
   * real double submission behind a pass.
   */
  async settle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // A request a click has only just triggered may not have been issued yet.
    await new Promise(resolve => setTimeout(resolve, 100));
    while ((this.inFlight.size > 0 || this.pending.size > 0) && Date.now() < deadline) {
      if (this.pending.size > 0) await Promise.race([Promise.allSettled([...this.pending]), new Promise(r => setTimeout(r, 200))]);
      else await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  getArtifacts(): ArtifactReport[] { return this.artifacts; }
  getConsoleEvents(): ConsoleEventReport[] { return this.consoleEvents; }
  getNetworkEvents(): NetworkEventReport[] { return this.networkEvents; }

  countConsoleErrors(): number {
    return this.consoleEvents.filter(e => e.level === 'error' || e.level === 'pageerror').length;
  }

  countNetworkErrors(): number {
    return this.networkEvents.filter(e => e.isFailed).length;
  }
}

/** Stops video and registers the file Playwright wrote for it. */
export async function collectVideo(
  context: BrowserContext, page: Page, collector: EvidenceCollector, logger: Logger
): Promise<void> {
  const video = page.video();
  if (!video) return;
  try {
    await page.close();          // the video file is only finalised once the page closes
    const path = await video.path();
    await collector.registerExternal('video', path.split('/').pop() ?? 'execution.webm', path, 'video/webm');
  } catch (error) {
    logger.warn('Video capture failed', { error: String(error) });
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}

function safeUrl(page: Page): string | undefined {
  try { return page.url(); } catch { return undefined; }
}
