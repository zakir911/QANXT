import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import type { ConsoleEventReport, NetworkEventReport } from '@qa-nxt/shared-types';

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
  /** The URL the most recent navigate step landed on. */
  urlAtLastNavigation(): string | undefined;
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
  const accepted = (s: FormSignals) => (s.successTexts.length > 0 || !s.formPresent)
    && s.invalidFields.length === 0 && s.errorTexts.length === 0;
  const result = await poll(timeoutMs, () => signals(page, form), accepted);

  await obs.settle();
  const crashed = serverErrorsSince(obs.network().slice(obs.networkMarkAtLastNavigation()));
  if (crashed.length > 0) {
    throw new OracleError(`Expected the submission to be accepted, but the server failed: `
      + `${crashed[0]!.method} ${crashed[0]!.url} returned HTTP ${crashed[0]!.statusCode}.`);
  }
  if (accepted(result)) return;
  throw new OracleError(`Expected the submission to be accepted, but ${describe(result)}.`);
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
  /** "navigation" (default): since the test's last navigate step. "test": the whole test. */
  scope?: 'navigation' | 'test';
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
  const events = expectation.scope === 'test' ? obs.network() : obs.network().slice(obs.networkMarkAtLastNavigation());
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
