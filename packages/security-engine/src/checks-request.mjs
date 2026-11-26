/**
 * Request-level flaws: CSRF, file upload, open redirect and SSRF.
 *
 * What these have in common is that the application is being asked to trust something it
 * should not — a request's origin, a file's name, a redirect target, a URL to fetch.
 *
 * Safety, check by check:
 *
 *   CSRF     sends the application's own state-changing request, once, with the same body
 *            a legitimate caller would send. It changes whatever that endpoint changes.
 *            Declared state-changing so the scope guard governs it.
 *   upload   sends metadata describing a file. It does not send an executable, a script,
 *            a web shell or a polyglot, and the "oversized" probe declares a size rather
 *            than transferring one — a scanner that uploads a gigabyte to test a size
 *            limit is running a load test.
 *   redirect never follows the Location it is given. The finding is that the header names
 *            an external host; going there is not part of establishing that.
 *   SSRF     asks the application to fetch a loopback address by default. The metadata
 *            endpoints (169.254.169.254 and friends) are behind an explicit opt-in and are
 *            off unless someone has turned them on, because the brief forbids reaching
 *            cloud metadata or internal infrastructure by default — and because a scanner
 *            that quietly pulls credentials out of an instance profile has done real harm
 *            in the course of proving it could.
 */
import { SECURITY_RISK } from './scope-guard.mjs';
import { SeverityFactors, confidenceFrom } from './severity.mjs';
import { authHeaders, isSignedIn } from './credentials.mjs';
import { at } from './target-url.mjs';

/** A host that exists to be recognised in a Location header and is never visited. */
const EXTERNAL_MARKER_HOST = 'qanxt-redirect-probe.invalid';

/**
 * Whether a state-changing request was accepted, judged from the answer.
 *
 * ## Why a status code is not the answer
 *
 * These checks used `status >= 400` as the whole test. On a JSON API that is right. On an
 * application rendered on the server it is wrong in the worst direction, because the ordinary
 * way such an application refuses is to answer 302 and show the form again:
 *
 *     POST /claims/new   (no token)   ->   302   location: /claims/new
 *
 * Nothing was created. 302 is under 400, so both the control and the probe "succeeded
 * identically" and the finding was raised. Measured on a 137-screen application that carries
 * and enforces an anti-forgery token on its forms, that produced 54 endpoints' worth —
 * 108 findings with the origin check included, 38% of everything the scan reported, every one
 * of them false.
 *
 * ## What is judged instead
 *
 * Where the answer went, which is what distinguishes the two cases:
 *
 *   - 4xx and 5xx: refused, as before.
 *   - 3xx back to the address posted to: the form being re-shown, which is a refusal. This is
 *     the case that was inverted.
 *   - 3xx to a sign-in: refused.
 *   - 3xx onward to somewhere else: accepted. A form that saves redirects to what it saved,
 *     which is the POST-redirect-GET pattern working.
 *   - 2xx: accepted.
 *
 * The product already judged this correctly one layer away. Its form engine reports "it
 * answered 302 and redirected to /x with nothing that reads as a rejection" — where it went,
 * and whether a rejection is visible. This is that reasoning, brought to the checks that
 * needed it.
 *
 * @returns {{accepted: boolean, how: string}}
 */
export function stateChangeAccepted(response, requestedPath) {
  const status = Number(response?.status ?? 0);

  if (status >= 400) return { accepted: false, how: `answered ${status}` };

  if (status >= 300 && status < 400) {
    const location = String(
      response?.headers?.get?.('location')
      ?? response?.headers?.location
      ?? '');

    if (location === '') {
      // A redirect with nowhere to go settles nothing, and calling it acceptance is the
      // mistake this function exists to avoid.
      return { accepted: false, how: `answered ${status} with no Location` };
    }
    if (/sign-?in|log-?in|auth\/|session/i.test(location)) {
      return { accepted: false, how: `redirected to ${location}, which asks for credentials` };
    }
    // An error page is a refusal that happens to redirect onward, so "onward" alone is not
    // acceptance. Without this, an application that answers a rejected write with
    // `302 -> /error` reads exactly like one that saved the record and redirected to it.
    //
    // Two patterns rather than one, because the boundaries differ and conflating them breaks
    // real records. A word may follow a hyphen — `/access-denied` is an error page — but a
    // status code may not: `/claims/clm-403` is a claim, and a rule that read it as an error
    // page would turn a real finding into silence.
    if (/(^|[/-])(error|errors|forbidden|denied|unauthoriz\w*|unauthoris\w*)([/?]|$)/i.test(location)
        || /(^|\/)(40[13]|500|not-?allowed)([/?]|$)/i.test(location)) {
      return { accepted: false, how: `redirected to ${location}, which is an error page` };
    }
    if (samePathAs(location, requestedPath)) {
      return {
        accepted: false,
        how: `redirected back to ${location}, which is how a form is shown again after a refusal`
      };
    }
    return { accepted: true, how: `redirected onward to ${location}` };
  }

  return { accepted: true, how: `answered ${status}` };
}

/** Whether a Location names the same path that was requested, ignoring host and query. */
function samePathAs(location, requestedPath) {
  const pathOf = (value) => {
    try {
      return new URL(value, 'http://placeholder.invalid').pathname.replace(/\/+$/, '');
    } catch {
      return String(value ?? '').split('?')[0]?.replace(/\/+$/, '') ?? '';
    }
  };
  const a = pathOf(location);
  const b = pathOf(requestedPath);
  return a !== '' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Missing anti-CSRF token: a state-changing request succeeds without one.
 *
 * The control matters as much as the claim. An endpoint that refuses the request with a
 * token as well proves nothing, and this reports inconclusive rather than calling it safe.
 */
/**
 * Whether a state-changing request changed anything, or just got the application's shell back.
 *
 * `stateChangeAccepted` reads the status and the redirect, which is enough on an application
 * that answers 404 or 405 to an address it does not serve. A single-page application does not:
 * clinic-spa serves its shell, 200 and HTML, for every path and every method it has no handler
 * for, because that is how client-side routing works. So a POST to `/` answered 200, the
 * control looked accepted, the probe without a token answered 200 too, and the check reported
 * *"A state-changing request succeeds with no anti-CSRF token"* about an address that does
 * nothing at all. Three findings on clinic-spa were that, and on any such application every
 * address with no handler would produce the same.
 *
 * A GET of the same address settles it. If the state-changing response is byte-identical to
 * what simply reading the address returns, nothing was changed and there is no state change to
 * defend. The test is deliberately strict — identical, not merely similar — because a real
 * change almost always shows: different JSON, a redirect, a changed page, a message. The cost
 * is one GET, and only once a finding is otherwise about to be founded.
 *
 * Contrast the endpoint this must not suppress: `/api/appointments/apt-1/cancel` has no GET
 * handler, so reading it returns clinic-spa's shell while the POST returns the cancelled
 * appointment as JSON. Different, so the finding stands — correctly, because that endpoint
 * really does accept a cookie-authorised POST with no token.
 */
/**
 * Where a redirect actually led, read rather than inferred from its Location.
 *
 * `stateChangeAccepted` distinguishes "redirected back to the form" from "redirected onward",
 * which is right for an application that shows the form again when it refuses. Plenty do not.
 * Freight's shipment edit answers a refusal with a flash message and a redirect to the record:
 *
 *     POST /shipments/shp-0005/edit   bad token   ->  302  location: /shipments/shp-0005
 *     POST /shipments/shp-0005/edit   real token  ->  302  location: /shipments/shp-0005
 *
 * Identical. Nothing was written in the first case — the endpoint enforces its token
 * properly — and the only place the application says so is the page the redirect leads to,
 * where the flash sits. Judged on the header alone, both arms read as accepted and the check
 * reports a missing anti-forgery token on an endpoint that has one.
 *
 * Measured: with a request body finally being sent (defect 82), that single pattern produced
 * 20 false MissingCsrfToken findings and 20 false PrivilegeEscalation findings on freight in
 * one run. So the redirect is followed, once per arm, and what the application says when it
 * gets there is the evidence.
 */
export async function arrivedAt(scanner, response, { baseUrl, session, testId, as }) {
  const status = Number(response?.status ?? 0);
  if (status < 300 || status >= 400) return null;
  const location = String(
    response?.headers?.get?.('location')
    ?? response?.headers?.location
    ?? response?.responseHeaders?.location
    ?? ''
  ).trim();
  if (location === '') return null;

  let url;
  try { url = new URL(location, baseUrl).href; } catch { return null; }

  const read = await scanner.request({
    url, method: 'GET', risk: SECURITY_RISK.PASSIVE,
    headers: { ...authHeaders(session) },
    as, testId: `${testId}:arrived`,
    note: 'the page the redirect led to, because an application that redirects to the same '
      + 'place whether it accepted or refused says which one in the page'
  });
  if (!read.allowed) return null;
  const body = typeof read.responseText === 'string' ? read.responseText : null;
  return body === null ? null : { url, body };
}

/**
 * Whether an alert on a page belongs to the page rather than to either request.
 *
 * An application's flash message is consumed when it is read: it is about the request that
 * set it and it is gone next time. A banner the page always carries — a stale-rates notice, a
 * maintenance warning — is still there. One more read tells them apart, and nothing else can:
 * from a single page the two look identical.
 *
 * Only asked when both arms landed on the same page *and* that page carries an alert, so it
 * costs one request in the one case where it decides something.
 */
export async function theAlertIsThePagesOwn(scanner, landing, { session, testId, alert }) {
  if (!landing?.url) return false;
  const again = await scanner.request({
    url: landing.url, method: 'GET', risk: SECURITY_RISK.PASSIVE,
    headers: { ...authHeaders(session) },
    as: 'the legitimate caller', testId: `${testId}:again`,
    note: 'reading the same page a second time, because a flash message about a request is '
      + 'consumed when it is read and a banner the page always carries is not'
  });
  if (!again.allowed || typeof again.responseText !== 'string') return false;
  return alertsIn(again.responseText).includes(alert);
}

/** The text of anything on the page that reads as an error the application is reporting. */
function alertsIn(html) {
  if (typeof html !== 'string') return [];
  const found = [];
  const pattern = /(?:role=["']alert["']|class=["'][^"']*(?:\berror\b|\balert-danger\b|\balert-error\b|\bflash-error\b|\binvalid-feedback\b)[^"']*["'])[^>]*>\s*([^<]{1,300})/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const text = match[1].replace(/\s+/g, ' ').trim();
    if (text !== '') found.push(text);
  }
  return found;
}

/**
 * Whether the application treated the two requests differently, read from where each landed.
 *
 * Three answers, and the third one matters: a page that differs for a reason this cannot
 * attribute is not evidence either way, and saying so beats both reporting a finding and
 * reporting none.
 */
export function distinguishedTheTwo(controlPage, probePage) {
  if (typeof controlPage !== 'string' || typeof probePage !== 'string') return { known: false };

  // The control has to have been *accepted* before the probe means anything, and an
  // application that answers a refusal with a redirect to the record has not said so in
  // anything `stateChangeAccepted` can see. It said so on the page it redirected to.
  //
  // This is the case that produced ten false findings on freight: the scan held no
  // anti-forgery token for an application that serves its token as a hidden input, so the
  // control was refused exactly like the probe, both landed on "That form expired.", the two
  // pages were identical — and identical was read as "the application did not distinguish
  // them", which is true and not the point.
  const onTheControl = alertsIn(controlPage);
  if (onTheControl.length > 0 && controlPage === probePage) {
    return { known: true, sameWithAnAlert: true, alert: onTheControl[0],
             how: `the application answered "${onTheControl[0]}" to both` };
  }

  if (controlPage === probePage) return { known: true, refused: false };

  const probeAlerts = alertsIn(probePage);
  const controlAlerts = new Set(alertsIn(controlPage));
  const onlyOnTheProbe = probeAlerts.filter(text => !controlAlerts.has(text));
  if (onlyOnTheProbe.length > 0) {
    return { known: true, refused: true, how: `the application answered "${onlyOnTheProbe[0]}"` };
  }
  return { known: false, differedAnyway: true };
}

export async function changedNothing(scanner, { baseUrl, path, response, session, testId }) {
  const read = await scanner.request({
    url: at(baseUrl, `${path}`), method: 'GET', risk: SECURITY_RISK.PASSIVE,
    headers: { ...authHeaders(session) },
    as: 'the legitimate caller', testId: `${testId}:read`,
    note: 'reading the address, to tell a state change from the application answering its shell'
  });
  if (!read.allowed) return null;
  if (Number(read.status) !== Number(response.status)) return null;

  const bodyOf = (result) => typeof result?.responseBody === 'string'
    ? result.responseBody
    : result?.responseBody === undefined ? null : JSON.stringify(result.responseBody);
  const left = bodyOf(response);
  const right = bodyOf(read);
  if (left === null || right === null || left !== right) return null;
  // An empty body on both sides is not evidence of anything. A 204, or a 302 whose body is
  // empty as most are, would otherwise compare equal to an empty read and have its finding
  // withdrawn on the strength of two blanks.
  if (left.trim() === '') return null;

  return `Not evaluated: this address answers exactly the same ${left.length}-byte response to a `
    + `plain GET as it does to the state-changing request — status ${response.status} both times, `
    + 'byte for byte. So the request changed nothing, and there is no state change here for an '
    + 'anti-forgery control to defend. A single-page application answers its shell this way for '
    + 'every address it has no handler for.';
}

/**
 * What was sent, in the terms a reader can check against their own application.
 *
 * An inconclusive reason that does not say what shape the request had cannot be acted on: the
 * reader has no way to tell "my endpoint wants a field you did not send" from "my endpoint
 * refuses JSON" from "my endpoint wants the token somewhere else".
 */
function describeShape(fields, contentType, tokenField) {
  const names = Object.keys(fields ?? {});
  const type = /x-www-form-urlencoded/i.test(String(contentType ?? ''))
    ? 'a urlencoded form body' : 'a JSON body';
  const carried = names.length === 0
    ? 'no fields, because none were discovered for this address'
    : `the field(s) ${names.join(', ')}`;
  const where = tokenField
    ? `, with the token in the ${tokenField} field and in a header`
    : ', with the token in a header only, because no form declared a token field here';
  return `${type} carrying ${carried}${where}`;
}

/**
 * Encode a body the way the application's own page would send it.
 *
 * `scanner.request` sends a string unchanged and JSON-encodes anything else, which is right
 * for an API and wrong for a form. A server that binds `application/x-www-form-urlencoded`
 * reads nothing out of a JSON document, so a request shaped as JSON is refused by the
 * application's own field validation rather than by any anti-forgery control — and a refusal
 * for that reason is not evidence about anything these checks are asking.
 */
export function encodeBody(fields, contentType) {
  if (!/x-www-form-urlencoded/i.test(String(contentType ?? ''))) return fields;
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (value === undefined || value === null) continue;
    form.append(name, String(value));
  }
  return form.toString();
}

/**
 * The anti-forgery token where the application's own page carries it.
 *
 * A form declares its token as a hidden field, and a server that reads it from the body will
 * not look in a header. So the control request puts it in both places; the probe puts it in
 * neither, and is stripped of the field even if a caller passed one in the sample. The two
 * requests then differ by the token alone, which is the whole premise of the check.
 */
function tokenPlacement(body, tokenField, token) {
  const without = { ...(body ?? {}) };
  if (tokenField) delete without[tokenField];
  const with_ = tokenField && token !== undefined && token !== null
    ? { ...without, [tokenField]: token }
    : without;
  return { with: with_, without };
}

export async function checkCsrfToken(scanner, { baseUrl, path, session, body = {},
    contentType = 'application/json', tokenHeader = 'x-csrf-token', tokenField = null,
    testId = 'SECA-CSRF' }) {
  if (!isSignedIn(session)) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: 'No authenticated session, so a cross-site request cannot be distinguished from an '
               + 'unauthenticated one.' };
  }

  const placed = tokenPlacement(body, tokenField, session.csrf);
  const withToken = await scanner.request({
    url: at(baseUrl, `${path}`), method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: {
      'content-type': contentType, ...authHeaders(session),
      origin: baseUrl, ...(session.csrf ? { [tokenHeader]: session.csrf } : {})
    },
    body: encodeBody(placed.with, contentType),
    as: 'the legitimate caller', testId: `${testId}:control`,
    note: 'the request as the application\'s own page would send it'
  });
  if (!withToken.allowed) return { skipped: true, decision: withToken.decision, findings: [] };

  const control = stateChangeAccepted(withToken, path);
  if (!control.accepted) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `Not evaluated: the endpoint did not accept the request even with a token and a `
               + `same-site origin — it ${control.how}. Nothing can be concluded about what it does `
               + `without one. What was sent: ${describeShape(placed.with, contentType, tokenField)}.` };
  }

  // Only now that the control is known to have been accepted: a refused control makes the
  // probe, and this read, not worth sending.
  const controlLanded = await arrivedAt(
    scanner, withToken, { baseUrl, session, testId, as: 'the legitimate caller' });

  const withoutToken = await scanner.request({
    url: at(baseUrl, `${path}`), method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { 'content-type': contentType, ...authHeaders(session), origin: baseUrl },
    body: encodeBody(placed.without, contentType),
    as: 'a caller with no anti-CSRF token', testId: `${testId}:no-token`,
    note: 'the same request with the anti-CSRF token removed'
  });
  if (!withoutToken.allowed) return { skipped: true, decision: withoutToken.decision, findings: [] };

  const probe = stateChangeAccepted(withoutToken, path);
  if (!probe.accepted) {
    return { skipped: false, findings: [], ok: true,
             detail: `with a token it ${control.how}; without one it ${probe.how}` };
  }

  // Both redirected onward, which on plenty of applications is what a refusal looks like
  // too. Read where each one landed before founding anything on the header alone.
  const probeLanded = await arrivedAt(
    scanner, withoutToken, { baseUrl, session, testId, as: 'a caller with no anti-CSRF token' });
  const difference = distinguishedTheTwo(controlLanded?.body, probeLanded?.body);
  if (difference.sameWithAnAlert
      && !await theAlertIsThePagesOwn(
           scanner, probeLanded, { session, testId, alert: difference.alert })) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `Not evaluated: the request with a token was refused too — ${difference.how}. `
               + `The endpoint answered both the same way and redirected both to the same place, `
               + `so nothing here distinguishes a missing token from a request this scan could `
               + `not make properly. What was sent: `
               + `${describeShape(placed.with, contentType, tokenField)}.` };
  }
  if (difference.known && difference.refused) {
    return { skipped: false, findings: [], ok: true,
             detail: `both requests redirected to the same address, but the one without a token `
               + `was refused there: ${difference.how}` };
  }
  if (difference.differedAnyway) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: 'Not evaluated: both requests were accepted and both redirected to the same '
               + 'address, but the page they led to is not the same for each, and the difference '
               + 'is not an error the application is reporting. That may be a refusal this check '
               + 'cannot read, or a page that simply varies. Founding a missing-token finding on '
               + 'it would be guessing.' };
  }

  // Both answered. Before founding a finding, establish that either answer was a change at
  // all: an address with no handler for this method answers the application's shell to
  // anything, and two identical shells are not a control group.
  const nothingChanged = await changedNothing(
    scanner, { baseUrl, path, response: withToken, session, testId });
  if (nothingChanged !== null) {
    return { skipped: false, findings: [], inconclusive: true, reason: nothingChanged };
  }

  return {
    skipped: false,
    findings: [{
      category: 'MissingCsrfToken',
      title: 'A state-changing request succeeds with no anti-CSRF token',
      endpoint: path, httpMethod: 'POST', observedAsRole: 'authenticated session, no token',
      description: `The request was accepted with a token — it ${control.how} — and accepted the same `
        + `way without one: it ${probe.how}. The session cookie alone is enough to authorise the change.`,
      impact: 'Any site the user visits while signed in can make this request on their behalf.',
      remediation: 'Require a per-session anti-CSRF token on every state-changing request, or set the '
        + 'session cookie SameSite=Strict and validate Origin.',
      cwe: 'CWE-352', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('straightforward', 'serious', 'none', 'personalData', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [withToken, withoutToken]
    }]
  };
}

/** Missing origin validation: a cross-origin Origin header is accepted. */
export async function checkOriginValidation(scanner, { baseUrl, path, session, body = {},
    contentType = 'application/json', tokenHeader = 'x-csrf-token', tokenField = null,
    testId = 'SECA-ORIGIN' }) {
  if (!isSignedIn(session)) {
    return { skipped: false, findings: [], inconclusive: true, reason: 'No authenticated session.' };
  }

  const headers = {
    'content-type': contentType, ...authHeaders(session),
    ...(session.csrf ? { [tokenHeader]: session.csrf } : {})
  };
  // The token belongs in both arms: the origin is the only thing that differs between them,
  // so an endpoint that reads the token from the body must be given it in both or the
  // comparison is measuring two things at once.
  const sent = encodeBody(tokenPlacement(body, tokenField, session.csrf).with, contentType);

  const sameOrigin = await scanner.request({
    url: at(baseUrl, `${path}`), method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { ...headers, origin: baseUrl }, body: sent,
    as: 'same-origin', testId: `${testId}:control`, note: 'the request with the application\'s own origin'
  });
  if (!sameOrigin.allowed) return { skipped: true, decision: sameOrigin.decision, findings: [] };
  const fromOwnOrigin = stateChangeAccepted(sameOrigin, path);
  if (!fromOwnOrigin.accepted) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `Not evaluated: the endpoint did not accept a request from its own origin — it `
               + `${fromOwnOrigin.how}. What it does with another origin's cannot be read against `
               + `that. What was sent: `
               + `${describeShape(tokenPlacement(body, tokenField, session.csrf).with, contentType, tokenField)}.` };
  }

  const ownLanded = await arrivedAt(
    scanner, sameOrigin, { baseUrl, session, testId, as: 'same-origin' });

  const crossOrigin = await scanner.request({
    url: at(baseUrl, `${path}`), method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { ...headers, origin: `https://${EXTERNAL_MARKER_HOST}` }, body: sent,
    as: 'cross-origin', testId: `${testId}:cross`,
    note: `the same request claiming to come from ${EXTERNAL_MARKER_HOST}, a host that does not resolve`
  });
  if (!crossOrigin.allowed) return { skipped: true, decision: crossOrigin.decision, findings: [] };

  const fromElsewhere = stateChangeAccepted(crossOrigin, path);
  if (!fromElsewhere.accepted) {
    return { skipped: false, findings: [], ok: true,
             detail: `from its own origin it ${fromOwnOrigin.how}; from another it ${fromElsewhere.how}` };
  }

  const elsewhereLanded = await arrivedAt(
    scanner, crossOrigin, { baseUrl, session, testId, as: 'cross-origin' });
  const originDifference = distinguishedTheTwo(ownLanded?.body, elsewhereLanded?.body);
  if (originDifference.sameWithAnAlert
      && !await theAlertIsThePagesOwn(
           scanner, elsewhereLanded, { session, testId, alert: originDifference.alert })) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `Not evaluated: the request from the application's own origin was refused `
               + `too — ${originDifference.how}. What another origin does cannot be read against `
               + 'a control that was not accepted.' };
  }
  if (originDifference.known && originDifference.refused) {
    return { skipped: false, findings: [], ok: true,
             detail: `both requests redirected to the same address, but the one claiming another `
               + `origin was refused there: ${originDifference.how}` };
  }
  if (originDifference.differedAnyway) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: 'Not evaluated: both requests were accepted and both redirected to the same '
               + 'address, but the page they led to is not the same for each, and the difference '
               + 'is not an error the application is reporting. Founding a missing-origin-check '
               + 'finding on it would be guessing.' };
  }

  // The same premise this check shares with the anti-forgery one: an address with no handler
  // for this method answers the application's shell whatever origin is claimed, and accepting
  // a shell from anywhere is not a missing origin check.
  const nothingChanged = await changedNothing(
    scanner, { baseUrl, path, response: sameOrigin, session, testId });
  if (nothingChanged !== null) {
    return { skipped: false, findings: [], inconclusive: true, reason: nothingChanged };
  }

  return {
    skipped: false,
    findings: [{
      category: 'MissingOriginValidation',
      title: 'A state-changing request is accepted from any origin',
      endpoint: path, httpMethod: 'POST', observedAsRole: 'cross-origin caller',
      description: `An Origin of https://${EXTERNAL_MARKER_HOST} was accepted — it ${fromElsewhere.how} — `
        + `the same way a request from the application's own origin was: it ${fromOwnOrigin.how}. `
        + 'The header is not being read. '
        + 'The host named does not resolve and nothing was sent to it.',
      impact: 'The origin check that would stop a cross-site request is not there.',
      remediation: 'Validate Origin (and Sec-Fetch-Site where available) on every state-changing request.',
      cwe: 'CWE-352', cweConfidence: 'confirmed',
      // A01, not A05. A missing origin check is a broken access control, not a
      // misconfiguration — it is the same failure as the missing anti-CSRF token beside it,
      // and filing the two under different categories would split one problem in a report.
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A01:2021',
      // 'nonSensitive': a missing origin check on its own does not reach personal data — it
      // removes one of the two defences against a cross-site request. Where the anti-CSRF
      // token is also missing, that finding carries the data impact and this one does not
      // need to double-count it.
      severityFactors: new SeverityFactors('straightforward', 'limited', 'none', 'nonSensitive', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [sameOrigin, crossOrigin]
    }]
  };
}

/**
 * Unrestricted file upload.
 *
 * Nothing executable is sent. The probe describes a file — a name, a declared content type
 * and a size — because that is what the application's validation reads, and because
 * sending a real web shell to an application that might store and serve it is how a test
 * becomes the incident it was meant to prevent.
 */
export async function checkUploadRestrictions(scanner, { baseUrl, path, actor, declaredOversizeBytes = 50 * 1024 * 1024, testId = 'SECA-UPLOAD' }) {
  const headers = { 'content-type': 'application/json', ...authHeaders(actor) };
  const send = async (body, id, note) => scanner.request({
    url: at(baseUrl, `${path}`), method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers, body, as: actor?.label ?? 'unauthenticated', testId: `${testId}:${id}`, note
  });

  const findings = [];

  // ---- executable extension with a mismatched declared type ----------------
  const executable = await send(
    { filename: 'qanxt-probe.php', contentType: 'image/png', size: 64,
      content: 'inert marker; this is not a script and nothing is intended to run' },
    'extension', 'an executable extension declared as an image — metadata only, no payload');
  if (!executable.allowed) return { skipped: true, decision: executable.decision, findings: [] };

  if (executable.status >= 200 && executable.status < 300) {
    findings.push({
      category: 'UnrestrictedFileUpload',
      title: 'An executable extension with a mismatched content type is accepted',
      endpoint: path, httpMethod: 'POST', parameter: 'filename',
      observedAsRole: actor?.label ?? 'unauthenticated',
      description: `A file named qanxt-probe.php declaring itself image/png was accepted `
        + `(${executable.status}). Neither the extension nor the disagreement between the two was `
        + 'checked. No executable content was sent: the request carried a name, a declared type and a '
        + 'size, which is what the validation reads.',
      impact: 'A file the server may later execute or serve can be uploaded by anyone who can upload at all.',
      remediation: 'Allowlist extensions, verify the content against the declared type, store outside the '
        + 'web root and serve with a fixed content type.',
      cwe: 'CWE-434', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A04:2021',
      severityFactors: new SeverityFactors('straightforward', 'serious', 'authenticatedUser', 'personalData', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [executable]
    });
  }

  // ---- a declared size far above any plausible limit -----------------------
  const oversize = await send(
    { filename: 'qanxt-probe.txt', contentType: 'text/plain', size: declaredOversizeBytes, content: 'marker' },
    'size', `a declared size of ${declaredOversizeBytes} bytes — declared, not transferred`);
  if (!oversize.allowed) return { skipped: true, decision: oversize.decision, findings: [] };

  if (oversize.status >= 200 && oversize.status < 300) {
    findings.push({
      category: 'NoUploadSizeLimit',
      title: `A declared size of ${Math.round(declaredOversizeBytes / 1024 / 1024)}MB is accepted`,
      endpoint: path, httpMethod: 'POST', parameter: 'size',
      observedAsRole: actor?.label ?? 'unauthenticated',
      description: `The upload declared ${declaredOversizeBytes} bytes and was accepted `
        + `(${oversize.status}). The size was declared in the request body; nothing of that size was `
        + 'transferred, and no attempt was made to find the real limit by sending larger and larger files.',
      impact: 'Storage and bandwidth can be consumed without bound.',
      remediation: 'Enforce a maximum size, and enforce it on the bytes received rather than on what the '
        + 'client declares.',
      cwe: 'CWE-770', cweConfidence: 'likely',
      owaspApiCategory: 'API4:2023', owaspWebCategory: 'A04:2021',
      // 'straightforward' rather than 'trivial': declaring a large size is free, but causing
      // any actual harm means transferring the bytes, which this check deliberately did not do
      // and cannot speak to.
      severityFactors: new SeverityFactors('straightforward', 'minimal', 'authenticatedUser', 'none', 'authenticatedUsers'),
      confidence: confidenceFrom({ reproduced: false, corroborated: false, unambiguous: true }),
      exchanges: [oversize],
      coverageNote: 'The size was declared, not transferred. This establishes that the declared value is '
        + 'not validated, not that a file of that size would be accepted.'
    });
  }

  // ---- path traversal in the supplied filename -----------------------------
  const traversal = await send(
    { filename: '../../qanxt-probe.txt', contentType: 'text/plain', size: 32, content: 'marker' },
    'traversal', 'a relative path in the filename');
  if (!traversal.allowed) return { skipped: true, decision: traversal.decision, findings: [] };

  const storedAs = traversal.responseBody?.upload?.storedAs ?? traversal.responseBody?.storedAs ?? null;
  if (traversal.status >= 200 && traversal.status < 300 && typeof storedAs === 'string' && storedAs.includes('..')) {
    findings.push({
      category: 'PathTraversalInFilename',
      title: 'The supplied filename is stored without sanitisation',
      endpoint: path, httpMethod: 'POST', parameter: 'filename',
      observedAsRole: actor?.label ?? 'unauthenticated',
      description: `A filename of '../../qanxt-probe.txt' was stored as '${storedAs}', keeping the relative `
        + 'path. The finding is what the application reported it stored; no file was written outside any '
        + 'directory during this test and none was attempted.',
      impact: 'A caller can influence where a file is written, which in the general case means overwriting '
        + 'something the application depends on.',
      remediation: 'Discard the supplied name. Generate the stored name yourself.',
      cwe: 'CWE-22', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('straightforward', 'serious', 'authenticatedUser', 'personalData', 'authenticatedUsers'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [traversal]
    });
  }

  if (findings.length === 0) {
    return { skipped: false, findings: [], ok: true,
             detail: `extension ${executable.status}, declared size ${oversize.status}, `
               + `traversal ${traversal.status}${storedAs ? ` stored as '${storedAs}'` : ''}` };
  }
  return { skipped: false, findings };
}

/**
 * Open redirect.
 *
 * The Location header is read; it is never followed. `redirect: 'manual'` is set on every
 * request the engine makes, so this is enforced rather than promised.
 */
export async function checkOpenRedirect(scanner, { baseUrl, path, parameter = 'next', testId = 'SECA-REDIRECT' }) {
  const target = `https://${EXTERNAL_MARKER_HOST}/qanxt-probe`;

  const relative = await scanner.request({
    url: at(baseUrl, `${path}?${parameter}=${encodeURIComponent('/dashboard')}`),
    risk: SECURITY_RISK.ACTIVE, testId: `${testId}:control`, as: 'unauthenticated',
    note: 'a relative destination, which the endpoint should accept'
  });
  if (!relative.allowed) return { skipped: true, decision: relative.decision, findings: [] };

  const external = await scanner.request({
    url: at(baseUrl, `${path}?${parameter}=${encodeURIComponent(target)}`),
    risk: SECURITY_RISK.ACTIVE, testId: `${testId}:external`, as: 'unauthenticated',
    note: `an absolute destination on ${EXTERNAL_MARKER_HOST}, a host that does not resolve; the Location `
      + 'header is read and never followed'
  });
  if (!external.allowed) return { skipped: true, decision: external.decision, findings: [] };

  const location = external.responseHeaders?.location ?? '';
  const redirected = external.status >= 300 && external.status < 400;
  const goesExternal = location.includes(EXTERNAL_MARKER_HOST);

  if (!(redirected && goesExternal)) {
    return { skipped: false, findings: [], ok: true,
             detail: `relative ${relative.status}, external ${external.status}`
               + `${location ? ` → ${location}` : ''}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'OpenRedirect',
      title: `'${parameter}' redirects to any host`,
      endpoint: path, httpMethod: 'GET', parameter, observedAsRole: 'unauthenticated',
      description: `The endpoint answered ${external.status} with Location: ${location}. The destination `
        + 'was supplied in the query string and was not checked against the application\'s own origin. '
        + `The host does not resolve and the redirect was not followed — the engine issues every request `
        + 'with redirects disabled.',
      impact: 'A link that starts on a domain the user trusts can land them anywhere, which is what makes '
        + 'this useful in phishing and in stealing tokens carried in a redirect.',
      remediation: 'Allow relative paths only, or match the destination against an allowlist of hosts.',
      cwe: 'CWE-601', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A01:2021',
      // 'minimal' direct impact: an open redirect does not by itself disclose or change
      // anything. Its value to an attacker is as a step in something else, and scoring the
      // step as though it were the whole attack is how severity stops meaning anything.
      severityFactors: new SeverityFactors('trivial', 'minimal', 'none', 'nonSensitive', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [relative, external]
    }]
  };
}

/**
 * Server-side request forgery.
 *
 * By default this asks the application to fetch a loopback address on a port nothing is
 * listening on. That is enough to tell an application that validates its targets from one
 * that does not, and it reaches nothing.
 *
 * The cloud-metadata payloads are behind `allowMetadataPayloads`, which is false unless
 * someone sets it. The brief forbids reaching cloud metadata or internal infrastructure by
 * default, and there is a practical reason as well as a rule: an instance-metadata endpoint
 * hands out credentials, and a scanner that pulls them into its own evidence store has
 * created the breach it was hired to look for.
 */
export async function checkSsrf(scanner, { baseUrl, path, parameter = 'url', allowMetadataPayloads = false, testId = 'SECA-SSRF' }) {
  const probes = [
    { id: 'loopback', value: 'http://127.0.0.1:9/qanxt-probe',
      describes: 'a loopback address on the discard port, where nothing is listening' },
    { id: 'private-range', value: 'http://10.255.255.1/qanxt-probe',
      describes: 'an address in a private range that does not route from here' }
  ];
  if (allowMetadataPayloads) {
    probes.push({ id: 'cloud-metadata', value: 'http://169.254.169.254/latest/meta-data/',
                  describes: 'a cloud instance metadata endpoint, included only because the scan was '
                    + 'explicitly configured to' });
  }

  const external = await scanner.request({
    url: at(baseUrl, `${path}?${parameter}=${encodeURIComponent(`https://${EXTERNAL_MARKER_HOST}/`)}`),
    risk: SECURITY_RISK.ACTIVE, testId: `${testId}:control`, as: 'unauthenticated',
    note: 'a destination outside the application, to establish what it does with one'
  });
  if (!external.allowed) return { skipped: true, decision: external.decision, findings: [] };

  const accepted = [];
  const exchanges = [external];
  for (const probe of probes) {
    const result = await scanner.request({
      url: at(baseUrl, `${path}?${parameter}=${encodeURIComponent(probe.value)}`),
      risk: SECURITY_RISK.ACTIVE, testId: `${testId}:${probe.id}`, as: 'unauthenticated',
      note: `SSRF probe: ${probe.describes}`
    });
    if (!result.allowed) return { skipped: true, decision: result.decision, findings: [] };
    exchanges.push(result);

    // 400 means the application refused the target, which is the correct answer. Anything
    // else means it took the destination seriously — whether the connection then succeeded
    // is a property of the network, not of the application's validation.
    if (result.status !== 400 && result.status !== 403) accepted.push({ probe, status: result.status });
  }

  if (accepted.length === 0) {
    return { skipped: false, findings: [], ok: true,
             detail: `${probes.length} internal destination(s), all refused` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'ServerSideRequestForgery',
      title: `'${parameter}' is fetched without validating the destination`,
      endpoint: path, httpMethod: 'GET', parameter, observedAsRole: 'unauthenticated',
      description: `The application accepted ${accepted.length} internal destination(s) it should have `
        + `refused: ${accepted.map(a => `${a.probe.value} (${a.status})`).join(', ')}. Each names an `
        + 'address that routes nowhere from here; nothing was reached and nothing was read back.'
        + (allowMetadataPayloads
          ? ' Cloud metadata payloads were included because this scan was explicitly configured to send them.'
          : ' Cloud metadata endpoints were NOT probed: they are off by default, and this finding says '
            + 'nothing about whether they are reachable.'),
      impact: 'The application will make requests to addresses the caller chooses, from inside the network '
        + 'where it runs.',
      remediation: 'Resolve the destination and match the resolved address against an allowlist, refusing '
        + 'loopback, link-local and private ranges — and re-check after every redirect.',
      cwe: 'CWE-918', cweConfidence: 'confirmed',
      owaspApiCategory: 'API7:2023', owaspWebCategory: 'A10:2021',
      severityFactors: new SeverityFactors('straightforward', 'serious', 'none', 'credentials', 'public'),
      confidence: confidenceFrom({ reproduced: true, corroborated: true, unambiguous: false }),
      exchanges,
      coverageNote: allowMetadataPayloads
        ? 'Cloud metadata endpoints were probed because this scan was configured to.'
        : 'Cloud metadata and internal infrastructure were not probed. That area is untested, not clean.'
    }]
  };
}

/**
 * Text that varies on its own between two identical reads of the same page, and so cannot
 * carry evidence that a probe changed anything. Stripped before the witness is digested.
 *
 * This is a narrow list on purpose. The check's whole claim rests on the witness page being
 * stable, and the honest way to establish that is to read it twice and compare, which is what
 * the control below does. Stripping is only here so that a clock in a page footer does not
 * make every witness useless — not to paper over a page that genuinely churns.
 */

/** Names a rotating per-render value goes by. Matched whole, with an optional `_` or `__`
 * prefix, because the framework conventions differ and all of them rotate. */
const NOISE_NAMES = 'csrf|xsrf|nonce|authenticity_token|request[-_]?verification_?token'
  + '|verification_?token|viewstate|eventvalidation|request[-_]?id|cachebust|_t';

/** What such a value looks like: base64, hex or url-safe, long enough not to be a word. */
const NOISE_VALUE = '[A-Za-z0-9_\\-+/=]{8,}';

const WITNESS_NOISE = [
  // ISO timestamps and common date-time renderings.
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g,
  /\d{1,2}:\d{2}:\d{2}\s*(AM|PM|am|pm)?/g,
  // A token named by one attribute and carried by another: the markup shape every server
  // framework emits. Matched before the direct form below, because the direct form would
  // otherwise consume the name and leave the value behind — which is exactly what it did,
  // and what left a page with a `<meta name="csrf-token" content="...">` unusable as a
  // witness while looking as though it had been handled.
  new RegExp(`(?:name|id)\\s*=\\s*["']?[_-]{0,2}(?:${NOISE_NAMES})`
    + `[^<>]{0,60}?(?:value|content)\\s*=\\s*["']?${NOISE_VALUE}`, 'gi'),
  // And the direct form: `csrf=...`, `"csrf":"..."`, `nonce="..."`.
  new RegExp(`[_-]{0,2}(?:${NOISE_NAMES})["']?\\s*[=:]\\s*["']?${NOISE_VALUE}`, 'gi'),
  // Durations a page reports about itself.
  /\b\d+(\.\d+)?\s?ms\b/gi
];

/** A witness page reduced to the part of it that can carry evidence of a state change. */
function witnessDigest(text) {
  if (typeof text !== 'string') return null;
  let stripped = text;
  for (const pattern of WITNESS_NOISE) stripped = stripped.replace(pattern, '');
  return stripped.replace(/\s+/g, ' ').trim();
}

/**
 * A state change reachable with a safe verb.
 *
 * The claim is that issuing a `GET` — a verb the HTTP specification says is safe, and which
 * therefore needs no anti-forgery token, survives in browser history, and is followed by
 * prefetchers, crawlers and link scanners — changed something an identity can observe.
 *
 * Nothing in the catalogue said that before this check existed. `authz.vertical` asks whether
 * a lower-privileged identity can reach what a higher one can, which on an application where
 * every role may approve returns the same answer for both and reports nothing.
 * `api.unsafe-method` creates an object and then tries to `DELETE` it, which probes something
 * else entirely.
 *
 * **The verb is not the evidence.** A link named `/approve` may do nothing; a link named
 * `/view` may do a great deal. So the finding is never raised from the URL. It is raised only
 * when a witness page the identity can read differs after the probe, and the honesty of that
 * rests entirely on the control:
 *
 *   1. read the witness twice, changing nothing in between;
 *   2. if those two reads already differ, the page cannot attribute a later difference to the
 *      probe, so the check reports that it could not evaluate and stops — it does not guess;
 *   3. only then issue the candidate request, and read the witness once more.
 *
 * Without step 2 any page carrying a clock, a counter or a rotating token would report a
 * state change on every candidate, and a scanner that confidently reports a finding on every
 * link is worth less than one that reports none.
 *
 * **A witness that does not move is not a clean bill of health.** The probe may have changed
 * something this page does not show. That is reported as not evaluated, not as a pass: this
 * check can establish that a safe verb changed state and cannot establish that it did not.
 *
 * The probe is declared state-changing, so the scope guard governs it and it is refused
 * rather than run where that has not been permitted.
 */
export async function checkStateChangeBySafeVerb(
  scanner,
  { baseUrl, path, witnessPath, actor, testId = 'SECA-SAFEVERB' }
) {
  // A witness is required, and it must not be the address under test.
  //
  // This defaulted to `path`, which reads as a harmless convenience and is not one: the
  // witness is read twice before the probe, so a caller omitting it would have performed the
  // state change twice before deciding whether to perform it at all, and then compared an
  // approved record against an approved record. Nothing in the worker does that, because it
  // refuses the check without a witness; the default was a trap for the next caller.
  if (!witnessPath || witnessPath === path) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: 'Not evaluated: this check needs a separate page to read before and after acting. '
        + 'The address under test cannot witness itself — reading it is performing the very '
        + 'change being investigated.'
    };
  }

  const witnessUrl = at(baseUrl, witnessPath);
  const role = actor?.label ?? 'unauthenticated';

  const read = (label, note) => scanner.request({
    url: witnessUrl, risk: SECURITY_RISK.PASSIVE, testId: `${testId}:${label}`,
    headers: authHeaders(actor), as: role, note
  });

  const before = await read('witness-1', 'reading the witness page before anything is probed');
  if (!before.allowed) return { skipped: true, decision: before.decision, findings: [] };

  if (before.status < 200 || before.status >= 300) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: `Not evaluated: this check needs a page it can read to tell whether anything changed, `
        + `and ${witnessPath} answered ${before.status} as ${role}. Without a witness a state `
        + `change cannot be observed, and the verb alone is not evidence of one.`
    };
  }

  const control = await read('witness-2', 'reading the witness page a second time, changing nothing, '
    + 'to establish whether it is stable enough to carry evidence');
  if (!control.allowed) return { skipped: true, decision: control.decision, findings: [] };

  const baseline = witnessDigest(before.responseText);
  const settled = witnessDigest(control.responseText);

  if (baseline === null || settled === null) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: 'Not evaluated: the witness page returned no text to compare, so a change to it could '
        + 'not be observed either way.'
    };
  }

  if (baseline !== settled) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: `Not evaluated: ${witnessPath} differs between two reads with nothing done in `
        + 'between, so a difference after the probe would not be evidence that the probe caused it. '
        + 'This check needs a stable page to witness against and will not report a state change it '
        + 'cannot attribute.'
    };
  }

  const probe = await scanner.request({
    url: at(baseUrl, path), risk: SECURITY_RISK.STATE_CHANGING, testId: `${testId}:probe`,
    headers: authHeaders(actor), as: role,
    note: `issuing ${path} as ${role} with no anti-forgery token, to establish by observation `
      + 'whether a safe verb changes state'
  });
  if (!probe.allowed) return { skipped: true, decision: probe.decision, findings: [] };

  if (probe.status === 401 || probe.status === 403 || probe.status === 405) {
    return {
      skipped: false, findings: [], ok: true,
      detail: `${path} refused a GET from ${role} with ${probe.status}`
    };
  }

  const after = await read('witness-3', 'reading the witness page after the probe');
  if (!after.allowed) return { skipped: true, decision: after.decision, findings: [] };

  const observed = witnessDigest(after.responseText);
  if (observed === settled) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: `Not evaluated: ${path} answered ${probe.status} and ${witnessPath} is unchanged, `
        + 'so this check saw no state change. It cannot conclude there was none — the request may have '
        + 'changed something this page does not show — and it will not record an untested endpoint as '
        + 'a safe one.'
    };
  }

  return {
    skipped: false,
    findings: [{
      category: 'StateChangeBySafeVerb',
      title: 'A GET changes state, and needs no anti-forgery token to do it',
      endpoint: path, httpMethod: 'GET', observedAsRole: role,
      description: `${path} was issued as ${role} with no anti-forgery token and answered `
        + `${probe.status}. ${witnessPath} read identically twice beforehand and differs `
        + 'afterwards, so the change is attributable to that request rather than to the page moving '
        + 'on its own. The verb was not the evidence: the witness page was.',
      impact: 'A GET needs no token, no form and no script. Any page on any other site can trigger '
        + 'it with an image tag, and so can a browser prefetcher, a link scanner, a chat client '
        + 'unfurling a preview or anything that walks the user\'s history. The change also happens '
        + 'for whoever follows the link, at whatever privilege they hold.',
      remediation: 'Make the state change a POST (or another unsafe verb), require an anti-forgery '
        + 'token on it, and authorize it against what the caller is allowed to do rather than against '
        + 'being signed in at all.',
      // CWE-352 is the exploitable shape: no token is required because the verb is safe, so a
      // third-party page can issue it. CWE-650 is the same flaw read from the HTTP side.
      cwe: 'CWE-352', cweConfidence: 'confirmed',
      owaspApiCategory: 'API5:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('trivial', 'serious', 'none', 'nonSensitive', 'public'),
      confidence: confidenceFrom({ reproduced: true, corroborated: true, unambiguous: true }),
      exchanges: [before, control, probe, after]
    }]
  };
}
