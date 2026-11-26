import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  REDACTED, redactBody, redactHeaders, redactText, writeFindingEvidence
} from '../src/evidence.mjs';

/**
 * What keeps somebody's credentials out of the evidence we hand them.
 *
 * Every finding is written twice: once as it happened, and once with the secrets taken out.
 * The second copy is what a report links to and what leaves the machine, so a miss here
 * means a password or a session token in a document that gets emailed around. It was at
 * 32.4% line coverage with no test file.
 *
 * The tests below are deliberately adversarial about the redaction, because the failure is
 * silent: nothing breaks when a secret survives, and nobody notices until it is somewhere
 * it should not be.
 */

const sandbox = () => mkdtempSync(join(tmpdir(), 'qanxt-evidence-'));

// ---- free text -----------------------------------------------------------------------

test('a bearer token is removed wherever it appears, including in prose', () => {
  const text = redactText('The call failed with Authorization: Bearer abc123.def-456_x=');

  assert.ok(!text.includes('abc123'));
  assert.match(text, /Bearer \*\*\*REDACTED\*\*\*/);
});

test('basic credentials are removed', () => {
  const text = redactText('Basic YWxpY2U6c2VjcmV0cGFzc3dvcmQ=');

  assert.ok(!text.includes('YWxpY2U'));
  assert.match(text, /Basic \*\*\*REDACTED\*\*\*/);
});

test('a JSON web token is removed by its shape, with no list to be on', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g';
  const text = redactText(`the response carried ${jwt} in its body`);

  assert.ok(!text.includes('eyJhbGciOi'));
  assert.ok(text.includes(REDACTED));
});

test('an api key, a bcrypt hash and a private key are each removed', () => {
  // A synthetic value, not a real provider's key shape. A fixture that looks like a live
  // secret is one a secret scanner is right to block, and it does not need to look real to
  // test the pattern.
  const key = redactText('sk_qanxt0000synthetic0000fixture');
  assert.ok(!key.includes('synthetic0000fixture'));

  const hash = redactText('$2b$12$KIXQJ1eQZ9kPqk3vM0iOxeH5VbQnFk8Lp2Rt7Yw1Zs3Av6Cd9Ef1G');
  assert.ok(!hash.includes('KIXQJ'));

  const pem = redactText('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\nmore\n-----END RSA PRIVATE KEY-----');
  assert.ok(!pem.includes('MIIEowIBAAK'));
  assert.equal(pem.trim(), REDACTED);
});

test('a card-length number is removed, because evidence is not a place for one', () => {
  const text = redactText('card 4111111111111111 was declined');

  assert.ok(!text.includes('4111111111111111'));
});

test('an ordinary number is not mistaken for a card', () => {
  // Over-redaction shreds the evidence it is meant to preserve.
  const text = redactText('the response was 404 and took 1532 ms for 12 records');

  assert.ok(text.includes('404'));
  assert.ok(text.includes('1532'));
});

test('a literal the caller knows about is removed before any pattern runs', () => {
  const text = redactText('the session was my-secret-session-value', ['my-secret-session-value']);

  assert.ok(!text.includes('my-secret-session-value'));
  assert.ok(text.includes(REDACTED));
});

test('a short literal is left alone, because redacting it would destroy the evidence', () => {
  // A four-character value appears everywhere. Removing every occurrence of "1234" would
  // leave a file nobody can read.
  const text = redactText('order 1234 for user 1234 at 12:34', ['1234']);

  assert.ok(text.includes('1234'));
});

test('every occurrence of a literal goes, not just the first', () => {
  const text = redactText('a=longsecretvalue b=longsecretvalue', ['longsecretvalue']);

  assert.equal(text.includes('longsecretvalue'), false);
});

test('null and undefined redact to an empty string rather than the word null', () => {
  assert.equal(redactText(null), '');
  assert.equal(redactText(undefined), '');
});

// ---- headers -------------------------------------------------------------------------

test('a sensitive header is removed by name, whatever its value looks like', () => {
  const out = redactHeaders({
    authorization: 'anything at all', cookie: 'session=plain', 'x-api-key': 'k',
    'set-cookie': 'a=b', 'x-csrf-token': 't', 'content-type': 'application/json'
  });

  for (const name of ['authorization', 'cookie', 'x-api-key', 'set-cookie', 'x-csrf-token']) {
    assert.equal(out[name], REDACTED, name);
  }
  // And a header that carries no secret is left readable, because it is evidence.
  assert.equal(out['content-type'], 'application/json');
});

test('header names are matched without regard to case', () => {
  const out = redactHeaders({ Authorization: 'Bearer x', 'Set-Cookie': 'a=b' });

  assert.equal(out.Authorization, REDACTED);
  assert.equal(out['Set-Cookie'], REDACTED);
});

test('a header not on the list is still cleaned by shape', () => {
  const out = redactHeaders({ 'x-trace': 'Bearer abcdefghijklmnop' });

  assert.ok(!out['x-trace'].includes('abcdefghijklmnop'));
});

test('no headers at all is an empty map rather than a crash', () => {
  assert.deepEqual(redactHeaders(undefined), {});
  assert.deepEqual(redactHeaders(null), {});
});

// ---- bodies --------------------------------------------------------------------------

test('a password field is removed by name', () => {
  const out = redactBody({ username: 'alice', password: 'Correct-Horse-1' });

  assert.equal(out.username, 'alice');
  assert.equal(out.password, REDACTED);
});

test('the spellings a real application uses are all matched', () => {
  const out = redactBody({
    passwd: 'x', pwd: 'x', newPassword: 'x', currentPassword: 'x', confirmPassword: 'x',
    clientSecret: 'x', api_key: 'x', accessToken: 'x', refresh_token: 'x', idToken: 'x',
    sessionId: 'x', private_key: 'x', credentials: 'x', password_hash: 'x',
    pin: 'x', cvv: 'x', card_number: 'x', ssn: 'x'
  });

  for (const [name, value] of Object.entries(out)) {
    assert.equal(value, REDACTED, name);
  }
});

test('a nested field is reached, however deep', () => {
  const out = redactBody({ user: { profile: { password: 'secret', name: 'Alice' } } });

  assert.equal(out.user.profile.password, REDACTED);
  assert.equal(out.user.profile.name, 'Alice');
});

test('a field inside an array of objects is reached', () => {
  const out = redactBody({ users: [{ name: 'a', password: 'p1' }, { name: 'b', password: 'p2' }] });

  assert.equal(out.users[0].password, REDACTED);
  assert.equal(out.users[1].password, REDACTED);
  assert.equal(out.users[0].name, 'a');
});

test('a string body is cleaned by shape', () => {
  const out = redactBody('token=eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig-value-here');

  assert.ok(!out.includes('eyJhbGciOi'));
});

test('numbers, booleans and null pass through unharmed', () => {
  const out = redactBody({ count: 3, ok: true, missing: null, nothing: undefined });

  assert.equal(out.count, 3);
  assert.equal(out.ok, true);
  assert.equal(out.missing, null);
  assert.equal(redactBody(null), null);
  assert.equal(redactBody(undefined), undefined);
  assert.equal(redactBody(7), 7);
});

// ---- the directory that gets written -------------------------------------------------

const exchange = (overrides = {}) => ({
  method: 'POST',
  url: 'https://app.test/auth/sign-in',
  requestHeaders: { authorization: 'Bearer abcdefghijklmnop', 'content-type': 'application/json' },
  requestBody: { username: 'alice', password: 'Correct-Horse-1' },
  status: 200,
  responseHeaders: { 'set-cookie': 'session=sess-abcdef123456; HttpOnly' },
  responseBody: { token: 'eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig-value-here' },
  as: 'alice',
  note: 'signing in',
  ...overrides
});

const finding = (overrides = {}) => ({
  title: 'A session cookie is missing HttpOnly',
  category: 'InsecureCookieAttributes',
  severity: 'Medium',
  confidence: 'High',
  status: 'Open',
  description: 'The cookie is readable by script.',
  application: 'app.test',
  ...overrides
});

test('a finding with no exchange is refused, because that is a claim and not a finding', () => {
  const root = sandbox();

  for (const exchanges of [[], undefined, null, 'not an array']) {
    assert.throws(() => writeFindingEvidence({ root, findingId: 'f1', finding: finding(), exchanges }),
      /no request\/response exchange/);
  }
  // And nothing is left behind on disk.
  assert.deepEqual(readdirSync(root), []);
});

test('both copies are written: what happened, and what is safe to circulate', () => {
  const root = sandbox();

  const result = writeFindingEvidence({
    root, findingId: 'f1', finding: finding(), exchanges: [exchange()]
  });

  for (const file of ['request.txt', 'response.txt', 'sanitized-request.txt',
                      'sanitized-response.txt', 'reproduction.md', 'metadata.json', 'sha256.txt']) {
    assert.ok(readdirSync(result.dir).includes(file), file);
  }
});

test('the sanitized copy carries no secret from any part of the exchange', () => {
  const root = sandbox();

  const { dir } = writeFindingEvidence({
    root, findingId: 'f1', finding: finding(), exchanges: [exchange()]
  });

  const safe = readFileSync(resolve(dir, 'sanitized-request.txt'), 'utf8')
    + readFileSync(resolve(dir, 'sanitized-response.txt'), 'utf8');

  for (const secret of ['abcdefghijklmnop', 'Correct-Horse-1', 'sess-abcdef123456',
                        'eyJhbGciOi']) {
    assert.ok(!safe.includes(secret), `${secret} survived into the sanitized copy`);
  }
  // And it is still readable as evidence.
  assert.match(safe, /POST https:\/\/app\.test\/auth\/sign-in/);
  assert.match(safe, /HTTP 200/);
});

test('the raw copy keeps what actually happened, which is the point of having two', () => {
  const root = sandbox();

  const { dir } = writeFindingEvidence({
    root, findingId: 'f1', finding: finding(), exchanges: [exchange()]
  });

  const raw = readFileSync(resolve(dir, 'request.txt'), 'utf8');
  assert.ok(raw.includes('Correct-Horse-1'));
});

test('several exchanges are all written and numbered', () => {
  const root = sandbox();

  const { dir } = writeFindingEvidence({
    root, findingId: 'f1', finding: finding(),
    exchanges: [exchange(), exchange({ status: 403, note: 'refused' })]
  });

  const request = readFileSync(resolve(dir, 'request.txt'), 'utf8');
  assert.match(request, /\(1 of 2\)/);
  assert.match(request, /\(2 of 2\)/);
});

test('a single exchange is not numbered, because there is nothing to distinguish', () => {
  const root = sandbox();
  const { dir } = writeFindingEvidence({
    root, findingId: 'f1', finding: finding(), exchanges: [exchange()]
  });

  assert.ok(!readFileSync(resolve(dir, 'request.txt'), 'utf8').includes('1 of 1'));
});

test('the reproduction tells somebody what to do and what they should see', () => {
  const root = sandbox();

  const { dir } = writeFindingEvidence({
    root, findingId: 'f1', finding: finding(), exchanges: [exchange()]
  });

  const steps = readFileSync(resolve(dir, 'reproduction.md'), 'utf8');
  assert.match(steps, /POST https:\/\/app\.test\/auth\/sign-in/);
  assert.match(steps, /as alice/);
  assert.match(steps, /HTTP 200 — signing in/);
  assert.match(steps, /The cookie is readable by script/);
  assert.match(steps, /\(not computed\)/);
});

test('the metadata records what the finding is and how many exchanges back it', () => {
  const root = sandbox();

  const { dir } = writeFindingEvidence({
    root, findingId: 'f1',
    finding: finding({ cwe: 'CWE-1004', endpoint: '/auth/sign-in' }),
    exchanges: [exchange(), exchange()]
  });

  const meta = JSON.parse(readFileSync(resolve(dir, 'metadata.json'), 'utf8'));
  assert.equal(meta.findingId, 'f1');
  assert.equal(meta.cwe, 'CWE-1004');
  assert.equal(meta.endpoint, '/auth/sign-in');
  assert.equal(meta.exchanges, 2);
  assert.ok(meta.files.includes('sanitized-request.txt'));
  assert.ok(meta.recordedAt);
});

test('the digest covers the sanitized pair, so a report can show it links to what was written', () => {
  const root = sandbox();

  const first = writeFindingEvidence({
    root, findingId: 'f1', finding: finding(), exchanges: [exchange()]
  });
  const again = writeFindingEvidence({
    root, findingId: 'f2', finding: finding(), exchanges: [exchange()]
  });
  const different = writeFindingEvidence({
    root, findingId: 'f3', finding: finding(), exchanges: [exchange({ status: 500 })]
  });

  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(first.digest, again.digest);
  assert.notEqual(first.digest, different.digest);
  assert.match(readFileSync(resolve(first.dir, 'sha256.txt'), 'utf8'), /^[0-9a-f]{64} /);
});

test('an extra file is written, and redacted on the way', () => {
  const root = sandbox();

  const { dir, files } = writeFindingEvidence({
    root, findingId: 'f1', finding: finding(), exchanges: [exchange()],
    extras: { 'notes.txt': 'the token was Bearer abcdefghijklmnop' }
  });

  assert.ok(files.includes('notes.txt'));
  const notes = readFileSync(resolve(dir, 'notes.txt'), 'utf8');
  assert.ok(!notes.includes('abcdefghijklmnop'));
});

test('a binary extra is written untouched, because redacting a screenshot corrupts it', () => {
  const root = sandbox();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const { dir } = writeFindingEvidence({
    root, findingId: 'f1', finding: finding(), exchanges: [exchange()],
    extras: { 'screenshot.png': png }
  });

  assert.deepEqual(readFileSync(resolve(dir, 'screenshot.png')), png);
});

test('an empty extra is skipped rather than written as the word null', () => {
  const root = sandbox();

  const { dir } = writeFindingEvidence({
    root, findingId: 'f1', finding: finding(), exchanges: [exchange()],
    extras: { 'nothing.txt': null, 'missing.txt': undefined }
  });

  assert.ok(!readdirSync(dir).includes('nothing.txt'));
  assert.ok(!readdirSync(dir).includes('missing.txt'));
});

test('an exchange with no headers or body still writes readable evidence', () => {
  const root = sandbox();

  const { dir } = writeFindingEvidence({
    root, findingId: 'f1', finding: finding(),
    exchanges: [{ method: 'GET', url: 'https://app.test/x', status: 204 }]
  });

  assert.match(readFileSync(resolve(dir, 'response.txt'), 'utf8'), /HTTP 204/);
});
