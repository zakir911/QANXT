import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityScanner } from '../src/engine.mjs';

/**
 * Signing in to an application behind an HTTP Basic challenge.
 *
 * The engine looked for a sign-in form on eight paths and posted JSON to seven endpoints.
 * Against a Basic-protected application all fifteen answered 401, `signIn` returned null,
 * and the scan reported every authorization and authentication check inconclusive for want
 * of an identity — with the credentials sitting unused in its own configuration.
 *
 * The scanner is driven through a stub request function, so these tests are about the
 * decision it makes rather than about any application.
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

const BASIC = { authorization: `Basic ${Buffer.from('clerk:Permit!2026').toString('base64')}` };

test('a Basic challenge is answered with a Basic header', async () => {
  const { scanner, sent } = scannerThat(options =>
    options.headers?.authorization
      ? { status: 200, responseBody: '<HTML>the register</HTML>', responseHeaders: {} }
      : { status: 401, responseHeaders: { 'www-authenticate': 'Basic realm="Permits"' } });

  const identity = await scanner.signIn('http://host/default.asp', 'clerk', 'Permit!2026');

  assert.ok(identity, 'an identity should be returned');
  assert.deepEqual(identity.headers, BASIC);
  assert.equal(identity.cookie, null);
  assert.equal(identity.csrf, null);
  // Two requests, and no time wasted guessing at form paths afterwards.
  assert.equal(sent.length, 2);
});

test('the base path is not appended: the challenge is read at the origin', async () => {
  const { scanner, sent } = scannerThat(options =>
    options.headers?.authorization
      ? { status: 200, responseBody: 'ok', responseHeaders: {} }
      : { status: 401, responseHeaders: { 'www-authenticate': 'Basic realm="Permits"' } });

  await scanner.signIn('http://host/deep/default.asp', 'clerk', 'Permit!2026');

  assert.deepEqual(sent.map(s => s.url), ['http://host/', 'http://host/']);
});

/**
 * The important negative. A Basic header sent to an application that does not use Basic is
 * ignored, so a 200 would otherwise be read as a successful sign-in that authenticates
 * nothing — and every authorization comparison downstream would compare two anonymous
 * requests and find them identical, which reads as "no defect".
 */
test('an application that does not ask for Basic produces no Basic identity', async () => {
  const { scanner } = scannerThat(() => ({ status: 200, responseBody: 'a public page', responseHeaders: {} }));

  assert.equal(await scanner.signInWithBasic('http://host/', 'clerk', 'x'), null);
});

test('a 401 asking for something other than Basic is not answered with Basic', async () => {
  const { scanner } = scannerThat(() => ({
    status: 401, responseHeaders: { 'www-authenticate': 'Bearer realm="api"' }
  }));

  assert.equal(await scanner.signInWithBasic('http://host/', 'clerk', 'x'), null);
});

test('wrong credentials against a real challenge are not an identity', async () => {
  const { scanner } = scannerThat(() => ({
    status: 401, responseHeaders: { 'www-authenticate': 'Basic realm="Permits"' }
  }));

  assert.equal(await scanner.signInWithBasic('http://host/', 'clerk', 'wrong'), null);
});

test('a challenge the scope refused is not guessed past', async () => {
  const scanner = new SecurityScanner({
    profile: 'standard',
    scope: { enabled: false, allowedDomains: [], allowedApiDomains: [] }
  });
  scanner.request = async () => ({ allowed: false, decision: { reason: 'scopeMissing' } });

  assert.equal(await scanner.signInWithBasic('http://host/', 'clerk', 'x'), null);
});
