import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityScanner } from '../src/engine.mjs';

/**
 * Where a failed sign-in is sent when the application has no form.
 *
 * Every authentication check works by making a sign-in fail and reading the answer. With an
 * HTML form the scanner finds and submits the real one. Without a form the whole of this
 * path was `POST /api/session` with `{username, password}` — a guess at the address and a
 * guess at the field names.
 *
 * Measured on this project's own token-api target, whose sign-in is `POST /api/auth/token`:
 * six "failed sign-ins" were six 404s, the control probe correctly noticed that no sign-in
 * had taken place, and the lockout check honestly reported that it could conclude nothing —
 * while the planted defect, a sign-in that is never throttled, sat there untested. The
 * application had declared its endpoint and field names since token sign-in was built. They
 * were never handed to the scan.
 */
function scannerWithDeclaredSignIn(signIn) {
  const scanner = new SecurityScanner({
    profile: 'standard',
    scope: {
      enabled: true, allowedDomains: ['host'], allowedApiDomains: ['host'],
      allowActiveTesting: true, allowDestructiveTesting: false,
      authorizationNote: 'A stub, for a unit test. No request leaves this process.'
    },
    context: signIn === undefined ? {} : { signIn }
  });
  const sent = [];
  scanner.request = async (options) => {
    sent.push(options);
    return { allowed: true, status: 401, responseHeaders: {}, responseText: '' };
  };
  // No form anywhere, which is the case this path exists for.
  scanner.findSignInForm = async () => null;
  return { scanner, sent };
}

test('a declared endpoint is used instead of the guess', async () => {
  const { scanner, sent } = scannerWithDeclaredSignIn({
    endpoint: 'http://host/api/auth/token', method: 'POST', contentType: 'json'
  });

  await scanner.submitSignIn('http://host/', 'alice', 'wrong-1');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'http://host/api/auth/token');
  assert.equal(sent[0].method, 'POST');
});

test('declared field names carry the credentials', async () => {
  // An API that calls them something else is describable rather than unsupported.
  const { scanner, sent } = scannerWithDeclaredSignIn({
    endpoint: 'http://host/api/auth/token', contentType: 'json',
    usernameField: 'email', passwordField: 'secret'
  });

  await scanner.submitSignIn('http://host/', 'alice@example.test', 'wrong-1');

  assert.deepEqual(sent[0].body, { email: 'alice@example.test', secret: 'wrong-1' });
});

test('the usual spellings are still tried when the owner named no fields', async () => {
  const { scanner, sent } = scannerWithDeclaredSignIn({
    endpoint: 'http://host/api/auth/token', contentType: 'json'
  });

  await scanner.submitSignIn('http://host/', 'alice', 'wrong-1');

  assert.deepEqual(sent[0].body, { username: 'alice', password: 'wrong-1' });
});

test('a declared form sign-in is form-encoded, not JSON', async () => {
  const { scanner, sent } = scannerWithDeclaredSignIn({
    endpoint: 'http://host/auth/sign-in', contentType: 'form'
  });

  await scanner.submitSignIn('http://host/', 'alice', 'wrong-1');

  assert.equal(sent[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(sent[0].body, 'username=alice&password=wrong-1');
});

test('with nothing declared it still guesses, so an application that said nothing is no worse off', async () => {
  const { scanner, sent } = scannerWithDeclaredSignIn(undefined);

  await scanner.submitSignIn('http://host/', 'alice', 'wrong-1');

  assert.match(sent[0].url, /\/api\/session$/);
  assert.deepEqual(sent[0].body, { username: 'alice', password: 'wrong-1' });
});

test('the password reaches the endpoint as given, so a failed sign-in really fails', async () => {
  // A probe that quietly sent the wrong thing would read as a refusal rather than a failed
  // sign-in, which is the trap the whole control-probe guard exists for.
  const { scanner, sent } = scannerWithDeclaredSignIn({
    endpoint: 'http://host/api/auth/token', contentType: 'json'
  });

  await scanner.submitSignIn('http://host/', 'alice', 'qanxt-wrong-3');

  assert.equal(sent[0].body.password, 'qanxt-wrong-3');
});
