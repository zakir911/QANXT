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
 * A link whose own words say it changes something is never followed, authorised or not.
 *
 * Authorising state-changing interaction exists for a control whose endpoint cannot be
 * learned any other way: clinic-spa hides its cancel button from a receptionist, and the
 * only way to find out what it calls is to press it — which is how CS_D04 is found. A link
 * is not that. Its address is in its own href, and it is recorded whether or not it is
 * followed, so the attack surface has it either way.
 *
 * Following it costs a detection. permits-legacy approves a permit through
 * `/approve.asp?id=1`, a GET any signed-in role may issue with no token, which is PL_D01 and
 * the whole reason that target exists. With interaction authorised the crawl followed it and
 * approved permits 1 and 2 while mapping. `request.safe-verb-state-change` then probed the
 * same address, read the listing before and after, saw nothing change, and said so:
 *
 *   "answered 200 and /list.asp is unchanged, so this check saw no state change. It cannot
 *    conclude there was none ... and it will not record an untested endpoint as a safe one."
 *
 * The check was right. The crawl had spent the evidence. Measured: permits-legacy read 4 of 4
 * in navigation mode and 3 of 4 with interaction authorised, losing the one defect that
 * authorisation was meant to help with.
 *
 * Nothing in the suite asserted the old behaviour, which is why it went unnoticed.
 */
const approved = new Set<string>();

/** A register with an approve link per row, in the shape permits-legacy uses. */
function startRegister(port: number): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/approve.asp') {
      approved.add(url.searchParams.get('id') ?? '');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<h1>Approved</h1>');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<h1>Register</h1><table><tbody>
      <tr><td>BP-0001</td><td>${approved.has('1') ? 'approved' : 'pending'}</td>
          <td><a href="/approve.asp?id=1">Approve</a></td></tr>
      <tr><td>BP-0002</td><td>${approved.has('2') ? 'approved' : 'pending'}</td>
          <td><a href="/approve.asp?id=2">Approve</a></td></tr>
      </tbody></table><a href="/about.asp">About</a>`);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () =>
    resolve({ server, baseUrl: 'http://127.0.0.1:' + port })));
}

describe('a link that says it changes something, with interaction authorised', () => {
  let app: Awaited<ReturnType<typeof startRegister>>;
  let pool: BrowserPool;
  let context: BrowserContext;
  let artifactDir: string;
  let report: DiscoveryCompletionReport;

  const logger = new Logger('error', {}, () => {});

  beforeAll(async () => {
    approved.clear();
    app = await startRegister(4315);
    artifactDir = await mkdtemp(join(tmpdir(), 'qanxt-mutating-links-'));
    pool = new BrowserPool(true, logger);
    context = await pool.createContext('chromium', {
      defaultTimeoutMs: 10_000, navigationTimeoutMs: 20_000
    });

    const crawler = new Crawler(context, {
      baseUrl: `${app.baseUrl}/list.asp`,
      artifactDir,
      navigationTimeoutMs: 20_000,
      auth: { strategy: 'none' },
      budget: {
        allowedHosts: ['127.0.0.1'],
        excludedPathPrefixes: [],
        maxDepth: 3,
        maxPages: 12,
        maxActions: 60,
        maxInstancesPerRouteShape: 3,
        timeoutSeconds: 90,
        allowPrivateNetworks: true,
        respectRobotsTxt: false,
        // The authorisation that used to make the crawl follow these.
        allowStateChangingClicks: true
      }
    }, logger);

    report = await crawler.run('run-under-test', 'worker-test');
  }, 180_000);

  afterAll(async () => {
    await pool?.close();
    await new Promise<void>(resolve => app?.server.close(() => resolve()));
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
  });

  test('nothing was approved: mapping did not alter the application', () => {
    // The assertion that matters, and the one the application itself can answer.
    expect([...approved]).toEqual([]);
  });

  test('no page was mapped at the approving address', () => {
    expect(report.pages.map(p => p.url).filter(u => u.includes('approve.asp'))).toEqual([]);
  });

  test('the address is recorded all the same, so the scan can probe it', () => {
    // This is the half that was already fixed, and the half this change depends on: refusing
    // to follow must not mean forgetting. The attack surface reads these to decide what to
    // probe, and PL_D01 is found by probing this address deliberately.
    const recorded = (report.stateChangingLinks ?? []).map(l => l.url);
    expect(recorded.some(u => u.includes('approve.asp'))).toBe(true);
  });

  test('ordinary links are still followed', () => {
    // The rule must be about the words, not about links.
    expect(report.pages.map(p => p.url).some(u => u.includes('about.asp'))).toBe(true);
  });
});
