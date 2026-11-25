import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { BrowserContext } from 'playwright';
import type { DiscoveryCompletionReport } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { Crawler } from '../src/discovery/crawler.js';
import { Logger } from '../src/util/logger.js';

/**
 * A URL the crawler invented, which the application says is not there.
 *
 * Reading identifiers out of a collection and appending them is a hypothesis about REST's
 * convention, and a good one. The application's answer decides whether it held. A 403 means
 * the route is there and refused, which the surface wants. A 404 means it was never there.
 *
 * Recording the 404 anyway put twelve rows on freight's surface for a route that does not
 * exist, each named `{id}` so it read as a record endpoint, because the 404 body was JSON:
 *
 *   /api/shipments/shp-0001/{id}   sample: /api/shipments/shp-0001/BOOKED   404
 *
 * "BOOKED" is a shipment's status, read out of a record as if it were an identifier. The
 * surface then carries one fabricated template per record, crowding out real endpoints under
 * a page cap — while `/api/shipments/{id}`, the one an object-level authorization check needs,
 * is a separate row a short crawl can miss.
 *
 * This fixture is that shape exactly: a collection of records, each carrying a status, and no
 * route under a record.
 */
describe('an instance URL the application does not serve', () => {
  let server: Server;
  let pool: BrowserPool;
  let context: BrowserContext;
  let artifactDir: string;
  let report: DiscoveryCompletionReport;
  let baseUrl: string;

  const logger = new Logger('error', {}, () => {});

  beforeAll(async () => {
    // Faithful to what freight serves, because the fabrication depends on it: each record
    // carries a nested array of events, and an event's `code` is read as that array's record
    // identifier. "BOOKED" then gets appended to the record's own path.
    const records = [
      { id: 'shp-0001', reference: 'MF770000', status: 'draft',
        events: [{ at: '2026-02-09T17:00:00.000Z', code: 'BOOKED', description: 'Booking confirmed' }] },
      { id: 'shp-0002', reference: 'MF770013', status: 'draft',
        events: [{ at: '2026-02-10T09:00:00.000Z', code: 'BOOKED', description: 'Booking confirmed' }] }
    ];

    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<h1>Shipments</h1><a href="/api/shipments">The shipments API</a>');
        return;
      }
      if (path === '/api/shipments') return json(200, { total: records.length, shipments: records });

      const one = /^\/api\/shipments\/([^/]+)$/.exec(path);
      if (one) {
        const found = records.find(r => r.id === one[1]);
        return found ? json(200, found) : json(404, { error: 'not_found' });
      }

      // Anything deeper is not a route. The JSON body is the point: it is what made a dead
      // guess look like an endpoint.
      return json(404, { error: 'not_found' });
    });

    await new Promise<void>(resolve => server.listen(4317, '127.0.0.1', resolve));
    baseUrl = 'http://127.0.0.1:4317';

    artifactDir = await mkdtemp(join(tmpdir(), 'qanxt-invented-'));
    pool = new BrowserPool(true, logger);
    context = await pool.createContext('chromium', {
      defaultTimeoutMs: 10_000, navigationTimeoutMs: 20_000
    });

    const crawler = new Crawler(context, {
      baseUrl,
      artifactDir,
      navigationTimeoutMs: 20_000,
      auth: { strategy: 'none' },
      budget: {
        allowedHosts: ['127.0.0.1'],
        excludedPathPrefixes: [],
        maxDepth: 3,
        maxPages: 20,
        maxActions: 60,
        maxInstancesPerRouteShape: 3,
        timeoutSeconds: 90,
        allowPrivateNetworks: true,
        respectRobotsTxt: false
      }
    }, logger);

    report = await crawler.run('run-invented', 'worker-test');
  }, 180_000);

  afterAll(async () => {
    await pool?.close();
    await new Promise<void>(resolve => server?.close(() => resolve()));
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
  });

  test('the collection and the record endpoint are both recorded', () => {
    const templates = report.apiEndpoints.map(e => e.urlTemplate);

    expect(templates).toContain(`${baseUrl}/api/shipments`);
    expect(templates.some(t => t === `${baseUrl}/api/shipments/{id}`)).toBe(true);
  });

  test('no endpoint is recorded for a route the application answered 404 for', () => {
    const invented = report.apiEndpoints.filter(e => e.statusCode === 404);

    expect(invented.map(e => `${e.urlTemplate} (${e.sampleUrl})`)).toEqual([]);
  });

  test('a page-heavy crawl with almost no API says the API surface is not the application\'s', () => {
    // A reader seeing "discovery completed" beside a page count reasonably concludes the
    // surface is complete. On a server-rendered application it is complete as a map of what
    // was walked and nowhere near complete as a map of the API, because nothing links to the
    // API. Measured on freight: completed, 164 pages, 221 targets, two API endpoints — and
    // one of the missing ones was the only address an object-level authorization check can
    // use.
    //
    // This fixture is small, so the note is asserted on the ratio rule rather than on
    // freight's numbers; the rule is what has to hold.
    const said = /follows what the pages link to/.test(report.progressLog ?? '');

    // Below the threshold the note would be noise on any small application, and this fixture
    // is deliberately small — so the assertion is on the rule, in whichever direction this
    // crawl falls.
    expect(said).toBe(report.pages.length >= 20);
  });

  test('no template is built below a record, where there is no route', () => {
    // The shape of the fabrication: a literal record id followed by a placeholder.
    const belowARecord = report.apiEndpoints
      .map(e => e.urlTemplate)
      .filter(t => /\/api\/shipments\/shp-\d+\//.test(t));

    expect(belowARecord).toEqual([]);
  });
});
