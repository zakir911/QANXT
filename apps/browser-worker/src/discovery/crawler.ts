import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, ConsoleMessage, Page, Request, Response } from 'playwright';
import type {
  DiscoveredForm,
  AuthConfig, CrawlBudget, DiscoveredApiEndpoint, DiscoveredElement, DiscoveredPage,
  DiscoveredTransition, DiscoveryCompletionReport, StateChangingLink
} from '@qa-nxt/shared-types';
import { buildLocatorFor } from '../browser/locator-builder.js';
import { buildLocator } from '../browser/locator-resolver.js';
import { SecretMasker } from '../security/masker.js';
import { isUrlAllowed, normalizeUrl, visitKey } from '../security/url-guard.js';
import { RobotsPolicy, requestContextFetcher } from '../security/robots.js';
import type { Logger } from '../util/logger.js';
import { classifyPage, inferRequiresAuthentication } from './classify.js';
import { decide, linkLooksMutating, looksMutating } from './clickable.js';
import type { RawClickCandidate } from './page-extractor.js';

/** Controls examined per page. Enough for a full sidebar, bounded so one dense page
 * cannot consume a crawl's whole action budget. */
const MAX_CLICK_CANDIDATES = 40;

/** URLs taken from a sitemap. Bounded so a large public sitemap cannot replace the
 * crawl with a list, while still being far more than most applications publish. */
const MAX_SITEMAP_URLS = 500;
import { collectClickCandidates, extractPage, type RawElement, type RawPageCapture } from './page-extractor.js';
import { extractForms, type RawForm } from './form-extractor.js';
import { findOpener, formIsVisible, probeForm, type FormOpener } from './form-probe.js';
import { performLogin, type LoginResult } from '../browser/authenticator.js';
import { CONCURRENT_SESSION, checkSessionSurvivesLoad, navigateInApp, performLogout, sessionGate, sessionKey } from '../browser/session.js';

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
  /**
   * Reports progress and may answer with an instruction to stop, which is how a cancelled
   * run reaches a crawl already in flight.
   */
  onProgress?: (message: string, visited: number, queued: number)
    => void | Promise<void> | Promise<{ shouldStop: boolean; reason?: string }>;
  /**
   * When the run began, as the control plane recorded it.
   *
   * The time budget is measured from here, not from the moment this process picked the job
   * up. A crawl whose worker died and whose job was reclaimed would otherwise start a fresh
   * full budget, so a run with a declared 15-minute budget could spend an hour exploring
   * somebody's application — measured at 20 minutes on a 900s budget after one restart.
   */
  runStartedAtMs?: number;
}

/** A mapped page plus the links found on it, which are crawl state rather than part of
 *  what is reported back to the control plane. */
/** How many controls the dependency probe may change on one page. */
const MAX_PROBE_INTERACTIONS_PER_PAGE = 60;

interface CrawledPage extends DiscoveredPage {
  links: string[];
  /**
   * The hrefs of links this page carries inside a navigation region.
   *
   * Crawl state, like `links`, and stripped from the report for the same reason: it is how
   * the crawler decides where to go next, not part of the map it hands back. It is kept
   * because whether a link lives in a navigation region decides whether a mutating word in
   * it names an action or the screen it opens, and `DiscoveredElement` is a shared contract
   * that should not grow a field for a decision local to crawling.
   */
  navHrefs: string[];
  /**
   * URLs the crawler will try because a JSON collection named the records behind them.
   *
   * Crawl state like the two above. A JSON API's instance endpoints are linked from
   * nothing: `/api/orders` answers with a list of orders carrying their ids, and
   * `/api/orders/ord-1` exists but no document on the application points at it. Opening
   * one is a hypothesis, tested by making the request and seeing what comes back, not an
   * assumption: a 404 records nothing and says so in the log.
   */
  apiInstanceCandidates: ApiInstanceCandidate[];
  /**
   * For each link on this page that sits in a row, that row's short cell values.
   *
   * Crawl state like the three above, and deliberately not part of the map: a row on a
   * customer list holds names, emails and amounts, and the report has no use for them. The
   * crawler uses them for one decision only — which instances of a route to spend its
   * allowance on — and nothing derived from them is stored except the masked column values
   * named in the progress log.
   */
  rowCellsByHref: Record<string, string[]>;
}

/** A URL the crawler built from a record a collection named, with the identifier it used. */
interface ApiInstanceCandidate {
  url: string;
  id: string;
}

interface QueueEntry {
  url: string;
  depth: number;
  parentNormalizedUrl?: string;
  viaAccessibleName?: string;
  /**
   * The record identifier this URL was built from, when the crawler built it.
   *
   * It is the difference between knowing and guessing. `normalizeUrl` turns a numeric path
   * segment into `{id}` because a number in a path is almost always one; it leaves `ord-1`
   * alone, correctly, because an opaque string there is as likely to be a route name. When
   * the crawler made the URL by taking an id out of a collection, there is nothing to infer
   * — the segment is an identifier because that is where it came from — and the endpoint is
   * recorded as `/api/orders/{id}` rather than as one order's address.
   *
   * Which matters because the surface is what the security engine tests: every
   * authorization check needs a path with a parameter in it to compare two identities
   * against, and reported inconclusive without one.
   */
  apiInstanceId?: string;
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
  /** Links not followed because their own words say they change something. */
  private mutatingLinksSkipped = 0;
  /** The same links, kept so the report can name them and not only count them. */
  private readonly stateChangingLinks = new Map<string, StateChangingLink>();
  private actionsUsed = 0;
  /** Null when the application has asked for robots.txt to be ignored. */
  private robots: RobotsPolicy | null = null;
  private lastNavigationAt = 0;
  /** Navigation-shaped controls not clicked because the crawl is in links-only mode.
   * Counted so a crawl that found one page can say why rather than looking complete. */
  private navigationNotFollowed = 0;
  /** URLs still waiting when a budget stopped the crawl, so the map can say how much of
   *  the application it never opened rather than only that it stopped early. */
  private unexplored: string[] = [];
  /** Pages skipped because their route shape had already been mapped to the cap, held per
   *  shape as the set of distinct URLs rather than a count of events: every page that links
   *  to a capped record raises the skip again, so counting events reports a number many
   *  times the real one. A defect that only exists for a record in one state lives behind
   *  this cap — three instances of /declarations/{id} chosen by crawl order will usually
   *  all be in the wrong one — so the report says so rather than leaving it to be inferred. */
  private readonly cappedByRouteShape = new Map<string, Set<string>>();
  /** The application signs out on a page load, so pages are opened from inside it. */
  private inApp = false;
  /** Where the sign-in landed: the first page of the signed-in application. */
  private landingUrl: string | undefined;
  private signedIn = false;
  private leaveSession: (() => void) | undefined;

  constructor(
    private readonly context: BrowserContext,
    private readonly options: CrawlOptions,
    private readonly logger: Logger
  ) {
    this.masker = new SecretMasker().withLiterals([
      options.auth.password, options.auth.bearerToken, options.auth.username, options.auth.otpValue
    ]);
  }

  async run(discoveryRunId: string, workerId: string, signal?: AbortSignal): Promise<DiscoveryCompletionReport> {
    const startedAt = new Date().toISOString();
    const deadline = crawlDeadline(
      this.options.budget.timeoutSeconds, this.options.runStartedAtMs, Date.now());
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
        if (login.succeeded) {
          this.signedIn = true;
          this.landingUrl = page.url();
          // Does a fresh page load keep the user signed in? Banking applications often
          // keep the session only in the page; loading each page by address would then
          // map nothing but signed-out shells.
          if (this.options.auth.strategy === 'formLogin') {
            this.inApp = !(await sessionGate.survivesLoad(sessionKey(this.options.auth),
              () => checkSessionSurvivesLoad(page, this.options.auth, this.options.navigationTimeoutMs)));
            if (this.inApp) this.note('This application signs out on a page load (its session lives in the page), so discovery moves through it from inside: by its links and its router, never by loading an address.');
          }
        }
        if (!login.succeeded) {
          // Continuing would produce a map of the login page repeated many times, which
          // is worse than useless — it looks like a successful crawl.
          throw new Error(`Authentication failed: ${this.masker.maskText(login.message)}`);
        }
      }

      // The base URL, then everything the owner named, then anything the application
      // publishes about itself. A crawl that can only follow links covers only what is
      // linked, which on a client-side-routed application is the landing page alone.
      //
      // Signed in, the crawl starts where the sign-in landed. A base URL that is the login
      // page (a common choice) would otherwise send the crawl back to the sign-in screen,
      // and from there only to the public pages it links to.
      const start = authenticated && this.landingUrl && !this.isLoginPage(this.landingUrl) ? this.landingUrl : this.options.baseUrl;
      const queue: QueueEntry[] = [{ url: start, depth: 0 }];
      if (visitKey(start) !== visitKey(this.options.baseUrl) && !(authenticated && this.isLoginPage(this.options.baseUrl))) {
        queue.push({ url: this.options.baseUrl, depth: 0 });
      }

      for (const seed of this.options.budget.seedUrls ?? []) {
        const resolved = this.resolveSeed(seed);
        if (resolved && visitKey(resolved) !== visitKey(this.options.baseUrl)) {
          queue.push({ url: resolved, depth: 0, viaAccessibleName: 'a route you listed' });
        }
      }

      if (this.options.budget.useSitemap) {
        for (const fromSitemap of await this.readSitemap(page)) {
          if (!queue.some(entry => visitKey(entry.url) === visitKey(fromSitemap))) {
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
          this.recordFrontier(queue);
          break;
        }
        if (this.pages.size >= this.options.budget.maxPages) {
          status = 'partiallyCompleted';
          this.note(`Stopped: the ${this.options.budget.maxPages}-page budget was reached.`);
          this.recordFrontier(queue);
          break;
        }
        if (this.actionsUsed >= this.options.budget.maxActions) {
          status = 'partiallyCompleted';
          this.note(`Stopped: the ${this.options.budget.maxActions}-action budget was reached.`);
          this.recordFrontier(queue);
          break;
        }

        const entry = queue.shift()!;
        const normalized = visitKey(entry.url);
        if (this.visited.has(normalized)) continue;
        // The sign-in page was mapped before signing in; going back to it signed in would
        // at best show it again and at worst sign the crawl out.
        if (authenticated && this.isLoginPage(entry.url)) { this.visited.add(normalized); continue; }

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
          const capped = this.cappedByRouteShape.get(shape) ?? new Set<string>();
          capped.add(normalized);
          this.cappedByRouteShape.set(shape, capped);
          this.note(`Skipped ${entry.url}: already mapped ${shapeCount} pages matching ${shape}.`);
          continue;
        }
        this.routeShapeCounts.set(shape, shapeCount + 1);

        this.visited.add(normalized);
        const discovered = await this.visit(page, entry, authenticated);
        if (!discovered) continue;

        // The answer to a progress report can say to stop. That is how cancelling a run
        // reaches a crawl that is already running: before this, the run row was marked
        // cancelled and the crawl carried on opening and clicking pages until its budget
        // ran out, which on a real application means the tool keeps touching a system
        // after being told to stop.
        const ack = await this.options.onProgress?.(
          `Explored ${discovered.route || '/'} (${discovered.elements.length} elements)`,
          this.pages.size, queue.length);
        if (ack && typeof ack === 'object' && ack.shouldStop) {
          status = 'cancelled';
          this.note(`Stopped: the control plane asked the crawl to stop — ${ack.reason ?? 'the run is no longer in flight'}.`);
          break;
        }

        if (entry.depth < this.options.budget.maxDepth) {
          for (const link of this.collectLinks(discovered, entry.depth)) {
            if (!this.visited.has(visitKey(link.url))) queue.push(link);
          }

          // Records a JSON collection named. Queued before clicking, because a GET for a
          // record the application just listed is as cheap and as certain as a link.
          for (const candidate of discovered.apiInstanceCandidates) {
            if (!this.visited.has(visitKey(candidate.url))) {
              queue.push({
                url: candidate.url, depth: entry.depth + 1,
                parentNormalizedUrl: visitKey(discovered.url),
                viaAccessibleName: 'a record this collection listed',
                apiInstanceId: candidate.id
              });
            }
          }

          // Clicking comes after link following so the cheap, certain route is exhausted
          // first and the budget is spent on pages nothing else would have reached.
          for (const clicked of await this.probeInteractions(page, entry, discovered)) {
            if (!this.visited.has(visitKey(clicked.url))) queue.push(clicked);
          }
        }
      }
    } catch (error) {
      status = this.pages.size > 0 ? 'partiallyCompleted' : 'failed';
      errorMessage = this.masker.maskText(error instanceof Error ? error.message : String(error));
      this.logger.error('Discovery run failed', error, { discoveryRunId });
      this.note(`Discovery failed: ${errorMessage}`);
    } finally {
      // Sign out, so an application that allows one session per user lets the next job in.
      if (this.signedIn) await performLogout(page).catch(() => false);
      await page.close().catch(() => undefined);
      this.leaveSession?.();
    }

    // Pages the crawl chose not to open, said once at the end as well as per link. A
    // reader who sees "7 pages" and a map missing the approvals screen should not have to
    // search the progress log to learn that it was deliberate.
    if (this.mutatingLinksSkipped > 0) {
      this.note(
        `${this.mutatingLinksSkipped} link(s) were not followed because their own words say `
        + 'they change something — approve, delete, cancel and the like. Mapping an '
        + 'application must not alter it. Each one is named above. To map them anyway, turn '
        + 'on state-changing interaction for this application.');
    }

    // A crawl stopped by a budget has to account for itself too, and this was the one
    // stop that did not. "Stopped: the 900s exploration budget was reached" says the map is
    // partial; it does not say whether one page was left or four hundred, and a coverage
    // figure computed over the pages that were opened reads the same either way. The
    // frontier is known at the moment of the stop, so it is reported.
    // What this map is a view of, said at the end where the other limits are said.
    //
    // Measured on the freight target: ops.lead holds role-operations, which has
    // shipment:cancel and not claim:settle. An interactive crawl as that account reached
    // /shipments/:id/cancel three times over and never reached /claims/:id/settle — not
    // because it declined to press Settle but because the application does not render Settle
    // for a role without the permission, so there was nothing on the page to press. The same
    // crawl as an administrator found it on the first pass. Nothing the first map produced
    // said any of that, which is the same confusion as an untested area reading as a clean
    // one.
    //
    // The identity is deliberately not named. The first version of this note interpolated the
    // username, the masker redacted it as the personal data it is, and the note read "This
    // map is what ***REDACTED*** can see" — worse than saying nothing, because it looks like
    // information. Whoever reads this configured the identity and can see it in the
    // application's settings; what they cannot see anywhere else is that the map is bounded
    // by it.
    //
    // It also does not claim to know what it missed. A control absent from the page leaves
    // nothing to count, so any number here would be invented.
    if (this.options.auth.strategy !== 'none') {
      this.note(
        'This map is what the signed-in identity can see. A control the application does not '
        + 'render for that identity is on no page here and was never followed, because there '
        + 'was nothing to follow — so this map cannot say what it leaves out. Mapping again as '
        + 'an identity holding other permissions is how to find out.');
    }

    if (this.unexplored.length > 0) {
      const examples = this.unexplored.slice(0, 5).map(url => routeShapeOf(url));
      this.note(
        `${this.unexplored.length} URL(s) were still waiting to be opened when the budget `
        + `stopped the crawl, so this map is partial by that much: ${examples.join(', ')}`
        + `${this.unexplored.length > examples.length ? ', and others' : ''}. Raise the `
        + 'budget on the application, or list the routes that matter, to reach them.');
    }

    // And the per-shape cap, which is the other way a map comes back missing something
    // real. Three instances of a route chosen by crawl order are three records in whatever
    // state the list happened to show first; a defect that only exists for a record in
    // another state sits behind exactly this line, unreachable and unnamed.
    if (this.cappedByRouteShape.size > 0) {
      const total = [...this.cappedByRouteShape.values()].reduce((sum, urls) => sum + urls.size, 0);
      const shapes = [...this.cappedByRouteShape.entries()]
        .sort((a, b) => b[1].size - a[1].size).slice(0, 5)
        .map(([shape, urls]) => `${shape} (${urls.size})`);
      this.note(
        `${total} page(s) were not opened because their route had already been mapped `
        + `${this.options.budget.maxInstancesPerRouteShape} time(s): ${shapes.join(', ')}. `
        + 'Instances are taken in crawl order, so a defect that only shows on a record in a '
        + 'state none of those instances is in will not be reached.');
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
      pages: [...this.pages.values()]
        .map(({ links, navHrefs, apiInstanceCandidates, rowCellsByHref, ...page }) => page),
      transitions: this.transitions,
      apiEndpoints: [...this.apiEndpoints.values()],
      consoleErrors: this.consoleErrors,
      pagesBlockedByPolicy: this.blockedByPolicy,
      stateChangingLinks: [...this.stateChangingLinks.values()],
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
      const normalized = visitKey(loginUrl);
      this.visited.add(normalized);
      this.routeShapeCounts.set(routeShapeOf(loginUrl), 1);
      const captured = await this.visit(page, { url: loginUrl, depth: 0 }, false);
      if (captured) this.note(`Mapped the sign-in page before signing in (${captured.elements.length} elements).`);
    } catch (error) {
      this.note(`Could not map the sign-in page: ${this.masker.maskText(String(error))}`);
    }
  }

  private isLoginPage(url: string): boolean {
    const login = this.options.auth.loginUrl;
    if (!login) return false;
    try { return normalizeUrl(url) === normalizeUrl(login); } catch { return false; }
  }

  /** Back to a page: from inside the application when a load would sign it out. */
  private async reopen(page: Page, url: string): Promise<void> {
    if (this.inApp) {
      await navigateInApp(page, url, this.options.navigationTimeoutMs).catch(() => undefined);
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.options.navigationTimeoutMs }).catch(() => undefined);
    }
  }

  /**
   * Puts a page back to its starting state without loading it: away to another page of
   * the application and back, which makes a single-page application build it afresh.
   */
  private async resetInApp(page: Page, url: string): Promise<void> {
    const elsewhere = this.landingUrl && normalizeUrl(this.landingUrl) !== normalizeUrl(url)
      ? this.landingUrl
      : [...this.pages.values()].map(p => p.url).find(other => normalizeUrl(other) !== normalizeUrl(url));
    if (elsewhere) await navigateInApp(page, elsewhere, this.options.navigationTimeoutMs).catch(() => undefined);
    await navigateInApp(page, url, this.options.navigationTimeoutMs).catch(() => undefined);
  }

  private async authenticate(page: Page): Promise<LoginResult> {
    this.note('Signing in to the application under test.');
    const loginOptions = { navigationTimeoutMs: this.options.navigationTimeoutMs, actionTimeoutMs: this.options.navigationTimeoutMs };
    const key = this.options.auth.strategy === 'formLogin' ? sessionKey(this.options.auth) : undefined;
    const exclusive = key ? sessionGate.isSingle(key) : false;
    if (key && !this.leaveSession) this.leaveSession = await sessionGate.enter(key);
    let result = await performLogin(page, this.options.auth, loginOptions);
    if (key && !result.succeeded && CONCURRENT_SESSION.test(result.message) && !exclusive) {
      this.note('The application refused a second session for this account; waiting for its other sessions to end, then signing in again.');
      this.leaveSession = await sessionGate.becomeExclusive(key, this.leaveSession ?? (() => undefined));
      result = await performLogin(page, this.options.auth, loginOptions);
    }
    this.note(result.succeeded ? 'Signed in successfully.' : `Sign-in failed: ${this.masker.maskText(result.message)}`);
    this.actionsUsed += result.actionsUsed;
    return result;
  }

  private async visit(page: Page, entry: QueueEntry, authenticated: boolean): Promise<CrawledPage | null> {
    await this.waitForCrawlDelay(entry.url);

    const started = Date.now();
    let httpStatus: number | undefined;
    let documentContentType: string | undefined;
    let documentBody: string | undefined;
    let documentRequiresAuth = false;

    try {
      this.lastNavigationAt = started;
      if (this.inApp && authenticated) {
        await navigateInApp(page, entry.url, this.options.navigationTimeoutMs);
        httpStatus = undefined;
      } else {
        const response = await page.goto(entry.url, {
          waitUntil: 'domcontentloaded',
          timeout: this.options.navigationTimeoutMs
        });
        httpStatus = response?.status();
        documentContentType = response?.headers()['content-type'];
        if (response && isJsonContentType(documentContentType)) {
          documentBody = await response.text().catch(() => undefined);
          // Whether this request carried a session, read from the request itself rather
          // than assumed. allHeaders() includes what the browser adds at the network layer
          // — the cookie, and the Authorization header a token sign-in set on the context —
          // which request.headers() does not. It decides whether the surface treats the
          // endpoint as authenticated, and an authenticated endpoint taking an identifier
          // is the shape that implies the object-authorization check.
          const sent = await response.request().allHeaders().catch(() => ({} as Record<string, string>));
          documentRequiresAuth = Boolean(sent['authorization'] || sent['cookie']);
        }
      }
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
    const normalized = visitKey(capture.url);

    // A redirect may have landed us somewhere already mapped (typically the login page).
    if (normalized !== visitKey(entry.url) && this.pages.has(normalized)) {
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
    // After the screenshot and DOM, because probing changes the page's controls.
    const forms = await this.captureForms(page);

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
      elements: capture.elements.map(element => this.toDiscoveredElement(element, capture.elements)),
      forms,
      links: capture.links,
      navHrefs: capture.elements
        .filter(element => element.inNav && element.attributes['href'])
        .map(element => element.attributes['href']!),
      apiInstanceCandidates: this.readJsonDocument(
        capture.url, httpStatus, documentContentType, documentBody, entry.apiInstanceId,
        documentRequiresAuth),
      rowCellsByHref: Object.fromEntries(capture.elements
        .filter(element => element.attributes['href'] && element.rowCells)
        .map(element => [element.attributes['href']!, element.rowCells!]))
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

    const formSummary = forms.length === 0 ? '' : `, ${forms.length} form(s) with ${forms.reduce((n, f) => n + f.fields.length, 0)} field(s)`;
    this.note(`Mapped ${discovered.route || '/'} — ${discovered.elements.length} elements, ${capture.links.length} links${formSummary}, kind=${discovered.kind}`);
    return discovered;
  }


  /**
   * Reads every form on the page and what its answers change.
   *
   * Probing has its own per-page limit rather than drawing on the crawl's action budget:
   * it is bounded by the number of controls on one page, and a page with a long form would
   * otherwise spend the budget that reaches the rest of the application. A form that could
   * not be read is reported and skipped, never allowed to fail the page.
   */
  private async captureForms(page: Page): Promise<DiscoveredForm[]> {
    let raw: RawForm[];
    try {
      raw = await page.evaluate(extractForms, 300) as RawForm[];
    } catch (error) {
      this.note(`Could not read the forms on ${page.url()}: ${this.masker.maskText(tidyForLog(String(error)))}`);
      return [];
    }

    const forms: DiscoveredForm[] = [];
    let remaining = MAX_PROBE_INTERACTIONS_PER_PAGE;
    for (const form of raw) {
      const masked: RawForm = {
        ...form,
        fields: form.fields.map(field => ({
          ...field,
          defaultValue: field.defaultValue === null ? null : this.masker.maskText(field.defaultValue)
        }))
      };
      if (remaining <= 0) {
        forms.push({ ...masked, dependencies: [], probeNote: 'Not probed: the per-page probing limit was reached.' });
        continue;
      }
      // A form whose fields are all hidden at load lives behind something — usually a
      // dialog. Find what opens it, so tests can open it too; probe it open.
      let hiddenAtLoad = false;
      let opener: FormOpener | undefined;
      if (form.fields.length > 0 && !form.isMultiStep && !(await formIsVisible(page, form))) {
        hiddenAtLoad = true;
        const found = await findOpener(page, form, this.inApp ? (p, url) => this.resetInApp(p, url) : undefined).catch(() => ({ opener: undefined, stoppedBecause: undefined }));
        opener = found.opener;
        remaining -= MAX_PROBE_INTERACTIONS_PER_PAGE / 6;
        if (!opener) {
          this.note(`The form ${form.key} on ${page.url()} is hidden when the page loads and nothing on the page was found to open it${found.stoppedBecause ? ` (${found.stoppedBecause})` : ''}.`);
          forms.push({ ...masked, dependencies: [], hiddenAtLoad, opener: null, probeNote: 'Hidden when the page loads; no control that opens it was found.' });
          continue;
        }
      }
      const open = async () => {
        if (!opener) return;
        await buildLocator(page, opener.locator).first().click({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(300);
      };
      let current = masked;
      if (opener) {
        // Read the form again with it open: which fields show is what a user sees once it
        // is open, not the all-hidden state of the closed dialog, which would make every
        // field look conditional.
        await open();
        const reopened = (await page.evaluate(extractForms, 300).catch(() => [] as RawForm[]) as RawForm[])
          .find(f => f.domIndex === form.domIndex && f.key === form.key);
        if (reopened) current = { ...masked, fields: masked.fields.map(field => ({ ...field, visible: reopened.fields.find(r => r.key === field.key)?.visible ?? field.visible })),
          buttons: masked.buttons.map(button => ({ ...button, visible: reopened.buttons.find(r => r.label === button.label)?.visible ?? button.visible })) };
      }
      try {
        const probe = await probeForm(page, current, remaining, open, this.inApp ? (p, url) => this.resetInApp(p, url) : undefined);
        remaining -= probe.interactions;
        if (probe.stoppedBecause) this.note(`Stopped probing ${form.key} on ${page.url()}: ${probe.stoppedBecause}.`);
        forms.push({ ...current, dependencies: probe.dependencies, probeNote: probe.stoppedBecause, hiddenAtLoad, opener: opener ?? null });
      } catch (error) {
        forms.push({ ...masked, dependencies: [], probeNote: `Probe failed: ${tidyForLog(String(error))}` });
      }
    }
    return forms;
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
        //
        // A control whose own label reads as mutating is always interesting, whatever the
        // reason it was refused, because it is the control the application's state-changing
        // setting is *about*. Logged on the label rather than only on the reason: clinic-spa's
        // cancel button was refused for being a non-navigation control in navigation mode,
        // which is not one of the two reasons below, so a run with state-changing clicks
        // authorised recorded "skipped 1 control(s)" and nothing else. Someone who turns that
        // setting on and sees nothing happen deserves to be told which setting stopped it.
        if (decision.reason.includes('changes data') || decision.reason.includes('form')
            || looksMutating(candidate.accessibleName)) {
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
        if (visitKey(after) !== visitKey(startUrl) && !this.visited.has(visitKey(after))) {
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
      if (visitKey(page.url()) !== visitKey(startUrl)) {
        await this.reopen(page, startUrl);
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
      const normalized = visitKey(href);
      if (seen.has(normalized) || this.visited.has(normalized)) continue;
      seen.add(normalized);

      const anchor = page.elements.find(e => e.kind === 'link' && e.attributes['href'] && href.endsWith(e.attributes['href']!));
      const name = anchor?.accessibleName ?? '';
      const inNav = page.navHrefs.some(nav => href.endsWith(nav) || nav.endsWith(href));

      // A link that says it changes something is not followed, and the crawl says so.
      // Mapping an application must not alter it: a run against a permit register
      // approved every permit in it through links exactly like this one.
      // A link whose own words say it changes something.
      //
      // Recorded whether or not it is followed, which it was not before: the record lived
      // inside the refusal, so turning state-changing interaction *on* made the crawl
      // forget these links entirely. The attack surface reads them to decide what to
      // probe, so the two settings cancelled each other out — refuse and the address is
      // known but the scan may not touch it, allow and the scan may touch it but the
      // address is no longer known. The fact and the refusal are separate things.
      //
      // Keyed by route shape: a register with a thousand rows offers a thousand approve
      // links, and a reader needs to know the shape exists, once.
      if (linkLooksMutating(name, href, inNav)) {
        const shape = routeShapeOf(href);
        if (!this.stateChangingLinks.has(shape)) {
          this.stateChangingLinks.set(shape, {
            url: href, foundOnUrl: page.url,
            ...(name ? { accessibleName: name } : {})
          });
        }
      }

      if (!this.options.budget.allowStateChangingClicks
          && linkLooksMutating(name, href, inNav)) {
        this.mutatingLinksSkipped++;
        this.note(`Did not follow ${href}${name ? ` ("${name}")` : ''}: it looks like it changes `
          + `something, and mapping an application must not alter it. Turn on state-changing `
          + `interaction for this application to follow links like this.`);
        continue;
      }

      out.push({
        url: href,
        depth: depth + 1,
        parentNormalizedUrl: page.normalizedUrl,
        viaAccessibleName: name || undefined
      });
    }
    return this.spreadAcrossColumns(out, page);
  }

  /**
   * Orders instances of the same route so the per-route allowance covers different records
   * rather than three rows of the same table.
   *
   * The cap exists because one more /accounts/<id> teaches nothing the first few did not.
   * That is true of a column the records agree on and false of one they differ in: a
   * declaration that is rejected and a declaration that is accepted are not the same page
   * shown twice, and on this project's own lab the difference is a planted defect that
   * only exists for the rejected one. The crawl took the first three rows, which were all
   * in states the defect does not live in, and the page that holds it is linked from
   * nowhere because the application does not draw the link for a rejected record.
   *
   * What makes a column worth spreading across is its shape, not its meaning. A column
   * every row agrees on says nothing. A column where every row differs is an identifier, a
   * reference or a date, and spreading across it is the document order it replaces. A
   * column taking a few values across many rows is a state, a type or an owner, whatever
   * the application calls it — so the column chosen is the one with the fewest distinct
   * values above one, and the order then takes one row per value before a second of any.
   *
   * Nothing here decides what to skip. The cap still does that, and raising it still
   * reaches more; this only decides which instances the allowance is spent on, which is
   * the part that was left to document order.
   */
  private spreadAcrossColumns(entries: QueueEntry[], page: CrawledPage): QueueEntry[] {
    // Built once. A list page can offer hundreds of record links, and resolving each
    // candidate's row against a freshly built index would be quadratic in that count.
    const rows = Object.entries(page.rowCellsByHref);
    const byShape = new Map<string, QueueEntry[]>();
    for (const entry of entries) {
      const shape = routeShapeOf(entry.url);
      const group = byShape.get(shape) ?? [];
      group.push(entry);
      byShape.set(shape, group);
    }

    const out: QueueEntry[] = [];
    for (const [shape, group] of byShape) {
      // Below the cap nothing is skipped, so the order changes nothing and the work and
      // the log line are not worth spending.
      if (group.length <= this.options.budget.maxInstancesPerRouteShape) { out.push(...group); continue; }

      const groupRows = group.map(entry => rowFor(entry.url, rows));
      const column = chooseVaryingColumn(groupRows);
      if (column === null) { out.push(...group); continue; }

      const values = group.map((_, index) => (groupRows[index]?.[column] ?? '').toLowerCase());
      const ordered = oneOfEachFirst(group, values);
      const distinct = new Set(values.filter(Boolean));
      this.note(
        `${group.length} link(s) matching ${shape} differ in one column, which takes `
        + `${distinct.size} value(s): ${[...distinct].slice(0, 6).map(value => this.masker.maskText(value)).join(', ')}. `
        + `Taking one of each first, so the ${this.options.budget.maxInstancesPerRouteShape}-instance `
        + 'allowance is not spent on one of them.');
      out.push(...ordered);
    }
    return out;
  }



  private toDiscoveredElement(element: RawElement, page: readonly RawElement[]): DiscoveredElement {
    // The whole page is passed so the locator can be checked for uniqueness, not just built.
    const built = buildLocatorFor(element, page);
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
      triggeredByNormalizedUrl: visitKey(request.frame()?.url() ?? url),
      timesObserved: 1
    });
  }

  /**
   * A page that is really a JSON body: recorded as the endpoint it is, and read for the
   * records it names.
   *
   * Endpoints were only ever recorded from XHR and fetch traffic, which is how a browser
   * application calls its API. Open the same URL in the address bar and the browser calls
   * it a document, so a JSON API visited directly was filed as a page with no elements and
   * no kind — and the attack surface, built from endpoints, had none. Measured on a
   * token-authenticated order API: three pages, zero endpoints, and every authorization
   * check inconclusive for want of a path to test.
   *
   * The second half is the identifiers. A collection answers with the records it holds and
   * nothing on the application links to any of them: `/api/orders` lists orders carrying
   * their ids, `/api/orders/ord-1` exists, and no document anywhere points at it. So the
   * ids are read out and the instance URLs offered to the queue — as a hypothesis, tested
   * by a GET. REST's shape is a convention, not a rule, so nothing is assumed: the request
   * is made, and a 404 maps nothing and says so in the log like any other dead link.
   *
   * Bounded deliberately. At most a handful per collection, because the point is to put the
   * shape of the endpoint on the surface, not to walk every record in the database — and
   * the route-shape cap would stop it anyway, later and more expensively.
   */
  private readJsonDocument(
    url: string,
    status: number | undefined,
    contentType: string | undefined,
    body: string | undefined,
    instanceId: string | undefined,
    requiresAuthentication: boolean
  ): ApiInstanceCandidate[] {
    if (!isJsonContentType(contentType) || body === undefined) return [];

    // A hypothesis that came back 404 is not an endpoint.
    //
    // `instanceId` is set only for a URL this crawler built itself, by appending an
    // identifier it read out of a collection. That is a guess at REST's convention, and a
    // 404 is the application saying the guess was wrong — there is no route there. Recording
    // it anyway put twelve rows on freight's surface for a route that does not exist, named
    // `{id}` so they read as record endpoints, because the 404 body was JSON:
    //
    //   /api/shipments/shp-0001/{id}   sample: /api/shipments/shp-0001/BOOKED   404
    //
    // That URL exists because "BOOKED" was read out of a shipment as if it were a record
    // identifier. The surface then carries one fabricated template per record, which crowds
    // out real endpoints under a page or time cap — and `/api/shipments/{id}`, the one an
    // object-level authorization check needs, is a separate row a short crawl can miss.
    //
    // The distinction is the status, not the guessing. A 403 on an invented URL means the
    // route is there and refused, which is exactly what the surface wants; a 404 means it
    // was never there. A 404 on a URL the *application* linked to is a dead link, which is
    // a different report and still reaches the notes below.
    if (instanceId !== undefined && status === 404) {
      this.note(`${safeRoute(url)} answered 404, so the identifier read from its collection `
        + 'does not address a record this way. Nothing is recorded as an endpoint: a route '
        + 'that is not there is not a route.');
      return [];
    }

    // The endpoint, whatever else it answered: an API that 403s is still an API, and the
    // surface wants to know it is there.
    const template = instanceId === undefined
      ? normalizeUrl(url)
      : templateForInstance(url, instanceId) ?? normalizeUrl(url);
    const key = `GET ${template}`;
    if (!this.apiEndpoints.has(key)) {
      this.apiEndpoints.set(key, {
        method: 'GET',
        urlTemplate: template,
        sampleUrl: url.slice(0, 2000),
        statusCode: status,
        durationMs: 0,
        responseSample: this.masker.maskJson(body).slice(0, 4000),
        responseContentType: contentType,
        requiresAuthentication,
        triggeredByNormalizedUrl: visitKey(url),
        timesObserved: 1
      });
      this.note(`${safeRoute(url)} answered JSON, so it is recorded as an endpoint rather than a page.`);
    }

    if (status === undefined || status < 200 || status >= 300) return [];

    const ids = identifiersIn(body);
    if (ids.length === 0) return [];

    const candidates: ApiInstanceCandidate[] = [];
    for (const id of ids.slice(0, MAX_API_INSTANCES_PER_COLLECTION)) {
      try {
        const instance = new URL(url);
        instance.search = '';
        instance.hash = '';
        instance.pathname = `${instance.pathname.replace(/\/$/, '')}/${encodeURIComponent(id)}`;
        candidates.push({ url: instance.toString(), id });
      } catch {
        // An id that cannot be put in a path is not a candidate. Nothing is reported: the
        // collection is still recorded, and a record that cannot be addressed this way may
        // simply not be addressable this way.
      }
    }
    if (candidates.length > 0) {
      this.note(`${safeRoute(url)} named ${ids.length} record(s); trying ${candidates.length} of them `
        + 'as addresses under it, which the application may or may not serve.');
    }
    return candidates;
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

  /**
   * What was left in the queue when a budget stopped the crawl.
   *
   * Deduped on the same visit key the crawl uses and filtered to what it had not already
   * opened, so the number is URLs the crawl would have gone to and not queue bookkeeping.
   */
  private recordFrontier(queue: { url: string }[]): void {
    const seen = new Set<string>();
    this.unexplored = queue
      .map(entry => entry.url)
      .filter(url => {
        const key = visitKey(url);
        if (this.visited.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
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
/**
 * The column these rows differ in by a few values rather than by all of them.
 *
 * Returns null when no column qualifies — every row agreeing, or every row differing — in
 * which case document order is as good an order as any and the caller leaves it alone.
 */
/** The row a link sits in, matched the way the crawler's anchor lookup matches hrefs. */
function rowFor(url: string, rows: Array<[string, string[]]>): string[] | undefined {
  for (const [href, cells] of rows) {
    if (url.endsWith(href)) return cells;
  }
  return undefined;
}

export function chooseVaryingColumn(rows: Array<string[] | undefined>): number | null {
  const present = rows.filter((row): row is string[] => Array.isArray(row));
  if (present.length < 2) return null;

  const width = Math.min(...present.map(row => row.length));
  let best: { column: number; distinct: number } | null = null;

  for (let column = 0; column < width; column++) {
    const values = present.map(row => (row[column] ?? '').trim().toLowerCase());
    // A column some rows leave empty is not a column these records differ in; it is a
    // column the table does not always fill.
    if (values.some(value => !value)) continue;
    const distinct = new Set(values).size;
    // One value says nothing. As many values as rows is an identifier or a date, and
    // spreading across it reproduces the order it was meant to replace.
    if (distinct < 2 || distinct >= present.length) continue;
    if (best === null || distinct < best.distinct) best = { column, distinct };
  }
  return best?.column ?? null;
}

/**
 * Reorders items so one of each value comes before a second of any, keeping the original
 * order inside each value and across the values' first appearances. A stable round-robin:
 * the first three of rejected/accepted/accepted/rejected/held are rejected, accepted, held.
 */
export function oneOfEachFirst<T>(items: T[], values: string[]): T[] {
  const buckets = new Map<string, T[]>();
  for (const [index, item] of items.entries()) {
    const key = values[index] ?? '';
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }

  const out: T[] = [];
  while (out.length < items.length) {
    for (const bucket of buckets.values()) {
      const next = bucket.shift();
      if (next !== undefined) out.push(next);
    }
  }
  return out;
}

export function routeShapeOf(url: string): string {
  let path: string;
  try { path = new URL(url).pathname; } catch { return url; }
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return '/';
  // Only a segment that looks like a record's identifier is a variable: /accounts/8812 and
  // /accounts/9001 are one page shown twice, but /Retail/accounts and /Retail/transfer are
  // two pages. Treating every last segment as a variable capped an application whose
  // pages all live under one prefix at three pages.
  return '/' + segments.map(segment => isIdentifier(segment) ? '{id}' : segment.toLowerCase()).join('/');
}

/** Numbers, UUIDs, long hex, and codes that mix letters and several digits. */
export function isIdentifier(segment: string): boolean {
  const value = decodeURIComponent(segment);
  if (/^\d+$/.test(value)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  if (/^[0-9a-f]{12,}$/i.test(value)) return true;
  // ORD-2024-0042, a1b2c3d4: letters and at least three digits, no spaces.
  return /^[A-Za-z0-9_-]{6,}$/.test(value) && (value.match(/\d/g)?.length ?? 0) >= 3;
}

function safeRoute(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function fileSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}


/**
 * When a crawl must stop.
 *
 * Measured from when the run began, not from the moment a worker picked the job up. A
 * crawl whose worker died and whose job was reclaimed would otherwise start a fresh full
 * budget: measured on this project's own test lab, a run with a declared 900-second budget
 * was still mapping pages twenty minutes in, because the reclaim had reset its clock. A
 * budget that resets is not a budget.
 *
 * A reclaimed job whose budget has already gone is not given a deadline in the past. It
 * gets a short window instead — long enough to finish the page it is on and report what it
 * found, because a crawl that stops without reporting leaves the run looking stranded and
 * throws away the pages it already has.
 */
export function crawlDeadline(
  timeoutSeconds: number,
  runStartedAtMs: number | undefined,
  nowMs: number
): number {
  const budgetMs = Math.max(0, timeoutSeconds) * 1000;
  if (runStartedAtMs === undefined) return nowMs + budgetMs;

  const graceMs = Math.min(budgetMs, 30_000);
  return Math.max(runStartedAtMs + budgetMs, nowMs + graceMs);
}


/** How many records of one collection are opened. Enough to put the instance endpoint on
 *  the surface; not a walk through the database. */
const MAX_API_INSTANCES_PER_COLLECTION = 3;

/**
 * The endpoint template for a URL the crawler built from a known identifier: that segment,
 * and only that segment, becomes `{id}`.
 *
 * Matched on the value rather than on its position, so a collection that lives under a
 * nested path is handled without counting segments, and an id that happens to equal a
 * directory name earlier in the path cannot be the one replaced — the last occurrence is.
 */
export function templateForInstance(url: string, id: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }

  const segments = parsed.pathname.split('/');
  const encoded = encodeURIComponent(id);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] === id || segments[i] === encoded) {
      segments[i] = '{id}';
      return `${parsed.origin}${segments.join('/')}`;
    }
  }
  return null;
}

export function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const value = contentType.toLowerCase();
  // application/json, application/vnd.api+json, application/problem+json, text/json.
  return value.includes('/json') || value.includes('+json');
}

/**
 * The identifiers a JSON body names, in the order it names them.
 *
 * Only a string or a number directly under a record counts, and only under a field whose
 * name says it is an identifier. A nested object's id is left alone: an order carrying a
 * customer's id does not mean the collection serves customers.
 */
export function identifiersIn(body: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return []; }

  const records: unknown[] = Array.isArray(parsed) ? parsed
    : parsed !== null && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>).find(Array.isArray) as unknown[] ?? []
      : [];

  const ids: string[] = [];
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    for (const [field, value] of Object.entries(record as Record<string, unknown>)) {
      if (!IDENTIFIER_FIELD.test(field)) continue;
      if (typeof value === 'string' && value.trim() !== '' && value.length <= 128) { ids.push(value); break; }
      if (typeof value === 'number' && Number.isFinite(value)) { ids.push(String(value)); break; }
    }
  }
  return [...new Set(ids)];
}

/** id, orderId, order_id, uuid, reference, ref, key, slug, code — the names a record's own
 *  identifier is given. Matched whole, so "paid" and "idle" are not identifiers. */
const IDENTIFIER_FIELD = /^(id|_id|uuid|guid|key|slug|code|ref|reference|number|no|[a-z0-9]+(?:Id|_id|Uuid|_uuid|Key|_key|Ref|_ref))$/i;
