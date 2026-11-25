import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCsrfToken, checkOriginValidation, stateChangeAccepted } from '../src/checks-request.mjs';

/**
 * Whether a state-changing request was accepted.
 *
 * The CSRF and origin checks used `status >= 400` as the whole test. On a JSON API that is
 * right; on an application rendered on the server it is wrong in the worst direction, because
 * such an application refuses by answering 302 and showing the form again:
 *
 *     POST /claims/new   (no token)   ->   302   location: /claims/new
 *
 * Nothing was created. 302 is under 400, so control and probe "succeeded identically" and the
 * finding was raised — 54 endpoints of a 137-screen application that carries and enforces its
 * tokens, 108 findings with the origin twin, 38% of everything that scan reported, all false.
 */

/** Headers as fetch presents them. */
const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });

const answered = (status, location) => ({
  allowed: true, status,
  headers: headers(location === undefined ? {} : { location }),
  responseBody: ''
});

const session = { cookie: 'session=abc', csrf: 't0ken' };

/** A scanner that answers each request from a script, in order. */
function stub(...responses) {
  const asked = [];
  return {
    asked,
    async request({ url, testId }) {
      asked.push({ url, testId });
      const next = responses.shift();
      if (!next) throw new Error(`no scripted response left for ${testId}`);
      return next;
    }
  };
}

test('a redirect back to the address posted to is a refusal, not an acceptance', () => {
  const outcome = stateChangeAccepted(answered(302, '/claims/new'), '/claims/new');

  assert.equal(outcome.accepted, false);
  assert.match(outcome.how, /redirected back to \/claims\/new/);
  assert.match(outcome.how, /shown again after a refusal/);
});

test('a redirect onward is an acceptance, which is how a saved form behaves', () => {
  const outcome = stateChangeAccepted(answered(302, '/claims/clm-0007'), '/claims/new');

  assert.equal(outcome.accepted, true);
  assert.match(outcome.how, /redirected onward to \/claims\/clm-0007/);
});

test('a redirect to a sign-in is a refusal', () => {
  assert.equal(stateChangeAccepted(answered(302, '/auth/sign-in'), '/claims/new').accepted, false);
  assert.equal(stateChangeAccepted(answered(303, '/login?next=/x'), '/x').accepted, false);
});

test('a redirect with nowhere to go settles nothing, so it is not acceptance', () => {
  const outcome = stateChangeAccepted(answered(302), '/claims/new');

  assert.equal(outcome.accepted, false);
  assert.match(outcome.how, /no Location/);
});

test('the host and the query do not change which path a redirect names', () => {
  assert.equal(
    stateChangeAccepted(answered(302, 'http://app.test/claims/new?error=1'), '/claims/new').accepted,
    false);
  assert.equal(stateChangeAccepted(answered(302, '/claims/new/'), '/claims/new').accepted, false);
});

test('4xx and 5xx are refusals and 2xx is acceptance', () => {
  assert.equal(stateChangeAccepted(answered(403), '/x').accepted, false);
  assert.equal(stateChangeAccepted(answered(500), '/x').accepted, false);
  assert.equal(stateChangeAccepted(answered(200), '/x').accepted, true);
  assert.equal(stateChangeAccepted(answered(201), '/x').accepted, true);
});

test('a protected form that refuses by re-showing itself raises no CSRF finding', async () => {
  // The 54-endpoint case, end to end. The control request is JSON with the token in a header,
  // which a form endpoint wanting a urlencoded body refuses — and refuses for the right
  // reason, so the honest answer is that nothing could be concluded.
  const scanner = stub(answered(302, '/claims/new'));

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/claims/new', session
  });

  assert.deepEqual(result.findings, []);
  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /^Not evaluated:/);
  assert.match(result.reason, /redirected back to \/claims\/new/);
  assert.equal(scanner.asked.length, 1, 'the probe is not worth sending once the control failed');
});

test('an endpoint that accepts the change without a token is still a finding', async () => {
  // The guard must not swallow what the check exists for.
  const scanner = stub(
    answered(302, '/warehouse/stock/stk-1'),
    answered(302, '/warehouse/stock/stk-1'),
    answered(200));   // reading the address: a form, not a redirect

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/warehouse/stock/stk-1/adjust', session
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].cwe, 'CWE-352');
  assert.match(result.findings[0].description, /redirected onward to \/warehouse\/stock\/stk-1/);
});

test('an endpoint that refuses without a token is a pass', async () => {
  const scanner = stub(
    answered(302, '/warehouse/stock/stk-1'),
    answered(403));

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/warehouse/stock/stk-1/adjust', session
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.match(result.detail, /without one it answered 403/);
});

test('the origin check reads a redirect the same way', async () => {
  const refusing = stub(answered(302, '/claims/new'));

  const result = await checkOriginValidation(refusing, {
    baseUrl: 'http://app.test', path: '/claims/new', session
  });

  assert.deepEqual(result.findings, []);
  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /did not accept a request from its own origin/);
});

test('an origin that is not read is still a finding', async () => {
  const scanner = stub(
    answered(302, '/claims/clm-1'),
    answered(302, '/claims/clm-2'),
    answered(200));   // reading the address: a form, not a redirect

  const result = await checkOriginValidation(scanner, {
    baseUrl: 'http://app.test', path: '/claims/new', session
  });

  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].description, /The header is not being read/);
});

test('a redirect to an error page is a refusal, not acceptance', () => {
  // "Onward" alone is not acceptance. An application that answers a rejected write with
  // 302 -> /error otherwise reads exactly like one that saved the record and redirected to
  // it, which is the same confusion as the redirect-back case one step along.
  for (const where of ['/error', '/errors/403', '/forbidden', '/access-denied',
                       '/unauthorized', '/403', '/not-allowed']) {
    const outcome = stateChangeAccepted(answered(302, where), '/claims/new');
    assert.equal(outcome.accepted, false, `${where} is a refusal`);
    assert.match(outcome.how, /error page|credentials/);
  }
});

test('a record whose address merely contains those letters is still an acceptance', () => {
  // The words have to be a path segment. "errorsmith" is a customer, "/claims/clm-403" is a
  // record, and neither is an error page — a rule that matched them would turn real findings
  // into silence, which is the direction that costs most.
  for (const where of ['/customers/errorsmith', '/claims/clm-403', '/invoices/5001',
                       '/reports/terrordome']) {
    assert.equal(stateChangeAccepted(answered(302, where), '/claims/new').accepted, true,
      `${where} is a saved record, not an error page`);
  }
});
