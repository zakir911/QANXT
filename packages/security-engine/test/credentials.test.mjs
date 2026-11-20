import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, credentialFrom, isSignedIn } from '../src/credentials.mjs';

/**
 * What makes a request carry an identity.
 *
 * The engine used to say this with one word: cookie. Every check built its headers as
 * { cookie: identity.cookie } and signIn returned null when a response carried no
 * Set-Cookie. An application that answers a sign-in with a bearer token — every SPA, every
 * mobile backend, most APIs written in the last decade — produced no identity at all, so
 * every authorization, API and injection check reported inconclusive. Not a wrong answer:
 * no answer, on half the applications there are.
 */

test('a cookie identity still authenticates the way it always did', () => {
  assert.deepEqual(authHeaders({ cookie: 'session=abc' }), { cookie: 'session=abc' });
  assert.equal(isSignedIn({ cookie: 'session=abc' }), true);
});

test('a bearer identity authenticates too', () => {
  const identity = { headers: { authorization: 'Bearer abc.def' } };
  assert.deepEqual(authHeaders(identity), { authorization: 'Bearer abc.def' });
  assert.equal(isSignedIn(identity), true);
});

test('an identity with no credential authenticates nothing', () => {
  for (const nothing of [undefined, null, {}, { cookie: null }, { headers: {} }]) {
    assert.deepEqual(authHeaders(nothing), {});
    assert.equal(isSignedIn(nothing), false);
  }
});

test('reads a Set-Cookie as a credential', () => {
  const credential = credentialFrom({
    headers: new Headers({ 'set-cookie': 'session=abc; Path=/; HttpOnly' })
  });

  assert.equal(credential.cookie, 'session=abc');
  assert.deepEqual(credential.headers, { cookie: 'session=abc' });
});

test('reads a bearer token out of a JSON body', () => {
  // The exact shape the token-api lab answers with.
  const credential = credentialFrom({
    headers: new Headers({}),
    responseBody: { token: '3551b3cb', tokenType: 'Bearer', role: 'owner' }
  });

  assert.deepEqual(credential.headers, { authorization: 'Bearer 3551b3cb' });
  assert.equal(credential.cookie, null);
});

test('reads the spellings a token actually arrives under', () => {
  for (const field of ['token', 'accessToken', 'access_token', 'idToken', 'id_token', 'jwt']) {
    const credential = credentialFrom({ headers: new Headers({}), responseBody: { [field]: 'v' } });
    assert.deepEqual(credential.headers, { authorization: 'Bearer v' }, `field ${field}`);
  }
});

test('honours a scheme the application names', () => {
  const credential = credentialFrom({
    headers: new Headers({}), responseBody: { token: 'v', token_type: 'DPoP' }
  });
  assert.deepEqual(credential.headers, { authorization: 'DPoP v' });
});

test('prefers a cookie when the response carries both', () => {
  // A cookie is the session the browser would actually use.
  const credential = credentialFrom({
    headers: new Headers({ 'set-cookie': 'session=abc' }),
    responseBody: { token: 'ignored' }
  });
  assert.equal(credential.cookie, 'session=abc');
});

test('returns nothing when a sign-in handed back nothing', () => {
  // A form re-rendered with "wrong password" is not an identity.
  assert.equal(credentialFrom({ headers: new Headers({}), responseBody: { error: 'bad' } }), null);
  assert.equal(credentialFrom({ headers: new Headers({}), responseText: '<form>...' }), null);
  assert.equal(credentialFrom(undefined), null);
});

test('reads a plain-object header bag as well as a Headers instance', () => {
  const credential = credentialFrom({ responseHeaders: { 'set-cookie': 'session=xyz; Path=/' } });
  assert.equal(credential.cookie, 'session=xyz');
});

import { checkBola } from '../src/checks-authz.mjs';

test('the object-level check refuses to run without a resource to compare', async () => {
  // It used to interpolate `undefined` into the URL and then report that the stranger's
  // response "did not contain undefined" — a verdict assembled from a missing input, in a
  // sentence no reader could act on.
  const scanner = {
    async request() {
      return { allowed: true, status: 200, responseHeaders: {}, responseBody: { id: 'ord-1' } };
    }
  };

  const result = await checkBola(scanner, {
    baseUrl: 'http://app.test', path: '/api/orders/{id}',
    owner: { label: 'bob', headers: { authorization: 'Bearer b' } },
    intruder: { label: 'alice', headers: { authorization: 'Bearer a' } }
  });

  assert.equal(result.inconclusive, true);
  assert.equal(result.findings.length, 0);
  assert.match(result.reason, /No resource belonging to the owning identity/);
});

test('the object-level check finds a leak when it has what it needs', async () => {
  // Bearer identities throughout: the shape that used to produce no identity at all.
  const seen = [];
  const scanner = {
    async request({ headers }) {
      seen.push(headers.authorization);
      return { allowed: true, status: 200, responseHeaders: {},
               responseBody: { id: 'ord-2', customer: 'cust-b', total: 980 } };
    }
  };

  const result = await checkBola(scanner, {
    baseUrl: 'http://app.test', path: '/api/orders/{id}',
    owner: { label: 'bob', resourceId: 'ord-2', headers: { authorization: 'Bearer b' } },
    intruder: { label: 'alice', headers: { authorization: 'Bearer a' } }
  });

  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].title, /alice can read a resource owned by bob/);
  assert.deepEqual(seen, ['Bearer b', 'Bearer a']);
});
