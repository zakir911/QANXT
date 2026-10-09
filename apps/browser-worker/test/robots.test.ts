import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BrowserContext } from 'playwright';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { Crawler } from '../src/discovery/crawler.js';
import { Logger } from '../src/util/logger.js';
import {
  MAX_CRAWL_DELAY_SECONDS, RobotsPolicy, parseRobotsTxt, patternMatches, robotsAllows,
  type RobotsFetcher, type RobotsResponse
} from '../src/security/robots.js';

/**
 * `respectRobotsTxt` defaulted to true, travelled from the application record into the
 * discovery job, and was read by nothing: the crawler never fetched /robots.txt, so the
 * documented "robots-respecting default" was a claim with no control behind it. These
 * tests are the control.
 *
 * The parser is exercised directly and the enforcement is exercised through a real crawl
 * against a real server, because a parser that is right and a crawler that never asks it
 * is the bug being fixed.
 */

describe('parsing robots.txt', () => {
  test('reads the rules of the group that names us', () => {
    const directives = parseRobotsTxt([
      'User-agent: Googlebot',
      'Disallow: /google-only',
      '',
      'User-agent: HeadlessChrome',
      'Disallow: /private',
      'Allow: /private/public-bit',
      'Crawl-delay: 2'
    ].join('\n'), 'Mozilla/5.0 HeadlessChrome/141.0.0.0');

    expect(directives.matchedUserAgent).toBe('headlesschrome');
    expect(directives.disallow).toEqual(['/private']);
    expect(directives.allow).toEqual(['/private/public-bit']);
    expect(directives.crawlDelaySeconds).toBe(2);
  });

  test('falls back to the wildcard group when no group names us', () => {
    const directives = parseRobotsTxt([
      'User-agent: Googlebot',
      'Disallow: /google-only',
      '',
      'User-agent: *',
      'Disallow: /admin'
    ].join('\n'), 'Mozilla/5.0 Chrome/141.0.0.0');

    expect(directives.matchedUserAgent).toBe('*');
    expect(directives.disallow).toEqual(['/admin']);
  });

  test('prefers the most specific group that matches', () => {
    const body = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: chrome',
      'Disallow: /nothing-much'
    ].join('\n');

    const directives = parseRobotsTxt(body, 'Mozilla/5.0 HeadlessChrome/141 Chrome/141');
    expect(directives.matchedUserAgent).toBe('chrome');
    expect(directives.disallow).toEqual(['/nothing-much']);
  });

  test('merges groups that name the same agent', () => {
    const directives = parseRobotsTxt([
      'User-agent: *',
      'Disallow: /a',
      '',
      'User-agent: *',
      'Disallow: /b'
    ].join('\n'), 'anything');

    expect(directives.disallow).toEqual(['/a', '/b']);
  });

  test('treats consecutive user-agent lines as one group header', () => {
    const directives = parseRobotsTxt([
      'User-agent: Googlebot',
      'User-agent: Bingbot',
      'Disallow: /search'
    ].join('\n'), 'Mozilla/5.0 Bingbot/2.0');

    expect(directives.matchedUserAgent).toBe('bingbot');
    expect(directives.disallow).toEqual(['/search']);
  });

  test('an empty Disallow restricts nothing', () => {
    // "Disallow:" with no path is the documented way to permit everything. Storing it as a
    // pattern would make it match every path and refuse the whole site.
    const directives = parseRobotsTxt('User-agent: *\nDisallow:', 'anything');
    expect(directives.disallow).toEqual([]);
    expect(robotsAllows(directives, '/anywhere')).toBe(true);
  });

  test('ignores comments, blank lines and directives it does not implement', () => {
    const directives = parseRobotsTxt([
      '# a comment',
      'Sitemap: https://example.test/sitemap.xml',
      'User-agent: *   # trailing comment',
      'Disallow: /admin # and here',
      'Host: example.test',
      'this line is not a directive'
    ].join('\n'), 'anything');

    expect(directives.disallow).toEqual(['/admin']);
  });

  test('discards rules written before any user-agent line', () => {
    const directives = parseRobotsTxt('Disallow: /orphan\nUser-agent: *\nDisallow: /admin', 'x');
    expect(directives.disallow).toEqual(['/admin']);
  });

  test('ignores a crawl-delay that is not a positive number', () => {
    expect(parseRobotsTxt('User-agent: *\nCrawl-delay: soon', 'x').crawlDelaySeconds).toBe(0);
    expect(parseRobotsTxt('User-agent: *\nCrawl-delay: -4', 'x').crawlDelaySeconds).toBe(0);
  });
});

describe('matching a robots.txt pattern', () => {
  test('a pattern is a prefix, not a whole path', () => {
    expect(patternMatches('/admin', '/admin')).toBe(true);
    expect(patternMatches('/admin', '/admin/users')).toBe(true);
    expect(patternMatches('/admin', '/administrator')).toBe(true);
    expect(patternMatches('/admin', '/public/admin')).toBe(false);
  });

  test('$ anchors the end of the path', () => {
    expect(patternMatches('/admin$', '/admin')).toBe(true);
    expect(patternMatches('/admin$', '/admin/users')).toBe(false);
    expect(patternMatches('/$', '/')).toBe(true);
    expect(patternMatches('/$', '/anything')).toBe(false);
  });

  test('* stands for any sequence', () => {
    expect(patternMatches('/*/edit', '/accounts/edit')).toBe(true);
    expect(patternMatches('/*/edit', '/a/b/c/edit')).toBe(true);
    expect(patternMatches('/*/edit', '/edit-nothing')).toBe(false);
    expect(patternMatches('/fish*', '/fish/salmon')).toBe(true);
  });

  test('* and $ combine', () => {
    expect(patternMatches('/*.pdf$', '/reports/q3.pdf')).toBe(true);
    expect(patternMatches('/*.pdf$', '/reports/q3.pdf.html')).toBe(false);
    expect(patternMatches('/private*$', '/private/anything/at/all')).toBe(true);
  });

  test('paths are case-sensitive', () => {
    expect(patternMatches('/Admin', '/admin')).toBe(false);
  });

  test('query strings are part of what is matched', () => {
    expect(patternMatches('/search?*', '/search?q=x')).toBe(true);
    expect(patternMatches('/*?export=', '/accounts?export=csv')).toBe(true);
  });
});

describe('resolving allow against disallow', () => {
  const directives = parseRobotsTxt([
    'User-agent: *',
    'Disallow: /private',
    'Allow: /private/brochure'
  ].join('\n'), 'x');

  test('the longest matching pattern wins', () => {
    expect(robotsAllows(directives, '/private/accounts')).toBe(false);
    expect(robotsAllows(directives, '/private/brochure')).toBe(true);
    expect(robotsAllows(directives, '/private/brochure/page-2')).toBe(true);
  });

  test('a path no pattern matches is permitted', () => {
    expect(robotsAllows(directives, '/dashboard')).toBe(true);
  });

  test('a tie goes to allow', () => {
    const tied = parseRobotsTxt('User-agent: *\nDisallow: /x\nAllow: /x', 'x');
    expect(robotsAllows(tied, '/x/y')).toBe(true);
  });

  test('Disallow: / refuses the whole site', () => {
    const closed = parseRobotsTxt('User-agent: *\nDisallow: /', 'x');
    expect(robotsAllows(closed, '/')).toBe(false);
    expect(robotsAllows(closed, '/anything')).toBe(false);
  });
});

describe('RobotsPolicy over one origin', () => {
  const fetcherReturning = (response: RobotsResponse | null, calls?: string[]): RobotsFetcher =>
    async url => { calls?.push(url); return response; };

  test('asks each origin once and remembers the answer', async () => {
    const calls: string[] = [];
    const policy = new RobotsPolicy(
      fetcherReturning({ status: 200, body: 'User-agent: *\nDisallow: /admin' }, calls), 'x');

    expect((await policy.allows('https://site.test/public')).allowed).toBe(true);
    expect((await policy.allows('https://site.test/admin')).allowed).toBe(false);
    expect((await policy.allows('https://site.test/admin/users')).allowed).toBe(false);
    expect(calls).toEqual(['https://site.test/robots.txt']);
  });

  test('shares one in-flight fetch between simultaneous questions', async () => {
    const calls: string[] = [];
    let release: (value: RobotsResponse) => void = () => {};
    const policy = new RobotsPolicy(async url => {
      calls.push(url);
      return new Promise<RobotsResponse>(resolve => { release = resolve; });
    }, 'x');

    const both = Promise.all([policy.allows('https://site.test/a'), policy.allows('https://site.test/b')]);
    release({ status: 200, body: 'User-agent: *\nDisallow: /b' });
    const [a, b] = await both;

    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test('a 404 means the site publishes no rules, so everything is permitted', async () => {
    const policy = new RobotsPolicy(fetcherReturning({ status: 404, body: '' }), 'x');
    expect((await policy.allows('https://site.test/anything')).allowed).toBe(true);
  });

  test('a 500 means the rules are unknown, so nothing is permitted', async () => {
    const policy = new RobotsPolicy(fetcherReturning({ status: 503, body: '' }), 'x');
    const decision = await policy.allows('https://site.test/anything');

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('503');
    // The refusal has to be actionable, or a run that maps nothing looks like an empty
    // application rather than a decision.
    expect(decision.reason).toContain('respect robots.txt');
  });

  test('a 429 is treated the same as a server error', async () => {
    const policy = new RobotsPolicy(fetcherReturning({ status: 429, body: '' }), 'x');
    expect((await policy.allows('https://site.test/anything')).allowed).toBe(false);
  });

  test('a failed request refuses the origin and says so', async () => {
    const policy = new RobotsPolicy(fetcherReturning(null), 'x');
    const decision = await policy.allows('https://site.test/anything');

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('could not be fetched');
  });

  test('keeps origins apart', async () => {
    const policy = new RobotsPolicy(async url => url.startsWith('https://closed.test')
      ? { status: 200, body: 'User-agent: *\nDisallow: /' }
      : { status: 404, body: '' }, 'x');

    expect((await policy.allows('https://closed.test/page')).allowed).toBe(false);
    expect((await policy.allows('https://open.test/page')).allowed).toBe(true);
  });

  test('reports what it found once per origin', async () => {
    const notes: string[] = [];
    const policy = new RobotsPolicy(
      fetcherReturning({ status: 200, body: 'User-agent: *\nDisallow: /admin\nCrawl-delay: 1' }),
      'x',
      (origin, description) => notes.push(`${origin} ${description}`));

    await policy.allows('https://site.test/a');
    await policy.allows('https://site.test/b');

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('https://site.test');
    expect(notes[0]).toContain('1 disallow');
    expect(notes[0]).toContain('crawl-delay 1s');
  });

  test('caps the crawl delay it will honour, and says it capped it', async () => {
    const notes: string[] = [];
    const policy = new RobotsPolicy(
      fetcherReturning({ status: 200, body: 'User-agent: *\nCrawl-delay: 3600' }),
      'x',
      (_, description) => notes.push(description));

    await policy.allows('https://slow.test/a');

    expect(policy.crawlDelayMsFor('https://slow.test/a')).toBe(MAX_CRAWL_DELAY_SECONDS * 1000);
    expect(notes[0]).toContain('honoured as');
  });

  test('a URL that is not absolute is refused rather than assumed harmless', async () => {
    const policy = new RobotsPolicy(fetcherReturning({ status: 404, body: '' }), 'x');
    expect((await policy.allows('/relative')).allowed).toBe(false);
  });
});

/**
 * The enforcement itself, against a real server in a real browser. A stub would not have
 * caught the original defect: the parser did not exist, but neither did the call.
 */
describe('the crawler honours robots.txt', () => {
  let server: Server;
  let baseUrl: string;
  let pool: BrowserPool;
  let artifactDir: string;

  const logger = new Logger('error', {}, () => {});

  const budget = (respectRobotsTxt: boolean) => ({
    allowedHosts: ['127.0.0.1'],
    excludedPathPrefixes: [],
    maxDepth: 2,
    maxPages: 20,
    maxActions: 100,
    maxInstancesPerRouteShape: 5,
    timeoutSeconds: 60,
    allowPrivateNetworks: true,
    respectRobotsTxt
  });

  const crawl = async (respectRobotsTxt: boolean) => {
    let context: BrowserContext | undefined;
    try {
      context = await pool.createContext('chromium', {
        defaultTimeoutMs: 10_000, navigationTimeoutMs: 20_000
      });
      const crawler = new Crawler(context, {
        baseUrl,
        artifactDir,
        navigationTimeoutMs: 20_000,
        auth: { strategy: 'none' },
        budget: budget(respectRobotsTxt)
      }, logger);
      return await crawler.run(`robots-${respectRobotsTxt}`, 'worker-test');
    } finally {
      await context?.close().catch(() => undefined);
    }
  };

  beforeAll(async () => {
    artifactDir = await mkdtemp(join(tmpdir(), 'qanxt-robots-'));
    pool = new BrowserPool(true, logger);

    const page = (title: string, links: string[]) =>
      `<!doctype html><title>${title}</title><body><h1>${title}</h1>`
      + links.map(href => `<a href="${href}">${href}</a>`).join(' ')
      + '</body>';

    server = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';

      if (path === '/robots.txt') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('User-agent: *\nDisallow: /private\nAllow: /private/brochure\n');
        return;
      }

      const known: Record<string, string> = {
        '/': page('Home', ['/open', '/private/accounts', '/private/brochure']),
        '/open': page('Open', ['/']),
        '/private/accounts': page('Private accounts', ['/']),
        '/private/brochure': page('Brochure', ['/'])
      };
      const body = known[path];
      if (body === undefined) {
        response.writeHead(404, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Not found</title>');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body);
    });

    await new Promise<void>(resolve => server.listen(4317, '127.0.0.1', () => resolve()));
    baseUrl = 'http://127.0.0.1:4317/';
  }, 60_000);

  afterAll(async () => {
    await pool?.close();
    await new Promise<void>(resolve => server?.close(() => resolve()));
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
  });

  test('does not map a page robots.txt disallows, and says why', async () => {
    const report = await crawl(true);
    const routes = report.pages.map(p => p.route);

    expect(routes).toContain('/');
    expect(routes).toContain('/open');
    expect(routes).not.toContain('/private/accounts');
    expect(report.pagesBlockedByPolicy).toBeGreaterThan(0);
    expect(report.progressLog).toContain('disallows /private/accounts');
  }, 120_000);

  test('still maps what an Allow rule carves back out', async () => {
    const report = await crawl(true);
    expect(report.pages.map(p => p.route)).toContain('/private/brochure');
  }, 120_000);

  test('records which rules it read', async () => {
    const report = await crawl(true);
    expect(report.progressLog).toContain('1 disallow and 1 allow rule(s)');
  }, 120_000);

  test('maps the disallowed page when the application opts out', async () => {
    // The other half of the proof: with the flag off the page is reachable, so the absence
    // above is the rule being honoured and not a crawl that failed to find the link.
    const report = await crawl(false);

    expect(report.pages.map(p => p.route)).toContain('/private/accounts');
    expect(report.progressLog).toContain('configured to ignore it');
  }, 120_000);
});
