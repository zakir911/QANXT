import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusal } from '../src/checks-authz.mjs';

/**
 * Whether a response refused to hand over a resource.
 *
 * This exists because the authorization checks recognised only 401, 403 and 404, and most
 * web applications protect a page by redirecting to the sign-in form. Meridian Freight
 * answers 302 with an empty body for every protected route, so the scan reported 67
 * Critical "protected data is served to an unauthenticated caller" findings against an
 * application that served nothing at all. Sixty-seven phantom criticals are worse than
 * none: they bury whatever is real and teach a team to stop reading the report.
 */

const response = (status, { location, body } = {}) => ({
  status,
  headers: new Headers(location ? { location } : {}),
  responseBody: body
});

test('a redirect to the sign-in form is a refusal', () => {
  // The exact shape that produced 67 false criticals.
  const verdict = refusal(response(302, { location: '/auth/sign-in?next=/shipments' }), '/shipments');

  assert.equal(verdict.refused, true);
  assert.match(verdict.how, /asks for credentials/);
});

test('a bare redirect with no body is a refusal, wherever it points', () => {
  // A 3xx carries no body, so nothing protected can have been disclosed by it.
  assert.equal(refusal(response(302, { location: '/somewhere-else' }), '/shipments').refused, true);
  assert.equal(refusal(response(303), '/shipments').refused, true);
});

test('a redirect to the same path is undecided, not a refusal', () => {
  // Canonicalisation — a trailing slash, a case fix — is not the application saying no,
  // and calling it one would hide a real hole behind a redirect.
  const verdict = refusal(response(301, { location: '/shipments' }), '/shipments');

  assert.equal(verdict.refused, false);
  assert.equal(verdict.undecided, true);
});

test('a 200 that renders the sign-in form is a refusal', () => {
  // Plenty of applications answer 200 and show the login page.
  const verdict = refusal(response(200, {
    body: '<form action="/login" method="post"><input type="password" name="pw"></form>'
  }), '/shipments');

  assert.equal(verdict.refused, true);
  assert.match(verdict.how, /sign-in form/);
});

test('the statuses that say no in words are still refusals', () => {
  for (const status of [401, 403, 404]) {
    assert.equal(refusal(response(status), '/x').refused, true, `status ${status}`);
  }
});

test('a 200 serving the resource is not a refusal', () => {
  // The case the check exists to find: data came back to a caller with no credentials.
  const verdict = refusal(response(200, {
    body: '<h1>Shipment MF-1000</h1><table><tr><td>Declared value</td><td>£4,000</td></tr></table>'
  }), '/shipments/shp-1');

  assert.equal(verdict.refused, false);
});

test('a 500 is not a refusal', () => {
  // Crashing is not declining, and the two need different reports.
  assert.equal(refusal(response(500, { body: 'NullReferenceException' }), '/x').refused, false);
});

test('a plain-object header bag works as well as Headers', () => {
  // Different call sites hand this different shapes; reading one and not the other is how
  // a fix passes its test and does nothing in production.
  const verdict = refusal(
    { status: 302, headers: { location: '/auth/sign-in' }, responseBody: '' }, '/shipments');

  assert.equal(verdict.refused, true);
});

test('a missing or malformed response is not read as a refusal', () => {
  assert.equal(refusal(undefined, '/x').refused, false);
  assert.equal(refusal({}, '/x').refused, false);
});
