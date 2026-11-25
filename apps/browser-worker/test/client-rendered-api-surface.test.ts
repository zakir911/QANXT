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
 * Finding record addresses on an application with no server-rendered markup.
 *
 * The identifier derivation — read the ids out of a collection, try them as addresses under
 * it — ran only on a JSON document the crawler had navigated to. That covers the
 * server-rendered case: freight links to `/api/shipments`, the crawler opens it as a page,
 * and `/api/shipments/{id}` goes on the surface.
 *
 * A client-rendered application never does that. clinic-spa's screens fetch
 * `/api/patients?q=` from their own JavaScript. The collection arrived on the network
 * listener, its body was recorded as a sample with `pat-1` and `pat-2` in it, and nothing was
 * derived from it. So `/api/patients/{id}` never reached the security surface, `authz.bola`
 * had no record route on which to compare two clinicians, and CS_D03 — a clinician reading
 * another clinician's patient — was reported as a gap on an application whose own traffic
 * carried the addresses needed to find it.
 *
 * Which was the wrong way round: record routes are where object-level authorization defects
 * live, they are the routes no document points at, and an SPA's API is nothing but
 * background fetches.
 *
 * This runs a real client-rendered application in a real Chromium, because the defect was
 * in the wiring and not in the logic: `identifiersIn` and the URL building were both correct
 * and unit-tested throughout, and never called. A unit test could not have caught it.
 */
const WIDGETS = [{ id: 'w-1', name: 'One' }, { id: 'w-2', name: 'Two' }];

/**
 * An application that serves a mount point and nothing else: no anchor to the collection,
 * no record ids in the markup. Everything is fetched by the page for itself.
 */
const DOCUMENT = `<!doctype html><html><head><title>Widgets</title></head><body>
<h1>Widgets</h1><div id="app">loading</div>
<script>
  fetch('/api/widgets').then(r => r.json()).then(rows => {
    document.getElementById('app').textContent = rows.map(r => r.name).join(', ');
  });
</script></body></html>`;

function startApp(port: number): Promise<{ server: Server; baseUrl: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    asked.push(path);
    if (path === '/api/widgets') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(WIDGETS));
    }
    const record = /^\/api\/widgets\/([^/]+)$/.exec(path);
    if (record) {
      const found = WIDGETS.find(w => w.id === record[1]);
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(found ?? { error: 'not_found' }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(DOCUMENT);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () =>
    resolve({ server, baseUrl: 'http://127.0.0.1:' + port, asked })));
}

describe('a client-rendered application\'s record routes', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let pool: BrowserPool;
  let context: BrowserContext;
  let artifactDir: string;
  let report: DiscoveryCompletionReport;

  const logger = new Logger('error', {}, () => {});

  beforeAll(async () => {
    app = await startApp(4313);
    artifactDir = await mkdtemp(join(tmpdir(), 'qanxt-spa-surface-'));
    pool = new BrowserPool(true, logger);
    context = await pool.createContext('chromium', {
      defaultTimeoutMs: 10_000, navigationTimeoutMs: 20_000
    });

    const crawler = new Crawler(context, {
      baseUrl: app.baseUrl,
      artifactDir,
      navigationTimeoutMs: 20_000,
      auth: { strategy: 'none' },
      budget: {
        allowedHosts: ['127.0.0.1'],
        excludedPathPrefixes: ['/logout'],
        maxDepth: 3,
        maxPages: 12,
        maxActions: 60,
        maxInstancesPerRouteShape: 3,
        timeoutSeconds: 90,
        allowPrivateNetworks: true,
        respectRobotsTxt: false
      }
    }, logger);

    report = await crawler.run('run-under-test', 'worker-test');
  }, 180_000);

  afterAll(async () => {
    await pool?.close();
    await new Promise<void>(resolve => app?.server.close(() => resolve()));
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
  });

  test('the collection the page fetched for itself is recorded', () => {
    expect(report.apiEndpoints.map(e => e.urlTemplate))
      .toContain(`${app.baseUrl}/api/widgets`);
  });

  test('the record route is derived from the ids that collection named', () => {
    // The point of the whole fix. No document anywhere points at this address.
    const templates = report.apiEndpoints.map(e => e.urlTemplate);
    expect(templates).toContain(`${app.baseUrl}/api/widgets/{id}`);
  });

  test('the record route was actually requested, not merely assumed', () => {
    // House rule: evidence, not inference. The endpoint is on the surface because a GET
    // was made and answered, and the application's own log says so.
    expect(app.asked).toContain('/api/widgets/w-1');
  });

  test('the derived route is recorded once, templated, not once per record', () => {
    const records = report.apiEndpoints
      .filter(e => /\/api\/widgets\/(?!\{)/.test(e.urlTemplate));
    expect(records).toEqual([]);
  });
});

/**
 * The same derivation on an application whose session does not survive a document load.
 *
 * clinic-spa is this shape, and it is where the first version of the fix went wrong. In this
 * mode discovery moves through the application by its own router, because loading an address
 * signs it out. A derived API address pushed through a client-side router fetches nothing:
 * the router does not recognise `/api/widgets/w-1`, renders its fallback screen, and the
 * crawl records that screen under the address it asked for.
 *
 * Measured on clinic-spa before this was fixed: three phantom pages, each a duplicate of the
 * schedule screen carrying that screen's form, and the form engine designed a full suite
 * against each — 396 tests where 199 were real. The record endpoint the whole derivation
 * exists to find was still missing from the surface.
 *
 * So an entry marked as an API address by construction is fetched from inside the page, which
 * carries the in-page session, and recorded as an endpoint rather than walked as a screen.
 */
const TOKEN_APP_WIDGETS = [{ id: 'w-1', name: 'One' }, { id: 'w-2', name: 'Two' }];

/**
 * A client-rendered application that keeps its token in a JavaScript variable. Nothing is
 * written to a cookie or to storage, so a document load signs it out — which is what puts
 * discovery into the mode under test.
 */
const TOKEN_SHELL = `<!doctype html><html><head><title>Widgets</title></head><body>
<div id="app"></div>
<script>
  let token = null;
  function go(path) { history.pushState({}, '', path); render(); }
  function signIn() {
    document.getElementById('app').innerHTML =
      '<form id="f"><input name="username" id="u" /><input type="password" name="password" id="p" />'
      + '<button type="submit">Sign in</button></form>';
    document.getElementById('f').addEventListener('submit', async e => {
      e.preventDefault();
      const r = await fetch('/api/session', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: document.getElementById('u').value,
                               password: document.getElementById('p').value })
      });
      if (!r.ok) return;
      token = (await r.json()).token;
      go('/widgets');
    });
  }
  async function widgets() {
    const r = await fetch('/api/widgets', { headers: { authorization: 'Bearer ' + token } });
    if (!r.ok) return signIn();
    const rows = await r.json();
    document.getElementById('app').innerHTML =
      '<h1>Widgets</h1><form id="s"><input name="q" /><button type="submit">Search</button></form>'
      + '<ul>' + rows.map(r => '<li>' + r.name + '</li>').join('') + '</ul>';
  }
  function render() {
    if (!token) return signIn();
    if (location.pathname === '/widgets') return widgets();
    return widgets();          // the fallback a derived API address used to land on
  }
  window.addEventListener('popstate', render);
  render();
</script></body></html>`;

function startTokenApp(port: number): Promise<{ server: Server; baseUrl: string; asked: string[] }> {
  const asked: string[] = [];
  const tokens = new Set<string>();
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    asked.push(path);
    const authorized = tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''));

    if (path === '/api/session' && req.method === 'POST') {
      const token = `t${tokens.size + 1}`;
      tokens.add(token);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ token }));
    }
    if (path === '/api/widgets') {
      if (!authorized) { res.writeHead(401, { 'content-type': 'application/json' });
                         return res.end('{"error":"unauthenticated"}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(TOKEN_APP_WIDGETS));
    }
    const record = /^\/api\/widgets\/([^/]+)$/.exec(path);
    if (record) {
      if (!authorized) { res.writeHead(401, { 'content-type': 'application/json' });
                         return res.end('{"error":"unauthenticated"}'); }
      const found = TOKEN_APP_WIDGETS.find(w => w.id === record[1]);
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(found ?? { error: 'not_found' }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(TOKEN_SHELL);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () =>
    resolve({ server, baseUrl: 'http://127.0.0.1:' + port, asked })));
}

describe('record routes where the session lives in the page', () => {
  let app: Awaited<ReturnType<typeof startTokenApp>>;
  let pool: BrowserPool;
  let context: BrowserContext;
  let artifactDir: string;
  let report: DiscoveryCompletionReport;

  const logger = new Logger('error', {}, () => {});

  beforeAll(async () => {
    app = await startTokenApp(4314);
    artifactDir = await mkdtemp(join(tmpdir(), 'qanxt-inapp-surface-'));
    pool = new BrowserPool(true, logger);
    context = await pool.createContext('chromium', {
      defaultTimeoutMs: 10_000, navigationTimeoutMs: 20_000
    });

    const crawler = new Crawler(context, {
      baseUrl: `${app.baseUrl}/widgets`,
      artifactDir,
      navigationTimeoutMs: 20_000,
      auth: {
        strategy: 'formLogin',
        loginUrl: `${app.baseUrl}/`,
        username: 'alice',
        password: 'Password123!',
        successUrlContains: '/widgets'
      },
      budget: {
        allowedHosts: ['127.0.0.1'],
        excludedPathPrefixes: ['/logout'],
        maxDepth: 3,
        maxPages: 12,
        maxActions: 60,
        maxInstancesPerRouteShape: 3,
        timeoutSeconds: 90,
        allowPrivateNetworks: true,
        respectRobotsTxt: false
      }
    }, logger);

    report = await crawler.run('run-under-test', 'worker-test');
  }, 180_000);

  afterAll(async () => {
    await pool?.close();
    await new Promise<void>(resolve => app?.server.close(() => resolve()));
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
  });

  test('the record route is recorded as an endpoint', () => {
    expect(report.apiEndpoints.map(e => e.urlTemplate))
      .toContain(`${app.baseUrl}/api/widgets/{id}`);
  });

  test('it was fetched from inside the application, with the in-page token', () => {
    // The whole point: a document load would have been unauthenticated. The application's
    // own log shows the record address was asked for, and it answered it rather than 401.
    expect(app.asked).toContain('/api/widgets/w-1');
  });

  test('the route is recorded once, templated: the probe is not the application\'s traffic', () => {
    // The network listener records the application's own API calls and cannot tell them from
    // the crawler's. So the in-page probe came back through it and was recorded a second
    // time, untemplated, and clinic-spa's surface carried `/api/patients/{id}` beside
    // `/api/patients/pat-1` and `/api/patients/pat-2`: three endpoints for one route, and
    // three scan targets where there was one route to test.
    const records = report.apiEndpoints
      .map(e => e.urlTemplate)
      .filter(t => /\/api\/widgets\//.test(t));
    expect(records).toEqual([`${app.baseUrl}/api/widgets/{id}`]);
  });

  test('no page is recorded at an API address', () => {
    // The phantom pages. Each was a duplicate of the fallback screen, carrying that
    // screen's form, and each grew a full test suite of its own.
    const phantoms = report.pages.filter(p => p.url.includes('/api/'));
    expect(phantoms.map(p => p.url)).toEqual([]);
  });
});
