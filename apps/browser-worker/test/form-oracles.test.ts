import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright';
import { ASSERTION_ACTIONS, type BrowserAction, type LocatorDescriptor } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { runAction, type ActionContext } from '../src/execution/action-runner.js';
import { EvidenceCollector } from '../src/execution/evidence-collector.js';
import { SecretMasker } from '../src/security/masker.js';
import { Logger } from '../src/util/logger.js';
import { extractForms, type RawForm } from '../src/discovery/form-extractor.js';
import { findOpener, formIsVisible } from '../src/discovery/form-probe.js';
import { explainTimeout } from '../src/execution/executor.js';
import { InconclusiveError, textDigest } from '../src/execution/form-oracles.js';

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
      urlAtLastNavigation: () => undefined, urlBeforeLastAction: () => urlBeforeLastAction,
      textDigestBeforeLastAction: () => textDigestBeforeLastAction,
      networkMarkBeforeLastAction: () => networkMarkBeforeLastAction, workDir
    }
  });

  // The harness tracks this the way the executor does — before any step that is not an
  // assertion — so a test here exercises the same signal the product computes, not a
  // convenience the product does not have.
  let urlBeforeLastAction: string | undefined;
  let textDigestBeforeLastAction: string | undefined;
  let networkMarkBeforeLastAction = 0;

  const run = async (action: Partial<BrowserAction> & { action: BrowserAction['action'] }) => {
    if (!ASSERTION_ACTIONS.includes(action.action)) {
      urlBeforeLastAction = page.url();
      await collector.settle();
      networkMarkBeforeLastAction = collector.getNetworkEvents().length;
      textDigestBeforeLastAction = await textDigest(page);
    }
    return runAction(page, { description: action.action, ...action } as BrowserAction, actionContext());
  };

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

  test('not evaluated: the application refuses because this identity may not do it', async () => {
    // Measured on the freight lab: 258 of 971 reported failures were the application
    // saying "You do not have permission", each read as it failing to accept a valid
    // submission. The submission is fine; the identity is not permitted to make it, so
    // whether a permitted one would be accepted is not something the run observed.
    await open('/permission-wall');
    await fill('permission-wall-invoice', 'INV-0042');
    await fill('permission-wall-amount', '250');
    await fill('permission-wall-reason', 'Goods returned');
    await submit('permission-wall');

    const error = await run({ action: 'assertFormAccepted', target: testId('permission-wall-form') })
      .then(() => null, (thrown: unknown) => thrown);

    expect((error as Error).name).toBe('InconclusiveError');
    expect((error as Error).message).toMatch(/not permitted to make this submission/);
    expect((error as Error).message).toMatch(/do not have permission to raise credit notes/);
  }, 30_000);

  test('not evaluated: the application refuses for a rule its markup does not declare', async () => {
    // Measured on the freight lab: 249 of 971 reported failures, a quarter of the run, and
    // every one of them the application being right. "The claim cannot exceed the declared
    // value of £7,609.52." "Only 757 outstanding on PO-2026-801." A submission built to
    // satisfy every declared constraint, refused for a rule that is nowhere in the markup.
    await open('/unmodelled-rule');
    await fill('unmodelled-rule-shipment', 'MF-1333');
    await fill('unmodelled-rule-amount', '9000');
    await fill('unmodelled-rule-detail', 'Pallet crushed in transit');
    await submit('unmodelled-rule');

    const error = await run({ action: 'assertFormAccepted', target: testId('unmodelled-rule-form') })
      .then(() => null, (thrown: unknown) => thrown);

    expect((error as Error).name).toBe('InconclusiveError');
    expect((error as Error).message).toMatch(/a rule this suite does not model/);
    // The application's own sentence is the useful output: this form's unmodelled rule in
    // its own words. A reason that did not carry it would be worth nothing to a reader.
    expect((error as Error).message).toMatch(/cannot exceed the declared value/);
  }, 30_000);

  test('and a refusal that is about the value is still a failure', async () => {
    // The counterpart. Softening a permission wall must not soften a form the application
    // would not take for a reason that is its own fault.
    await open('/simple-form');
    await submit('simple-form');

    const error = await run({ action: 'assertFormAccepted', target: testId('simple-form-form') })
      .then(() => null, (thrown: unknown) => thrown);

    expect((error as Error).name).not.toBe('InconclusiveError');
  }, 30_000);

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

  /**
   * The two halves of the client-rendering fix, which only mean anything together.
   *
   * Half one: an application that answers a submission by changing its route and redrawing
   * has accepted it, even with the same form still visible and nothing congratulating the
   * user. Half two: an application that swallows the submission has not, and must still
   * fail — otherwise the first half has simply made the oracle easier to satisfy.
   */
  test('a client-rendered search that changes the route and redraws is accepted', async () => {
    await open('/client-search');
    await fill('client-search-reference', 'CON-4471');
    await submit('client-search');
    await run({ action: 'assertFormAccepted', target: testId('client-search-form') });
    // Nothing navigated, and the form is still on screen: the route is the only signal.
    expect(page.url()).toContain('reference=CON-4471');
    const stillThere = await page.locator('[data-testid="client-search-form"]').isVisible();
    expect(stillThere).toBe(true);
    await fails(run({ action: 'assertFormRejected', target: testId('client-search-form') }),
      /refused/);
  }, 30_000);

  /**
   * The commonest shape in a client-rendered application, and the one with no strong
   * signal at all: the submission is posted, answered, and the screen it is already on is
   * redrawn. No navigation, no route change, no banner, the same form still there. Twenty
   * of thirty-five failures against a client-rendered target were this.
   */
  test('a submission answered by redrawing the screen in place is accepted', async () => {
    await open('/client-redraw');
    await fill('client-redraw-who', 'Ada Lovelace');
    await submit('client-redraw');
    await run({ action: 'assertFormAccepted', target: testId('client-redraw-form') });
    // Everything the oracle cannot use: same URL, same form, no confirmation.
    expect(page.url()).toContain('/client-redraw');
    expect(await page.locator('[data-testid="client-redraw-form"]').isVisible()).toBe(true);
  }, 30_000);

  /**
   * Why the redraw is only ever read alongside a successful request, and never alone: an
   * application that posts, is answered 201, throws the submission away and leaves the
   * screen identical must still fail. Otherwise the signal above has made the oracle
   * easier to satisfy rather than better at reading an answer.
   */
  test('a submission answered and then discarded is not an acceptance (FL-D14)', async () => {
    await open('/client-silent-discard');
    await fill('client-silent-discard-draft', 'a draft nobody keeps');
    await submit('client-silent-discard');
    // Still a failure, and this is the line the change above draws: the application said
    // nothing. A refusal that names a rule is the suite's data not satisfying it; a refusal
    // that names nothing is the application discarding a submission, and softening the
    // first must not soften this. In the measured freight run not one of the 249 was this
    // shape, which is why the line holds.
    await fails(run({ action: 'assertFormAccepted', target: testId('client-silent-discard-form') }),
      /did not redraw in answer to it|route did not change/);
  }, 30_000);

  test('a form that swallows the submission is still not an acceptance (FL-D12)', async () => {
    await open('/client-dead-end');
    await fill('client-dead-end-preference', 'daily');
    await submit('client-dead-end');
    await fails(run({ action: 'assertFormAccepted', target: testId('client-dead-end-form') }),
      /the route did not change/);
  }, 30_000);

  /**
   * "What this submission sent" has to mean what it says.
   *
   * Counted from the last navigation, it included everything the page fetched while
   * loading. On a client-rendered application that is most of its traffic: a check that
   * could name neither a verb nor an address read the page's own data fetch, found its
   * status, and reported the submission accordingly. The client-redraw route loads nothing
   * of its own, so this uses the one that does.
   */
  test('a submission-scoped request check ignores what the page fetched while loading', async () => {
    await open('/client-redraw');
    // The page's own load traffic is in the record by now; the submission's is not.
    await fill('client-redraw-who', 'Ada Lovelace');
    await submit('client-redraw');

    // One POST, and only one request, is attributable to the submission.
    await run({ action: 'assertRequests', value: JSON.stringify({
      minCount: 1, maxCount: 1, statusIn: ['2xx', '3xx'], scope: 'submission' }) });

    // The same expectation counted from the navigation sees the page load as well.
    await fails(run({ action: 'assertRequests', value: JSON.stringify({
      minCount: 1, maxCount: 1, scope: 'navigation' }) }), /request/);
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

  /**
   * The false refusal this removes.
   *
   * A server-rendered form that answers in place re-renders itself empty with a
   * confirmation above it. Every required field on it is then natively invalid, and the
   * oracle read that as the application reporting a problem — so a freight export form
   * showing "Export of shipments queued. You will be emailed when it is ready." and a
   * document upload showing "Document uploaded." were both filed as refusals of a valid
   * submission.
   */
  test('a form that confirms in place and clears itself is accepted, not refused', async () => {
    await open('/queue-export');
    await fill('queue-export-dataset', 'shipments');
    await fill('queue-export-dateFrom', '2026-01-01');
    await fill('queue-export-dateTo', '2026-02-01');
    await submit('queue-export');
    await run({ action: 'assertFormAccepted', target: testId('queue-export-form') });
  }, 30_000);

  /** And the refusal it must not remove: a submission the browser blocks still reports its
   *  fields, because the user has tried to submit them. */
  test('an empty submission the browser blocks still reports its fields', async () => {
    await open('/queue-export');
    await submit('queue-export');
    await fails(run({ action: 'assertFormAccepted', target: testId('queue-export-form') }),
      /fields marked invalid: dataset/);
  }, 30_000);

  // ---- Reading the saved record back -----------------------------------------------

  const savedValues = (...values: { label: string; value: string }[]) => JSON.stringify({ values });

  const inconclusive = async (promise: Promise<unknown>, pattern: RegExp) => {
    await expect(promise).rejects.toThrow(InconclusiveError);
    await expect(promise).rejects.toThrow(pattern);
  };

  test('a record the application shows back reads back', async () => {
    await open('/record-view');
    await fill('record-view-consignee', 'QANXT-11111111');
    await fill('record-view-origin', 'QANXT-22222222');
    await fill('record-view-instructions', 'QANXT-33333333');
    await submit('record-view');
    await run({ action: 'assertFormAccepted', target: testId('record-view-form') });
    await run({ action: 'assertSavedValuesReadBack', value: savedValues(
      { label: 'Consignee', value: 'QANXT-11111111' },
      { label: 'Origin', value: 'QANXT-22222222' },
      { label: 'Handling instructions', value: 'QANXT-33333333' }) });
  }, 30_000);

  test('a record shown back without one of its values fails, naming it (FL-D16)', async () => {
    await open('/record-loses-field');
    await fill('record-loses-field-consignee', 'QANXT-44444444');
    await fill('record-loses-field-origin', 'QANXT-55555555');
    await fill('record-loses-field-instructions', 'QANXT-66666666');
    await submit('record-loses-field');
    await run({ action: 'assertFormAccepted', target: testId('record-loses-field-form') });
    await fails(run({ action: 'assertSavedValuesReadBack', value: savedValues(
      { label: 'Consignee', value: 'QANXT-44444444' },
      { label: 'Origin', value: 'QANXT-55555555' },
      { label: 'Handling instructions', value: 'QANXT-66666666' }) }),
      /shows Consignee, Origin back but not Handling instructions \(QANXT-66666666\)/);
  }, 30_000);

  /**
   * The false finding this oracle would otherwise produce on most applications. A
   * confirmation page is a correct way to answer a save and shows none of the submission,
   * which is indistinguishable from a page that lost the whole record.
   */
  test('a confirmation page that shows nothing submitted reaches no verdict', async () => {
    await open('/simple-form');
    await fill('simple-form-name', 'QANXT-77777777');
    await submit('simple-form');
    await run({ action: 'assertFormAccepted', target: testId('simple-form-form') });
    await inconclusive(run({ action: 'assertSavedValuesReadBack',
      value: savedValues({ label: 'Your name', value: 'QANXT-77777777' }) }),
      /a confirmation page rather than the record/);
  }, 30_000);

  /** An application that answers by redrawing the screen it is on has not said where the
   *  record is, and guessing would report a paginated application for losing records. */
  test('a form the application stays on reaches no verdict', async () => {
    await open('/client-redraw');
    await fill('client-redraw-who', 'QANXT-88888888');
    await submit('client-redraw');
    await inconclusive(run({ action: 'assertSavedValuesReadBack',
      value: savedValues({ label: 'Name', value: 'QANXT-88888888' }) }),
      /stayed on \/client-redraw after accepting the submission/);
  }, 30_000);

  test('a field keeps at most its declared length', async () => {
    await open('/validation');
    await fill('validation-username', 'a'.repeat(13));
    await run({ action: 'assertValueLength', target: testId('validation-username'), value: '<=12' });
    await run({ action: 'assertPresent', target: css('input[name="_csrf"]') });
  }, 30_000);
});
