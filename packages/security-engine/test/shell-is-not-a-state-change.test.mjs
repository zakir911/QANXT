import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCsrfToken, checkOriginValidation } from '../src/checks-request.mjs';

/**
 * An address that answers the application's shell did not change anything.
 *
 * `stateChangeAccepted` reads the status and the redirect, which is enough on an application
 * that answers 404 or 405 to a method it does not serve. A single-page application does not.
 * clinic-spa serves its shell — 200, HTML — for every path and method it has no handler for,
 * because that is what client-side routing requires.
 *
 * So a POST to `/` answered 200, the control looked accepted, the probe without a token
 * answered 200 as well, and the check reported *"A state-changing request succeeds with no
 * anti-CSRF token"* at severity 3 about an address that does nothing. Measured on clinic-spa:
 * three findings of the twelve in that family were this, and on any application of the shape
 * every address without a handler would have produced the same pair.
 *
 * Proven against the running application before it was fixed:
 *
 *   POST /  -> 200 text/html 244 bytes
 *   GET  /  -> 200 text/html 244 bytes      byte-identical: the POST changed nothing
 *
 * The contrast that must survive, from the same application:
 *
 *   GET  /api/appointments/apt-1/cancel -> 200 text/html (the shell; there is no GET handler)
 *   POST /api/appointments/apt-1/cancel -> 200 application/json (the cancelled appointment)
 *
 * Different, so that finding stands — correctly, because the endpoint really does accept a
 * cookie-authorised POST with no token.
 */
const headers = (map = {}) => ({ get: (name) => map[name.toLowerCase()] ?? null });

const SHELL = '<!doctype html><div id="app"></div><script src="/app.js"></script>';

const answered = (status, body) => ({ allowed: true, status, headers: headers(), responseBody: body });

const session = { cookie: 'session=abc', csrf: 't0ken' };

/** A scanner that answers each request from a script, in order. */
function stub(...responses) {
  const asked = [];
  return {
    asked,
    async request({ url, method, testId }) {
      asked.push({ url, method, testId });
      const next = responses.shift();
      if (!next) throw new Error(`no scripted response left for ${testId}`);
      return next;
    }
  };
}

const args = { baseUrl: 'http://app.test', path: '/', session, body: {} };

test('a POST answering the same shell as a GET founds no anti-forgery finding', async () => {
  // control 200 shell, probe 200 shell, then the read: 200, the same shell.
  const scanner = stub(answered(200, SHELL), answered(200, SHELL), answered(200, SHELL));

  const result = await checkCsrfToken(scanner, args);

  assert.equal(result.findings.length, 0);
  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /exactly the same \d+-byte response to a plain GET/);
  assert.match(result.reason, /changed nothing/);
});

test('the read is a GET of the same address, and is made only once', async () => {
  const scanner = stub(answered(200, SHELL), answered(200, SHELL), answered(200, SHELL));

  await checkCsrfToken(scanner, args);

  const reads = scanner.asked.filter(a => a.method === 'GET');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].url, 'http://app.test/');
  assert.match(reads[0].testId, /:read$/);
});

test('an endpoint whose POST answers something else keeps its finding', async () => {
  // clinic-spa's cancel endpoint: the shell for a GET, the cancelled appointment for a POST.
  const cancelled = JSON.stringify({ id: 'apt-1', status: 'cancelled' });
  const scanner = stub(answered(200, cancelled), answered(200, cancelled), answered(200, SHELL));

  const result = await checkCsrfToken(scanner, { ...args, path: '/api/appointments/apt-1/cancel' });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, 'A state-changing request succeeds with no anti-CSRF token');
});

test('a different status keeps the finding, even with an identical body', async () => {
  // 201 to the POST and 200 to the GET is a change, whatever the bodies say.
  const scanner = stub(answered(201, SHELL), answered(201, SHELL), answered(200, SHELL));

  const result = await checkCsrfToken(scanner, args);

  assert.equal(result.findings.length, 1);
});

test('a read that is refused does not suppress the finding', async () => {
  // Scope or policy refusing the read is not evidence that the change was real or unreal.
  // The finding stands on the evidence already gathered rather than being dropped silently.
  const scanner = stub(answered(200, SHELL), answered(200, SHELL),
    { allowed: false, decision: 'out of scope' });

  const result = await checkCsrfToken(scanner, args);

  assert.equal(result.findings.length, 1);
});

test('the origin check applies the same premise', async () => {
  const scanner = stub(answered(200, SHELL), answered(200, SHELL), answered(200, SHELL));

  const result = await checkOriginValidation(scanner, args);

  assert.equal(result.findings.length, 0);
  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /changed nothing/);
});

test('and the origin check still reports a real one', async () => {
  const cancelled = JSON.stringify({ id: 'apt-1', status: 'cancelled' });
  const scanner = stub(answered(200, cancelled), answered(200, cancelled), answered(200, SHELL));

  const result = await checkOriginValidation(scanner, { ...args, path: '/api/appointments/apt-1/cancel' });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, 'A state-changing request is accepted from any origin');
});

test('two empty bodies are not evidence that nothing changed', async () => {
  // A 204, or a 302 whose body is empty as most are, would otherwise compare equal to an
  // empty read and have a true finding withdrawn on the strength of two blanks.
  const scanner = stub(answered(204, ''), answered(204, ''), answered(204, ''));

  const result = await checkCsrfToken(scanner, args);

  assert.equal(result.findings.length, 1);
});
