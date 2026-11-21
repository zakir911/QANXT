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
 * A map that stopped early has to say how much it is missing.
 *
 * Measured on this project's own 137-screen lab: a crawl reported "Stopped: the 900s
 * exploration budget was reached" after 150 pages, and that was the whole account. Five
 * planted defects sat on screens it never opened, and nothing in the report distinguished
 * "the budget cut off a handful of pages" from "the budget cut off a third of the
 * application". A coverage figure computed over the pages that were opened reads the same
 * either way, which is how a partial map comes to look like a complete one.
 *
 * The per-route cap is the second way it happens, and the quieter one. Three instances of
 * /declarations/{id} are three records in whatever state the list showed first; a defect
 * that only exists for a rejected record is behind that cap, and a reader has no way to
 * know the cap was what stopped it.
 *
 * Driven against a real server in a real browser: the claim is about what the crawl did
 * with its queue, and a mocked page would not have one.
 */
const HUB_LINKS = Array.from({ length: 12 }, (_, i) => `/page-${i + 1}`);
// Four digits, as a real application writes them: a one-digit suffix is not an
// identifier by the crawler's own rule, and the cap would never engage.
const RECORDS = Array.from({ length: 6 }, (_, i) => `/records/rec-${String(i + 1).padStart(4, '0')}`);

describe('a map that stopped early', () => {
  let server: Server;
  let baseUrl: string;
  let pool: BrowserPool;
  let context: BrowserContext;
  let artifactDir: string;

  const logger = new Logger('error', {}, () => {});

  const budget = (overrides: Record<string, unknown> = {}) => ({
    allowedHosts: ['127.0.0.1'],
    excludedPathPrefixes: ['/logout'],
    maxDepth: 3,
    maxPages: 50,
    maxActions: 200,
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
      const known = path === '/' || HUB_LINKS.includes(path) || RECORDS.includes(path);

      if (!known) {
        response.writeHead(404, { 'content-type': 'text/html' });
        response.end('<h1>Not found</h1>');
        return;
      }

      // Every page links to everything, so the queue is always deep: the crawl stops
      // because of its budget and not because it ran out of places to go.
      const links = [...HUB_LINKS, ...RECORDS]
        .map(href => `<a href="${href}">${href}</a>`).join(' ');
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><html><head><title>${path}</title></head>`
        + `<body><h1>${path}</h1><nav>${links}</nav></body></html>`);
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    artifactDir = await mkdtemp(join(tmpdir(), 'qanxt-partial-'));
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

  test('says how many URLs it never opened, not only that it stopped', async () => {
    const report = await crawl({ maxPages: 4 });

    expect(report.status).toBe('partiallyCompleted');
    expect(report.progressLog).toMatch(/page budget was reached/);
    // The magnitude is the point. Asserting only that it stopped is what the report
    // already did, and is exactly what left five screens unaccounted for.
    const said = /(\d+) URL\(s\) were still waiting to be opened/.exec(report.progressLog);
    expect(said).not.toBeNull();
    expect(Number(said![1])).toBeGreaterThan(5);
  }, 90_000);

  test('names some of what is missing, so the gap can be acted on', async () => {
    const report = await crawl({ maxPages: 4 });

    expect(report.progressLog).toMatch(/Raise the budget on the application/);
    expect(report.progressLog).toMatch(/\/page-\d+|\/records\//);
  }, 90_000);

  test('counts only URLs it had not already opened', async () => {
    // Every page links to every other, so the queue fills with URLs already visited.
    // Counting the raw queue would report a frontier several times the site's size.
    const report = await crawl({ maxPages: 6 });
    const said = /(\d+) URL\(s\) were still waiting to be opened/.exec(report.progressLog);

    expect(said).not.toBeNull();
    expect(Number(said![1])).toBeLessThanOrEqual(HUB_LINKS.length + RECORDS.length);
  }, 90_000);

  test('says nothing about a frontier when the crawl finished the application', async () => {
    // The note must not fire on a complete crawl: a map that saw everything claiming it
    // missed something is the same failure in the other direction.
    const report = await crawl();

    expect(report.status).toBe('completed');
    expect(report.progressLog).not.toMatch(/still waiting to be opened/);
  }, 120_000);

  test('says how many pages the per-route cap kept it from opening', async () => {
    const report = await crawl();

    // Six records, a cap of three: three were skipped, and the reason is not the budget.
    expect(report.progressLog).toMatch(/3 page\(s\) were not opened because their route/);
    expect(report.progressLog).toMatch(/\/records\/\{id\} \(3\)/);
    expect(report.progressLog).toMatch(/Instances are taken in crawl order/);
  }, 120_000);
});
