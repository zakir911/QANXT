import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { Crawler, chooseVaryingColumn, oneOfEachFirst } from '../src/discovery/crawler.js';
import { Logger } from '../src/util/logger.js';

/**
 * Which records a capped crawl spends its allowance on.
 *
 * Measured on this project's own freight lab: the crawl mapped three declarations, the cap
 * stopped it there, and all three were in states the planted defect does not live in. The
 * defect needs a rejected declaration, and the application does not draw a link to a
 * rejected declaration's release page — so taking the first three rows of the list put the
 * page beyond reach with no way for a reader to know the cap was why.
 *
 * The fixture is that shape with the rows in the order that hurts: five records a defect
 * would not be found on, then the one it would. Document order cannot reach the sixth with
 * an allowance of three, however many times the crawl is run.
 */
const STATUSES: Record<string, string> = {
  'dec-0001': 'Accepted',
  'dec-0002': 'Accepted',
  'dec-0003': 'Accepted',
  'dec-0004': 'Accepted',
  'dec-0005': 'Held',
  'dec-0006': 'Rejected'
};

describe('choosing which records to open', () => {
  describe('the column to spread across', () => {
    test('is the one taking a few values across many rows', () => {
      const rows = [
        ['DEC-0001', 'Accepted', '2026-01-01'],
        ['DEC-0002', 'Accepted', '2026-01-02'],
        ['DEC-0003', 'Held', '2026-01-03'],
        ['DEC-0004', 'Rejected', '2026-01-04']
      ];
      expect(chooseVaryingColumn(rows)).toBe(1);
    });

    test('is not a column every row agrees on', () => {
      const rows = [['A', 'Open'], ['B', 'Open'], ['C', 'Open']];
      // Nothing to spread across: opening three of these teaches what one does.
      expect(chooseVaryingColumn(rows)).toBeNull();
    });

    test('is not an identifier or a date, where every row differs', () => {
      const rows = [['DEC-1', '2026-01-01'], ['DEC-2', '2026-01-02'], ['DEC-3', '2026-01-03']];
      // Spreading across a column with one value per row is the document order it replaces.
      expect(chooseVaryingColumn(rows)).toBeNull();
    });

    test('prefers the coarser of two varying columns', () => {
      const rows = [
        ['Open', 'Freight', 'a'], ['Open', 'Customs', 'b'],
        ['Closed', 'Freight', 'c'], ['Open', 'Claims', 'd']
      ];
      // Column 0 takes two values, column 1 takes three. The coarser column is the one a
      // small allowance can actually cover.
      expect(chooseVaryingColumn(rows)).toBe(0);
    });

    test('ignores a column the table does not always fill', () => {
      const rows = [['A', 'Open'], ['B', ''], ['C', 'Closed']];
      expect(chooseVaryingColumn(rows)).toBeNull();
    });

    test('says nothing when there is nothing to compare', () => {
      expect(chooseVaryingColumn([])).toBeNull();
      expect(chooseVaryingColumn([undefined, undefined])).toBeNull();
      expect(chooseVaryingColumn([['A', 'Open']])).toBeNull();
    });

    test('tolerates rows of different widths, comparing only the columns they share', () => {
      // Three rows, the second a cell short. The shared width is two, and within it the
      // status column still takes fewer values than there are rows.
      const rows = [['A', 'Open', 'x'], ['B', 'Closed'], ['C', 'Open']];
      expect(chooseVaryingColumn(rows)).toBe(1);
    });

    test('finds nothing to spread across in two rows, whatever they hold', () => {
      // With two rows a column either agrees or has one value per row. "A few values
      // across many rows" needs more than two rows to mean anything, and claiming a
      // column here would spread an allowance of three across a list of two.
      expect(chooseVaryingColumn([['A', 'Open'], ['B', 'Closed']])).toBeNull();
    });
  });

  describe('the order', () => {
    test('takes one of each value before a second of any', () => {
      const items = ['a1', 'a2', 'b1', 'a3', 'c1'];
      const values = ['a', 'a', 'b', 'a', 'c'];
      expect(oneOfEachFirst(items, values).slice(0, 3)).toEqual(['a1', 'b1', 'c1']);
    });

    test("keeps every item, and each value's own order within it", () => {
      const items = ['a1', 'a2', 'b1', 'a3'];
      const values = ['a', 'a', 'b', 'a'];
      expect(oneOfEachFirst(items, values)).toEqual(['a1', 'b1', 'a2', 'a3']);
    });

    test('leaves a single-valued list as it was', () => {
      const items = ['x', 'y', 'z'];
      expect(oneOfEachFirst(items, ['s', 's', 's'])).toEqual(['x', 'y', 'z']);
    });
  });

  describe('against a real list page', () => {
    let server: Server;
    let baseUrl: string;
    let pool: BrowserPool;
    let context: BrowserContext;
    let artifactDir: string;

    const logger = new Logger('error', {}, () => {});

    const crawl = async () => {
      const crawler = new Crawler(context, {
        baseUrl: `${baseUrl}/declarations`,
        artifactDir,
        navigationTimeoutMs: 15_000,
        auth: { strategy: 'none' },
        budget: {
          allowedHosts: ['127.0.0.1'],
          excludedPathPrefixes: ['/logout'],
          maxDepth: 2,
          maxPages: 30,
          maxActions: 100,
          maxInstancesPerRouteShape: 3,
          timeoutSeconds: 120,
          allowPrivateNetworks: true,
          respectRobotsTxt: false,
          interactionMode: 'links' as const,
          allowStateChangingClicks: false,
          seedUrls: [] as string[],
          useSitemap: false
        } as never
      }, logger);

      return crawler.run(`run-${Math.random().toString(36).slice(2)}`, 'worker-test');
    };

    beforeAll(async () => {
      server = createServer((request, response) => {
        const path = (request.url ?? '/').split('?')[0]!;

        if (path === '/declarations') {
          const rows = Object.entries(STATUSES).map(([id, status]) =>
            `<tr><td><a href="/declarations/${id}">${id.toUpperCase()}</a></td>`
            + `<td>${status}</td><td>Acme Ltd</td></tr>`).join('');
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<!doctype html><html><head><title>Declarations</title></head><body>'
            + '<h1>Declarations</h1><table><thead><tr><th>Reference</th><th>Status</th>'
            + `<th>Importer</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
          return;
        }

        const id = /^\/declarations\/(dec-\d{4})$/.exec(path)?.[1];
        if (id && STATUSES[id]) {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(`<!doctype html><html><head><title>${id}</title></head><body>`
            + `<h1>${id.toUpperCase()}</h1><p data-testid="status">${STATUSES[id]}</p>`
            + '</body></html>');
          return;
        }

        response.writeHead(404, { 'content-type': 'text/html' });
        response.end('<h1>Not found</h1>');
      });

      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;

      artifactDir = await mkdtemp(join(tmpdir(), 'qanxt-spread-'));
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

    test('opens one record of each state rather than three of the first', async () => {
      const report = await crawl();
      const opened = report.pages
        .map(page => /dec-\d{4}/.exec(page.url)?.[0])
        .filter((id): id is string => id !== undefined);

      expect(opened).toHaveLength(3);
      const states = new Set(opened.map(id => STATUSES[id]));
      expect(states).toEqual(new Set(['Accepted', 'Held', 'Rejected']));
    }, 120_000);

    test('reaches the record document order could never reach', async () => {
      // dec-0006 is last of six with an allowance of three. This is the whole claim.
      const report = await crawl();

      expect(report.pages.some(page => page.url.endsWith('/declarations/dec-0006'))).toBe(true);
    }, 120_000);

    test('says which column it spread across and what it took', async () => {
      const report = await crawl();

      expect(report.progressLog).toMatch(/differ in one column, which takes 3 value\(s\)/);
      expect(report.progressLog).toMatch(/accepted|held|rejected/i);
      expect(report.progressLog).toMatch(/allowance is not spent on one of them/);
    }, 120_000);

    test('keeps the row values out of the map it hands back', async () => {
      // A row on a customer list holds names and amounts. The crawler reads them to choose
      // records and the report has no use for them, so they must not travel with it.
      const report = await crawl();

      // Not asserted by searching for the value: the list page's own visible text
      // legitimately contains it, and a test that failed on that would be testing the
      // fixture. What must not be there is the field the crawler reads rows into.
      expect(JSON.stringify(report.pages)).not.toMatch(/rowCellsByHref/);
      expect(JSON.stringify(report.pages)).not.toMatch(/"rowCells"/);
    }, 120_000);
  });
});
