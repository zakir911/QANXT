import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserAction } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { runAction, type ActionContext } from '../src/execution/action-runner.js';
import { Logger } from '../src/util/logger.js';

/**
 * Whether a rule the page keeps by drawing nothing is a rule the server keeps.
 *
 * The lab is the shape of both defects. A claim page draws its Settle button disabled for an
 * identity without the permission, and the handler behind it checks only that somebody is
 * signed in — so the button is the whole of the permission. The same page will release a
 * declaration that customs rejected, because the state machine is "we do not draw that
 * button" rather than a check in the handler.
 *
 * Run against a real server and a real browser, because the claim is about an HTTP exchange
 * and cannot be established by reasoning about one.
 */
describe('a rule the page keeps by drawing nothing', () => {
  let pool: BrowserPool;
  let context: BrowserContext;
  let page: Page;
  let server: Server;
  let base: string;
  let answer: { status: number; body?: string; headers?: Record<string, string> };
  let received: Array<Record<string, string>>;
  /** What the page says about the record, so the state premise can be moved. */
  let status: string;
  /** Whether the submit control is offered to this identity. */
  let control: 'disabled' | 'hidden' | 'offered';
  const logger = new Logger('error', {}, () => {});

  const actionContext = (): ActionContext => ({
    defaultTimeoutMs: 3000, allowScriptExecution: false, allowedHosts: ['127.0.0.1'],
    allowPrivateNetworks: true, baseUrl: base,
    resolveValue: raw => raw, resolveTemplate: raw => raw
  });

  const run = (action: 'assertHiddenMeansForbidden' | 'assertStateForbidsAction', value: unknown) =>
    runAction(page, { description: action, action, value: JSON.stringify(value) } as BrowserAction, actionContext());

  const settleForm = { strategy: 'testId', value: 'settle-form' };
  const settleButton = { strategy: 'testId', value: 'settle-submit' };

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === 'GET' && request.url?.startsWith('/claim')) {
        const attribute = control === 'disabled' ? 'disabled' : '';
        const hidden = control === 'hidden' ? 'style="display:none"' : '';
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<!doctype html><html><head>
          <meta name="csrf-token" content="meta-tok" /></head><body>
          <span data-testid="status">${status}</span>
          <form action="/claim/settle" method="post" data-testid="settle-form">
            <input type="hidden" name="__RequestVerificationToken" value="tok-xyz" />
            <input name="amount" value="250.00" />
            <button type="submit" data-testid="settle-submit" ${attribute} ${hidden}>Settle</button>
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
    received = [];
    answer = { status: 200 };
    status = 'Rejected';
    control = 'disabled';
  });

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close().catch(() => undefined);
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const open = async () => { await page.goto(`${base}/claim`); };

  // ---- a control the page withholds --------------------------------------

  test('fails when the server accepts what the disabled control will not send', async () => {
    await open();
    answer = { status: 200, body: '<h1>Claim settled</h1>' };

    await expect(run('assertHiddenMeansForbidden', {
      control: settleButton, form: settleForm, capability: 'settle the claim'
    })).rejects.toThrow(/accepted a request this identity has no control/);

    await expect(run('assertHiddenMeansForbidden', {
      control: settleButton, form: settleForm
    })).rejects.toThrow(/enforced in the page and nowhere else/);
  });

  test('passes when the server refuses it', async () => {
    await open();
    answer = { status: 403, body: 'Forbidden' };

    await expect(run('assertHiddenMeansForbidden', { control: settleButton, form: settleForm }))
      .resolves.toBeUndefined();
  });

  test('sends the anti-forgery token the page carries, or the refusal means nothing', async () => {
    // The trap this family is most exposed to. With no token the handler refuses for the
    // wrong reason, and a refusal for the wrong reason reads here as the permission being
    // enforced — turning the defect being looked for into a pass.
    await open();
    answer = { status: 403 };

    await run('assertHiddenMeansForbidden', { control: settleButton, form: settleForm });

    expect(received).toHaveLength(1);
    expect(received[0]!['__RequestVerificationToken']).toBe('tok-xyz');
    expect(received[0]!['csrf-token']).toBe('meta-tok');
    // And the form's real values, read off the live page rather than rebuilt from a plan.
    expect(received[0]!['amount']).toBe('250.00');
  });

  test('refuses to answer when the control is in fact offered', async () => {
    // The premise is the absence. With the control available the question has changed, and
    // answering the old one would be meaningless either way.
    control = 'offered';
    await open();
    answer = { status: 200, body: '<h1>Claim settled</h1>' };

    await expect(run('assertHiddenMeansForbidden', { control: settleButton, form: settleForm }))
      .rejects.toThrow(/premise no longer holds/);
  });

  test('treats a hidden control the same as a disabled one', async () => {
    control = 'hidden';
    await open();
    answer = { status: 200, body: '<h1>Claim settled</h1>' };

    await expect(run('assertHiddenMeansForbidden', { control: settleButton, form: settleForm }))
      .rejects.toThrow(/accepted a request/);
  });

  test('reads a redirect to the sign-in page as a refusal, not an acceptance', async () => {
    await open();
    answer = { status: 302, headers: { location: '/auth/sign-in?returnUrl=/claim' } };

    await expect(run('assertHiddenMeansForbidden', { control: settleButton, form: settleForm }))
      .resolves.toBeUndefined();
  });

  test('reports a 5xx as its own defect rather than as a refusal', async () => {
    await open();
    answer = { status: 500, body: 'NullReferenceException' };

    await expect(run('assertHiddenMeansForbidden', { control: settleButton, form: settleForm }))
      .rejects.toThrow(/answered 500 rather than refusing/);
  });

  test('reads a 200 carrying a complaint as a refusal', async () => {
    await open();
    answer = { status: 200, body: '<div class="error">You do not have permission to settle claims.</div>' };

    await expect(run('assertHiddenMeansForbidden', { control: settleButton, form: settleForm }))
      .resolves.toBeUndefined();
  });

  // ---- a state the page will not move on from ----------------------------

  test('fails when a rejected record is still moved on', async () => {
    await open();
    answer = { status: 302, headers: { location: '/claim/settled' } };

    await expect(run('assertStateForbidsAction', {
      state: 'rejected', shownIn: { strategy: 'testId', value: 'status' },
      form: settleForm, action: 'settle the claim'
    })).rejects.toThrow(/accepted a request to settle the claim on a record that is rejected/);
  });

  test('passes when the handler refuses the transition', async () => {
    await open();
    answer = { status: 409, body: 'A rejected claim cannot be settled.' };

    await expect(run('assertStateForbidsAction', {
      state: 'rejected', shownIn: { strategy: 'testId', value: 'status' }, form: settleForm
    })).resolves.toBeUndefined();
  });

  test('refuses to answer when the record is not in that state', async () => {
    // Asking whether a rejected record can be settled, of a record that is open, answers a
    // different question. Its answer would be noise in a run of thousands.
    status = 'Open';
    await open();
    answer = { status: 200, body: '<h1>Settled</h1>' };

    await expect(run('assertStateForbidsAction', {
      state: 'rejected', shownIn: { strategy: 'testId', value: 'status' }, form: settleForm
    })).rejects.toThrow(/does not say it is rejected/);
  });

  test('finds the state anywhere on the page when it is told no element', async () => {
    await open();
    answer = { status: 200, body: '<h1>Settled</h1>' };

    await expect(run('assertStateForbidsAction', { state: 'rejected', form: settleForm }))
      .rejects.toThrow(/on a record that is rejected/);
  });

  test('does not read a state word inside a longer word', async () => {
    // "unrejected" is not "rejected", and a substring match would make the premise hold
    // wherever the vocabulary happened to appear.
    status = 'Unrejectedly fine';
    await open();

    await expect(run('assertStateForbidsAction', {
      state: 'rejected', shownIn: { strategy: 'testId', value: 'status' }, form: settleForm
    })).rejects.toThrow(/does not say it is rejected/);
  });

  test('says so rather than guessing when there is nothing to send', async () => {
    await open();

    await expect(run('assertStateForbidsAction', {
      state: 'rejected', form: { strategy: 'testId', value: 'no-such-form' }
    })).rejects.toThrow(/nothing to send/);
  });
});
