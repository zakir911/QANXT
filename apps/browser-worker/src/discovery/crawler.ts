import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, ConsoleMessage, Page, Request, Response } from 'playwright';
import type {
  AuthConfig, CrawlBudget, DiscoveredApiEndpoint, DiscoveredElement, DiscoveredPage,
  DiscoveredTransition, DiscoveryCompletionReport
} from '@aira/shared-types';
import { buildLocatorFor } from '../browser/locator-builder.js';
import { SecretMasker } from '../security/masker.js';
import { isUrlAllowed, normalizeUrl } from '../security/url-guard.js';
import type { Logger } from '../util/logger.js';
import { classifyPage, inferRequiresAuthentication } from './classify.js';
import { extractPage, type RawElement, type RawPageCapture } from './page-extractor.js';
import { performLogin, type LoginResult } from '../browser/authenticator.js';

/**
 * Bounded breadth-first exploration of an application.
 *
 * Every constraint here exists because an unbounded crawler is a hazard: it hammers the
 * target, follows itself round paginated loops forever, wanders onto third-party domains,
 * and eventually clicks something destructive. Depth, page, action and time budgets, URL
 * normalization, an allowlist and an exclusion list are all enforced before each
 * navigation, not after.
 */

export interface CrawlOptions {
  baseUrl: string;
  budget: CrawlBudget;
  auth: AuthConfig;
  artifactDir: string;
  navigationTimeoutMs: number;
  onProgress?: (message: string, visited: number, queued: number) => void | Promise<void>;
}

/** A mapped page plus the links found on it, which are crawl state rather than part of
 *  what is reported back to the control plane. */
interface CrawledPage extends DiscoveredPage {
  links: string[];
}

interface QueueEntry {
  url: string;
  depth: number;
  parentNormalizedUrl?: string;
  viaAccessibleName?: string;
}

export class Crawler {
  private readonly masker: SecretMasker;
  private readonly pages = new Map<string, CrawledPage>();
  private readonly transitions: DiscoveredTransition[] = [];
  private readonly apiEndpoints = new Map<string, DiscoveredApiEndpoint>();
  private readonly consoleErrors: { level: string; message: string; url?: string; occurredAt: string }[] = [];
  private readonly progressLog: string[] = [];
  private readonly visited = new Set<string>();
  /** Pages visited per route shape, e.g. "/accounts/*" -> 3. Loop protection. */
  private readonly routeShapeCounts = new Map<string, number>();
  private blockedByPolicy = 0;
  private actionsUsed = 0;

  constructor(
    private readonly context: BrowserContext,
    private readonly options: CrawlOptions,
    private readonly logger: Logger
  ) {
    this.masker = new SecretMasker().withLiterals([
      options.auth.password, options.auth.bearerToken, options.auth.username
    ]);
  }

  async run(discoveryRunId: string, workerId: string, signal?: AbortSignal): Promise<DiscoveryCompletionReport> {
    const startedAt = new Date().toISOString();
    const deadline = Date.now() + this.options.budget.timeoutSeconds * 1000;
    let status: DiscoveryCompletionReport['status'] = 'completed';
    let errorMessage: string | undefined;

    const page = await this.context.newPage();
    this.attachListeners(page);

    try {
      let authenticated = false;
      if (this.options.auth.strategy !== 'none') {
        // Map the sign-in page before signing in. Afterwards the application redirects a
        // signed-in visitor away from it, so this is the only moment it can be captured —
        // and a model with no sign-in screen cannot produce a sign-in test, which is the
        // one test almost every application needs (BUG-0008).
        await this.captureLoginPage(page);

        const login = await this.authenticate(page);
        authenticated = login.succeeded;
        if (!login.succeeded) {
          // Continuing would produce a map of the login page repeated many times, which
          // is worse than useless — it looks like a successful crawl.
          throw new Error(`Authentication failed: ${login.message}`);
        }
      }

      const queue: QueueEntry[] = [{ url: this.options.baseUrl, depth: 0 }];

      while (queue.length > 0) {
        if (signal?.aborted) { status = 'cancelled'; break; }

        if (Date.now() > deadline) {
          status = 'partiallyCompleted';
          this.note(`Stopped: the ${this.options.budget.timeoutSeconds}s exploration budget was reached.`);
          break;
        }
        if (this.pages.size >= this.options.budget.maxPages) {
          status = 'partiallyCompleted';
          this.note(`Stopped: the ${this.options.budget.maxPages}-page budget was reached.`);
          break;
        }
        if (this.actionsUsed >= this.options.budget.maxActions) {
          status = 'partiallyCompleted';
          this.note(`Stopped: the ${this.options.budget.maxActions}-action budget was reached.`);
          break;
        }

        const entry = queue.shift()!;
        const normalized = normalizeUrl(entry.url);
        if (this.visited.has(normalized)) continue;

        const guard = isUrlAllowed(entry.url, {
          allowedHosts: this.options.budget.allowedHosts,
          excludedPathPrefixes: this.options.budget.excludedPathPrefixes,
          allowPrivateNetworks: this.options.budget.allowPrivateNetworks
        });
        if (!guard.allowed) {
          this.blockedByPolicy++;
          this.note(`Skipped ${entry.url}: ${guard.reason}`);
          continue;
        }

        const shape = routeShapeOf(entry.url);
        const shapeCount = this.routeShapeCounts.get(shape) ?? 0;
        if (shapeCount >= this.options.budget.maxInstancesPerRouteShape) {
          // One more /accounts/<id> teaches nothing the first few did not; without this
          // cap a list of a thousand records is a thousand near-identical page nodes.
          this.note(`Skipped ${entry.url}: already mapped ${shapeCount} pages matching ${shape}.`);
          continue;
        }
        this.routeShapeCounts.set(shape, shapeCount + 1);

        this.visited.add(normalized);
        const discovered = await this.visit(page, entry, authenticated);
        if (!discovered) continue;

        await this.options.onProgress?.(
          `Explored ${discovered.route || '/'} (${discovered.elements.length} elements)`,
          this.pages.size, queue.length);

        if (entry.depth < this.options.budget.maxDepth) {
          for (const link of this.collectLinks(discovered, entry.depth)) {
            if (!this.visited.has(normalizeUrl(link.url))) queue.push(link);
          }
        }
      }
    } catch (error) {
      status = this.pages.size > 0 ? 'partiallyCompleted' : 'failed';
      errorMessage = this.masker.maskText(error instanceof Error ? error.message : String(error));
      this.logger.error('Discovery run failed', error, { discoveryRunId });
      this.note(`Discovery failed: ${errorMessage}`);
    } finally {
      await page.close().catch(() => undefined);
    }

    return {
      discoveryRunId,
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      workerId,
      // `links` is crawl state; the report carries only the page model.
      pages: [...this.pages.values()].map(({ links, ...page }) => page),
      transitions: this.transitions,
      apiEndpoints: [...this.apiEndpoints.values()],
      consoleErrors: this.consoleErrors,
      pagesBlockedByPolicy: this.blockedByPolicy,
      errorMessage,
      progressLog: this.progressLog.join('\n')
    };
  }

  /**
   * Visits and records the login page, unauthenticated.
   *
   * Failing here must not fail the run: the page is worth having, but it is not worth
   * losing a whole crawl over, and the sign-in that follows is the part that matters.
   */
  private async captureLoginPage(page: Page): Promise<void> {
    const loginUrl = this.options.auth.loginUrl;
    if (!loginUrl) return;

    const guard = isUrlAllowed(loginUrl, {
      allowedHosts: this.options.budget.allowedHosts,
      excludedPathPrefixes: this.options.budget.excludedPathPrefixes,
      allowPrivateNetworks: this.options.budget.allowPrivateNetworks
    });
    if (!guard.allowed) {
      this.note(`Did not map the sign-in page: ${guard.reason}`);
      return;
    }

    try {
      const normalized = normalizeUrl(loginUrl);
      this.visited.add(normalized);
      this.routeShapeCounts.set(routeShapeOf(loginUrl), 1);
      const captured = await this.visit(page, { url: loginUrl, depth: 0 }, false);
      if (captured) this.note(`Mapped the sign-in page before signing in (${captured.elements.length} elements).`);
    } catch (error) {
      this.note(`Could not map the sign-in page: ${this.masker.maskText(String(error))}`);
    }
  }

  private async authenticate(page: Page): Promise<LoginResult> {
    this.note('Signing in to the application under test.');
    const result = await performLogin(page, this.options.auth, {
      navigationTimeoutMs: this.options.navigationTimeoutMs,
      actionTimeoutMs: this.options.navigationTimeoutMs
    });
    this.note(result.succeeded ? 'Signed in successfully.' : `Sign-in failed: ${result.message}`);
    this.actionsUsed += result.actionsUsed;
    return result;
  }

  private async visit(page: Page, entry: QueueEntry, authenticated: boolean): Promise<CrawledPage | null> {
    const started = Date.now();
    let httpStatus: number | undefined;

    try {
      const response = await page.goto(entry.url, {
        waitUntil: 'domcontentloaded',
        timeout: this.options.navigationTimeoutMs
      });
      httpStatus = response?.status();
      this.actionsUsed++;

      // Single-page applications finish rendering after DOMContentLoaded; a short network
      // settle catches the content without waiting on long-poll connections that never idle.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    } catch (error) {
      this.note(`Could not load ${entry.url}: ${this.masker.maskText(error instanceof Error ? error.message : String(error))}`);
      return null;
    }

    const capture = await page.evaluate(extractPage, 400) as RawPageCapture;
    const loadTimeMs = Date.now() - started;
    const normalized = normalizeUrl(capture.url);

    // A redirect may have landed us somewhere already mapped (typically the login page).
    if (normalized !== normalizeUrl(entry.url) && this.pages.has(normalized)) {
      this.visited.add(normalized);
      return null;
    }

    const screenshotKey = await this.captureScreenshot(page, normalized);
    const domKey = await this.captureDom(page, normalized);
    const accessibilityKey = await this.captureAccessibilityTree(page, normalized);

    const discovered: CrawledPage = {
      url: capture.url,
      normalizedUrl: normalized,
      route: safeRoute(capture.url),
      title: capture.title,
      kind: classifyPage(capture),
      depth: entry.depth,
      parentNormalizedUrl: entry.parentNormalizedUrl,
      requiresAuthentication: inferRequiresAuthentication(capture, authenticated),
      httpStatus,
      loadTimeMs,
      consoleErrorCount: 0,
      visibleTextExcerpt: this.masker.maskText(capture.visibleTextExcerpt),
      screenshotKey,
      domKey,
      accessibilityKey,
      elements: capture.elements.map(element => this.toDiscoveredElement(element)),
      links: capture.links
    };

    this.pages.set(normalized, discovered);

    if (entry.parentNormalizedUrl && entry.parentNormalizedUrl !== normalized) {
      this.transitions.push({
        fromNormalizedUrl: entry.parentNormalizedUrl,
        toNormalizedUrl: normalized,
        action: 'click',
        triggerAccessibleName: entry.viaAccessibleName
      });
    }

    this.note(`Mapped ${discovered.route || '/'} — ${discovered.elements.length} elements, ${capture.links.length} links, kind=${discovered.kind}`);
    return discovered;
  }

  private collectLinks(page: CrawledPage, depth: number): QueueEntry[] {
    const links = page.links;
    const out: QueueEntry[] = [];
    const seen = new Set<string>();

    for (const href of links) {
      const normalized = normalizeUrl(href);
      if (seen.has(normalized) || this.visited.has(normalized)) continue;
      seen.add(normalized);

      const anchor = page.elements.find(e => e.kind === 'link' && e.attributes['href'] && href.endsWith(e.attributes['href']!));
      out.push({
        url: href,
        depth: depth + 1,
        parentNormalizedUrl: page.normalizedUrl,
        viaAccessibleName: anchor?.accessibleName
      });
    }
    return out;
  }

  private toDiscoveredElement(element: RawElement): DiscoveredElement {
    const built = buildLocatorFor(element);
    return {
      kind: element.kind as DiscoveredElement['kind'],
      tagName: element.tagName,
      ariaRole: element.ariaRole ?? undefined,
      accessibleName: element.accessibleName ? this.masker.maskText(element.accessibleName) : undefined,
      text: element.text ? this.masker.maskText(element.text) : undefined,
      label: element.label ?? undefined,
      placeholder: element.placeholder ?? undefined,
      testId: element.testId ?? undefined,
      elementId: element.elementId ?? undefined,
      name: element.name ?? undefined,
      type: element.type ?? undefined,
      title: element.title ?? undefined,
      // A field's current value can be customer data; it is masked like any other content.
      value: element.value ? this.masker.maskText(element.value) : undefined,
      cssSelector: element.cssSelector ?? undefined,
      xpath: element.xpath ?? undefined,
      domPath: element.domPath ?? undefined,
      parentSignature: element.parentSignature ?? undefined,
      neighbourText: element.neighbourText ? this.masker.maskText(element.neighbourText) : undefined,
      bounding: element.bounding,
      isVisible: element.isVisible,
      isEnabled: element.isEnabled,
      isRequired: element.isRequired,
      attributes: element.attributes,
      preferredLocator: built.preferred,
      stabilityScore: built.stability
    };
  }

  private attachListeners(page: Page): void {
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      this.consoleErrors.push({
        level: message.type() === 'error' ? 'error' : 'warn',
        message: this.masker.maskText(message.text()).slice(0, 4000),
        url: page.url(),
        occurredAt: new Date().toISOString()
      });
    });

    page.on('pageerror', error => {
      this.consoleErrors.push({
        level: 'pageerror',
        message: this.masker.maskText(error.message).slice(0, 4000),
        url: page.url(),
        occurredAt: new Date().toISOString()
      });
    });

    // API discovery: XHR/fetch traffic is the application's own API surface, which is
    // what later feeds API test generation and UI-action-to-call correlation.
    page.on('response', (response: Response) => {
      void this.recordApiCall(response).catch(() => undefined);
    });
  }

  private async recordApiCall(response: Response): Promise<void> {
    const request: Request = response.request();
    const resourceType = request.resourceType();
    if (resourceType !== 'xhr' && resourceType !== 'fetch') return;

    const url = response.url();
    const template = normalizeUrl(url);
    const key = `${request.method()} ${template}`;
    const timing = request.timing();
    const durationMs = timing.responseEnd > 0
      ? Math.max(0, Math.round(timing.responseEnd - Math.max(0, timing.requestStart)))
      : 0;

    const status = response.status();
    const isSuccess = status >= 200 && status < 300;

    let responseSample: string | undefined;
    const contentType = response.headers()['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      try {
        const body = await response.text();
        responseSample = this.masker.maskJson(body).slice(0, 4000);
      } catch {
        // A response body can be unavailable (redirects, aborted requests); the endpoint
        // is still worth recording without a sample.
      }
    }

    const existing = this.apiEndpoints.get(key);
    if (existing) {
      existing.timesObserved += 1;

      // The status and the sample must describe the same response.
      //
      // This used to set the status and return, leaving the sample from the first
      // observation. An endpoint seen signed-out and then signed-in — GET /api/session
      // answers 401 {"error":…} and then 200 {"user":…} — ended up recorded as status 200
      // carrying the 401 body. The contract baseline then inherited that pair, and every
      // later check compared a real success response against an error body it had never
      // actually returned with that status, reporting the absence of "error" as a breaking
      // change (BUG-0040).
      //
      // A success response wins and is not displaced by a later failure: the baseline is
      // meant to describe what a caller gets when the endpoint works, and a 401 picked up
      // while crawling signed-out pages is not that. Otherwise the most recent observation
      // wins, so an endpoint only ever seen failing is still recorded honestly.
      const existingIsSuccess = existing.statusCode !== undefined
        && existing.statusCode >= 200 && existing.statusCode < 300;
      if (isSuccess || !existingIsSuccess) {
        existing.statusCode = status;
        existing.responseSample = responseSample;
        existing.responseContentType = contentType || undefined;
      }
      return;
    }

    // allHeaders() includes headers the browser adds at the network layer (cookies in
    // particular), which request.headers() does not — and a cookie is exactly what marks
    // a same-origin API call as authenticated.
    const requestHeaders = await request.allHeaders().catch(() => request.headers());
    const postData = request.postData();
    this.apiEndpoints.set(key, {
      method: request.method(),
      urlTemplate: template,
      sampleUrl: url.slice(0, 2000),
      statusCode: status,
      durationMs,
      requestSample: postData ? this.masker.maskJson(postData).slice(0, 4000) : undefined,
      responseSample,
      requestContentType: requestHeaders['content-type'],
      responseContentType: contentType || undefined,
      requiresAuthentication: Boolean(requestHeaders['authorization'] || requestHeaders['cookie']),
      triggeredByNormalizedUrl: normalizeUrl(request.frame()?.url() ?? url),
      timesObserved: 1
    });
  }

  private async captureScreenshot(page: Page, normalized: string): Promise<string | undefined> {
    try {
      const name = `${fileSafe(normalized)}.png`;
      const path = join(this.options.artifactDir, name);
      await mkdir(this.options.artifactDir, { recursive: true });
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      return name;
    } catch (error) {
      this.logger.warn('Screenshot capture failed', { url: normalized, error: String(error) });
      return undefined;
    }
  }

  private async captureDom(page: Page, normalized: string): Promise<string | undefined> {
    try {
      const html = await page.content();
      const name = `${fileSafe(normalized)}.html`;
      await mkdir(this.options.artifactDir, { recursive: true });
      // Masked before it touches the disk: the DOM of a signed-in page routinely contains
      // names, balances and tokens.
      await writeFile(join(this.options.artifactDir, name), this.masker.maskText(html), 'utf8');
      return name;
    } catch (error) {
      this.logger.warn('DOM capture failed', { url: normalized, error: String(error) });
      return undefined;
    }
  }

  private async captureAccessibilityTree(page: Page, normalized: string): Promise<string | undefined> {
    try {
      const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
      if (!snapshot) return undefined;
      const name = `${fileSafe(normalized)}.a11y.json`;
      await mkdir(this.options.artifactDir, { recursive: true });
      await writeFile(join(this.options.artifactDir, name),
        this.masker.maskJson(JSON.stringify(snapshot, null, 2)), 'utf8');
      return name;
    } catch (error) {
      this.logger.warn('Accessibility snapshot failed', { url: normalized, error: String(error) });
      return undefined;
    }
  }

  private note(message: string): void {
    const line = `[${new Date().toISOString()}] ${this.masker.maskText(message)}`;
    this.progressLog.push(line);
    this.logger.info(message);
  }
}

/**
 * The shape of a route with its final segment generalised: /accounts/acc-1001 and
 * /accounts/acc-1002 share the shape /accounts/*. Used only for loop protection, never
 * as a page's identity.
 */
export function routeShapeOf(url: string): string {
  let path: string;
  try { path = new URL(url).pathname; } catch { return url; }
  const segments = path.split('/').filter(Boolean);
  // A single-segment path is a route in its own right (/dashboard, /accounts), not an
  // instance of one; generalising it would make every top-level page share a shape.
  if (segments.length < 2) return path === '' ? '/' : path.toLowerCase();
  return '/' + [...segments.slice(0, -1).map(s => s.toLowerCase()), '*'].join('/');
}

function safeRoute(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function fileSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}
