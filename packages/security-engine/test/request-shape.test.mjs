import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCsrfToken, checkOriginValidation, encodeBody } from '../src/checks-request.mjs';
import { checkReadOnlyWrite } from '../src/checks-authz.mjs';

/**
 * The request these checks actually send.
 *
 * They work by issuing the application's own state-changing request twice and varying one
 * thing. That establishes nothing if the request is refused, and the checks were sending an
 * empty body: every form endpoint that validates its fields refuses it, a server-rendered
 * application refuses by redirecting back to the form, and the check correctly reported that
 * it could reach no verdict.
 *
 * Measured on a 137-screen freight application: 37 endpoints where both the anti-forgery and
 * the origin check reached no verdict, one of them a planted missing-token defect on
 * /warehouse/stock/:id/adjust. Proven against the running application — POST with {} redirects
 * back to the form; POST with {delta, reason} redirects to the record and the stock balance
 * moves — so the endpoint gives the defect up the moment the request carries the two fields
 * its own form declares.
 */

const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });

const answered = (status, location, body = '') => ({
  allowed: true, status,
  headers: headers(location === undefined ? {} : { location }),
  responseBody: body
});

const session = { cookie: 'session=abc', csrf: 't0ken' };

/**
 * A scanner that answers from a script and records the whole request it was given.
 *
 * Reads of where a redirect led are answered with the same page for every arm, so these tests
 * stay about the request that was sent. Differing landing pages have their own tests.
 */
function stub(...responses) {
  const sent = [];
  const sameLandingPage = {
    allowed: true, status: 200, headers: headers({}),
    responseBody: '<h1>The record</h1>', responseText: '<h1>The record</h1>'
  };
  return {
    sent,
    async request(options) {
      sent.push(options);
      if (String(options.testId).endsWith(':arrived')) return sameLandingPage;
      const next = responses.shift();
      if (!next) throw new Error(`no scripted response left for ${options.testId}`);
      return next;
    }
  };
}

const formBody = { delta: '1', reason: 'Damage' };

test('a urlencoded form body is sent as a form, not as a JSON document', () => {
  const encoded = encodeBody({ delta: '1', reason: 'Cycle count correction' },
                             'application/x-www-form-urlencoded');

  assert.equal(typeof encoded, 'string');
  assert.equal(encoded, 'delta=1&reason=Cycle+count+correction');
});

test('a JSON content type leaves the body as an object, which the scanner encodes', () => {
  const encoded = encodeBody(formBody, 'application/json');

  assert.deepEqual(encoded, formBody);
});

test('a null or undefined value is omitted rather than sent as the word "null"', () => {
  assert.equal(encodeBody({ a: '1', b: null, c: undefined }, 'application/x-www-form-urlencoded'),
               'a=1');
});

test('the control request carries the form fields, in the form content type', async () => {
  const scanner = stub(
    answered(302, '/warehouse/stock/s-1'),   // control: accepted, redirected to the record
    answered(302, '/warehouse/stock/s-1'),   // probe without a token: accepted the same way
    answered(200, undefined, '<form>a different page</form>') // the read changedNothing makes
  );

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/warehouse/stock/s-1/adjust', session,
    body: formBody, contentType: 'application/x-www-form-urlencoded', tokenField: '_csrf'
  });

  const control = scanner.sent.find(r => r.testId.endsWith(':control'));
  assert.equal(control.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.match(control.body, /delta=1/);
  assert.match(control.body, /reason=Damage/);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'MissingCsrfToken');
});

test('the token goes in the field the form declares, as well as in a header', async () => {
  const scanner = stub(
    answered(302, '/warehouse/stock/s-1'),
    answered(302, '/warehouse/stock/s-1'),
    answered(200, undefined, '<form>a different page</form>')
  );

  await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/warehouse/stock/s-1/adjust', session,
    body: formBody, contentType: 'application/x-www-form-urlencoded', tokenField: '_csrf'
  });

  // A server that reads the token from the body will not look in a header, so an endpoint
  // that enforces its token would refuse the control request and the check would reach no
  // verdict against an application that is doing the right thing.
  const control = scanner.sent.find(r => r.testId.endsWith(':control'));
  assert.match(control.body, /_csrf=t0ken/);
  assert.equal(control.headers['x-csrf-token'], 't0ken');
});

test('the probe sends the same request with the token in neither place', async () => {
  const scanner = stub(
    answered(302, '/warehouse/stock/s-1'),
    answered(302, '/warehouse/stock/s-1'),
    answered(200, undefined, '<form>a different page</form>')
  );

  await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/warehouse/stock/s-1/adjust', session,
    body: formBody, contentType: 'application/x-www-form-urlencoded', tokenField: '_csrf'
  });

  const probe = scanner.sent.find(r => r.testId.endsWith(':no-token'));
  assert.doesNotMatch(probe.body, /_csrf/);
  assert.equal(probe.headers['x-csrf-token'], undefined);
  // And the rest of the request is unchanged, or the two are not a comparison.
  assert.match(probe.body, /delta=1/);
  assert.match(probe.body, /reason=Damage/);
});

test('a token a caller passed inside the sample is stripped from the probe', async () => {
  const scanner = stub(
    answered(302, '/warehouse/stock/s-1'),
    answered(302, '/warehouse/stock/s-1'),
    answered(200, undefined, '<form>a different page</form>')
  );

  await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/warehouse/stock/s-1/adjust', session,
    body: { ...formBody, _csrf: 'stale' },
    contentType: 'application/x-www-form-urlencoded', tokenField: '_csrf'
  });

  // Otherwise the probe is the control, and the check reports a missing token on an
  // application that enforces one.
  const probe = scanner.sent.find(r => r.testId.endsWith(':no-token'));
  assert.doesNotMatch(probe.body, /_csrf/);
});

test('an endpoint that enforces its body token reads as clean, not as unevaluable', async () => {
  const scanner = stub(
    answered(302, '/warehouse/stock/s-1'),      // control with the body token: accepted
    answered(302, '/warehouse/stock/s-1/adjust') // probe without it: form shown again
  );

  // This is what the body token buys. Without it the control is refused and the check reaches
  // no verdict against an application that is doing the right thing; with it the check can
  // say the endpoint enforces its token.
  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/warehouse/stock/s-1/adjust', session,
    body: formBody, contentType: 'application/x-www-form-urlencoded', tokenField: '_csrf'
  });

  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
  assert.match(result.detail, /without one it/);
});

test('an inconclusive reason says what was sent, so a reader can act on it', async () => {
  const scanner = stub(answered(302, '/warehouse/stock/s-1/adjust'));

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/warehouse/stock/s-1/adjust', session,
    body: formBody, contentType: 'application/x-www-form-urlencoded', tokenField: '_csrf'
  });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /a urlencoded form body/);
  assert.match(result.reason, /delta/);
  assert.match(result.reason, /token in the _csrf field/);
});

test('with no declared body the reason says so rather than implying one was sent', async () => {
  const scanner = stub(answered(302, '/claims/new'));

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/claims/new', session
  });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /no fields, because none were discovered/);
  assert.match(result.reason, /token in a header only/);
});

test('both origin arms carry the body token, so the origin is the only difference', async () => {
  const scanner = stub(
    answered(302, '/warehouse/stock/s-1'),
    answered(302, '/warehouse/stock/s-1'),
    answered(200, undefined, '<form>a different page</form>')
  );

  await checkOriginValidation(scanner, {
    baseUrl: 'http://app.test', path: '/warehouse/stock/s-1/adjust', session,
    body: formBody, contentType: 'application/x-www-form-urlencoded', tokenField: '_csrf'
  });

  const [own, elsewhere] = scanner.sent.filter(r => r.method === 'POST');
  assert.match(own.body, /_csrf=t0ken/);
  assert.match(elsewhere.body, /_csrf=t0ken/);
  assert.equal(own.body, elsewhere.body);
  assert.notEqual(own.headers.origin, elsewhere.headers.origin);
});

test('the read-only check sends each identity its own token', async () => {
  const scanner = stub(
    answered(302, '/warehouse/stock/s-1'),
    answered(302, '/warehouse/stock/s-1'),
    answered(200, undefined, '<form>a different page</form>')
  );

  const result = await checkReadOnlyWrite(scanner, {
    baseUrl: 'http://app.test', path: '/warehouse/stock/s-1/adjust',
    writer: { label: 'warehouse', cookie: 'session=w', csrf: 'writer-token' },
    readonly: { label: 'viewer', cookie: 'session=v', csrf: 'viewer-token' },
    body: formBody, contentType: 'application/x-www-form-urlencoded', tokenField: '_csrf'
  });

  // Each identity's own token: a check that sent the writer's token as the read-only account
  // would be sending a request that account's own page never sends.
  const [control, attempt] = scanner.sent.filter(r => r.method === 'POST');
  assert.match(control.body, /_csrf=writer-token/);
  assert.match(attempt.body, /_csrf=viewer-token/);
  assert.match(control.body, /delta=1/);
  assert.match(attempt.body, /delta=1/);
  assert.equal(result.findings.length, 1);
});

test('an identity with no token still sends the body, without inventing one', async () => {
  const scanner = stub(
    answered(302, '/warehouse/stock/s-1'),
    answered(302, '/warehouse/stock/s-1'),
    answered(200, undefined, '<form>a different page</form>')
  );

  await checkReadOnlyWrite(scanner, {
    baseUrl: 'http://app.test', path: '/warehouse/stock/s-1/adjust',
    writer: { label: 'warehouse', cookie: 'session=w' },
    readonly: { label: 'viewer', cookie: 'session=v' },
    body: formBody, contentType: 'application/x-www-form-urlencoded', tokenField: '_csrf'
  });

  const [control] = scanner.sent.filter(r => r.method === 'POST');
  assert.doesNotMatch(control.body, /_csrf/);
  assert.match(control.body, /delta=1/);
});

/**
 * The read-only check judged its write arms with `refusal`, the notion built for a check that
 * asks whether a resource was *served*. On a read a 3xx means it was not, so a redirect is a
 * refusal. On a write it is the opposite: an application rendered on the server saves and then
 * redirects to what it saved.
 *
 * Proven against freight, one request, with the fix to the body in place: the `readonly`
 * account — on a page that tells it "Settling a claim needs the claim:settle permission, which
 * your role does not hold" — settled a £5,953.11 claim for £1.00. Status submitted -> settled,
 * settled amount — -> £1.00. The check reported clean.
 */
test('a read-only account that wrote is a finding, not a refusal', async () => {
  const scanner = stub(
    answered(302, '/claims/clm-0001'),  // the writer: saved, redirected to the record
    answered(302, '/claims/clm-0001'),  // the viewer: the same, which is the defect
    answered(200, undefined, '<form>the settle form</form>') // the read changedNothing makes
  );

  const result = await checkReadOnlyWrite(scanner, {
    baseUrl: 'http://app.test', path: '/claims/clm-0001/settle',
    writer: { label: 'claims handler', cookie: 'session=w' },
    readonly: { label: 'viewer', cookie: 'session=v' },
    body: { settledAmountGbp: '1' }, contentType: 'application/x-www-form-urlencoded'
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'PrivilegeEscalation');
  assert.match(result.findings[0].description, /redirected onward/);
});

test('a read-only account sent back to the form was refused, and reads as clean', async () => {
  const scanner = stub(
    answered(302, '/claims/clm-0001'),          // the writer saved
    answered(302, '/claims/clm-0001/settle')    // the viewer got the form again
  );

  const result = await checkReadOnlyWrite(scanner, {
    baseUrl: 'http://app.test', path: '/claims/clm-0001/settle',
    writer: { label: 'claims handler', cookie: 'session=w' },
    readonly: { label: 'viewer', cookie: 'session=v' },
    body: { settledAmountGbp: '1' }, contentType: 'application/x-www-form-urlencoded'
  });

  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
});

test('an endpoint that refuses both accounts founds nothing, not an escalation', async () => {
  // The other direction of the same mistake. Both arms are sent back to the form, which is a
  // refusal; 302 is under 400, so the old `status >= 400` guard let the control through and
  // the finding was raised against an endpoint that wrote nothing for anybody.
  const scanner = stub(
    answered(302, '/claims/clm-0001/settle'),
    answered(302, '/claims/clm-0001/settle')
  );

  const result = await checkReadOnlyWrite(scanner, {
    baseUrl: 'http://app.test', path: '/claims/clm-0001/settle',
    writer: { label: 'claims handler', cookie: 'session=w' },
    readonly: { label: 'viewer', cookie: 'session=v' },
    body: {}, contentType: 'application/x-www-form-urlencoded'
  });

  assert.equal(result.inconclusive, true);
  assert.equal(result.findings.length, 0);
  assert.match(result.reason, /could not write either/);
  assert.match(result.reason, /redirected back to/);
});

test('a 4xx for the writer is still unevaluable, as it always was', async () => {
  const scanner = stub(answered(403), answered(403));

  const result = await checkReadOnlyWrite(scanner, {
    baseUrl: 'http://app.test', path: '/claims/clm-0001/settle',
    writer: { label: 'claims handler', cookie: 'session=w' },
    readonly: { label: 'viewer', cookie: 'session=v' },
    body: { settledAmountGbp: '1' }
  });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /could not write either/);
});
