import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCookies } from '../src/checks-passive.mjs';
import { readSignInForm } from '../src/engine.mjs';

/**
 * Which response's cookies the cookie check judges.
 *
 * The check used to read the Set-Cookie headers of a passive GET of the page under test. A
 * page GET is close to the only request that issues no session cookie, so it reported no
 * finding from having looked at the wrong exchange — indistinguishable, to a reader, from a
 * session cookie that is correctly configured.
 *
 * These tests are mostly about the two things that make the difference real: the cookies come
 * from the authentication response, and a form offering a second way to authenticate gets
 * both ways examined. The shape under test is the common one — an ordinary sign-in that sets
 * HttpOnly and a "keep me signed in" branch that assembles its header by hand and loses it.
 */

/** Headers as fetch presents them, which is where getSetCookie() comes from. */
const headers = (...setCookie) => ({ getSetCookie: () => setCookie });

const SIGN_IN_PAGE = `
  <form method="post" action="/auth/sign-in">
    <input type="hidden" name="_csrf" value="t0ken" />
    <input name="username" />
    <input type="password" name="password" />
    <input type="checkbox" name="remember" />
    <button type="submit">Sign in</button>
  </form>`;

const GOOD = 'lab_session=abc; Path=/; HttpOnly; SameSite=Lax';
const NO_HTTPONLY = 'lab_session=abc; Path=/; Max-Age=2592000; SameSite=Lax';

/**
 * A scanner whose sign-in exchanges are scripted per control, which is what the real engine
 * method returns. The page under test answers with no cookies, like most pages.
 */
function stub({ page = headers(), byControl = {}, noForm = false } = {}) {
  const calls = [];
  return {
    calls,
    async request({ url, testId }) {
      calls.push({ url, testId });
      return { allowed: true, status: 200, headers: page, responseBody: '' };
    },
    async signInExchanges(baseUrl, username) {
      calls.push({ signInAs: username });
      if (noForm) return { exchanges: [], form: null };
      return {
        exchanges: Object.entries(byControl).map(([control, setCookie]) => ({
          label: control === 'default' ? 'the form as it stands' : `with "${control}" enabled`,
          control: control === 'default' ? null : control,
          result: { allowed: true, status: 302, headers: headers(setCookie), responseBody: '' }
        })),
        form: { action: '/auth/sign-in', method: 'POST', options: [{ name: 'remember', value: 'on' }] }
      };
    }
  };
}

const run = (scanner, options) => checkCookies(
  scanner, 'http://app.test/dashboard', 'passive.cookies',
  { baseUrl: 'http://app.test', credentials: { username: 'ops.lead', password: 'pw' }, ...options });

test('the remember-me branch losing HttpOnly is a finding', async () => {
  const result = await run(stub({ byControl: { default: GOOD, remember: NO_HTTPONLY } }));

  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.category, 'InsecureCookieAttributes');
  assert.equal(finding.cwe, 'CWE-1004');
  assert.match(finding.title, /missing HttpOnly when "remember" is enabled/);
  assert.match(finding.description, /fault in the "remember" branch specifically/);
});

test('the default sign-in path is judged on its own terms', async () => {
  const result = await run(stub({ byControl: { default: NO_HTTPONLY, remember: NO_HTTPONLY } }));

  // Both branches are broken, and they are two fixes in two places, not one finding.
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings.filter(f => /when "remember"/.test(f.title)).length, 1);
});

test('a correctly configured session cookie on every path is a clean result', async () => {
  const result = await run(stub({ byControl: { default: GOOD, remember: GOOD } }));

  assert.deepEqual(result.findings, []);
  assert.notEqual(result.inconclusive, true);
  assert.ok(result.observations.some(o => o.looksLikeSession && o.httpOnly));
});

test('a cookie records which response set it, and never its value', async () => {
  const result = await run(stub({ byControl: { default: GOOD, remember: NO_HTTPONLY } }));

  const seen = result.observations.filter(o => o.looksLikeSession);
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(o => typeof o.setBy === 'string' && o.setBy.length > 0));
  assert.ok(seen.every(o => !JSON.stringify(o).includes('abc')),
    'the cookie value must never be recorded, only its shape');
});

test('no session cookie anywhere is inconclusive, not clean', async () => {
  // The fault this closes: a check that saw nothing returned what a check that saw good
  // cookies returned, so "correct" and "never looked at" read identically.
  const result = await run(stub({ byControl: { default: 'theme=dark; Path=/' } }));

  assert.equal(result.inconclusive, true);
  assert.equal(result.findings.length, 0);
  assert.match(result.reason, /^Not evaluated:/);
  assert.match(result.reason, /signing in was examined/);
});

test('no credentials says so, rather than reporting on a page GET', async () => {
  const result = await checkCookies(
    stub(), 'http://app.test/dashboard', 'passive.cookies', { baseUrl: 'http://app.test' });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /no credentials were supplied/);
  assert.match(result.reason, /issued by signing in/);
});

test('credentials with no sign-in form to use them on is distinguished from having none', async () => {
  const result = await run(stub({ noForm: true }));

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /no sign-in form could be found/);
});

test('a page that sets its own session cookie is still judged', async () => {
  // An application that mints a session on first visit: the page GET is the right exchange
  // for it, and dropping the old behaviour entirely would have lost that case.
  const result = await checkCookies(
    stub({ page: headers(NO_HTTPONLY) }), 'http://app.test/dashboard', 'passive.cookies', {});

  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].description, /set by the page under test/);
});

test('the sign-in form reports an unticked box as an alternative path', () => {
  const form = readSignInForm(SIGN_IN_PAGE, 'ops.lead', 'pw');

  assert.deepEqual(form.options, [{ name: 'remember', value: 'on', type: 'checkbox' }]);
  // The box stays unticked in the default submission: a scan authenticates the way the form
  // does, not the way it could be made to.
  assert.equal(form.fields.remember, undefined);
  assert.equal(form.fields._csrf, 't0ken');
});

test('a box the form ticks for you is part of the default submission', () => {
  const form = readSignInForm(
    SIGN_IN_PAGE.replace('name="remember" />', 'name="remember" checked />'), 'ops.lead', 'pw');

  assert.equal(form.fields.remember, 'on');
  assert.deepEqual(form.options, []);
});
