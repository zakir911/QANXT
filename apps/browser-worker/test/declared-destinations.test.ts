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
 * A destination a control declares, rather than carries in an href.
 *
 * An application whose navigation is buttons calling a client-side router writes the
 * destination into an attribute: `<button data-route="/claims/clm-0001">CLM-0001</button>`.
 * That is the application stating where the control goes, in its own markup — the same kind
 * of evidence as a form's `action`, and better than an observed request rather than worse,
 * because nothing has to be sent or pressed to read it.
 *
 * Reading it rather than clicking it costs no action budget, works where nothing may be
 * pressed, and cannot change the application.
 *
 * Measured on freight: every claim reference in every claims list is such a button, so a
 * crawl that does not click reached no claim detail page and no settlement form — 147 routes
 * found and not one of them a claim. FP_D11_VIEWER_CAN_SETTLE_CLAIM sits behind both, and the
 * check that finds it never had an address to probe.
 */

/** Hit counts, so the test can assert nothing was pressed. */
const served = new Map<string, number>();
const settled = new Set<string>();

/** A register whose rows navigate by data-route, in the shape freight uses. */
function startApp(port: number): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    served.set(url.pathname, (served.get(url.pathname) ?? 0) + 1);

    if (req.method === 'POST' && url.pathname.endsWith('/settle')) {
      settled.add(url.pathname);
      res.writeHead(302, { location: '/claims/clm-0001' });
      return res.end();
    }
    if (url.pathname === '/claims/clm-0001') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<h1>Claim CLM-0001</h1>
        <button type="button" data-route="/claims/clm-0001/settle">Settle</button>`);
    }
    if (url.pathname === '/claims/clm-0001/settle') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<h1>Settle</h1>
        <form method="post" action="/claims/clm-0001/settle">
          <label for="a">Amount</label><input id="a" name="settledAmountGbp" required />
          <button type="submit">Settle</button>
        </form>`);
    }
    if (url.pathname === '/about') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<h1>About</h1>');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<h1>Claims</h1><table><tbody>
      <tr><td><button type="button" data-route="/claims/clm-0001">CLM-0001</button></td></tr>
      </tbody></table>
      <button type="button" data-route="/claims/clm-0001/delete">Delete claim</button>
      <a href="/about">About</a>`);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () =>
    resolve({ server, baseUrl: 'http://127.0.0.1:' + port })));
}

describe('a destination declared on a control, with no clicking authorised', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let pool: BrowserPool;
  let context: BrowserContext;
  let artifactDir: string;
  let report: DiscoveryCompletionReport;

  const logger = new Logger('error', {}, () => {});

  beforeAll(async () => {
    served.clear();
    settled.clear();
    app = await startApp(4317);
    artifactDir = await mkdtemp(join(tmpdir(), 'qanxt-declared-dest-'));
    pool = new BrowserPool(true, logger);
    context = await pool.createContext('chromium', {
      defaultTimeoutMs: 10_000, navigationTimeoutMs: 20_000
    });

    const crawler = new Crawler(context, {
      baseUrl: `${app.baseUrl}/claims`,
      artifactDir,
      navigationTimeoutMs: 20_000,
      auth: { strategy: 'none' },
      budget: {
        allowedHosts: ['127.0.0.1'],
        excludedPathPrefixes: [],
        maxDepth: 4,
        maxPages: 12,
        maxActions: 60,
        maxInstancesPerRouteShape: 3,
        timeoutSeconds: 90,
        allowPrivateNetworks: true,
        respectRobotsTxt: false,
        // Nothing may be pressed. The destinations are read from the markup.
        allowStateChangingClicks: false
      }
    }, logger);

    report = await crawler.run('run-under-test', 'worker-test');
  }, 180_000);

  afterAll(async () => {
    await context?.close();
    await pool?.close();
    app?.server.close();
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
  });

  test('the detail page behind a data-route button is reached', () => {
    expect(report.pages.map(p => new URL(p.url).pathname)).toContain('/claims/clm-0001');
  });

  test('and the form it leads to, which is where the defect lives', () => {
    expect(report.pages.map(p => new URL(p.url).pathname)).toContain('/claims/clm-0001/settle');
    // And its form, which is what puts the write endpoint on the attack surface.
    const page = report.pages.find(p => p.url.endsWith('/claims/clm-0001/settle'));
    const form = page?.forms?.find(f => (f.action ?? '').includes('/settle'));
    expect(form).toBeDefined();
    expect(form?.method?.toLowerCase()).toBe('post');
    expect(form?.fields.map(f => f.name)).toContain('settledAmountGbp');
  });

  test('nothing was submitted to get there', () => {
    // The whole point of reading the destination rather than pressing the control.
    expect([...settled]).toEqual([]);
  });

  test('a declared destination whose words say it changes something is not followed', () => {
    // The guard that applies to an href applies here too: the address is recorded so a check
    // can probe it deliberately, and the crawl does not walk into it.
    expect(report.pages.map(p => new URL(p.url).pathname)).not.toContain('/claims/clm-0001/delete');
    expect(served.has('/claims/clm-0001/delete')).toBe(false);
  });

  test('ordinary links still work', () => {
    expect(report.pages.map(p => new URL(p.url).pathname)).toContain('/about');
  });
});
