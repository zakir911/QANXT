import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserAction } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { runAction, type ActionContext } from '../src/execution/action-runner.js';
import { Logger } from '../src/util/logger.js';

/**
 * Whether the server enforces what the browser enforces.
 *
 * The lab here is deliberately the shape of the defect this check exists for: a form whose
 * amount limit lives in a `max` attribute and a handler that never looks at it. A browser
 * refuses the submission; curl does not. Of the 32 defects planted in the freight test lab,
 * three are this exact shape, and the engine passed over every one of them because nothing
 * ever asked the endpoint directly.
 *
 * Each case is run against a real server and a real browser, because the claim being made
 * is about an HTTP exchange and cannot be established by reasoning about one.
 */
describe('a rule the browser enforces and the server does not', () => {
  let pool: BrowserPool;
  let context: BrowserContext;
  let page: Page;
  let server: Server;
  let base: string;
  /** How the handler should answer the next submission. */
  let answer: { status: number; body?: string; headers?: Record<string, string> };
  let received: Array<Record<string, string>>;
  const logger = new Logger('error', {}, () => {});

  const actionContext = (): ActionContext => ({
    defaultTimeoutMs: 3000, allowScriptExecution: false, allowedHosts: ['127.0.0.1'],
    allowPrivateNetworks: true, baseUrl: base,
    resolveValue: raw => raw, resolveTemplate: raw => raw
  });

  const enforces = (value: unknown) =>
    runAction(
      page,
      {
        description: 'server enforces', action: 'assertServerEnforces',
        value: JSON.stringify(value)
      } as BrowserAction,
      actionContext()
    );

  beforeAll(async () => {
    received = [];
    answer = { status: 200 };
    server = createServer((request, response) => {
      if (request.method === 'GET' && request.url?.startsWith('/order')) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<!doctype html><html><body>
          <form action="/order" method="post">
            <input type="hidden" name="__csrf" value="tok-abc123" />
            <input name="amount" type="number" max="100" value="5000" />
            <input name="customer" value="c-1" />
            <input name="note" disabled value="not sent" />
            <input name="unnamed-ok" value="sent" />
            <select name="currency"><option value="gbp" selected>GBP</option></select>
            <input type="checkbox" name="urgent" checked />
            <input type="checkbox" name="gift" />
            <button type="submit">Place order</button>
          </form></body></html>`);
        return;
      }
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        received.push(Object.fromEntries(new URLSearchParams(body)));
        response.writeHead(answer.status, { 'content-type': 'text/html', ...answer.headers });
        response.end(answer.body ?? 'ok');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    pool = new BrowserPool(true, logger);
  }, 60_000);

  beforeEach(async () => {
    await context?.close().catch(() => undefined);
    context = await pool.createContext('chromium', { defaultTimeoutMs: 3000, navigationTimeoutMs: 15_000 });
    page = await context.newPage();
    await page.goto(`${base}/order`);
    received = [];
    answer = { status: 200 };
  });

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close().catch(() => undefined);
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  test('fails, naming the rule, when the server accepts what the browser refused', async () => {
    answer = { status: 200, body: '<h1>Order placed</h1>' };

    await expect(enforces({ form: { strategy: 'css', value: 'form' }, rule: 'amount exceeds its maximum of 100' }))
      .rejects.toThrow(/accepted the submission/);
    await expect(enforces({ form: { strategy: 'css', value: 'form' }, rule: 'amount exceeds its maximum of 100' }))
      .rejects.toThrow(/enforced in the browser and not on the server/);
    await expect(enforces({ form: { strategy: 'css', value: 'form' }, rule: 'amount exceeds its maximum of 100' }))
      .rejects.toThrow(/amount exceeds its maximum of 100/);
  });

  test('passes when the server refuses with a 4xx', async () => {
    answer = { status: 422, body: 'Amount too large' };
    await enforces({ form: { strategy: 'css', value: 'form' } });
  });

  test('passes when the server answers 200 with a field-level complaint', async () => {
    // The common server-rendered shape: same page back, with the error filled in.
    answer = { status: 200, body: '<form><span class="field-error">Amount exceeds the limit</span></form>' };
    await enforces({ form: { strategy: 'css', value: 'form' } });
  });

  test('passes when the server answers 200 with a JSON error envelope', async () => {
    answer = { status: 200, body: JSON.stringify({ errors: { amount: 'too large' } }) };
    await enforces({ form: { strategy: 'css', value: 'form' } });
  });

  test('is not fooled by an empty error container', async () => {
    // Every healthy page has one of these. Reading it as a refusal would excuse the defect.
    answer = { status: 200, body: '<div class="error"></div><h1>Order placed</h1>' };
    await expect(enforces({ form: { strategy: 'css', value: 'form' } }))
      .rejects.toThrow(/accepted the submission/);
  });

  test('passes when a redirect goes back to the form', async () => {
    answer = { status: 302, headers: { location: '/order?error=amount' } };
    await enforces({ form: { strategy: 'css', value: 'form' } });
  });

  test('fails when a redirect goes somewhere else, which means it went through', async () => {
    answer = { status: 302, headers: { location: '/orders/9001/confirmed' } };
    await expect(enforces({ form: { strategy: 'css', value: 'form' } }))
      .rejects.toThrow(/accepted the submission.*redirected to \/orders\/9001\/confirmed/s);
  });

  test('reports a 5xx as its own defect rather than as a refusal', async () => {
    answer = { status: 500, body: 'TypeError: cannot read property of undefined' };
    await expect(enforces({ form: { strategy: 'css', value: 'form' } }))
      .rejects.toThrow(/answered 500 rather than refusing.*its own defect/s);
  });

  test('sends the anti-forgery token, so a refusal means the rule and not the token', async () => {
    // Rebuilding the payload from the plan would omit this and the server would refuse for
    // the wrong reason — which this check would have read as a pass.
    answer = { status: 422 };
    await enforces({ form: { strategy: 'css', value: 'form' } });

    expect(received).toHaveLength(1);
    expect(received[0]!['__csrf']).toBe('tok-abc123');
  });

  test('submits the form the way a browser would', async () => {
    answer = { status: 422 };
    await enforces({ form: { strategy: 'css', value: 'form' } });

    const sent = received[0]!;
    expect(sent['amount']).toBe('5000');          // the violating value, as the browser has it
    expect(sent['currency']).toBe('gbp');         // selected option
    expect(sent['urgent']).toBe('on');            // checked box with no value
    expect(sent).not.toHaveProperty('gift');      // unchecked box is not sent
    expect(sent).not.toHaveProperty('note');      // disabled control is not sent
  });

  test('applies overrides on top of the live form', async () => {
    answer = { status: 422 };
    await enforces({ form: { strategy: 'css', value: 'form' }, overrides: { amount: '999999' } });

    expect(received[0]!['amount']).toBe('999999');
    expect(received[0]!['__csrf']).toBe('tok-abc123');
  });

  test('honours an explicit list of statuses that count as a refusal', async () => {
    answer = { status: 200, body: '<h1>Order placed</h1>' };
    await expect(enforces({ form: { strategy: 'css', value: 'form' }, refusedStatuses: [409] }))
      .rejects.toThrow(/accepted the submission/);

    answer = { status: 409 };
    await enforces({ form: { strategy: 'css', value: 'form' }, refusedStatuses: [409] });
  });

  test('says so when the form is no longer on the page', async () => {
    await page.setContent('<p>gone</p>');
    await expect(enforces({ form: { strategy: 'css', value: 'form' } }))
      .rejects.toThrow(/Could not read the form off the page/);
  });
});
