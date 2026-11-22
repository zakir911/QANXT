import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAccountLockout, checkUserEnumeration } from '../src/checks-auth.mjs';

/**
 * Credential probes have to reach the sign-in logic before they judge it.
 *
 * Both checks used to POST JSON at a guessed endpoint. Meridian Freight answers 403 to all
 * of those, from its anti-forgery guard, before any password is looked at — so the lockout
 * check saw six identical non-429 answers and reported "six consecutive failed sign-ins
 * were never throttled". Submitted properly, through the form with its token, the
 * application answers 401 seven times and the verdict holds. It was right by luck, on
 * evidence of a conversation that never took place.
 */

/** A scanner whose submitSignIn the test controls. */
function scannerThatAnswers(answers) {
  let i = 0;
  const sent = [];
  return {
    sent,
    async submitSignIn(baseUrl, username, password, options) {
      sent.push({ username, password, as: options?.as });
      const reply = typeof answers === 'function' ? answers(username, password, i) : answers[i];
      i += 1;
      return { allowed: true, responseHeaders: {}, responseText: '', ...reply };
    },
    async request() { throw new Error('a credential probe must go through submitSignIn'); }
  };
}

test('reports no lockout when the application really does answer every attempt', async () => {
  // Seven 401s and no throttling, which is what the lab does when asked properly.
  const result = await checkAccountLockout(scannerThatAnswers(
    (username) => ({ status: username === '' ? 400 : 401 })),
    { baseUrl: 'http://app.test', path: '/auth/sign-in', knownUser: 'ops.lead' });

  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].title, /never throttled/);
});

test('refuses to conclude when every attempt was refused before sign-in', async () => {
  // The anti-forgery case: six 403s and an empty submission that also answers 403. Six
  // refusals with no 429 among them look exactly like six un-throttled attempts.
  const result = await checkAccountLockout(scannerThatAnswers(() => ({ status: 403 })),
    { baseUrl: 'http://app.test', path: '/auth/sign-in', knownUser: 'ops.lead' });

  assert.equal(result.findings.length, 0);
  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /refused these requests rather than evaluating them/);
});

test('still reports throttling when the application throttles', async () => {
  const result = await checkAccountLockout(scannerThatAnswers(
    (_u, _p, i) => ({ status: i >= 3 ? 429 : 401 })),
    { baseUrl: 'http://app.test', path: '/auth/sign-in', knownUser: 'ops.lead' });

  assert.equal(result.findings.length, 0);
  assert.equal(result.ok, true);
  assert.match(result.detail, /throttled at attempt/);
});

test('the lockout probe never bypasses submitSignIn', async () => {
  // The whole point: a check that builds its own request goes back to guessing an
  // endpoint. The fake throws if `request` is touched.
  await checkAccountLockout(scannerThatAnswers(() => ({ status: 401 })),
    { baseUrl: 'http://app.test', path: '/auth/sign-in', knownUser: 'ops.lead' });
});

test('enumeration compares two answers that both reached the sign-in logic', async () => {
  const scanner = scannerThatAnswers((username) => ({
    status: 401,
    responseText: username === 'ops.lead' ? 'Wrong password' : 'No such user'
  }));

  await checkUserEnumeration(scanner, {
    baseUrl: 'http://app.test', path: '/auth/sign-in', knownUser: 'ops.lead'
  });

  assert.equal(scanner.sent.length, 2);
  assert.equal(scanner.sent[0].username, 'ops.lead');
  assert.notEqual(scanner.sent[1].username, 'ops.lead');
});

test('enumeration sends a deliberately wrong password, never a real one', async () => {
  const scanner = scannerThatAnswers(() => ({ status: 401 }));

  await checkUserEnumeration(scanner, {
    baseUrl: 'http://app.test', path: '/auth/sign-in', knownUser: 'ops.lead'
  });

  for (const sent of scanner.sent) {
    assert.match(sent.password, /deliberately-wrong/,
      'a probe must never attempt a credential that could succeed');
  }
});

/**
 * Whether the endpoint evaluates credentials at all, established positively.
 *
 * The guard above exists because an application that refuses every request before reading
 * a password answers six failed sign-ins identically, and that is not a throttling result.
 * Its control was an empty submission: if every attempt and an empty one answered the same,
 * conclude nothing.
 *
 * That reads an application behaving correctly as one that is not listening. Measured on
 * this project's own token-api target: a wrong password answers 401 invalid_credentials and
 * so does a submission with no credentials — same status, same body, which is reasonable of
 * it and indistinguishable to a negative control. The planted defect went untested behind a
 * guard built to prevent a different false result.
 */
function scannerTracking(answerFor) {
  const sent = [];
  return {
    sent,
    async submitSignIn(baseUrl, username, password, options) {
      sent.push({ username, password, testId: options?.testId });
      return { allowed: true, responseHeaders: {}, responseText: '', ...answerFor(username, password) };
    },
    async request() { throw new Error('a credential probe must go through submitSignIn'); }
  };
}

/** The lab's behaviour: 401 for anything but the one correct password. */
const tokenApi = (username, password) =>
  username === 'alice' && password === 'Token!2026'
    ? { status: 200 }
    : { status: 401 };

test('a wrong password and an empty submission answering alike is still reported', async () => {
  const scanner = scannerTracking(tokenApi);

  const result = await checkAccountLockout(scanner, {
    baseUrl: 'http://app.test', path: '/api/auth/token',
    knownUser: 'alice', knownPassword: 'Token!2026'
  });

  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].title, /never throttled/);
});

test('the correct sign-in is sent first, so a threshold cannot block the control', async () => {
  // If the failures went first and the application did lock out, the control would be
  // refused and the check would conclude nothing about an application that threshold-locks.
  const scanner = scannerTracking(tokenApi);

  await checkAccountLockout(scanner, {
    baseUrl: 'http://app.test', path: '/api/auth/token',
    knownUser: 'alice', knownPassword: 'Token!2026'
  });

  assert.match(scanner.sent[0].testId, /control-valid$/);
  assert.equal(scanner.sent[0].password, 'Token!2026');
});

test('an endpoint that refuses even a correct password still concludes nothing', async () => {
  // The anti-forgery case the guard was built for. Nothing here establishes that the
  // endpoint ever looked at a password, so no finding is the right answer.
  const scanner = scannerTracking(() => ({ status: 403 }));

  const result = await checkAccountLockout(scanner, {
    baseUrl: 'http://app.test', path: '/auth/sign-in',
    knownUser: 'alice', knownPassword: 'Token!2026'
  });

  assert.equal(result.findings.length, 0);
  assert.ok(result.inconclusive || result.skipped);
});

test('throttling is still read as throttling, not as a finding', async () => {
  let n = 0;
  const scanner = scannerTracking((username, password) => {
    if (password === 'Token!2026') return { status: 200 };
    n += 1;
    return { status: n >= 3 ? 429 : 401 };
  });

  const result = await checkAccountLockout(scanner, {
    baseUrl: 'http://app.test', path: '/api/auth/token',
    knownUser: 'alice', knownPassword: 'Token!2026'
  });

  assert.equal(result.findings.length, 0);
  assert.equal(result.ok, true);
});

test('with no password to hand it falls back to the empty-submission control', async () => {
  // An older caller, or an identity whose password the scan does not hold. The previous
  // behaviour has to remain reachable rather than becoming a silent no-op.
  const scanner = scannerTracking(() => ({ status: 401 }));

  const result = await checkAccountLockout(scanner, {
    baseUrl: 'http://app.test', path: '/api/auth/token', knownUser: 'alice'
  });

  assert.equal(result.findings.length, 0);
  assert.ok(result.inconclusive);
});
