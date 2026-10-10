import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { Crawler } from '../src/discovery/crawler.js';
import { Logger } from '../src/util/logger.js';

/**
 * An application with no links at all.
 *
 * This is the shape that defeated discovery: every page renders, every page is reachable
 * by URL, and not one of them is linked from another, because navigation happens in
 * JavaScript. A crawl that spreads by following links finds the page it started on and
 * reports success. The numbers look like a small application rather than a failed crawl.
 *
 * Driven against a real server in a real browser, because the fix is about what the
 * crawler does over HTTP and a mocked page would not exercise it.
 */
const PAGES: Record<string, string> = {
  '/': '<h1>Home</h1><p>No links anywhere.</p>',
  '/dashboard': '<h1>Dashboard</h1><button id="go">Go to users</button>',
  '/users': '<h1>Users</h1><input id="q" aria-label="Search users">',
  '/reports': '<h1>Reports</h1><table><tr><td>row</td></tr></table>',
  '/settings': '<h1>Settings</h1><input id="name" aria-label="Display name">'
};

describe('reaching pages that nothing links to', () => {
  let server: Server;
  let baseUrl: string;
  let pool: BrowserPool;
  let context: BrowserContext;
  let artifactDir: string;

  const logger = new Logger('error', {}, () => {});

  const budget = (overrides: Record<string, unknown> = {}) => ({
    allowedHosts: ['127.0.0.1'],
    excludedPathPrefixes: ['/logout'],
    maxDepth: 2,
    maxPages: 20,
    maxActions: 100,
    maxInstancesPerRouteShape: 3,
    timeoutSeconds: 90,
    allowPrivateNetworks: true,
    respectRobotsTxt: false,
    interactionMode: 'links' as const,
    allowStateChangingClicks: false,
    seedUrls: [] as string[],
    useSitemap: false,
    ...overrides
  });

  const crawl = async (overrides: Record<string, unknown> = {}) => {
    const crawler = new Crawler(context, {
      baseUrl: `${baseUrl}/`,
      artifactDir,
      navigationTimeoutMs: 15_000,
      auth: { strategy: 'none' },
      budget: budget(overrides) as never
    }, logger);

    return crawler.run(`run-${Math.random().toString(36).slice(2)}`, 'worker-test');
  };

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0]!;

      if (path === '/sitemap.xml') {
        response.writeHead(200, { 'content-type': 'application/xml' });
        response.end(
          '<?xml version="1.0" encoding="UTF-8"?>'
          + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
          + `<url><loc>${baseUrl}/reports</loc></url>`
          + `<url><loc>${baseUrl}/settings</loc></url>`
          + '</urlset>');
        return;
      }

      const body = PAGES[path];
      if (body === undefined) {
        response.writeHead(404, { 'content-type': 'text/html' });
        response.end('<h1>Not found</h1>');
        return;
      }

      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><html><head><title>${path}</title></head><body>${body}</body></html>`);
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    artifactDir = await mkdtemp(join(tmpdir(), 'qanxt-seed-'));
    pool = new BrowserPool(true, logger);
    context = await pool.createContext('chromium', {
      defaultTimeoutMs: 8000, navigationTimeoutMs: 15_000
    });
  }, 120_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close().catch(() => undefined);
    await new Promise<void>(resolve => server?.close(() => resolve()));
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
  });

  test('without help, a link-less application yields only its landing page', async () => {
    const report = await crawl();

    // The defect, reproduced: four other pages exist and are reachable by URL.
    expect(report.pages).toHaveLength(1);
    expect(report.status).toBe('completed');
  }, 90_000);

  test('and the run says why, rather than looking like a complete crawl', async () => {
    const report = await crawl();

    // One page with a success badge and no explanation is indistinguishable from an
    // application that genuinely has one page.
    expect(report.progressLog).toMatch(/no link was found to follow|left unclicked/i);
  }, 90_000);

  test('routes the owner lists are explored', async () => {
    const report = await crawl({ seedUrls: ['/dashboard', '/users'] });

    const routes = report.pages.map(p => p.route).sort();
    expect(routes).toContain('/dashboard');
    expect(routes).toContain('/users');
    expect(report.pages.length).toBeGreaterThanOrEqual(3);
  }, 90_000);

  test('a full URL works as well as a path, because people paste both', async () => {
    const report = await crawl({ seedUrls: [`${baseUrl}/settings`] });

    expect(report.pages.map(p => p.route)).toContain('/settings');
  }, 90_000);

  test('the sitemap is read when the application publishes one', async () => {
    const report = await crawl({ useSitemap: true });

    const routes = report.pages.map(p => p.route);
    expect(routes).toContain('/reports');
    expect(routes).toContain('/settings');
  }, 90_000);

  test('a listed route is still subject to the exclusion list', async () => {
    // A route somebody typed does not outrank the crawl boundary. If it did, the boundary
    // would be advisory and the safest control in discovery would be the easiest to lose.
    const report = await crawl({
      seedUrls: ['/users'],
      excludedPathPrefixes: ['/users']
    });

    expect(report.pages.map(p => p.route)).not.toContain('/users');
    expect(report.pagesBlockedByPolicy).toBeGreaterThan(0);
  }, 90_000);

  test('a nonsense entry is reported rather than silently dropped', async () => {
    const report = await crawl({ seedUrls: ['http://'] });

    // A route somebody listed that was ignored without a word is worse than one that
    // errors: the crawl afterwards looks complete.
    expect(report.progressLog).toMatch(/Ignored|not a URL/i);
  }, 90_000);
});
