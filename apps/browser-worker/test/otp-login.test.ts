import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BrowserContext } from 'playwright';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { Logger } from '../src/util/logger.js';
import { performLogin } from '../src/browser/authenticator.js';
import { base32Decode, totp } from '../src/browser/totp.js';

// The RFC 6238 test secret, "12345678901234567890", in base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP', () => {
  test('matches the RFC 6238 SHA-1 test vectors', () => {
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
    expect(totp(RFC_SECRET, 59_000, 30, 8)).toBe('94287082');
    expect(totp(RFC_SECRET, 1_111_111_109_000, 30, 8)).toBe('07081804');
    expect(totp(RFC_SECRET, 1_234_567_890_000, 30, 8)).toBe('89005924');
  });

  test('a secret that is not base32 is refused with a reason', () => {
    expect(() => totp('not-base32!!')).toThrow(/base32/);
  });
});

/**
 * A sign-in that asks for a code after the password, the way real applications do: a
 * server-rendered page with one field, and a page of single-digit boxes.
 */
function otpSite(): Server {
  const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const send = (html: string) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); };
    const code = () => url.searchParams.get('code') ?? [1, 2, 3, 4, 5, 6].map(i => url.searchParams.get(`d${i}`) ?? '').join('');
    const expected = url.searchParams.get('style') === 'totp' ? totp(RFC_SECRET) : '246810';

    if (url.pathname === '/login') {
      const style = url.searchParams.get('style') ?? 'single';
      return send(page(`<form action="/otp" method="get"><input type="hidden" name="style" value="${style}">
        <label>Username <input name="username"></label><label>Password <input type="password" name="password"></label>
        <button>Sign in</button></form>`));
    }
    if (url.pathname === '/otp') {
      const digits = url.searchParams.get('style') === 'digits';
      const error = url.searchParams.has('wrong') ? '<p role="alert">That code is not right.</p>' : '';
      return send(page(`<h1>Enter the code</h1>${error}<form action="/verify" method="get">
        <input type="hidden" name="style" value="${url.searchParams.get('style') ?? 'single'}">
        ${digits ? [1, 2, 3, 4, 5, 6].map(i => `<input name="d${i}" maxlength="1" inputmode="numeric">`).join('')
                 : '<label>Verification code <input name="code" autocomplete="one-time-code" inputmode="numeric"></label>'}
        <button>Verify</button></form>`));
    }
    if (url.pathname === '/verify') {
      if (code() !== expected) { response.writeHead(302, { location: `/otp?style=${url.searchParams.get('style')}&wrong=1` }); return response.end(); }
      return send(page('<h1>Dashboard</h1>'));
    }
    response.writeHead(404); response.end();
  });
}

describe('sign-in with a one-time code', () => {
  let server: Server;
  let base: string;
  let pool: BrowserPool;
  let context: BrowserContext;
  const options = { navigationTimeoutMs: 10_000, actionTimeoutMs: 4_000 };

  beforeAll(async () => {
    server = otpSite();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    pool = new BrowserPool(true, new Logger('error', {}, () => {}));
    context = await pool.createContext('chromium', { defaultTimeoutMs: 5_000, navigationTimeoutMs: 10_000 });
  }, 60_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close();
    await new Promise(resolve => server?.close(resolve));
  });

  const login = async (style: string, otp: { otpMode?: 'none' | 'fixed' | 'totp'; otpValue?: string }) => {
    const page = await context.newPage();
    try {
      const result = await performLogin(page, {
        strategy: 'formLogin', loginUrl: `${base}/login?style=${style}`,
        username: 'tester', password: 'secret', ...otp
      }, options);
      return { result, heading: await page.locator('h1').textContent().catch(() => null) };
    } finally {
      await page.close();
    }
  };

  test('a fixed test code is entered and the application is reached', async () => {
    const { result, heading } = await login('single', { otpMode: 'fixed', otpValue: '246810' });
    expect(result.message).toBe('Signed in.');
    expect(result.succeeded).toBe(true);
    expect(heading).toBe('Dashboard');
  }, 30_000);

  test('an authenticator secret produces the current code', async () => {
    const { result, heading } = await login('totp', { otpMode: 'totp', otpValue: RFC_SECRET });
    expect(result.succeeded).toBe(true);
    expect(heading).toBe('Dashboard');
  }, 40_000);

  test('a code split across one box per digit is filled box by box', async () => {
    const { result, heading } = await login('digits', { otpMode: 'fixed', otpValue: '246810' });
    expect(result.succeeded).toBe(true);
    expect(heading).toBe('Dashboard');
  }, 30_000);

  test('a code that is asked for but not configured fails and says what to configure', async () => {
    const { result } = await login('single', {});
    expect(result.succeeded).toBe(false);
    expect(result.message).toMatch(/asked for a one-time code.*none is configured/);
  }, 30_000);

  test('a wrong code is a failure, not a sign-in', async () => {
    const { result } = await login('single', { otpMode: 'fixed', otpValue: '000000' });
    expect(result.succeeded).toBe(false);
    expect(result.message).toMatch(/did not accept the fixed one-time code/);
  }, 30_000);
});
