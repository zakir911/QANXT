/**
 * robots.txt, enforced.
 *
 * The application record carries `respectRobotsTxt` and it defaults to true, the discovery
 * job payload has carried it to the worker since discovery was written, and
 * `docs/architecture-assessment.md` lists a "robots-respecting default" among the controls
 * on crawling somebody else's application. Nothing read the flag. The crawler never asked
 * for /robots.txt, so the default was a claim rather than a control — which matters the
 * moment the target is a live site rather than the demo bank.
 *
 * Follows RFC 9309 where it is specific:
 *   - group selection by user-agent, `*` as the fallback group,
 *   - `Allow` and `Disallow` as path patterns with `*` and `$`,
 *   - the longest matching pattern wins, and `Allow` wins a tie,
 *   - 4xx means there are no rules, so everything is permitted,
 *   - 429 and 5xx mean the rules are unknown, which is treated as permitting nothing.
 *
 * That last one fails closed, and deliberately: a site that cannot tell us what it does not
 * want crawled has not thereby consented to all of it. The reason is written into the
 * exploration log, so a run that maps nothing says why rather than looking like an empty
 * application.
 *
 * `Crawl-delay` is not in RFC 9309 but is widely published and is part of what a site is
 * asking for. It is honoured, capped, and the cap is logged — an hour-long delay would
 * otherwise spend a whole exploration budget waiting.
 */

/** The rules that apply to one user agent, with the groups that named it merged. */
export interface RobotsDirectives {
  allow: string[];
  disallow: string[];
  crawlDelaySeconds: number;
  /** The group header that won, for the log. `*` when only the fallback group matched. */
  matchedUserAgent: string;
}

export const EMPTY_DIRECTIVES: RobotsDirectives = {
  allow: [], disallow: [], crawlDelaySeconds: 0, matchedUserAgent: '*'
};

/** No `Crawl-delay` is honoured beyond this; a longer one would eat the whole budget. */
export const MAX_CRAWL_DELAY_SECONDS = 10;

interface Group {
  tokens: string[];
  allow: string[];
  disallow: string[];
  crawlDelaySeconds?: number;
}

/**
 * Parses a robots.txt body and resolves it for one user agent.
 *
 * Unparseable lines are skipped rather than failing the file: robots.txt is written by hand
 * and a typo in one directive is not a reason to ignore the ones around it.
 */
export function parseRobotsTxt(body: string, userAgent: string): RobotsDirectives {
  const groups: Group[] = [];
  let current: Group | null = null;
  // Consecutive user-agent lines form one group header. A rule line closes the header, so
  // the next user-agent line after a rule starts a new group.
  let headerOpen = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!headerOpen || current === null) {
        current = { tokens: [], allow: [], disallow: [] };
        groups.push(current);
        headerOpen = true;
      }
      if (value !== '') current.tokens.push(value.toLowerCase());
      continue;
    }

    // A rule before any user-agent line belongs to no group and is discarded, as is
    // anything global (Sitemap, Host).
    if (current === null) continue;
    headerOpen = false;

    if (field === 'disallow') {
      // An empty Disallow is the documented way to say "nothing is disallowed". It is not
      // a pattern matching everything, so it must not be stored as one.
      if (value !== '') current.disallow.push(value);
    } else if (field === 'allow') {
      if (value !== '') current.allow.push(value);
    } else if (field === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds > 0) current.crawlDelaySeconds = seconds;
    }
  }

  return resolveForUserAgent(groups, userAgent);
}

/**
 * Picks the groups that apply to us and merges them.
 *
 * Matching is by substring of our user-agent rather than by product token, because the
 * worker drives a real browser and sends a real browser's user-agent — there is no bot
 * token to match on. A site that writes `User-agent: Chrome` is therefore honoured, which
 * is the conservative direction to be wrong in.
 */
function resolveForUserAgent(groups: Group[], userAgent: string): RobotsDirectives {
  const ua = userAgent.toLowerCase();

  let winner = '';
  for (const group of groups) {
    for (const token of group.tokens) {
      if (token === '*') continue;
      if (!ua.includes(token)) continue;
      // Most specific wins, and specificity is the length of the token that matched.
      if (token.length > winner.length) winner = token;
    }
  }
  if (winner === '') winner = '*';

  const matching = groups.filter(group => group.tokens.includes(winner));
  if (matching.length === 0) return { ...EMPTY_DIRECTIVES, matchedUserAgent: winner };

  const merged: RobotsDirectives = {
    allow: matching.flatMap(g => g.allow),
    disallow: matching.flatMap(g => g.disallow),
    // Several groups naming the same agent is already unusual; honour the longest delay
    // asked for rather than whichever happened to be parsed last.
    crawlDelaySeconds: Math.max(0, ...matching.map(g => g.crawlDelaySeconds ?? 0)),
    matchedUserAgent: winner
  };
  return merged;
}

/**
 * Whether robots.txt permits a path.
 *
 * `target` is the path and query as the server sees it; the fragment is never sent and so
 * is never matched on.
 */
export function robotsAllows(directives: RobotsDirectives, target: string): boolean {
  const allow = longestMatch(directives.allow, target);
  const disallow = longestMatch(directives.disallow, target);

  if (disallow === null) return true;
  if (allow === null) return false;
  // A tie goes to Allow: a site that states both at the same specificity has not clearly
  // refused, and the narrower reading of a refusal is the right one.
  return allow >= disallow;
}

/** The length of the longest pattern in `patterns` matching `target`, or null if none do. */
function longestMatch(patterns: string[], target: string): number | null {
  let best: number | null = null;
  for (const pattern of patterns) {
    if (!patternMatches(pattern, target)) continue;
    if (best === null || pattern.length > best) best = pattern.length;
  }
  return best;
}

/**
 * Matches one robots.txt pattern against a path.
 *
 * Patterns are prefixes, not whole-string matches: `/admin` matches `/admin/users`. `*`
 * stands for any sequence of characters and `$` anchors the end of the path. Paths are
 * case-sensitive, which is what the specification says and what servers do.
 */
export function patternMatches(pattern: string, target: string): boolean {
  if (pattern === '') return false;

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const segments = body.split('*');

  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === '') continue;

    if (i === 0) {
      // The first segment is a literal prefix: robots patterns are rooted at the path.
      if (!target.startsWith(segment)) return false;
      cursor = segment.length;
      continue;
    }

    const isLast = i === segments.length - 1;
    if (isLast && anchored) {
      // "/x*.php$" — the tail has to sit at the very end, and not overlap what we matched.
      if (!target.endsWith(segment)) return false;
      return target.length - segment.length >= cursor;
    }

    const found = target.indexOf(segment, cursor);
    if (found === -1) return false;
    cursor = found + segment.length;
  }

  // Only reachable for an anchored pattern whose last segment was empty or absent: either
  // a trailing wildcard, which swallows whatever remains, or a plain prefix like "/admin$",
  // which has to have reached the end of the path.
  if (anchored && !body.endsWith('*')) return target.length === cursor;
  return true;
}

// ---------------------------------------------------------------------------------------
// Fetching and caching, one entry per origin
// ---------------------------------------------------------------------------------------

/** What a fetch of robots.txt came back with. `null` means the request itself failed. */
export interface RobotsResponse {
  status: number;
  body: string;
}

export type RobotsFetcher = (robotsUrl: string) => Promise<RobotsResponse | null>;

export interface RobotsDecision {
  allowed: boolean;
  /** Written into the exploration log when a URL is refused. */
  reason: string;
}

interface OriginState {
  directives: RobotsDirectives;
  /** Set when the rules could not be read, so nothing is permitted for this origin. */
  unavailableReason?: string;
}

/**
 * Per-origin robots.txt, fetched once and remembered for the run.
 *
 * A crawl can cross origins when an application spans hosts and the allowlist permits it,
 * so the rules are keyed on origin rather than fetched once for the base URL. Concurrent
 * asks for the same origin share one in-flight fetch: the queue loop is serial today, but
 * a second request for robots.txt because two links happened to arrive together would be
 * exactly the kind of extra traffic this class exists to avoid.
 */
export class RobotsPolicy {
  private readonly origins = new Map<string, OriginState>();
  private readonly inFlight = new Map<string, Promise<OriginState>>();

  constructor(
    private readonly fetcher: RobotsFetcher,
    private readonly userAgent: string,
    /** Called once per origin, with what was found. The crawler writes it to its log. */
    private readonly onOriginLoaded?: (origin: string, description: string) => void
  ) {}

  async allows(url: string): Promise<RobotsDecision> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: 'robots.txt could not be checked: the URL is not absolute' };
    }

    const state = await this.stateFor(parsed.origin);
    if (state.unavailableReason) {
      return { allowed: false, reason: state.unavailableReason };
    }

    const target = `${parsed.pathname}${parsed.search}`;
    if (robotsAllows(state.directives, target)) return { allowed: true, reason: '' };

    const agent = state.directives.matchedUserAgent;
    return {
      allowed: false,
      reason: `robots.txt at ${parsed.origin} disallows ${target}`
        + (agent === '*' ? '' : ` for '${agent}'`)
    };
  }

  /** The delay this origin asks for between requests, in milliseconds, already capped. */
  crawlDelayMsFor(url: string): number {
    let origin: string;
    try { origin = new URL(url).origin; } catch { return 0; }
    const asked = this.origins.get(origin)?.directives.crawlDelaySeconds ?? 0;
    return Math.min(asked, MAX_CRAWL_DELAY_SECONDS) * 1000;
  }

  private async stateFor(origin: string): Promise<OriginState> {
    const known = this.origins.get(origin);
    if (known) return known;

    const pending = this.inFlight.get(origin);
    if (pending) return pending;

    const load = this.load(origin).then(state => {
      this.origins.set(origin, state);
      this.inFlight.delete(origin);
      this.onOriginLoaded?.(origin, describe(state));
      return state;
    });
    this.inFlight.set(origin, load);
    return load;
  }

  private async load(origin: string): Promise<OriginState> {
    const response = await this.fetcher(`${origin}/robots.txt`);

    if (response === null) {
      return {
        directives: EMPTY_DIRECTIVES,
        unavailableReason: `robots.txt at ${origin} could not be fetched, so nothing there is `
          + 'crawled. Set "respect robots.txt" off on the application to explore it anyway.'
      };
    }

    const { status } = response;
    if (status >= 200 && status < 300) {
      return { directives: parseRobotsTxt(response.body, this.userAgent) };
    }
    if (status === 429 || status >= 500) {
      return {
        directives: EMPTY_DIRECTIVES,
        unavailableReason: `robots.txt at ${origin} answered ${status}, so its rules are unknown `
          + 'and nothing there is crawled. Set "respect robots.txt" off on the application to '
          + 'explore it anyway.'
      };
    }
    // Any other status, 404 included, means the site publishes no rules.
    return { directives: EMPTY_DIRECTIVES };
  }
}

function describe(state: OriginState): string {
  if (state.unavailableReason) return state.unavailableReason;

  const { allow, disallow, crawlDelaySeconds, matchedUserAgent } = state.directives;
  if (allow.length === 0 && disallow.length === 0 && crawlDelaySeconds === 0) {
    return 'robots.txt permits everything here.';
  }

  const parts = [`${disallow.length} disallow and ${allow.length} allow rule(s)`];
  if (matchedUserAgent !== '*') parts.push(`matched on '${matchedUserAgent}'`);
  if (crawlDelaySeconds > 0) {
    const honoured = Math.min(crawlDelaySeconds, MAX_CRAWL_DELAY_SECONDS);
    parts.push(honoured < crawlDelaySeconds
      ? `crawl-delay ${crawlDelaySeconds}s, honoured as ${honoured}s`
      : `crawl-delay ${crawlDelaySeconds}s`);
  }
  return `robots.txt: ${parts.join(', ')}.`;
}

/**
 * The part of Playwright's APIRequestContext this needs, named so the fetcher can be
 * driven by a stub in a test without standing up a browser.
 */
export interface RobotsRequestContext {
  get(url: string, options?: { timeout?: number; failOnStatusCode?: boolean }):
    Promise<{ status(): number; text(): Promise<string> }>;
}

/** Builds a fetcher over Playwright's request context, so it shares the crawl's session. */
export function requestContextFetcher(
  request: RobotsRequestContext,
  timeoutMs: number
): RobotsFetcher {
  return async robotsUrl => {
    try {
      const response = await request.get(robotsUrl, { timeout: timeoutMs, failOnStatusCode: false });
      const status = response.status();
      // Only a 2xx body is worth reading; an error page is not a rule set.
      const body = status >= 200 && status < 300 ? await response.text() : '';
      return { status, body };
    } catch {
      return null;
    }
  };
}
