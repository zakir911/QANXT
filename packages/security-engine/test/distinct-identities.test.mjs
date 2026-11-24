import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBola, checkVerticalEscalation, checkReadOnlyWrite } from '../src/checks-authz.mjs';

/**
 * A comparison check handed one identity twice.
 *
 * This is not hypothetical. The worker resolved two of its three identity slots by position
 * rather than by the role the caller declared, and a launcher sending privileged, owner,
 * readonly in that order got the administrator as both the privileged and the lesser
 * identity. authz.vertical then compared him with himself across five targets and reported
 * that both roles reached the route.
 *
 * The output was not a false finding. It was "inconclusive", with a sentence about most
 * routes being reachable by every role — which reads as a scoping limit a reader might accept
 * and was in fact a check that could not have failed. That is the more dangerous shape, so
 * the engine refuses the comparison itself rather than trusting whoever calls it.
 */

const actor = (label, extra = {}) => ({ label, cookie: `session=${label}`, headers: {}, ...extra });
const unreachable = {
  async request() { throw new Error('a refused comparison must issue no request'); }
};

test('vertical escalation refuses the same identity as both roles', async () => {
  const admin = actor('administrator');
  const result = await checkVerticalEscalation(unreachable, {
    baseUrl: 'http://app.test', path: '/admin/users', privileged: admin, lesser: admin
  });

  assert.equal(result.inconclusive, true);
  assert.equal(result.findings.length, 0);
  assert.match(result.reason, /^Not evaluated:/);
  assert.match(result.reason, /the same one \(administrator\)/);
  assert.match(result.reason, /lesser identity holds every privilege/);
});

test('two identities sharing a session cookie are the same identity', async () => {
  // The same credential under two names. Labels would say these are different.
  const result = await checkVerticalEscalation(unreachable, {
    baseUrl: 'http://app.test', path: '/admin/users',
    privileged: { label: 'administrator', cookie: 'session=a', headers: {} },
    lesser: { label: 'operations', cookie: 'session=a', headers: {} }
  });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /the same session cookie/);
});

test('two identities sharing authentication headers are the same identity', async () => {
  const result = await checkBola(unreachable, {
    baseUrl: 'http://app.test', path: '/api/orders/{id}',
    owner: { label: 'one', cookie: null, headers: { authorization: 'Bearer t' }, resourceId: '7' },
    intruder: { label: 'two', cookie: null, headers: { authorization: 'Bearer t' } }
  });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /identical authentication headers/);
});

test('bola refuses an identity reading its own record', async () => {
  const one = actor('operations', { resourceId: '7' });
  const result = await checkBola(unreachable, {
    baseUrl: 'http://app.test', path: '/api/orders/{id}', owner: one, intruder: one
  });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /reading its own record is the application working/);
});

test('the read-only check refuses one identity playing both parts', async () => {
  const one = actor('administrator');
  const result = await checkReadOnlyWrite(unreachable, {
    baseUrl: 'http://app.test', path: '/api/orders', writer: one, readonly: one
  });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /establishes nothing about one that is not/);
});

test('two genuinely different identities are compared, not refused', async () => {
  // The guard must not be so eager that it refuses the comparison it exists to protect.
  const asked = [];
  const scanner = {
    async request({ testId, headers }) {
      asked.push({ testId, headers });
      return { allowed: true, status: 200, responseBody: 'ok', headers: { get: () => null } };
    }
  };

  const result = await checkVerticalEscalation(scanner, {
    baseUrl: 'http://app.test', path: '/reports',
    privileged: actor('administrator'), lesser: actor('operations')
  });

  assert.notEqual(result.reason?.startsWith('Not evaluated: the privileged'), true);
  assert.equal(asked.length, 2, 'both identities must actually be asked');
});

test('two identities differing only in label, with no credential at all, are not treated as one', async () => {
  // An anonymous comparison is a different problem from a duplicated identity, and conflating
  // them would hide it behind the wrong sentence.
  const asked = [];
  const scanner = {
    async request({ testId }) {
      asked.push(testId);
      return { allowed: true, status: 200, responseBody: 'ok', headers: { get: () => null } };
    }
  };

  const result = await checkVerticalEscalation(scanner, {
    baseUrl: 'http://app.test', path: '/reports',
    privileged: { label: 'administrator', cookie: null, headers: {} },
    lesser: { label: 'operations', cookie: null, headers: {} }
  });

  assert.equal(asked.length, 2);
  assert.equal(/the same one/.test(result.reason ?? ''), false);
});
