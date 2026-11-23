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
 * A map is one identity's view, and it has to say so.
 *
 * Measured on this project's 137-screen lab. `ops.lead` holds `role-operations`, which has
 * `shipment:cancel` and not `claim:settle`. An interactive crawl signed in as that account
 * reached `/shipments/:id/cancel` three times over and never reached `/claims/:id/settle` —
 * not because it declined to press the Settle control but because there was no Settle control
 * on the page: the application does not render it for a role without the permission. The same
 * crawl signed in as an administrator found it on the first pass.
 *
 * Nothing the first map produced said any of that. A reader could see the pages it opened and
 * the queue it left unopened, and had no way to learn that a class of control was absent from
 * every page in it. That is the same confusion as an untested area reading as a clean one,
 * which is the one thing this product exists not to do.
 *
 * What the note cannot do is name what it did not see: a control absent from the page leaves
 * no trace to count. So it says that the map is bounded by an identity, which is enough for a
 * reader to ask the question, and asserting that it does not overclaim is half of what these
 * tests are for.
 *
 * It deliberately does not name the identity. The first version interpolated the username, the
 * masker redacted it as the personal data it is, and the note read "This map is what
 * ***REDACTED*** can see" — worse than silence, because it looks like information. That is what
 * the redaction test below exists to stop coming back.
 */
describe('a map says whose view it is', () => {
  let server: Server;
  let baseUrl: string;
  let pool: BrowserPool;
  let context: BrowserContext;
  let artifactDir: string;

  const logger = new Logger('error', {}, () => {});

  const budget = () => ({
    allowedHosts: ['127.0.0.1'],
    excludedPathPrefixes: ['/logout'],
    maxDepth: 2,
    maxPages: 6,
    maxActions: 20,
    maxInstancesPerRouteShape: 3,
    timeoutSeconds: 60,
    allowPrivateNetworks: true,
    respectRobotsTxt: false,
    interactionMode: 'links' as const,
    allowStateChangingClicks: false,
    seedUrls: [] as string[],
    useSitemap: false
  });

  const crawl = async (auth: Record<string, unknown>) => {
    const crawler = new Crawler(context, {
      baseUrl: `${baseUrl}/`,
      artifactDir,
      navigationTimeoutMs: 15_000,
      auth: auth as never,
      budget: budget() as never
    }, logger);
    return crawler.run(`run-${Math.random().toString(36).slice(2)}`, 'worker-test');
  };

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0]!;
      if (path !== '/' && path !== '/second') {
        response.writeHead(404, { 'content-type': 'text/html' });
        response.end('<h1>Not found</h1>');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><head><title>Page</title></head>'
        + '<body><h1>Page</h1><a href="/second">Second</a></body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    artifactDir = await mkdtemp(join(tmpdir(), 'qanxt-identity-'));
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

  test('it says the map is bounded by an identity, and how to find out what that leaves out', async () => {
    // storageState, so the crawl carries an identity without needing a login form on the
    // fixture: the note is about the map being one identity's view, not about how the session
    // was obtained.
    const result = await crawl({ strategy: 'storageState', username: 'ops.lead' });
    const log = result.progressLog ?? '';

    expect(log).toContain('This map is what the signed-in identity can see');
    expect(log).toContain('is on no page here and was never followed');
    expect(log).toContain('Mapping again as an identity holding other permissions');
  }, 120_000);

  test('it never prints a redaction marker where a reader expects a fact', async () => {
    // The first version of this note interpolated the username and the masker replaced it,
    // leaving a sentence that looked like information and carried none.
    const log = (await crawl({ strategy: 'storageState', username: 'ops.lead' })).progressLog ?? '';
    const identityNote = log.split('\n').find(line => line.includes('This map is what')) ?? '';
    expect(identityNote).not.toContain('REDACTED');
  }, 120_000);

  test('it does not claim to know what it could not see', async () => {
    const log = (await crawl({ strategy: 'storageState', username: 'ops.lead' })).progressLog ?? '';

    // A control absent from the page leaves nothing to count, so any number here would be
    // invented. The note must not imply one.
    expect(log).not.toMatch(/\d+\s+(control|hidden|invisible)/i);
    expect(log).not.toMatch(/controls? (were|was) hidden/i);
  }, 120_000);

  test('an unauthenticated crawl says nothing about an identity', async () => {
    // There is no identity to name, and a sentence about permissions on a map of a public
    // site is noise that teaches a reader to skip the notes.
    const log = (await crawl({ strategy: 'none' })).progressLog ?? '';
    expect(log).not.toContain('This map is what');
  }, 120_000);

  test('the sign-in line does not try to name the identity either', async () => {
    // Same reason: a masked username in a sign-in line is a redaction marker where a reader
    // expects a name. The end-of-crawl note is where the limit belongs, once, in full.
    const log = (await crawl({ strategy: 'storageState', username: 'ops.lead' })).progressLog ?? '';
    const signIn = log.split('\n').find(line => line.includes('Signed in successfully')) ?? '';
    if (signIn) expect(signIn).not.toContain('REDACTED');
  }, 120_000);
});
