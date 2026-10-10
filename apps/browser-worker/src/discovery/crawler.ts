import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, ConsoleMessage, Page, Request, Response } from 'playwright';
import type {
  AuthConfig, CrawlBudget, DiscoveredApiEndpoint, DiscoveredElement, DiscoveredPage,
  DiscoveredTransition, DiscoveryCompletionReport
} from '@qa-nxt/shared-types';
import { buildLocatorFor } from '../browser/locator-builder.js';
import { SecretMasker } from '../security/masker.js';
import { isUrlAllowed, normalizeUrl } from '../security/url-guard.js';
import { RobotsPolicy, requestContextFetcher } from '../security/robots.js';
import type { Logger } from '../util/logger.js';
import { classifyPage, inferRequiresAuthentication } from './classify.js';
import { decide } from './clickable.js';
import type { RawClickCandidate } from './page-extractor.js';

/** Controls examined per page. Enough for a full sidebar, bounded so one dense page
 * cannot consume a crawl's whole action budget. */
const MAX_CLICK_CANDIDATES = 40;

/** URLs taken from a sitemap. Bounded so a large public sitemap cannot replace the
 * crawl with a list, while still being far more than most applications publish. */
const MAX_SITEMAP_URLS = 500;
import { collectClickCandidates, extractPage, type RawElement, type RawPageCapture } from './page-extractor.js';
import { performLogin, type LoginResult } from '../browser/authenticator.js';

/**
 * Bounded breadth-first exploration of an application.
 *
 * Every constraint here exists because an unbounded crawler is a hazard: it hammers the
 * target, follows itself round paginated loops forever, wanders onto third-party domains,
 * and eventually clicks something destructive. Depth, page, action and time budgets, URL
 * normalization, an allowlist and an exclusion list are all enforced before each
 * navigation, not after. When the application asks for robots.txt to be respected, that is
 * enforced in the same place and on the same terms.
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
  /** Null when the application has asked for robots.txt to be ignored. */
  private robots: RobotsPolicy | null = null;
  private lastNavigationAt = 0;
  /** Navigation-shaped controls not clicked because the crawl is in links-only mode.
   * Counted so a crawl that found one page can say why rather than looking complete. */
  private navigationNotFollowed = 0;

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
      await this.loadRobotsPolicy(page);

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

      // The base URL, then everything the owner named, then anything the application
      // publishes about itself. A crawl that can only follow links covers only what is
      // linked, which on a client-side-routed application is the landing page alone.
      const queue: QueueEntry[] = [{ url: this.options.baseUrl, depth: 0 }];

      for (const seed of this.options.budget.seedUrls ?? []) {
        const resolved = this.resolveSeed(seed);
        if (resolved && normalizeUrl(resolved) !== normalizeUrl(this.options.baseUrl)) {
          queue.push({ url: resolved, depth: 0, viaAccessibleName: 'a route you listed' });
        }
      }

      if (this.options.budget.useSitemap) {
        for (const fromSitemap of await this.readSitemap(page)) {
          if (!queue.some(entry => normalizeUrl(entry.url) === normalizeUrl(fromSitemap))) {
            queue.push({ url: fromSitemap, depth: 0, viaAccessibleName: 'the sitemap' });
          }
        }
      }

      if (queue.length > 1) {
        this.note(`Starting from ${queue.length} URLs: the base URL plus `
          + `${queue.length - 1} from your route list and the sitemap.`);
      }

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

        const robots = await this.robots?.allows(entry.url);
        if (robots && !robots.allowed) {
          this.blockedByPolicy++;
          this.note(`Skipped ${entry.url}: ${robots.reason}`);
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

          // Clicking comes after link following so the cheap, certain route is exhausted
          // first and the budget is spent on pages nothing else would have reached.
          for (const clicked of await this.probeInteractions(page, entry, discovered)) {
            if (!this.visited.has(normalizeUrl(clicked.url))) queue.push(clicked);
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

    // A thin crawl has to account for itself. One page can mean the application has one
    // page, or that the crawler was not allowed to reach the rest — and only the first
    // reading is visible from the numbers, which is how a crawl that found nothing ends
    // up looking like a crawl that found everything.
    if (this.pages.size <= 1 && status === 'completed') {
      if (this.navigationNotFollowed > 0) {
        this.note(
          `Only ${this.pages.size} page(s) were explored, and ${this.navigationNotFollowed} `
          + 'navigation control(s) were left unclicked because this application is set to '
          + 'follow links only. Set "How discovery explores" to "Also click navigation '
          + 'controls" on the application, or list its routes, to reach the rest.');
      } else if ((this.options.budget.seedUrls ?? []).length === 0) {
        this.note(
          `Only ${this.pages.size} page(s) were explored and no link was found to follow. `
          + 'If this application routes without links, list its routes on the application '
          + 'so discovery can open them directly.');
      }
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
   * Reads robots.txt for the base URL's origin, or records that the application asked for
   * it to be ignored.
   *
   * The user agent is taken from the browser rather than invented: group selection in
   * robots.txt is only meaningful against the string the site actually sees, and the worker
   * drives a real browser that sends a real browser's user-agent.
   *
   * The fetch goes through the browser context's own request API so it shares the crawl's
   * proxy settings and cookie jar. Failing to read robots.txt is not caught here: when the
   * rules cannot be read, `RobotsPolicy` refuses the origin and says why, and that refusal
   * is the point.
   */
  private async loadRobotsPolicy(page: Page): Promise<void> {
    if (!this.options.budget.respectRobotsTxt) {
      this.note('robots.txt is not being consulted: this application is configured to ignore it.');
      return;
    }

    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
    if (userAgent === '') {
      // Only the wildcard group can match an empty user-agent, so a site's rules for this
      // browser specifically would be skipped. Rare, and not worth failing a run over, but
      // it changes which rules were honoured and so belongs in the evidence.
      this.note('Could not read the browser user-agent, so only robots.txt rules for '
        + '"User-agent: *" are being applied.');
    }

    this.robots = new RobotsPolicy(
      requestContextFetcher(this.context.request, Math.min(this.options.navigationTimeoutMs, 10_000)),
      userAgent,
      (origin, description) => this.note(`${origin}: ${description}`)
    );
  }

  /** Honours a `Crawl-delay` the origin published, measured from the last navigation. */
  private async waitForCrawlDelay(url: string): Promise<void> {
    const delayMs = this.robots?.crawlDelayMsFor(url) ?? 0;
    if (delayMs <= 0) return;

    const waitMs = delayMs - (Date.now() - this.lastNavigationAt);
    if (waitMs <= 0) return;
    await new Promise(resolve => setTimeout(resolve, waitMs));
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

    const robots = await this.robots?.allows(loginUrl);
    if (robots && !robots.allowed) {
      // Signing in still goes ahead. robots.txt governs what a crawler may retrieve on its
      // own account, and the authenticator navigates to the login page because a person
      // with an account told it to; what it must not do is add the page to the map as a
      // crawl result.
      this.note(`Did not map the sign-in page: ${robots.reason}`);
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
    await this.waitForCrawlDelay(entry.url);

    const started = Date.now();
    let httpStatus: number | undefined;

    try {
      this.lastNavigationAt = started;
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
      // A link that serves a file rather than a page is not a failure. Playwright reports
      // it by throwing "Download is starting", which went into the exploration log as
      // "Could not load ...", so every CSV or PDF export on a page read as a broken link.
      const raw = error instanceof Error ? error.message : String(error);
      this.note(/download is starting/i.test(raw)
        ? `Did not open ${entry.url}: it serves a file download, not a page.`
        : `Could not load ${entry.url}: ${this.masker.maskText(tidyForLog(raw))}`);
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

    // Mark where we actually landed, not only what we asked for. The queue loop records
    // entry.url, so a redirect left the landing URL unvisited: the base URL redirecting to
    // /dashboard mapped that page, then the explicit /dashboard link in the navigation
    // mapped it again 650ms later — a duplicate line in the exploration log and a page
    // spent from the budget for nothing.
    this.visited.add(normalized);

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


  /**
   * Turns one entry from the owner's route list into an absolute URL.
   *
   * Accepts a path or a whole URL, because people write both and refusing one of them
   * teaches nothing. Anything that will not resolve is reported rather than dropped: a
   * route somebody listed and that was silently ignored is worse than one that errors,
   * since the crawl afterwards looks complete.
   */
  private resolveSeed(seed: string): string | null {
    const trimmed = seed.trim();
    if (trimmed.length === 0) return null;

    try {
      return new URL(trimmed, this.options.baseUrl).toString();
    } catch {
      this.note(`Ignored "${trimmed}" from your route list: it is not a URL or a path.`);
      return null;
    }
  }

  /**
   * Reads the application's own sitemap for routes nothing links to.
   *
   * A plain GET of a file the application publishes about itself, through the same browser
   * context so it carries the session. Index sitemaps are followed one level, which covers
   * the common shape without turning a crawl into a sitemap crawl.
   *
   * Failure is silent by design beyond a log line: most applications have no sitemap, and
   * saying so on every run would train people to ignore the exploration log.
   */
  private async readSitemap(page: Page): Promise<string[]> {
    const candidates = ['/sitemap.xml', '/sitemap_index.xml'];
    const found = new Set<string>();

    for (const candidate of candidates) {
      if (found.size >= MAX_SITEMAP_URLS) break;

      let xml: string;
      try {
        const url = new URL(candidate, this.options.baseUrl).toString();
        const response = await page.request.get(url, { timeout: 10_000 });
        if (!response.ok()) continue;
        xml = await response.text();
      } catch {
        continue;
      }

      // Deliberately a regex and not an XML parser. The only thing wanted is the <loc>
      // values, the worker has no XML dependency, and a malformed sitemap should yield
      // whatever it does contain rather than throwing the crawl away.
      const locations = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]!);

      for (const location of locations) {
        if (found.size >= MAX_SITEMAP_URLS) break;

        // An index sitemap lists sitemaps. One level deep only.
        if (/sitemap.*\.xml$/i.test(location) && !candidates.includes(location)) {
          try {
            const nested = await page.request.get(location, { timeout: 10_000 });
            if (!nested.ok()) continue;
            const nestedXml = await nested.text();
            for (const inner of [...nestedXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]) {
              if (found.size >= MAX_SITEMAP_URLS) break;
              if (!/\.xml$/i.test(inner[1]!)) found.add(inner[1]!);
            }
          } catch {
            // A nested sitemap that will not load costs us its entries, nothing more.
          }
          continue;
        }

        found.add(location);
      }
    }

    if (found.size > 0) {
      this.note(`Read ${found.size} URL(s) from the sitemap.`);
    }

    return [...found];
  }

  /**
   * Finds pages that nothing links to, by clicking the controls that lead to them.
   *
   * An admin application whose sidebar is buttons calling a client-side router has no
   * anchor for the crawler to follow, so link-only discovery saw the landing page and
   * stopped. This presses the controls that look like they navigate and records wherever
   * the URL ends up.
   *
   * What it will press is decided by {@link decide}, outside the browser, and is cautious
   * by default: anything shaped like a state change is skipped unless the application
   * explicitly permits it. The reasons are written to the exploration log, because a page
   * that was not explored is worth as much to a reader as one that was.
   *
   * After every click the crawler returns to the page it started from. A click that opens
   * a modal, or does nothing at all, must not leave the next candidate being judged
   * against a page that is no longer there.
   */
  private async probeInteractions(
    page: Page, entry: QueueEntry, discovered: CrawledPage
  ): Promise<QueueEntry[]> {
    const mode = this.options.budget.interactionMode;

    if (mode === 'links') {
      // Still look, so the run can report what it chose not to do. A crawl that found one
      // page because clicking is off is indistinguishable from an application with one
      // page, and the second reading is the one people take.
      try {
        const candidates = await page.evaluate(
          collectClickCandidates, MAX_CLICK_CANDIDATES) as RawClickCandidate[];
        this.navigationNotFollowed += candidates.filter(c =>
          decide(c, 'navigation', false).click).length;
      } catch {
        // Counting is advisory; failing to count must not fail the crawl.
      }
      return [];
    }

    const found: QueueEntry[] = [];
    const startUrl = page.url();

    let candidates: RawClickCandidate[];
    try {
      candidates = await page.evaluate(collectClickCandidates, MAX_CLICK_CANDIDATES) as RawClickCandidate[];
    } catch (error) {
      this.note(`Could not look for clickable navigation on ${discovered.route || '/'}: `
        + this.masker.maskText(tidyForLog(error instanceof Error ? error.message : String(error))));
      return [];
    }

    let skipped = 0;

    for (const candidate of candidates) {
      if (this.actionsUsed >= this.options.budget.maxActions) {
        this.note('Stopped looking for clickable navigation: the action budget was reached.');
        break;
      }

      const decision = decide(candidate, mode, this.options.budget.allowStateChangingClicks);
      if (!decision.click) {
        // Only the interesting refusals are logged. "It is an ordinary link" would be
        // every anchor on the page and would bury the ones that matter.
        if (decision.reason.includes('changes data') || decision.reason.includes('form')) {
          this.note(`Did not click "${candidate.accessibleName || candidate.tagName}" on `
            + `${discovered.route || '/'}: ${decision.reason}.`);
        }
        skipped++;
        continue;
      }

      try {
        const locator = page.locator(candidate.selector).first();
        if (await locator.count() === 0) continue;

        this.actionsUsed++;
        await locator.click({ timeout: 5000, noWaitAfter: true });
        // Long enough for a client-side route change to land, short enough that a page
        // of inert buttons does not cost the whole crawl.
        await page.waitForTimeout(400);
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);

        const after = page.url();
        if (normalizeUrl(after) !== normalizeUrl(startUrl) && !this.visited.has(normalizeUrl(after))) {
          found.push({
            url: after,
            depth: entry.depth + 1,
            parentNormalizedUrl: discovered.normalizedUrl,
            viaAccessibleName: candidate.accessibleName || undefined
          });
          this.note(`Found ${after} by clicking "${candidate.accessibleName || candidate.tagName}".`);
        }
      } catch {
        // A control that will not take a click is not a failure of the crawl. It may have
        // been re-rendered out from under us, which on a live application is ordinary.
      }

      // Back to where we started, whatever the click did.
      if (normalizeUrl(page.url()) !== normalizeUrl(startUrl)) {
        await page.goto(startUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.options.navigationTimeoutMs
        }).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      } else {
        // Same URL, but a modal or a menu may now be open. Escape closes most of them and
        // costs nothing when there is nothing to close.
        await page.keyboard.press('Escape').catch(() => undefined);
      }
    }

    if (found.length > 0 || skipped > 0) {
      this.note(`Clicked through ${discovered.route || '/'}: found ${found.length} page(s) `
        + `no link pointed at, skipped ${skipped} control(s).`);
    }

    return found;
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
    const line = `[${new Date().toISOString()}] ${this.masker.maskText(tidyForLog(message))}`;
    this.progressLog.push(line);
    this.logger.info(message);
  }
}


/**
 * Makes driver output fit a log that is rendered one entry per line.
 *
 * Playwright's errors are written for a terminal: they carry ANSI colour codes and a
 * multi-line "Call log:" trailer. Both went into the console verbatim, so the exploration
 * log showed literal escape sequences — `[2m  - navigating to "…"[22m` — and a stack of
 * driver internals in the middle of a list of pages. The message itself is worth keeping;
 * the terminal formatting around it is not.
 */
export function tidyForLog(message: string): string {
  const withoutColour = message
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    // The same codes turn up with the escape byte already lost, as a bare "[2m".
    .replace(/\[\d{1,3}m/g, '');

  const firstLine = withoutColour.split(/\r?\n/)[0] ?? '';
  return firstLine.replace(/\s+/g, ' ').trim();
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
