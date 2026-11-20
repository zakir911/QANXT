import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReflectedXss } from '../src/checks-xss.mjs';

/**
 * Reaching the page before judging it.
 *
 * The reflected-XSS probe was always anonymous. Most business applications put their search
 * and filter pages behind a login, so the probe received the sign-in redirect, found no
 * reflection in an empty body, and reported "ok" — a clean verdict on a page it had never
 * rendered. Meridian Freight reflects its `q` parameter raw into the results page and this
 * check passed it on every run.
 */

/**
 * A scanner whose responses the test controls, recording what was asked of it.
 *
 * The response shape matches what the real engine returns — `responseHeaders` as a plain
 * object and the body as `responseText`. An earlier version of this fixture used Headers, the
 * content-type check silently read undefined, every reflection came back "not-html", and
 * the test failed against correct code. A fixture that does not match production tests
 * nothing.
 */
function fakeScanner(reply) {
  const asked = [];
  return {
    asked,
    async request({ url, headers, as }) {
      asked.push({ url, cookie: headers?.cookie ?? null, as });
      return { allowed: true, ...reply(url) };
    }
  };
}

const htmlReflecting = (url) => {
  const value = decodeURIComponent(new URL(url, 'http://x').searchParams.get('q') ?? '');
  return {
    status: 200,
    responseHeaders: { 'content-type': 'text/html; charset=utf-8' },
    responseText: `<div class="empty">No shipments match ${value}</div>`
  };
};

const redirect = () => ({
  status: 302, responseHeaders: { location: '/auth/sign-in' }, responseText: ''
});

test('sends the identity\'s cookie when one is supplied', async () => {
  const scanner = fakeScanner(htmlReflecting);

  await checkReflectedXss(scanner, {
    baseUrl: 'http://app.test', path: '/shipments', parameter: 'q',
    identity: { label: 'operations', cookie: 'session=abc' }
  });

  assert.ok(scanner.asked.length > 0);
  for (const call of scanner.asked) {
    assert.equal(call.cookie, 'session=abc');
    assert.equal(call.as, 'operations');
  }
});

test('finds the reflection the signed-in page actually serves', async () => {
  // The shape of FP_D28, verbatim from the lab's response.
  const result = await checkReflectedXss(fakeScanner(htmlReflecting), {
    baseUrl: 'http://app.test', path: '/shipments', parameter: 'q',
    identity: { label: 'operations', cookie: 'session=abc' }
  });

  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].title, /reflected into HTML without encoding/);
});

test('a page that redirects every probe is inconclusive, never clean', async () => {
  // The false-clean this check was producing: "no reflection found" about a sign-in
  // redirect. A page that was never rendered cannot be reported clean.
  const result = await checkReflectedXss(fakeScanner(redirect), {
    baseUrl: 'http://app.test', path: '/shipments', parameter: 'q'
  });

  assert.equal(result.inconclusive, true);
  assert.equal(result.ok, undefined);
  assert.match(result.reason, /redirected every probe/);
  assert.match(result.reason, /No identity was supplied/);
});

test('says nothing about an identity when one was supplied and it still redirected', async () => {
  const result = await checkReflectedXss(fakeScanner(redirect), {
    baseUrl: 'http://app.test', path: '/shipments', parameter: 'q',
    identity: { label: 'operations', cookie: 'session=abc' }
  });

  assert.equal(result.inconclusive, true);
  assert.doesNotMatch(result.reason, /No identity was supplied/);
});

test('a page that renders and encodes the marker is clean', async () => {
  const encoded = (url) => {
    const value = decodeURIComponent(new URL(url, 'http://x').searchParams.get('q') ?? '');
    // Quotes too. An application that escapes angle brackets and leaves quotes raw is
    // still injectable in an attribute context, and the check is right to say so — an
    // earlier version of this fixture escaped only <, > and & and then complained that
    // correct code reported a finding.
    const escaped = value
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return {
      status: 200, responseHeaders: { 'content-type': 'text/html; charset=utf-8' },
      responseText: `<div>No shipments match ${escaped}</div>`
    };
  };

  const result = await checkReflectedXss(fakeScanner(encoded), {
    baseUrl: 'http://app.test', path: '/shipments', parameter: 'q',
    identity: { label: 'operations', cookie: 'session=abc' }
  });

  assert.equal(result.findings.length, 0);
  assert.equal(result.ok, true);
});

test('works anonymously when no identity is available', async () => {
  const scanner = fakeScanner(htmlReflecting);

  await checkReflectedXss(scanner, {
    baseUrl: 'http://app.test', path: '/search', parameter: 'q'
  });

  assert.equal(scanner.asked[0].cookie, null);
  assert.equal(scanner.asked[0].as, 'unauthenticated');
});
