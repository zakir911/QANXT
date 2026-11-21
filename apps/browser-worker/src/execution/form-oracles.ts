import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import type { ConsoleEventReport, LocatorDescriptor, NetworkEventReport } from '@qa-nxt/shared-types';
import { buildLocator } from '../browser/locator-resolver.js';

/**
 * The form oracles: how a test decides what an application did with a submission, without
 * knowing the application's wording.
 *
 * Each one answers a behavioural question from evidence the browser can see — the form is
 * still there and a field is marked invalid, a confirmation appeared, a request came back
 * 500, two POSTs left where one should have — and each failure message says what was
 * observed, because "assertion failed" is not something a person can act on.
 *
 * None of them passes on an absence of evidence. A form that refuses a value without
 * saying why fails "refused" with that reason, rather than being given the benefit of the
 * doubt: a test that passes because nothing happened is how a broken form looks healthy.
 */

/** What the oracles need from the execution that the page alone cannot tell them. */
export interface Observations {
  /** Network events recorded so far, including those still being recorded once settled. */
  network(): NetworkEventReport[];
  console(): ConsoleEventReport[];
  /** Waits for in-flight response recordings to land. */
  settle(): Promise<void>;
  /** Index into network() at the test's most recent navigate step. */
  networkMarkAtLastNavigation(): number;
  /**
   * Index into network() before the most recent step that was not an assertion — in
   * practice, before the click or key press that submitted the form.
   *
   * "What this submission sent" was measured from the last navigation, which includes
   * everything the page fetched while loading. On an application rendered in the browser
   * that is most of its traffic: a check on a submission that could name neither a verb nor
   * an address judged the page's own `GET /api/me`, found it answered 401, and reported the
   * submission as having failed.
   */
  networkMarkBeforeLastAction(): number;
  /** The URL the most recent navigate step landed on. */
  urlAtLastNavigation(): string | undefined;
  /**
   * The URL as it stood before the most recent step that was not an assertion — in
   * practice, before the click or key press that submitted the form.
   *
   * An application that renders in the browser answers a submission by changing its route
   * and redrawing, with no document navigation and no confirmation banner. Without this,
   * the only acceptance signals were a confirmation text and the form going away, and a
   * search form that renders its results in place matched neither: 23 of 43 failures in
   * the first run against a client-rendered target were submissions the application had
   * accepted and acted on.
   */
  urlBeforeLastAction(): string | undefined;
  /**
   * A digest of the page's visible text as it stood before the most recent step that was
   * not an assertion.
   *
   * The last acceptance signal, and the weakest, for the application that answers a
   * submission by redrawing the screen it is already on: a booking form whose new row
   * appears in the table above it, with no navigation, no route change and nothing
   * congratulating the user. There is no stronger evidence available — a confirmation
   * banner is not shown, the form comes back, and the URL is the same — and twenty of
   * thirty-five failures against a client-rendered target were that.
   *
   * It is only ever used together with a successful request, because "the page changed"
   * alone would accept a clock ticking. A submission the application silently discards
   * changes nothing and still fails.
   */
  textDigestBeforeLastAction(): string | undefined;
  /** Where generated upload files may be written. */
  workDir: string;
}

export class OracleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OracleError';
  }
}

interface FormSignals {
  formPresent: boolean;
  formVisible: boolean;
  invalidFields: string[];
  errorTexts: string[];
  successTexts: string[];
  nativeValidation: boolean;
}

// Matched on conventions for error messages, not on the word "error" anywhere: a test id
// like "error-handling-confirmation" is a confirmation on a form called error-handling.
const ERROR_SELECTOR = [
  '[role="alert"]', '[aria-live="assertive"]', '.error', '.errors', '.error-message', '.field-error',
  '.invalid-feedback', '.form-error', '.alert-danger', '.alert-error', '[data-error]',
  '[id$="-error"]', '[id$="-errors"]', '[data-testid$="-error"]', '[data-testid$="-errors"]', '[data-testid="error"]',
  '.has-error .help-block'
].join(',');

const SUCCESS_SELECTOR = [
  '[role="status"]', '.success', '.alert-success', '.confirmation', '.notice-success',
  '[data-testid*="success"]', '[data-testid*="confirmation"]', '[data-testid*="thank"]'
].join(',');

/** Reads, inside the page, what the form and the page are saying right now. */
async function signals(page: Page, form: Locator | null): Promise<FormSignals> {
  const handle = form ? await form.first().elementHandle({ timeout: 500 }).catch(() => null) : null;
  return page.evaluate(([root, errorSelector, successSelector]) => {
    const visible = (el: Element) => {
      if ((el as HTMLElement).closest('[hidden]')) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const formEl = root as HTMLFormElement | null;
    const connected = Boolean(formEl && formEl.isConnected);
    const nativeValidation = Boolean(formEl && formEl.tagName === 'FORM' && !formEl.noValidate);
    const controls = connected ? Array.from(formEl!.querySelectorAll('input, select, textarea')) as HTMLInputElement[] : [];
    const invalidFields = controls
      .filter(c => c.getAttribute('aria-invalid') === 'true'
        || (nativeValidation && typeof c.checkValidity === 'function' && !c.validity.valid && visible(c)))
      .map(c => c.name || c.id || c.type);
    const errorTexts = Array.from(document.querySelectorAll(errorSelector))
      .filter(el => visible(el) && text(el).length > 0)
      .map(el => text(el).slice(0, 160));
    const successTexts = Array.from(document.querySelectorAll(successSelector))
      .filter(el => visible(el) && text(el).length > 0)
      .map(el => text(el).slice(0, 160));
    return {
      formPresent: connected,
      formVisible: connected && visible(formEl!),
      invalidFields: [...new Set(invalidFields)],
      errorTexts: [...new Set(errorTexts)].slice(0, 5),
      successTexts: [...new Set(successTexts)].slice(0, 5),
      nativeValidation
    };
  }, [handle, ERROR_SELECTOR, SUCCESS_SELECTOR] as const);
}

async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => undefined);
}

async function poll<T>(timeoutMs: number, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
    try { value = await read(); } catch { /* the page is between documents; ask again */ }
  }
  return value;
}

const serverErrorsSince = (events: NetworkEventReport[]) =>
  events.filter(e => (e.statusCode ?? 0) >= 500 && ['document', 'xhr', 'fetch'].includes(e.resourceType ?? 'document'));

function describe(s: FormSignals): string {
  const parts = [
    s.formPresent ? (s.formVisible ? 'the form is still shown' : 'the form is present but hidden') : 'the form is gone',
    s.invalidFields.length ? `fields marked invalid: ${s.invalidFields.join(', ')}` : 'no field is marked invalid',
    s.errorTexts.length ? `messages: "${s.errorTexts.join('" | "')}"` : 'no error message is shown',
    s.successTexts.length ? `confirmation: "${s.successTexts.join('" | "')}"` : 'no confirmation is shown'
  ];
  return parts.join('; ');
}

/** The submission was refused: the form is still there, it says why, and nothing confirmed it. */
export async function assertFormRejected(page: Page, form: Locator, obs: Observations, timeoutMs: number): Promise<void> {
  await settlePage(page);
  await obs.settle();
  const rejected = (s: FormSignals) => s.formPresent && s.successTexts.length === 0
    && (s.invalidFields.length > 0 || s.errorTexts.length > 0);
  // A confirmation on a settled page is an answer too: waiting out the timeout for a
  // refusal that will not come only makes the failure slow.
  const confirmed = (s: FormSignals) => s.successTexts.length > 0 && s.errorTexts.length === 0;
  const result = await poll(timeoutMs, () => signals(page, form), s => rejected(s) || confirmed(s));
  if (rejected(result)) return;

  await obs.settle();
  const crashed = serverErrorsSince(obs.network().slice(obs.networkMarkAtLastNavigation()));
  if (crashed.length > 0) {
    throw new OracleError(`Expected the submission to be refused with a validation message, but the server failed: `
      + `${crashed[0]!.method} ${crashed[0]!.url} returned HTTP ${crashed[0]!.statusCode}.`);
  }
  if (!result.formPresent || result.successTexts.length > 0) {
    throw new OracleError(`Expected the submission to be refused, but it was accepted: ${describe(result)} (now at ${page.url()}).`);
  }
  throw new OracleError(`Expected the submission to be refused with a reason, but nothing told the user what was wrong: ${describe(result)}.`);
}

/** The submission was accepted: a confirmation appeared or the form gave way, with no error. */
export async function assertFormAccepted(page: Page, form: Locator, obs: Observations, timeoutMs: number): Promise<void> {
  await settlePage(page);
  await obs.settle();
  // Accepted when a confirmation is shown, or the form is no longer in front of the user.
  //
  // This tested !formPresent — the form removed from the DOM. A modal form that closes on
  // success stays in the DOM and is hidden, which is the commonest acceptance pattern in a
  // back-office application, and it was reported as a silent refusal: "the form is present
  // but hidden; no field is marked invalid; no error message is shown". 30 of 275 failures
  // in a measured run were that, on an application that had accepted every one of them.
  //
  // formVisible was already computed alongside formPresent and simply not used here. The
  // guards that matter are unchanged: no invalid field and no error text, so a form hidden
  // while an error is shown elsewhere is still not an acceptance.
  //
  // assertFormRejected keeps formPresent deliberately. It establishes a refusal from the
  // error signals themselves, and a hidden form showing a visible error is still a refusal,
  // so presence is the weaker condition there and visibility would not improve it.
  //
  // A third acceptance signal, for an application that renders in the browser: the route
  // changed. A search form that pushes `?q=...` and redraws its results in place has
  // accepted the submission and acted on it, but the form it redraws is a new, identical,
  // visible form and there is no confirmation banner, so neither signal above sees it.
  //
  // A route change is the same evidence as a document navigation, which `!formVisible`
  // already accepts — the difference is only whether the browser fetched a new document.
  // It is not "the server answered 200", which would be weaker: an application that
  // answers a submission, discards it and redraws the same screen still fails here,
  // because nothing about where the user is has changed.
  //
  // The guards are unchanged: an invalid field or a visible error message is a refusal
  // whatever the route did.
  const before = obs.urlBeforeLastAction();
  const movedOn = () => before !== undefined && !sameScreen(before, page.url());

  // The submission's own request, and whether the application answered it without failing.
  // This is never acceptance on its own: an application that answers 200, throws the
  // submission away and redraws the same screen would pass on it, which is precisely the
  // defect class a "silently discards" test exists to catch.
  const since = obs.network().slice(obs.networkMarkAtLastNavigation());
  const answered = since.filter(e =>
    ['document', 'xhr', 'fetch'].includes(e.resourceType ?? 'document')
    && e.statusCode !== undefined && e.statusCode >= 200 && e.statusCode < 400);
  const textBefore = obs.textDigestBeforeLastAction();
  const redrew = async () => {
    if (answered.length === 0 || textBefore === undefined) return false;
    const now = await textDigest(page);
    return now !== undefined && now !== textBefore;
  };

  // Polled on the three signals the page itself carries; the redraw is asked about once,
  // afterwards, because it costs a page evaluation and only matters when the others are silent.
  const settled = (s: FormSignals) =>
    s.invalidFields.length === 0 && s.errorTexts.length === 0
    && (s.successTexts.length > 0 || !s.formVisible || movedOn());
  const result = await poll(timeoutMs, () => signals(page, form), settled);
  const drewSomethingNew = settled(result) ? false : await redrew();
  const accepted = (s: FormSignals) =>
    s.invalidFields.length === 0 && s.errorTexts.length === 0
    && (s.successTexts.length > 0 || !s.formVisible || movedOn() || drewSomethingNew);

  await obs.settle();
  const crashed = serverErrorsSince(obs.network().slice(obs.networkMarkAtLastNavigation()));
  if (crashed.length > 0) {
    throw new OracleError(`Expected the submission to be accepted, but the server failed: `
      + `${crashed[0]!.method} ${crashed[0]!.url} returned HTTP ${crashed[0]!.statusCode}.`);
  }
  if (accepted(result)) return;
  throw new OracleError(`Expected the submission to be accepted, but ${describe(result)}`
    + `${before === undefined ? '' : `; the route did not change from ${routeOf(before)}`}`
    + `; ${answered.length === 0
      ? 'no request the application answered left the page'
      : 'the page did not redraw in answer to it'}.`);
}

/**
 * A cheap stand-in for "what the page is showing".
 *
 * The visible text, not the markup: a re-render that produces identical text has shown the
 * user nothing new, and an attribute changing under the hood is not feedback. Length and a
 * rolling hash are enough to tell "changed" from "did not", which is the only question
 * asked of it.
 */
export async function textDigest(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    return `${text.length}:${hash}`;
  }).catch(() => undefined);
}

/**
 * Is this the same screen, ignoring the parts of a URL that do not name one?
 *
 * The fragment is excluded because a hash is how one kind of client-side router names a
 * screen and how another names a position on the current one; comparing the path and the
 * query catches the first, and the second is not a submission being accepted. The query
 * IS compared, because `?q=cardiology` is a different screen from `?q=` to every user who
 * has ever used a search form.
 */
function sameScreen(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname
      && left.search === right.search;
  } catch {
    return a === b;
  }
}

function routeOf(url: string): string {
  try { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}`; } catch { return url; }
}

interface FieldState { found: boolean; indicated: boolean; associated: boolean; detail: string }

async function fieldState(field: Locator): Promise<FieldState> {
  return field.first().evaluate((el: Element) => {
    const control = el as HTMLInputElement;
    const visible = (node: Element) => {
      if ((node as HTMLElement).closest('[hidden]')) return false;
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && node.getBoundingClientRect().height > 0;
    };
    const form = control.form;
    const nativeActive = Boolean(form && !form.noValidate);
    const nativeInvalid = nativeActive && typeof control.checkValidity === 'function' && !control.validity.valid;
    const group = control.type === 'radio' ? control.closest('fieldset') : null;
    const ariaInvalid = control.getAttribute('aria-invalid') === 'true' || group?.getAttribute('aria-invalid') === 'true';
    const referenced = [control.getAttribute('aria-describedby'), control.getAttribute('aria-errormessage'),
      group?.getAttribute('aria-describedby')]
      .filter(Boolean).join(' ').split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null && visible(node) && (node.textContent ?? '').trim().length > 0);
    // The nearest container holding only this control, for an error printed next to it.
    let container: Element | null = control.parentElement;
    while (container && container.querySelectorAll('input:not([type=radio]), select, textarea').length <= 1 && container.parentElement
      && container.parentElement.querySelectorAll('input:not([type=radio]), select, textarea').length <= 1) {
      container = container.parentElement;
    }
    const nearby = container
      ? Array.from(container.querySelectorAll('[class*="error"], [id$="-error"], [role="alert"]'))
          .filter(node => visible(node) && (node.textContent ?? '').trim().length > 0)
      : [];
    const indicated = ariaInvalid || nativeInvalid || nearby.length > 0;
    const associated = (ariaInvalid && referenced.length > 0) || nativeInvalid;
    const detail = [
      ariaInvalid ? 'aria-invalid="true"' : 'no aria-invalid',
      referenced.length ? `described by "${(referenced[0]!.textContent ?? '').trim().slice(0, 80)}"` : 'no error referenced by aria-describedby',
      nativeInvalid ? `browser validation: "${control.validationMessage}"` : '',
      nearby.length ? `message beside it: "${(nearby[0]!.textContent ?? '').trim().slice(0, 80)}"` : ''
    ].filter(Boolean).join(', ');
    return { found: true, indicated, associated, detail };
  });
}

export async function assertFieldInvalid(page: Page, field: Locator, timeoutMs: number): Promise<void> {
  await settlePage(page);
  const state = await poll(timeoutMs, () => fieldState(field), s => s.indicated);
  if (!state.indicated) throw new OracleError(`Expected this field to be reported invalid, but nothing marks it: ${state.detail}.`);
}

export async function assertFieldValid(page: Page, field: Locator, timeoutMs: number): Promise<void> {
  await settlePage(page);
  const state = await poll(timeoutMs, () => fieldState(field), s => !s.indicated);
  if (state.indicated) throw new OracleError(`Expected this field to no longer be reported invalid, but it still is: ${state.detail}.`);
}

/** The error is tied to the field programmatically, so assistive technology announces it. */
export async function assertErrorAssociated(page: Page, field: Locator, timeoutMs: number): Promise<void> {
  await settlePage(page);
  const state = await poll(timeoutMs, () => fieldState(field), s => s.associated);
  if (!state.associated) {
    throw new OracleError(state.indicated
      ? `The field shows an error, but assistive technology would not announce it with the field: ${state.detail}.`
      : `Expected an error programmatically associated with this field, but there is none: ${state.detail}.`);
  }
}

export async function assertFocused(field: Locator, timeoutMs: number): Promise<void> {
  const focused = await poll(timeoutMs, () => field.first().evaluate((el: Element) => document.activeElement === el), v => v);
  if (!focused) {
    const active = await field.page().evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return 'nothing';
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${(el as HTMLInputElement).name ? `[name=${(el as HTMLInputElement).name}]` : ''}`;
    });
    throw new OracleError(`Expected this field to have keyboard focus, but focus is on ${active}.`);
  }
}

const STACK_TRACE = [
  /\bat [\w$.<>]+ \([^)]*:\d+:\d+\)/, /Traceback \(most recent call last\)/, /SQLSTATE\[/i, /You have an error in your SQL syntax/i,
  /\bORA-\d{5}\b/, /System\.\w+Exception/, /NullReferenceException/, /Stack ?trace:/i, /Fatal error: Uncaught/
];

/** No server error, no uncaught script error, no stack trace or SQL error shown to the user. */
export async function assertNoServerError(page: Page, obs: Observations): Promise<void> {
  await settlePage(page);
  await obs.settle();
  const problems: string[] = [];
  const crashed = serverErrorsSince(obs.network());
  if (crashed.length > 0) problems.push(`${crashed.length} request(s) failed on the server, first ${crashed[0]!.method} ${crashed[0]!.url} → HTTP ${crashed[0]!.statusCode}`);
  const uncaught = obs.console().filter(e => e.level === 'pageerror');
  if (uncaught.length > 0) problems.push(`uncaught script error: ${uncaught[0]!.message.slice(0, 160)}`);
  const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const leaked = STACK_TRACE.find(pattern => pattern.test(body));
  if (leaked) problems.push(`the page shows internal error detail matching ${leaked}`);
  if (problems.length > 0) throw new OracleError(`Expected the application to handle this without an error, but ${problems.join('; ')}.`);
}

interface RequestExpectation {
  method?: string;
  urlContains?: string;
  minCount?: number;
  maxCount?: number;
  /** Status classes or codes, e.g. ["2xx", "3xx"] or [201]. */
  statusIn?: (string | number)[];
  maxDurationMs?: number;
  bodyContains?: string;
  /**
   * Which requests to count. "navigation" (default): since the test's last navigate step.
   * "test": the whole test. "submission": since the last step that acted, which is the only
   * one of the three that means "what this submission sent".
   */
  scope?: 'navigation' | 'test' | 'submission';
  /** Count only requests the server did not refuse: no 4xx or 5xx answer. A request that
   *  never got an answer (aborted by a second submission) is counted, because the server may
   *  still have acted on it. Used for duplicate submission, where a second request the
   *  server refused is not a second transaction. */
  countUnrefusedOnly?: boolean;
}

/**
 * Whether a request went to the expected address. The expectation comes from the API
 * inventory, which stores addresses normalised — lower case, with ids as `{id}` — so a
 * literal, case-sensitive "contains" missed a login posted to /IDSenseAPI/… when the
 * inventory said /idsenseapi/…, and reported a working form as broken.
 */
export function urlMatches(url: string, expected: string): boolean {
  const actual = url.toLowerCase();
  const wanted = expected.toLowerCase();
  if (!wanted.includes('{')) return actual.includes(wanted);
  const pattern = wanted.split(/\{[^}]+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/?#]+');
  return new RegExp(pattern).test(actual);
}

const statusMatches = (code: number | undefined, accepted: (string | number)[]) =>
  code !== undefined && accepted.some(a => typeof a === 'number' ? a === code : new RegExp(`^${String(a).replace(/x/g, '\\d')}$`).test(String(code)));

/** Counts the requests the page sent, and checks their status, timing and payload. */
export async function assertRequests(page: Page, value: string | undefined, obs: Observations): Promise<void> {
  let expectation: RequestExpectation;
  try { expectation = JSON.parse(value ?? '{}') as RequestExpectation; } catch { throw new OracleError('assertRequests needs a JSON description of the requests it expects.'); }
  await settlePage(page);
  await obs.settle();
  const events = expectation.scope === 'test'
    ? obs.network()
    : obs.network().slice(expectation.scope === 'submission'
        ? obs.networkMarkBeforeLastAction()
        : obs.networkMarkAtLastNavigation());
  const matching = events.filter(e =>
    (!expectation.method || e.method.toUpperCase() === expectation.method.toUpperCase())
    && (!expectation.urlContains || urlMatches(e.url, expectation.urlContains))
    && ['document', 'xhr', 'fetch', undefined].includes(e.resourceType)
    && (!expectation.countUnrefusedOnly || e.statusCode === undefined || e.statusCode < 400));
  const what = `${expectation.method ?? 'any'}${expectation.countUnrefusedOnly ? ' submission' : ' request'}(s)${expectation.urlContains ? ` to "${expectation.urlContains}"` : ''}${expectation.countUnrefusedOnly ? ' the server did not refuse' : ''}`;
  const problems: string[] = [];
  if (expectation.minCount !== undefined && matching.length < expectation.minCount) {
    // Name what was sent instead, so a reader can tell "nothing was sent" from "it went
    // somewhere else" without opening the trace.
    const sent = events.filter(e => ['document', 'xhr', 'fetch'].includes(e.resourceType ?? '') && e.method !== 'GET').slice(0, 3)
      .map(e => `${e.method} ${e.url}${e.statusCode === undefined ? '' : ` → ${e.statusCode}`}`);
    problems.push(`expected at least ${expectation.minCount} ${what} but saw ${matching.length}${sent.length ? ` (sent instead: ${sent.join('; ')})` : ' (no submission was sent at all)'}`);
  }
  if (expectation.maxCount !== undefined && matching.length > expectation.maxCount) problems.push(`expected at most ${expectation.maxCount} ${what} but saw ${matching.length}`);
  const answered = matching.filter(e => e.statusCode !== undefined);
  if (expectation.statusIn && answered.some(e => !statusMatches(e.statusCode, expectation.statusIn!))) {
    const wrong = answered.find(e => !statusMatches(e.statusCode, expectation.statusIn!))!;
    problems.push(`expected status ${expectation.statusIn.join('/')} but ${wrong.method} ${wrong.url} returned ${wrong.statusCode}`);
  }
  if (expectation.maxDurationMs !== undefined) {
    const slow = answered.filter(e => e.durationMs > expectation.maxDurationMs!);
    if (slow.length > 0) problems.push(`expected a response within ${expectation.maxDurationMs} ms but ${slow[0]!.method} ${slow[0]!.url} took ${slow[0]!.durationMs} ms`);
  }
  if (expectation.bodyContains !== undefined && !matching.some(e => decodeBody(e.requestBodyExcerpt).includes(expectation.bodyContains!))) {
    problems.push(`expected a ${what} carrying "${expectation.bodyContains}" but none did`);
  }
  if (problems.length > 0) throw new OracleError(problems.join('; ') + '.');
}

function decodeBody(body: string | undefined): string {
  if (!body) return '';
  try { return `${body}\n${decodeURIComponent(body.replace(/\+/g, ' '))}`; } catch { return body; }
}

export async function assertLoadTimeUnder(page: Page, value: string | undefined, inAppNavigationMs?: number): Promise<void> {
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget <= 0) throw new OracleError('assertLoadTimeUnder needs a budget in milliseconds.');
  // Reached from inside the application (its session does not survive a page load), so
  // the browser has no new navigation timing: the time from asking for the page to the
  // page settling is the load time a user sees.
  if (inAppNavigationMs !== undefined) {
    if (inAppNavigationMs > budget) throw new OracleError(`Expected the page to load within ${budget} ms but it took ${inAppNavigationMs} ms (opened from inside the application).`);
    return;
  }
  await page.waitForLoadState('load', { timeout: Math.max(budget * 3, 10_000) }).catch(() => undefined);
  const measured = await page.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!entry) return null;
    return Math.round(entry.loadEventEnd > 0 ? entry.loadEventEnd : entry.domContentLoadedEventEnd);
  });
  if (measured === null) throw new OracleError('The browser recorded no navigation timing for this page, so its load time could not be measured.');
  if (measured > budget) throw new OracleError(`Expected the page to load within ${budget} ms but it took ${measured} ms.`);
}

/** A marker element typed into a field must never come back as a live element. */
export async function assertNoMarkupInjection(page: Page, marker: string | undefined): Promise<void> {
  const tag = (marker ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*-[a-z0-9-]+$/.test(tag)) throw new OracleError('assertNoMarkupInjection needs a custom-element tag name as its marker.');
  await settlePage(page);
  const count = await page.evaluate((name: string) => document.getElementsByTagName(name).length, tag);
  if (count > 0) throw new OracleError(`Input was written back into the page as live markup: ${count} <${tag}> element(s) exist. The application does not encode what it reflects.`);
}

export async function assertValueLength(field: Locator, value: string | undefined): Promise<void> {
  const match = /^(<=|>=|==|<|>)?\s*(\d+)$/.exec((value ?? '').trim());
  if (!match) throw new OracleError('assertValueLength needs a comparison such as "<=20".');
  const [, op = '==', raw] = match;
  const limit = Number(raw);
  const length = (await field.first().inputValue()).length;
  const ok = op === '<=' ? length <= limit : op === '>=' ? length >= limit : op === '<' ? length < limit : op === '>' ? length > limit : length === limit;
  if (!ok) throw new OracleError(`Expected the value's length to be ${op} ${limit}, but it holds ${length} characters.`);
}

export async function assertNoHorizontalScroll(page: Page): Promise<void> {
  await settlePage(page);
  // Whether a person can actually scroll sideways, not how wide the content is: decoration
  // a site clips with overflow-x: hidden is wider than the viewport but cannot be reached,
  // and reporting it sent developers after a layout that was fine.
  const result = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const viewport = document.documentElement.clientWidth || window.innerWidth;
    // The window scrolls sideways unless the page tells it not to: html's overflow-x, or
    // body's when html leaves it visible (CSS hands body's value to the window then).
    // Hidden and clip stop a person scrolling; a script still could, so measuring with
    // scrollTo would be wrong.
    const htmlOverflow = getComputedStyle(document.documentElement).overflowX;
    const windowOverflow = htmlOverflow !== 'visible' ? htmlOverflow : getComputedStyle(document.body).overflowX;
    const overflow = Math.max(0, root.scrollWidth - viewport);
    const reachable = windowOverflow === 'hidden' || windowOverflow === 'clip' ? 0 : overflow;
    if (reachable <= 1) return { reachable, viewport, culprit: null as string | null, right: 0 };

    // The element that sticks out furthest and is not itself inside something that clips.
    const clips = (el: Element | null): boolean => {
      for (let node = el?.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === 'hidden' || overflow === 'clip' || overflow === 'auto' || overflow === 'scroll') return true;
      }
      return false;
    };
    let culprit: Element | null = null;
    let right = 0;
    for (const el of Array.from(document.body.querySelectorAll('*')).slice(0, 5000)) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.right <= viewport + 1 || clips(el)) continue;
      // Document order visits an element before its children, so on a tie the outermost
      // element — the one with the fixed width — is kept, not the input inside it.
      if (box.right > right + 0.5) { culprit = el; right = box.right; }
    }
    const describe = (el: Element) => {
      const id = el.id ? `#${el.id}` : '';
      const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map(c => `.${c}`).join('') : '';
      return `${el.tagName.toLowerCase()}${id}${classes}`;
    };
    return { reachable, viewport, culprit: culprit ? describe(culprit) : null, right: Math.round(right + window.scrollX) };
  });
  if (result.reachable > 1) {
    throw new OracleError(`The page can be scrolled sideways by ${Math.round(result.reachable)}px in a ${result.viewport}px-wide window`
      + (result.culprit ? `; the element reaching furthest is ${result.culprit}, whose right edge is at ${result.right}px.` : '.'));
  }
}

// ---- Generated upload files -------------------------------------------------

const PNG_HEADER = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

/** Writes the file a `fixture:<ext>:<bytes>` upload asks for, and returns its path. */
export async function materialiseFixture(spec: string, workDir: string): Promise<string> {
  const match = /^fixture:([a-z0-9]{1,8}):(\d{1,9})$/.exec(spec);
  if (!match) throw new OracleError(`"${spec}" is not an upload fixture; expected fixture:<extension>:<bytes>.`);
  const extension = match[1]!;
  const size = Math.min(Number(match[2]), 20 * 1024 * 1024);
  const header = extension === 'png' ? PNG_HEADER : extension === 'pdf' ? Buffer.from('%PDF-1.4\n') : Buffer.alloc(0);
  const body = Buffer.alloc(Math.max(0, size - header.length), extension === 'txt' || extension === 'csv' ? 0x61 : 0x20);
  const path = join(workDir, `qanxt-fixture-${size}.${extension}`);
  await writeFile(path, Buffer.concat([header, body]).subarray(0, Math.max(size, header.length)));
  return path;
}

/** What `assertServerEnforces` is asked to send, and what counts as the server refusing. */
interface ServerEnforcementCheck {
  /** The form to serialise and send. Its own action, method and enctype are used. */
  form?: LocatorDescriptor;
  /** Values forced on top of whatever the live form carries. */
  overrides?: Record<string, string>;
  /** What the browser objected to, quoted back in the failure so a reader can see it. */
  rule?: string;
  /** Status codes that mean the server refused. Defaults to the 4xx range. */
  refusedStatuses?: number[];
}

export interface SerialisedForm {
  action: string;
  method: string;
  enctype: string;
  fields: Array<[string, string]>;
}

/**
 * Asks whether the server enforces the rule the browser enforces.
 *
 * This is the check that separates a form from the thing behind it. A rule implemented in
 * the browser alone holds for exactly as long as everybody uses a browser, which is to say
 * not at all: the endpoint is reachable with a terminal. So the same submission is sent
 * straight to the form's action, carrying the session's own cookies and no DOM, and the
 * only question asked is whether it was refused.
 *
 * The step is meaningless alone and the designer never emits it alone. It follows a step
 * that has already shown the browser refusing these exact values, because a server that
 * accepts a value nothing objects to is not a defect — it is an unconstrained field. Read
 * the pair together and a failure here says precisely one thing: the rule is enforced in
 * the browser and nowhere else.
 *
 * The submission is read off the live form rather than rebuilt from the plan, and that is
 * not a detail. A form usually carries fields the planner never modelled — an anti-forgery
 * token above all — and a request that omits one is refused for the wrong reason. That
 * refusal would read here as the server enforcing the rule, turning a real defect into a
 * pass, which is the one failure mode this check cannot be allowed to have. Serialising
 * what the browser would actually send is what makes a refusal mean what it says.
 *
 * A 5xx is reported separately from acceptance. Crashing on a value is a different defect
 * from storing it, and calling a crash "refused" would turn one bug into a pass.
 *
 * This step submits for real. On a form that changes data, an application that does have
 * the defect will write the record — that is what finding it means, and it is the same
 * exposure the engine's double-submit test already carries.
 */
export async function assertServerEnforces(page: Page, value: string | undefined): Promise<void> {
  let check: ServerEnforcementCheck;
  try {
    check = JSON.parse(value ?? '{}') as ServerEnforcementCheck;
  } catch {
    throw new OracleError('assertServerEnforces needs a JSON description of the submission to send.');
  }

  const serialised = await serialiseForm(page, check.form);
  if (serialised === null) {
    throw new OracleError(
      'Could not read the form off the page to send it to the server. The form has to still '
      + 'be present for this check, which is what the preceding rejection step establishes.'
    );
  }

  const fields = new Map(serialised.fields);
  for (const [name, forced] of Object.entries(check.overrides ?? {})) fields.set(name, forced);
  if (fields.size === 0) {
    throw new OracleError('The form carries no named fields, so there is no submission to send.');
  }

  const method = serialised.method.toUpperCase();
  const target = new URL(serialised.action, page.url()).toString();
  const rule = check.rule ? ` The browser refused it because ${check.rule}.` : '';
  const payload = Object.fromEntries(fields);

  // The context's cookies travel with this, so the request is made as the signed-in user
  // and not as an anonymous one. Redirects are not followed: a 302 is part of the answer.
  let response;
  try {
    response = method === 'GET'
      ? await page.request.fetch(withQuery(target, payload), { method, maxRedirects: 0 })
      : await page.request.fetch(target, {
        method,
        maxRedirects: 0,
        ...(serialised.enctype === 'multipart/form-data' ? { multipart: payload } : { form: payload })
      });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new OracleError(
      `Could not reach ${method} ${target} to see whether the server enforces the rule: ${why}`
    );
  }

  const status = response.status();
  const refused = check.refusedStatuses
    ? check.refusedStatuses.includes(status)
    : status >= 400 && status < 500;

  if (refused) return;

  if (status >= 500) {
    const body = (await response.text().catch(() => '')).slice(0, 400);
    throw new OracleError(
      `${method} ${target} answered ${status} rather than refusing the submission.${rule} `
      + 'The server did not accept the value, but it did not reject it either — it failed on '
      + `it, which is its own defect.${body ? ` It replied: ${collapse(body)}` : ''}`
    );
  }

  // 2xx and 3xx both need looking at: plenty of applications answer an invalid form with
  // 200 and the form again, and a 302 back to the form itself is a refusal too.
  const body = await response.text().catch(() => '');
  const location = response.headers()['location'];

  if (firstComplaint(body)) return;
  if (location && sameRoute(location, target)) return;

  throw new OracleError(
    `${method} ${target} accepted the submission: it answered ${status}`
    + `${location ? ` and redirected to ${location}` : ''} with nothing that reads as a `
    + `rejection.${rule} The rule is enforced in the browser and not on the server, so `
    + 'anything that is not a browser can ignore it.'
  );
}

/**
 * Reads a form off the page the way the browser would submit it.
 *
 * Follows the HTML form-submission rules that matter here: disabled controls and unnamed
 * controls are not sent, an unchecked box is not sent, a checked box with no value is sent
 * as "on", a multi-select sends one entry per selection, and a file input cannot be
 * serialised from the DOM at all so its name is sent empty. Hidden inputs are included,
 * which is the whole reason for reading the live form.
 */
export async function serialiseForm(
  page: Page,
  descriptor: LocatorDescriptor | undefined
): Promise<SerialisedForm | null> {
  // Resolved through the platform's own locator grammar, not a raw CSS query. The designer
  // emits whichever strategy discovery chose for the form, which is a test id far more
  // often than a selector, and honouring only CSS meant silently serialising the first
  // form on the page instead of the one named — so on any page with two forms the wrong
  // submission was sent, and a wrong submission gets refused, which this check would have
  // read as the server enforcing the rule.
  const scope = descriptor === undefined ? page.locator('form').first() : buildLocator(page, descriptor);

  return await scope.evaluate((node) => {
    const form = node as HTMLFormElement;
    if (!form || form.tagName.toLowerCase() !== 'form') return null;

    const fields: Array<[string, string]> = [];
    for (const control of Array.from(form.elements)) {
      const element = control as HTMLInputElement & { type: string; name: string; disabled: boolean };
      if (!element.name || element.disabled) continue;

      const type = (element.type ?? '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue;

      if (type === 'checkbox' || type === 'radio') {
        if (element.checked) fields.push([element.name, element.value || 'on']);
        continue;
      }
      if (type === 'file') {
        // The bytes are not reachable from the DOM; the name is still sent.
        fields.push([element.name, '']);
        continue;
      }
      if (element.tagName.toLowerCase() === 'select') {
        const select = control as unknown as HTMLSelectElement;
        for (const option of Array.from(select.selectedOptions)) {
          fields.push([select.name, option.value]);
        }
        continue;
      }
      fields.push([element.name, element.value ?? '']);
    }

    return {
      action: form.getAttribute('action') || window.location.href,
      method: form.getAttribute('method') || 'post',
      enctype: form.getAttribute('enctype') || 'application/x-www-form-urlencoded',
      fields
    };
  }).catch(() => null);
}

/** Appends the fields as a query string, for a form whose method is GET. */
function withQuery(target: string, fields: Record<string, string>): string {
  const url = new URL(target);
  for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
  return url.toString();
}

/**
 * The first thing in a response body that reads as the server objecting.
 *
 * Deliberately narrow. A body is only read as a refusal on wording a server uses to say
 * no, not on the mere presence of the word "error" somewhere in a page of markup — a page
 * with an empty error container would otherwise excuse every acceptance.
 */
export function firstComplaint(body: string): string | undefined {
  if (!body) return undefined;

  // A JSON error envelope: the shape most APIs answer a bad request with.
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      for (const key of ['errors', 'error', 'message', 'detail', 'title', 'validationErrors']) {
        const found = parsed[key];
        if (typeof found === 'string' && found.trim()) return found.trim().slice(0, 200);
        if (found && typeof found === 'object' && Object.keys(found).length > 0) {
          return JSON.stringify(found).slice(0, 200);
        }
      }
    } catch {
      // Not JSON after all; fall through to the markup rules.
    }
  }

  // Markup: an element that carries a complaint, with text in it. The text requirement is
  // the whole point — an empty <div class="error"> is what a healthy page also contains.
  const patterns = [
    /<[^>]*(?:class|id)="[^"]*(?:error|invalid|danger|alert)[^"]*"[^>]*>\s*([^<\s][^<]{2,200}?)\s*</i,
    /<[^>]*role="alert"[^>]*>\s*([^<\s][^<]{2,200}?)\s*</i,
    /\baria-invalid="true"/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (match) return collapse(match[1] ?? 'a field marked invalid');
  }
  return undefined;
}

/** True when a redirect goes back where the submission came from, which is a refusal. */
export function sameRoute(location: string, target: string): boolean {
  try {
    return new URL(location, target).pathname === new URL(target).pathname;
  } catch {
    return false;
  }
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Looks for information carried by colour alone.
 *
 * axe-core does not report this. It checks that colours have enough contrast, which is a
 * different question from whether a colour is the only thing saying what a row is. A table
 * whose status column is a green, amber or red square with no text passes every contrast
 * rule and is unreadable to anyone who cannot distinguish them — about one man in twelve.
 *
 * The test that makes this reliable is variation down a column. A cell with no text and one
 * coloured mark could be a spacer, a bullet or a rule, and flagging it would bury the real
 * findings. The same column carrying two or more different colours across its rows is not
 * decoration: something is being said, and only the colour is saying it. So a column is
 * only reported when its no-text cells disagree about colour.
 *
 * A mark that carries its meaning in text as well is not reported, whether that text is an
 * accessible name, a title, alternative text, an SVG title or visually-hidden content —
 * those are the correct ways to do this and the check must not argue with them.
 */
export async function assertNotColourOnly(page: Page): Promise<void> {
  const findings = await page.evaluate(() => {
    /** Anything that conveys the mark's meaning other than its colour. */
    const hasTextualMeaning = (element: Element): boolean => {
      if ((element.textContent ?? '').trim() !== '') return true;
      for (const node of [element, ...Array.from(element.querySelectorAll('*'))]) {
        const name = node.getAttribute('aria-label') ?? node.getAttribute('title')
          ?? node.getAttribute('alt') ?? node.getAttribute('aria-labelledby');
        if (name && name.trim() !== '') return true;
        if (node.tagName.toLowerCase() === 'svg' && node.querySelector('title')) return true;
      }
      return false;
    };

    /** The colour a mark is drawn in, ignoring anything fully transparent. */
    const markColour = (element: Element): string | null => {
      for (const node of [element, ...Array.from(element.querySelectorAll('*'))]) {
        const style = window.getComputedStyle(node);
        for (const value of [style.backgroundColor, style.borderTopColor, style.color]) {
          if (!value) continue;
          if (value === 'transparent' || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(value)) continue;
          // A background the page already uses everywhere is not a mark.
          if (value === 'rgba(0, 0, 0, 0)') continue;
          if (style.backgroundColor === value) return value;
        }
      }
      return null;
    };

    const reports: Array<{ table: string; column: number; colours: string[]; header: string }> = [];

    document.querySelectorAll('table').forEach((table, tableIndex) => {
      const rows = Array.from(table.querySelectorAll('tbody tr, tr'));
      /** Column index → the distinct colours its text-free cells are drawn in. */
      const byColumn = new Map<number, Set<string>>();

      for (const row of rows) {
        Array.from(row.children).forEach((cell, column) => {
          const tag = cell.tagName.toLowerCase();
          if (tag !== 'td' && cell.getAttribute('role') !== 'cell'
            && cell.getAttribute('role') !== 'gridcell') return;
          if (hasTextualMeaning(cell)) return;
          if (cell.children.length === 0) return;   // a genuinely empty cell says nothing

          const colour = markColour(cell);
          if (colour === null) return;
          if (!byColumn.has(column)) byColumn.set(column, new Set());
          byColumn.get(column)!.add(colour);
        });
      }

      const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th'))
        .map(cell => (cell.textContent ?? '').trim());

      for (const [column, colours] of byColumn) {
        // One colour is decoration. Two or more is data.
        if (colours.size < 2) continue;
        reports.push({
          table: table.getAttribute('id') ?? table.getAttribute('data-testid') ?? `table ${tableIndex + 1}`,
          column: column + 1,
          colours: Array.from(colours),
          header: headers[column] ?? ''
        });
      }
    });

    return reports;
  });

  if (findings.length === 0) return;

  const described = findings.map(finding =>
    `${finding.table}, column ${finding.column}${finding.header ? ` ("${finding.header}")` : ''} `
    + `uses ${finding.colours.length} colours (${finding.colours.join(', ')}) with no text in any of those cells`
  );

  throw new OracleError(
    `Information is carried by colour alone: ${described.join('; ')}. The cells differ only `
    + 'in colour, so what they say is unavailable to anyone who cannot tell those colours '
    + 'apart. Add text, an aria-label, a title or visually-hidden content to each mark.'
  );
}
