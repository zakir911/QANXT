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
