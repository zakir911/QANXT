import type { Page } from 'playwright';
import type { LocatorDescriptor } from '@qa-nxt/shared-types';
import { buildLocator } from '../browser/locator-resolver.js';
import {
  InconclusiveError, OracleError, collapse, firstComplaint, sameRoute, serialiseForm
} from './form-oracles.js';

/**
 * The authorization and state oracles: whether the rules a page draws are rules the server
 * keeps.
 *
 * Both of these ask the same question `assertServerEnforces` asks about validation, about
 * two other things an application is just as likely to implement in the markup alone.
 *
 * A control that is not drawn is not a permission. Omitting a Settle button from a viewer's
 * page is presentation; it stops nobody who can open a terminal, replay a request or edit
 * the DOM, and the handler behind it is frequently checking only that somebody is signed
 * in. A state machine enforced by which buttons are drawn has exactly the same hole: a
 * declaration customs has rejected can still be released by anyone who sends the request.
 *
 * Neither is reachable by a suite built from what a page shows, because the whole defect is
 * that the page shows nothing. The request has to be made directly, and these two steps are
 * the only places in the engine that do that on the strength of what is *missing*.
 */

/** A request to make directly, as the signed-in identity, with no browser in the way. */
export interface DirectRequest {
  method?: string;
  url: string;
  fields?: Record<string, string>;
}

export interface HiddenMeansForbiddenCheck {
  /** The control this identity does not have. Its absence is the premise. */
  control?: LocatorDescriptor;
  /**
   * The form to read the submission off, when the form is on the page and only its control
   * is withheld. Preferred over `request`: a submission rebuilt from the plan omits the
   * fields the planner never modelled, an anti-forgery token above all, and a request
   * refused for a missing token reads here as the server enforcing the permission — which
   * would turn the defect being looked for into a pass.
   */
  form?: LocatorDescriptor;
  /** Used when there is no form to read, so the request has to be described. */
  request?: DirectRequest;
  /** What the control would have done, quoted into the failure. */
  capability?: string;
}

export interface StateForbidsActionCheck {
  /** The state the entity must be in for the question to mean anything. */
  state: string;
  /** Where to read the state. Defaults to anywhere on the page. */
  shownIn?: LocatorDescriptor;
  /** The form to read the submission off, preferred over `request` for the same reason. */
  form?: LocatorDescriptor;
  request?: DirectRequest;
  /** What the request would do, quoted into the failure. */
  action?: string;
}

/** What the server did with a request it should have refused. */
interface Verdict {
  refused: boolean;
  status: number;
  location?: string;
  body: string;
  target: string;
  method: string;
}

/**
 * Field names that carry an anti-forgery token.
 *
 * Collected and resent because a request that omits one is refused for the wrong reason,
 * and a refusal for the wrong reason reads here as the server enforcing the rule — turning
 * the defect being looked for into a pass. This is the same trap `assertServerEnforces`
 * avoids by serialising the live form; here there is no form to serialise, because the
 * control is missing, so the token is gathered from the page instead.
 */
const TOKEN_FIELD = /token|csrf|xsrf|verification|authenticity|nonce/i;

async function antiForgeryFields(page: Page): Promise<Record<string, string>> {
  return await page.evaluate((pattern) => {
    const matcher = new RegExp(pattern, 'i');
    const found: Record<string, string> = {};

    document.querySelectorAll('input[type="hidden"][name]').forEach(node => {
      const input = node as HTMLInputElement;
      if (matcher.test(input.name) && input.value) found[input.name] = input.value;
    });

    // The meta-tag convention, which several frameworks use in place of a hidden field.
    document.querySelectorAll('meta[name][content]').forEach(node => {
      const meta = node as HTMLMetaElement;
      if (matcher.test(meta.name) && meta.content) found[meta.name] = meta.content;
    });

    return found;
  }, TOKEN_FIELD.source);
}

/**
 * Sends a request the application should refuse, and says what it did instead.
 *
 * The context's cookies travel with it, so this is the signed-in identity rather than an
 * anonymous one — which is the whole point: an anonymous refusal proves nothing about
 * whether a signed-in user without the permission is stopped. Redirects are not followed,
 * because a 302 is part of the answer.
 */
async function send(
  page: Page,
  form: LocatorDescriptor | undefined,
  request: DirectRequest | undefined
): Promise<Verdict> {
  const live = form === undefined ? null : await serialiseForm(page, form);

  if (live === null && request?.url === undefined) {
    throw new OracleError(
      'There is nothing to send: the form named is not on the page and no request was '
      + 'described. This check cannot be answered without one of them, and answering it '
      + 'from a guess would be worse than not answering it.'
    );
  }

  const method = (live?.method ?? request?.method ?? 'POST').toUpperCase();
  const target = new URL(live?.action ?? request!.url, page.url()).toString();
  const fields = {
    ...await antiForgeryFields(page),
    ...Object.fromEntries(live?.fields ?? []),
    ...(request?.fields ?? {})
  };

  let response;
  try {
    response = method === 'GET' || method === 'HEAD'
      ? await page.request.fetch(withQuery(target, fields), { method, maxRedirects: 0 })
      : await page.request.fetch(target, { method, maxRedirects: 0, form: fields });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new OracleError(`Could not reach ${method} ${target} to see whether it is refused: ${why}`);
  }

  const status = response.status();
  const body = await response.text().catch(() => '');
  const location = response.headers()['location'];

  // Any 4xx is a refusal: the server said no, whatever word it chose. A 5xx is not — it
  // failed on the request rather than declining it, which is reported separately below.
  const refused = (status >= 400 && status < 500)
    || Boolean(firstComplaint(body))
    || (location !== undefined && (sameRoute(location, target) || looksLikeSignIn(location)));

  return { refused, status, body, target, method, ...(location ? { location } : {}) };
}

/** A redirect to somewhere that asks for credentials is a refusal, not an acceptance. */
function looksLikeSignIn(location: string): boolean {
  return /\/(sign-?in|log-?in|auth|account\/login|unauthori[sz]ed|forbidden|denied)\b/i.test(location);
}

function withQuery(target: string, fields: Record<string, string>): string {
  const url = new URL(target);
  for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
  return url.toString();
}

/** The common tail of both oracles: a 5xx is its own defect, and acceptance is the finding. */
function reportNotRefused(verdict: Verdict, what: string, because: string): never {
  if (verdict.status >= 500) {
    throw new OracleError(
      `${verdict.method} ${verdict.target} answered ${verdict.status} rather than refusing ${what}. `
      + 'The server did not allow the request, but it did not decline it either — it failed on '
      + `it, which is its own defect.${verdict.body ? ` It replied: ${collapse(verdict.body.slice(0, 300))}` : ''}`
    );
  }

  throw new OracleError(
    `${verdict.method} ${verdict.target} accepted ${what}: it answered ${verdict.status}`
    + `${verdict.location ? ` and redirected to ${verdict.location}` : ''} with nothing that `
    + `reads as a refusal. ${because}`
  );
}

/**
 * Asks whether a control this identity cannot see is also refused by the server.
 *
 * The premise is the absence. The step is emitted where discovery recorded a control that
 * this identity does not get, and it begins by confirming that the control is in fact
 * missing or disabled — because if it has become available, the question has changed and
 * answering the old one would be meaningless.
 *
 * Then the request the control would have made is sent directly, carrying the session's own
 * cookies and any anti-forgery token the page holds. A refusal of any kind passes. Anything
 * that reads as acceptance is the finding: the permission exists in the page and nowhere
 * else, so every client that is not this page has it.
 *
 * This submits for real. An application that does have the defect will perform the action —
 * that is what finding it means, and it is why the designer only emits this against an
 * environment that allows mutating tests.
 */
export async function assertHiddenMeansForbidden(page: Page, value: string | undefined): Promise<void> {
  const check = parse<HiddenMeansForbiddenCheck>(value, 'assertHiddenMeansForbidden');
  if (check.form === undefined && check.request?.url === undefined) {
    throw new OracleError(
      'assertHiddenMeansForbidden needs either the form to read the submission off or the '
      + 'request the withheld control would have made.');
  }

  if (check.control) {
    const control = buildLocator(page, check.control);
    const available = await control.first().isVisible().catch(() => false)
      && await control.first().isEnabled().catch(() => false);

    if (available) {
      // The premise is the absence, and the absence is gone. The application has not
      // misbehaved — this step simply has nothing left to ask, so it reaches no conclusion
      // rather than blaming the application for a question that no longer applies.
      throw new InconclusiveError(
        'Not evaluated: this check asks whether a control this identity cannot use is also '
        + 'refused by the server, but the control is visible and enabled on the page, so the '
        + 'premise no longer holds. Either the permission has changed or the test is pointed '
        + 'at the wrong identity; re-generate it rather than reading this as a result.'
      );
    }
  }

  const verdict = await send(page, check.form, check.request);
  if (verdict.refused) return;

  const capability = check.capability ? ` to ${check.capability}` : '';
  reportNotRefused(verdict, `a request this identity has no control${capability}`,
    'The control is hidden from this identity and the request behind it is not refused, so '
    + 'the permission is enforced in the page and nowhere else: anyone who can send the '
    + 'request has it, whatever the page draws.');
}

/**
 * Asks whether an entity in a terminal state refuses an action that would move it on.
 *
 * Same shape, different premise. A cancelled order that can still be dispatched, or a
 * rejected declaration that can still be released, is a state machine implemented by
 * hiding buttons — and the page hiding them is exactly why no generated test notices.
 *
 * The state is confirmed on the page first. A check that fires against an entity which is
 * not in that state is answering a different question, and its answer would be noise.
 */
export async function assertStateForbidsAction(page: Page, value: string | undefined): Promise<void> {
  const check = parse<StateForbidsActionCheck>(value, 'assertStateForbidsAction');
  if (!check.state || (check.form === undefined && check.request?.url === undefined)) {
    throw new OracleError(
      'assertStateForbidsAction needs the state to confirm, and either the form to read the '
      + 'submission off or the request to try.');
  }

  const scope = check.shownIn ? buildLocator(page, check.shownIn).first() : page.locator('body');
  const shown = await scope.innerText({ timeout: 5_000 }).catch(() => '');

  if (!new RegExp(`\\b${escapeForRegExp(check.state)}\\b`, 'i').test(shown)) {
    // Same reasoning as the withheld control above: an unconfirmed premise is not a defect.
    // Reporting it as one would blame the application for the state of its own test data.
    throw new InconclusiveError(
      `Not evaluated: this check asks whether an action is refused while the record is `
      + `${check.state}, but the page does not say it is ${check.state}. The record has moved `
      + 'on, or the state is shown somewhere this step does not look; either way the question '
      + 'this step asks is not the one it would be answering.'
    );
  }

  const verdict = await send(page, check.form, check.request);
  if (verdict.refused) return;

  const action = check.action ? `a request to ${check.action}` : 'the request';
  reportNotRefused(verdict, `${action} on a record that is ${check.state}`,
    `The record is ${check.state} and the transition is still accepted, so the state is `
    + 'enforced by which controls the page draws rather than by the handler: anything that '
    + 'sends the request can move the record on from a state it should not leave.');
}

function parse<T>(value: string | undefined, verb: string): T {
  try {
    return JSON.parse(value ?? '{}') as T;
  } catch {
    throw new OracleError(`${verb} needs a JSON description of what to check.`);
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
