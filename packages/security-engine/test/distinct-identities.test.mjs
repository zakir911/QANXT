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

/**
 * A resource whose ownership nobody established.
 *
 * The worker can now derive the owner's record from an address discovery reached, which is
 * what let authz.bola run at all. It is also how the check came within one control group of
 * reporting an IDOR on every record two roles may legitimately share: pointed at freight's
 * `/api/shipments/{id}` with the identifier read off a sample URL, it reported "readonly can
 * read a resource owned by ops.lead". The application was right — `role-viewer` holds
 * `shipment:read` by design and shipments belong to customers, not users — and the finding
 * was wrong. It persisted with the planted defect switched off, which is what caught it.
 */
const reads = (body) => ({
  async request() {
    return { allowed: true, status: 200, responseBody: body, headers: { get: () => null } };
  }
});

test('a derived resource both identities can read is inconclusive, not a finding', async () => {
  const result = await checkBola(reads({ id: 'shp-0001', reference: 'MF770000' }), {
    baseUrl: 'http://app.test', path: '/api/shipments/{id}',
    owner: { label: 'ops.lead', cookie: 'session=a', headers: {}, resourceId: 'shp-0001' },
    intruder: { label: 'readonly', cookie: 'session=b', headers: {} },
    resourceOwnership: 'assumed'
  });

  assert.equal(result.findings.length, 0);
  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /nothing establishes that it was private to the first/);
  assert.match(result.reason, /a record two roles may both read is the ordinary case/);
});

test('a declared resource both identities can read is still a finding', async () => {
  // The caller named the record, which is the caller asserting it belongs to that identity.
  // The guard must not swallow the finding it exists to allow.
  const result = await checkBola(reads({ id: 'ord-77', total: 120 }), {
    baseUrl: 'http://app.test', path: '/api/orders/{id}',
    owner: { label: 'alice', cookie: 'session=a', headers: {}, resourceId: 'ord-77' },
    intruder: { label: 'bob', cookie: 'session=b', headers: {} }
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].cwe, 'CWE-639');
  assert.match(result.findings[0].title, /bob can read a resource owned by alice/);
});

test('a derived resource the second identity is refused is a pass, which is why deriving is worth it', async () => {
  // The value the derivation buys: the check can now reach a verdict at all where it used to
  // stop at "no resource was supplied".
  const refusing = {
    calls: 0,
    async request() {
      this.calls += 1;
      return this.calls === 1
        ? { allowed: true, status: 200, responseBody: { id: 'shp-0001' }, headers: { get: () => null } }
        : { allowed: true, status: 403, responseBody: { error: 'forbidden' }, headers: { get: () => null } };
    }
  };

  const result = await checkBola(refusing, {
    baseUrl: 'http://app.test', path: '/api/shipments/{id}',
    owner: { label: 'ops.lead', cookie: 'session=a', headers: {}, resourceId: 'shp-0001' },
    intruder: { label: 'readonly', cookie: 'session=b', headers: {} },
    resourceOwnership: 'assumed'
  });

  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
  assert.notEqual(result.inconclusive, true);
});

/**
 * Which routes name themselves administrative.
 *
 * The vertical-escalation check reports a finding when two roles both reach a route *and* the
 * route's own name says it was meant to be restricted. The name list had three business
 * domains in it — billing, invoices, reports — and freight produced seven high-severity
 * findings naming routes a finance team uses as its job:
 *
 *   high | operations reaches /billing/payments, which names itself administrative
 *
 * All seven wrong, and in the costliest direction: a reader who checks two, finds the
 * application correct, and stops reading has been taught to skim the report.
 */
test('a business domain does not name itself administrative', async () => {
  const { looksPrivileged } = await import('../src/checks-authz.mjs');

  for (const path of ['/billing/payments', '/billing/invoices/new', '/billing/surcharges',
                      '/reports/builder', '/reports/export', '/reports/scheduled',
                      '/invoices/5003', '/shipments', '/customers', '/claims/new']) {
    assert.equal(looksPrivileged(path), false, `${path} is not an administrative route`);
  }
});

test('the administration of the application still does', async () => {
  const { looksPrivileged } = await import('../src/checks-authz.mjs');

  for (const path of ['/admin/users', '/admin/api-keys', '/administration/roles',
                      '/settings/permissions', '/system/config', '/back-office/staff',
                      '/internal/console', '/admin/audit']) {
    assert.equal(looksPrivileged(path), true, `${path} is an administrative route`);
  }
});
