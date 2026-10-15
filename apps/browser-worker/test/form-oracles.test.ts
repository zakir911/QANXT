import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserAction, LocatorDescriptor } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { runAction, type ActionContext } from '../src/execution/action-runner.js';
import { EvidenceCollector } from '../src/execution/evidence-collector.js';
import { SecretMasker } from '../src/security/masker.js';
import { Logger } from '../src/util/logger.js';
import { extractForms, type RawForm } from '../src/discovery/form-extractor.js';
import { findOpener, formIsVisible } from '../src/discovery/form-probe.js';
import { explainTimeout } from '../src/execution/executor.js';

/**
 * The form oracles against the golden form lab.
 *
 * Every oracle is shown both ways: holding on a form that behaves, and failing — with a
 * message that says what happened — on the lab's deliberate defect for it. An oracle that
 * has only been seen to pass has not been shown to check anything.
 */
const here = dirname(fileURLToPath(import.meta.url));
const LAB = resolve(here, '../../../test-lab/form-lab');

const testId = (value: string): LocatorDescriptor => ({ strategy: 'testId', value });
const css = (value: string): LocatorDescriptor => ({ strategy: 'css', value });

describe('form oracles', () => {
  let lab: ChildProcess;
  let base: string;
  let pool: BrowserPool;
  let context: BrowserContext;
  let page: Page;
  let workDir: string;
  let collector: EvidenceCollector;
  let mark = 0;
  const logger = new Logger('error', {}, () => {});

  const actionContext = (): ActionContext => ({
    defaultTimeoutMs: 6000, allowScriptExecution: false, allowedHosts: ['127.0.0.1'], allowPrivateNetworks: true,
    baseUrl: base, resolveValue: raw => raw, resolveTemplate: raw => raw,
    observations: {
      network: () => collector.getNetworkEvents(), console: () => collector.getConsoleEvents(),
      settle: () => collector.settle(), networkMarkAtLastNavigation: () => mark,
      urlAtLastNavigation: () => undefined, workDir
    }
  });

  const run = (action: Partial<BrowserAction> & { action: BrowserAction['action'] }) =>
    runAction(page, { description: action.action, ...action } as BrowserAction, actionContext());

  const open = async (route: string) => {
    await collector.settle();
    mark = collector.getNetworkEvents().length;
    await run({ action: 'navigate', url: `${base}${route}` });
  };

  const fill = (id: string, value: string) => run({ action: 'fill', target: testId(id), value });
  const submit = (form: string) => run({ action: 'click', target: testId(`${form}-submit`) });
  const fails = async (promise: Promise<unknown>, pattern: RegExp) => {
    await expect(promise).rejects.toThrow(pattern);
  };

  beforeAll(async () => {
    const port = 4800 + Math.floor(Math.random() * 90);
    base = `http://127.0.0.1:${port}`;
    lab = spawn(process.execPath, [join(LAB, 'server.js')], { env: { ...process.env, FORM_LAB_PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`${base}/health`).then(r => r.ok).catch(() => false)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    workDir = await mkdtemp(join(tmpdir(), 'qanxt-oracles-'));
    pool = new BrowserPool(true, logger);
  }, 60_000);

  beforeEach(async () => {
    await context?.close().catch(() => undefined);
    context = await pool.createContext('chromium', { defaultTimeoutMs: 6000, navigationTimeoutMs: 15_000 });
    page = await context.newPage();
    collector = new EvidenceCollector(workDir, new SecretMasker(), logger);
    collector.attach(page);
    mark = 0;
  });

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close().catch(() => undefined);
    lab?.kill();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  test('refused: native validation blocks an empty required field', async () => {
    await open('/simple-form');
    await submit('simple-form');
    await run({ action: 'assertFormRejected', target: testId('simple-form-form') });
    await fails(run({ action: 'assertFormAccepted', target: testId('simple-form-form') }), /accepted, but the form is still shown/);
  });

  test('accepted: a valid registration, and a refused one the other way round', async () => {
    await open('/registration');
    await fill('registration-fullName', 'Ada Lovelace');
    await fill('registration-email', 'ada@example.test');
    await fill('registration-password', 'Str0ng-passphrase');
    await fill('registration-confirmPassword', 'Str0ng-passphrase');
    await run({ action: 'check', target: testId('registration-terms') });
    await submit('registration');
    await run({ action: 'assertFormAccepted', target: testId('registration-form') });
    await run({ action: 'assertNoServerError' });
    await fails(run({ action: 'assertFormRejected', target: testId('registration-form') }), /accepted/);
  }, 30_000);

  test('a server-side boundary is enforced above the maximum and broken below the minimum (FL-D02)', async () => {
    const fillValidation = async (age: string) => {
      await open('/validation');
      await fill('validation-username', 'ada_99');
      await fill('validation-age', age);
      await fill('validation-amount', '10.00');
      await fill('validation-quantity', '5');
      await submit('validation');
    };
    await fillValidation('121');
    await run({ action: 'assertFormRejected', target: testId('validation-form') });
    await run({ action: 'assertFieldInvalid', target: testId('validation-age') });

    await fillValidation('17');
    await fails(run({ action: 'assertFormRejected', target: testId('validation-form') }), /accepted/);
  }, 30_000);

  test('an error shown beside a field but not tied to it is caught (FL-D04)', async () => {
    await open('/accessibility');
    await submit('accessibility');
    await run({ action: 'assertFieldInvalid', target: testId('accessibility-nickname') });
    await fails(run({ action: 'assertErrorAssociated', target: testId('accessibility-nickname') }), /would not announce it/);
    // The labelled field on the same form does it properly.
    await run({ action: 'assertErrorAssociated', target: testId('accessibility-email') });
  }, 30_000);

  test('a crash with a stack trace is caught (FL-D05)', async () => {
    await open('/error-handling');
    await fill('error-handling-subject', 'Help');
    await fill('error-handling-message', 'null');
    await submit('error-handling');
    await fails(run({ action: 'assertNoServerError' }), /HTTP 500.*internal error detail/s);
    await fails(run({ action: 'assertFormRejected', target: testId('error-handling-form') }), /server failed/);
  }, 30_000);

  test('a submission the server handles is not reported as an error', async () => {
    await open('/error-handling');
    await fill('error-handling-subject', 'Help');
    await fill('error-handling-message', 'Please call me.');
    await submit('error-handling');
    await run({ action: 'assertNoServerError' });
  }, 30_000);

  test('a double click sends one order where it is guarded and two where it is not (FL-D03)', async () => {
    await open('/checkout');
    await fill('checkout-fullName', 'Ada');
    await fill('checkout-email', 'ada@example.test');
    await fill('checkout-quantity', '1');
    await run({ action: 'check', target: testId('checkout-shipping-0') });
    await run({ action: 'click', target: testId('checkout-submit'), value: 'repeat:2:120' });
    await run({ action: 'assertRequests', value: JSON.stringify({ method: 'POST', urlContains: '/checkout', maxCount: 1 }) });

    await open('/duplicate-submit');
    await fill('duplicate-submit-payee', 'Acme');
    await fill('duplicate-submit-amount', '10');
    await run({ action: 'click', target: testId('duplicate-submit-submit'), value: 'repeat:2:120' });
    await fails(run({ action: 'assertRequests', value: JSON.stringify({ method: 'POST', urlContains: '/api/transfers', maxCount: 1 }) }), /at most 1 .* saw 2/);
  }, 30_000);

  test('a submission still in flight is waited for, not missed', async () => {
    // The transfer API answers after 600 ms. Asserting straight after the click used to
    // count nothing, because the page had long since been "network idle" — which hid a real
    // double submission behind a pass.
    await open('/duplicate-submit');
    await fill('duplicate-submit-payee', 'Acme');
    await fill('duplicate-submit-amount', '10');
    await submit('duplicate-submit');
    await run({ action: 'assertRequests', value: JSON.stringify({ method: 'POST', urlContains: '/api/transfers', minCount: 1, maxCount: 1, statusIn: ['2xx'] }) });
  }, 30_000);

  test('a slow submission is measured as slow (FL-D07)', async () => {
    await open('/slow-form');
    await fill('slow-form-company', 'Acme');
    await fill('slow-form-seats', '3');
    await submit('slow-form');
    await fails(run({ action: 'assertRequests', value: JSON.stringify({ method: 'POST', minCount: 1, maxDurationMs: 2000 }) }), /within 2000 ms .* took \d{4} ms/);
    await run({ action: 'assertLoadTimeUnder', value: '5000' });
  }, 30_000);

  test('reflected markup is caught where it is reflected and not where it is encoded (FL-D06)', async () => {
    await open('/search');
    await fill('search-q', '<qanxt-probe-x1></qanxt-probe-x1>');
    await submit('search');
    await fails(run({ action: 'assertNoMarkupInjection', value: 'qanxt-probe-x1' }), /live markup/);

    await open('/profile');
    await fill('profile-displayName', '<qanxt-probe-x1></qanxt-probe-x1>');
    await submit('profile');
    await run({ action: 'assertNoMarkupInjection', value: 'qanxt-probe-x1' });
  }, 30_000);

  test('a fixed-width form overflows a phone and a fluid one does not (FL-D15)', async () => {
    await run({ action: 'setViewport', value: '390x844' });
    await open('/address');
    await fails(run({ action: 'assertNoHorizontalScroll' }), /scrolled sideways/);
    await open('/registration');
    await run({ action: 'assertNoHorizontalScroll' });
  }, 30_000);

  test('decoration a page clips is not reported as sideways scrolling', async () => {
    // The sign-in page carries a 1700px-wide background the page clips with overflow-x:
    // hidden. Its content is wider than a phone; nobody can scroll to it.
    await run({ action: 'setViewport', value: '390x844' });
    await open('/login');
    await run({ action: 'assertNoHorizontalScroll' });
  }, 30_000);

  test('a scrolling page names the element that sticks out', async () => {
    await run({ action: 'setViewport', value: '390x844' });
    await open('/address');
    await fails(run({ action: 'assertNoHorizontalScroll' }), /element reaching furthest is form#address/);
  }, 30_000);

  test('a form in a closed dialog is found behind its opener, and a click on its hidden control says why it failed', async () => {
    await open('/contact-modal');
    const [raw] = (await page.evaluate(extractForms, 300)) as RawForm[];
    expect(raw).toBeDefined();
    expect(await formIsVisible(page, raw!)).toBe(false);
    const found = await findOpener(page, raw!);
    expect(found.opener?.label).toBe('Contact us');

    const timedOut = 'locator.click: Timeout 1000ms exceeded.';
    expect(await explainTimeout(page, timedOut, testId('contact-modal-submit'))).toMatch(/hidden, so nobody can use it/);
    await run({ action: 'click', target: found.opener!.locator });
    expect(await formIsVisible(page, raw!)).toBe(true);
    expect(await explainTimeout(page, timedOut, testId('contact-modal-submit'))).toBe(timedOut);
  }, 30_000);

  test('the keyboard moves focus through the fields in order', async () => {
    await open('/registration');
    await run({ action: 'click', target: testId('registration-fullName') });
    await run({ action: 'press', value: 'Tab' });
    await run({ action: 'assertFocused', target: testId('registration-email') });
    await fails(run({ action: 'assertFocused', target: testId('registration-password') }), /focus is on input#registration-email/);
  }, 30_000);

  test('an upload uses a generated file, accepted by type and refused otherwise', async () => {
    await open('/file-upload');
    await fill('file-upload-title', 'Proof');
    await run({ action: 'upload', target: testId('file-upload-document'), value: 'fixture:pdf:2048' });
    await submit('file-upload');
    await run({ action: 'assertFormAccepted', target: testId('file-upload-form') });

    await open('/file-upload');
    await fill('file-upload-title', 'Proof');
    await run({ action: 'upload', target: testId('file-upload-document'), value: 'fixture:exe:100' });
    await submit('file-upload');
    await run({ action: 'assertFormRejected', target: testId('file-upload-form') });
  }, 30_000);

  test('a form that submits with fetch is judged by what it renders in place', async () => {
    await open('/api-form');
    await fill('api-form-name', 'Ada');
    await fill('api-form-phone', 'not a phone');
    await run({ action: 'select', target: testId('api-form-when'), value: 'Morning' });
    await submit('api-form');
    await run({ action: 'assertFormRejected', target: testId('api-form-form') });

    await fill('api-form-phone', '0207 946 000');
    await submit('api-form');
    await run({ action: 'assertFormAccepted', target: testId('api-form-form') });
    await run({ action: 'assertRequests', value: JSON.stringify({ method: 'POST', urlContains: '/api/callbacks', statusIn: ['201', '422'], bodyContains: '0207 946 000' }) });
  }, 30_000);

  test('going back in a wizard keeps the answers or does not (FL-D11)', async () => {
    await open('/multi-step');
    await fill('multi-step-applicant', 'Ada Lovelace');
    await fill('multi-step-email', 'ada@example.test');
    await run({ action: 'click', target: testId('multi-step-next') });
    await run({ action: 'assertVisible', target: testId('multi-step-loanAmount') });
    await run({ action: 'click', target: testId('multi-step-previous') });
    await fails(run({ action: 'assertValue', target: testId('multi-step-applicant'), expected: 'Ada Lovelace' }), /Expected the value "Ada Lovelace" but found ""/);
  }, 30_000);

  test('refreshing after a submission does not send it again', async () => {
    await open('/profile');
    await fill('profile-displayName', 'Ada');
    await fill('profile-email', 'ada@example.test');
    await submit('profile');
    await run({ action: 'assertFormAccepted', target: testId('profile-form') });
    await run({ action: 'reload' });
    await run({ action: 'assertRequests', value: JSON.stringify({ method: 'POST', urlContains: '/profile', maxCount: 1 }) });
  }, 30_000);

  test('a submission after the session has gone crashes where it does (FL-D13)', async () => {
    await open('/session-expiry');
    await fill('session-expiry-note', 'Remember');
    await run({ action: 'clearCookies' });
    await submit('session-expiry');
    await fails(run({ action: 'assertNoServerError' }), /HTTP 500/);
  }, 30_000);

  test('a field keeps at most its declared length', async () => {
    await open('/validation');
    await fill('validation-username', 'a'.repeat(13));
    await run({ action: 'assertValueLength', target: testId('validation-username'), value: '<=12' });
    await run({ action: 'assertPresent', target: css('input[name="_csrf"]') });
  }, 30_000);
});
