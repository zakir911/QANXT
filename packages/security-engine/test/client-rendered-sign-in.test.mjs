import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityScanner } from '../src/engine.mjs';
import { checkCookies } from '../src/checks-passive.mjs';

/**
 * Signing in to an application that builds its sign-in form in the browser.
 *
 * `signIn` and `signInExchanges` both look for a form on the same eight paths. Only `signIn`
 * then tried a JSON sign-in, which it had grown when a bearer-token application could not be
 * authenticated at all. `signInExchanges` was written afterwards, for the cookie check, and
 * kept the form half of that.
 *
 * The cost was that the cookie check could not reach a client-rendered application at all.
 * clinic-spa serves a near-empty document and builds its sign-in form in JavaScript, so
 * there is no form in the HTML to read; it answers credentials at `/api/session` and sets
 * `clinic_session=...; HttpOnly; SameSite=Lax`. The scan signed in to it successfully,
 * through `signIn`, and ran its authorization checks as that identity. The cookie check,
 * moments later, reported "no sign-in form could be found to authenticate against" and
 * judged nothing — about an application it was authenticated to, holding a cookie with
 * attributes plainly worth judging.
 *
 * These tests drive the real engine method through a stubbed request, so what is under test
 * is the decision rather than any application. The shape is clinic-spa's: a document with no
 * form in it, and a JSON endpoint that answers credentials with a Set-Cookie.
 */
function scannerThat(handler) {
  const scanner = new SecurityScanner({
    profile: 'standard',
    scope: {
      enabled: true, allowedDomains: ['host'], allowedApiDomains: ['host'],
      allowActiveTesting: true, allowDestructiveTesting: false,
      authorizationNote: 'A stub, for a unit test. No request leaves this process.'
    }
  });
  const sent = [];
  scanner.request = async (options) => {
    sent.push(options);
    return { allowed: true, ...handler(options) };
  };
  return { scanner, sent };
}

/** The document clinic-spa serves: a mount point, and the form built into it later. */
const CLIENT_RENDERED = '<!doctype html><div id="app"></div><script src="/app.js"></script>';

const SESSION_COOKIE = 'clinic_session=s1; Path=/; HttpOnly; SameSite=Lax';
const WITHOUT_HTTPONLY = 'clinic_session=s1; Path=/; SameSite=Lax';

/** Headers as fetch presents them, which is where getSetCookie() comes from. */
const headers = (...setCookie) => ({ getSetCookie: () => setCookie });

/** A client-rendered application that answers credentials as JSON at /api/session. */
const clientRendered = (setCookie = SESSION_COOKIE) => (options) => {
  if (options.method === 'POST' && options.url.endsWith('/api/session')) {
    return { status: 200, responseBody: { ok: true }, headers: headers(setCookie),
             responseHeaders: { 'set-cookie': setCookie } };
  }
  if (options.method === 'POST') return { status: 404, responseHeaders: {} };
  return { status: 200, responseBody: CLIENT_RENDERED, headers: headers(), responseHeaders: {} };
};

test('an exchange is returned from the JSON endpoint when no form is served', async () => {
  const { scanner } = scannerThat(clientRendered());

  const { exchanges, form } = await scanner.signInExchanges('http://host/', 'dr.okafor', 'pw');

  assert.equal(exchanges.length, 1, 'the JSON sign-in is one exchange');
  assert.equal(form, null, 'there is no form, and the result should not claim one');
  assert.match(exchanges[0].label, /\/api\/session/);
  assert.equal(exchanges[0].control, null, 'a JSON endpoint has no optional control to vary');
  assert.deepEqual(exchanges[0].result.headers.getSetCookie(), [SESSION_COOKIE]);
});

test('the form is still preferred when the application serves one', async () => {
  // The JSON fallback must not take precedence: a served form carries hidden fields and
  // optional controls, and the per-control exchanges are the only way to see a
  // "remember me" that downgrades a cookie.
  const withForm = `<form method="post" action="/auth/sign-in">
    <input name="username" /><input type="password" name="password" />
    <input type="checkbox" name="remember" /></form>`;
  const { scanner } = scannerThat(options => {
    if (options.method === 'POST') {
      return { status: 200, responseBody: '', headers: headers(SESSION_COOKIE), responseHeaders: {} };
    }
    return { status: 200, responseBody: withForm, headers: headers(), responseHeaders: {} };
  });

  const { exchanges, form } = await scanner.signInExchanges('http://host/', 'u', 'p');

  assert.ok(form, 'the served form should be reported');
  assert.equal(exchanges.length, 2, 'the form as it stands, and with "remember" enabled');
  assert.equal(exchanges[1].control, 'remember');
});

test('a JSON endpoint that refuses the credentials yields no exchange', async () => {
  // Sensitivity: the fallback must not manufacture an exchange out of a refusal. A 401 is
  // not an authentication response and its headers are not a session cookie.
  const { scanner } = scannerThat(options =>
    options.method === 'POST'
      ? { status: 401, responseBody: { error: 'unauthenticated' }, headers: headers(),
          responseHeaders: {} }
      : { status: 200, responseBody: CLIENT_RENDERED, headers: headers(), responseHeaders: {} });

  const { exchanges } = await scanner.signInExchanges('http://host/', 'u', 'wrong');

  assert.equal(exchanges.length, 0);
});

test('the cookie check now judges a client-rendered application, and finds nothing wrong', async () => {
  // clinic-spa's own cookie: HttpOnly and SameSite=Lax, and no Secure, which is correct
  // over plain HTTP. An answer, where there was an inconclusive.
  const { scanner } = scannerThat(clientRendered());

  const result = await checkCookies(scanner, 'http://host/schedule', 'SECP-COOKIES', {
    baseUrl: 'http://host/', credentials: { username: 'dr.okafor', password: 'pw' }
  });

  assert.equal(result.inconclusive, undefined, `should not be inconclusive: ${result.reason ?? ''}`);
  assert.equal(result.findings.length, 0, 'this cookie is correctly configured');
  assert.ok(result.observations.some(o => o.looksLikeSession),
    'the session cookie should have been seen');
});

test('and reports a client-rendered application that loses HttpOnly', async () => {
  // The point of reaching the application at all: the same shape, one attribute missing,
  // now produces a finding where before it produced the same inconclusive either way.
  const { scanner } = scannerThat(clientRendered(WITHOUT_HTTPONLY));

  const result = await checkCookies(scanner, 'http://host/schedule', 'SECP-COOKIES', {
    baseUrl: 'http://host/', credentials: { username: 'dr.okafor', password: 'pw' }
  });

  assert.equal(result.inconclusive, undefined);
  assert.equal(result.findings.length, 1, 'the missing HttpOnly should be reported');
  assert.match(JSON.stringify(result.findings[0]), /HttpOnly/i);
});

test('a client-rendered application carrying no cookie still says so precisely', async () => {
  // A token-in-the-body SPA. The authentication response was obtained, so the reason must be
  // the one about signing in having been examined, not the one about no form being found.
  const { scanner } = scannerThat(options =>
    options.method === 'POST' && options.url.endsWith('/api/session')
      ? { status: 200, responseBody: { token: 't' }, headers: headers(), responseHeaders: {} }
      : options.method === 'POST'
        ? { status: 404, responseHeaders: {} }
        : { status: 200, responseBody: CLIENT_RENDERED, headers: headers(), responseHeaders: {} });

  const result = await checkCookies(scanner, 'http://host/schedule', 'SECP-COOKIES', {
    baseUrl: 'http://host/', credentials: { username: 'dr.okafor', password: 'pw' }
  });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /signing in was examined and no response set a cookie/);
  assert.equal(/no sign-in form could be found/.test(result.reason), false,
    'the form sentence is now wrong for this application and must not be used');
});
