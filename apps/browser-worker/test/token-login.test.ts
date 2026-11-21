import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright';
import type { AuthConfig } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { contextAuthOptions, performLogin } from '../src/browser/authenticator.js';
import { Logger } from '../src/util/logger.js';

/**
 * Credentials exchanged for a token, against the real token-authenticated lab.
 *
 * The gap this closes, measured: the order-management target was driven for the first time
 * and mapped three public pages, no forms and no endpoints, because `bearerToken` wants a
 * token somebody has already obtained and the application issues one from an endpoint. The
 * product had no way to describe that, so a whole shape of application — a JSON API with a
 * sign-in — could only be visited as an anonymous caller.
 */
const here = dirname(fileURLToPath(import.meta.url));
const LAB = resolve(here, '../../../test-lab/token-api');

describe('token sign-in', () => {
  let lab: ChildProcess;
  let base: string;
  let pool: BrowserPool;
  let context: BrowserContext;
  let page: Page;
  const logger = new Logger('error', {}, () => {});
  const options = { navigationTimeoutMs: 15_000, actionTimeoutMs: 6_000 };

  const auth = (over: Partial<AuthConfig> = {}): AuthConfig => ({
    strategy: 'tokenLogin',
    username: 'alice',
    password: 'Token!2026',
    tokenEndpoint: `${base}/api/auth/token`,
    ...over
  } as AuthConfig);

  beforeAll(async () => {
    const port = 4950 + Math.floor(Math.random() * 40);
    base = `http://127.0.0.1:${port}`;
    lab = spawn(process.execPath, [join(LAB, 'server.js')],
      { env: { ...process.env, TOKEN_API_PORT: String(port), PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${base}/`).then(r => r.ok).catch(() => false)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    pool = new BrowserPool(true, logger);
  }, 60_000);

  beforeEach(async () => {
    await context?.close().catch(() => undefined);
    context = await pool.createContext('chromium', { defaultTimeoutMs: 6000, navigationTimeoutMs: 15_000 });
    page = await context.newPage();
  });

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close().catch(() => undefined);
    lab?.kill();
  });

  /** Nothing can be sent at context creation: the token does not exist yet. */
  it('asks for no context options, because the token is not known yet', () => {
    expect(contextAuthOptions(auth())).toEqual({});
  });

  it('exchanges credentials for a token and sends it on every later request', async () => {
    const result = await performLogin(page, auth(), options);

    expect(result.succeeded, result.message).toBe(true);
    expect(result.message).toContain('authorization');

    // The proof is a request the application only answers to a signed-in caller.
    const answer = await page.request.get(`${base}/api/orders`);
    expect(answer.status()).toBe(200);
    expect(await answer.text()).toContain('ord-');
  }, 30_000);

  it('reaches the same endpoint through the page, not only the request context', async () => {
    await performLogin(page, auth(), options);
    await page.goto(`${base}/api/orders`);
    expect(await page.content()).toContain('ord-');
  }, 30_000);

  /** Without the exchange the same endpoint refuses, which is what makes the test above
   *  mean something. This lab answers 403 to a caller carrying no token at all and 401 to
   *  one carrying a token it does not know, so the assertion is "refused", not a code. */
  it('is refused without signing in', async () => {
    const answer = await page.request.get(`${base}/api/orders`);
    expect([401, 403]).toContain(answer.status());
  }, 30_000);

  it('says what the endpoint answered when the credentials are wrong', async () => {
    const result = await performLogin(page, auth({ password: 'wrong' }), options);

    expect(result.succeeded).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).toContain('invalid_credentials');
  }, 30_000);

  it('names the fields the answer did carry when no token is in it', async () => {
    const result = await performLogin(page, auth({ tokenField: 'sessionId' }), options);

    expect(result.succeeded).toBe(false);
    expect(result.message).toContain('sessionId');
    expect(result.message).toContain('token, tokenType, role',
    );
  }, 30_000);

  it('fails with the reason when the endpoint is not reachable', async () => {
    const result = await performLogin(page, auth({ tokenEndpoint: `${base}/api/auth/nowhere` }), options);

    expect(result.succeeded).toBe(false);
    expect(result.message).toContain('404');
  }, 30_000);

  it('says so when no endpoint is configured at all', async () => {
    const result = await performLogin(page, auth({ tokenEndpoint: undefined, loginUrl: undefined }), options);

    expect(result.succeeded).toBe(false);
    expect(result.message).toContain('tokenEndpoint');
  }, 30_000);

  /** An API that wants the token under its own header name, with no word before it. */
  it('honours a header name and an empty prefix', async () => {
    const result = await performLogin(page, auth({ tokenHeader: 'X-Api-Token', tokenPrefix: '' }), options);

    expect(result.succeeded, result.message).toBe(true);
    expect(result.message).toContain('X-Api-Token');
  }, 30_000);
});
