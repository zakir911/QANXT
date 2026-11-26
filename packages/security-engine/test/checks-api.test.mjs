import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkErrorDisclosure, checkExcessiveData, checkInputValidation, checkMassAssignment,
  checkRateLimit, checkUnsafeMethods
} from '../src/checks-api.mjs';

/**
 * The API checks: 44.9% line coverage, no test file.
 *
 * Two of these change data — mass assignment sends a PATCH, unsafe methods creates something
 * and then tries to delete it — so the tests assert what gets sent as carefully as what gets
 * concluded. A check that reports nothing but writes to somebody's application is worse than
 * one that reports nothing.
 */

/** Answers from a script keyed by the part of the test id after the colon. */
function stub(answers, fallback) {
  const sent = [];
  return {
    sent,
    async request(options) {
      sent.push(options);
      const id = String(options.testId).split(':').slice(1).join(':');
      const answer = answers[id] ?? fallback;
      if (answer === undefined) throw new Error(`no scripted answer for '${id}'`);
      return { allowed: true, ...answer };
    }
  };
}

const refuses = () => ({
  sent: [],
  async request() { return { allowed: false, decision: { reason: 'activeTestingNotAllowed' } }; }
});

const at = 'http://app.test';
const actor = { label: 'alice', cookie: 'session=a', resourceId: 'ord-1' };

// ---- a field the client should not be able to set ------------------------------------

test('a privileged field the server accepted and applied is a finding', async () => {
  const scanner = stub({
    before: { status: 200, responseBody: { role: 'user' } },
    role: { status: 200, responseBody: { applied: ['role'] } }
  }, { status: 400, responseBody: {} });

  const result = await checkMassAssignment(scanner, { baseUrl: at, path: '/api/orders/{id}', actor });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'BrokenObjectPropertyLevelAuthorization');
});

test('a server that echoes the escalated value back is a finding too', async () => {
  const scanner = stub({
    before: { status: 200, responseBody: {} },
    isAdmin: { status: 200, responseBody: { isAdmin: 'admin' } }
  }, { status: 400, responseBody: {} });

  const result = await checkMassAssignment(scanner, { baseUrl: at, path: '/api/orders/{id}', actor });

  assert.equal(result.findings.length, 1);
});

test('a server that refuses every privileged field is clean', async () => {
  const scanner = stub({ before: { status: 200, responseBody: {} } },
                       { status: 403, responseBody: { error: 'forbidden' } });

  const result = await checkMassAssignment(scanner, { baseUrl: at, path: '/api/orders/{id}', actor });

  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
});

test('a 200 that neither applied nor echoed the field is not a finding', async () => {
  // Plenty of APIs answer 200 and ignore what they do not recognise. Reading that as
  // escalation would be a false finding on correct behaviour.
  const scanner = stub({
    before: { status: 200, responseBody: {} },
    role: { status: 200, responseBody: { applied: ['title'] } }
  }, { status: 200, responseBody: { applied: [] } });

  assert.equal((await checkMassAssignment(scanner, { baseUrl: at, path: '/api/orders/{id}', actor })).ok, true);
});

test('the identifier is put into the path, so the probe reaches a real record', async () => {
  const scanner = stub({ before: { status: 200, responseBody: {} } }, { status: 403 });

  await checkMassAssignment(scanner, { baseUrl: at, path: '/api/orders/{id}', actor });

  assert.ok(scanner.sent.every(r => r.url.includes('/api/orders/ord-1')));
  assert.ok(scanner.sent.every(r => !r.url.includes('{id}')));
});

test('each write it sends is declared state-changing, so the guard governs it', async () => {
  const scanner = stub({ before: { status: 200, responseBody: {} } }, { status: 403 });

  await checkMassAssignment(scanner, { baseUrl: at, path: '/api/orders/{id}', actor });

  const writes = scanner.sent.filter(r => r.method === 'PATCH');
  assert.ok(writes.length > 0);
  assert.ok(writes.every(r => r.risk === 2), 'every PATCH declares state-changing risk');
});

test('a refusal partway through stops the check rather than reporting a partial answer', async () => {
  let calls = 0;
  const scanner = {
    sent: [],
    async request(options) {
      calls += 1;
      if (calls === 1) return { allowed: true, status: 200, responseBody: {} };
      return { allowed: false, decision: { reason: 'destructiveTestingNotAllowed' } };
    }
  };

  const result = await checkMassAssignment(scanner, { baseUrl: at, path: '/api/orders/{id}', actor });

  assert.equal(result.skipped, true);
  assert.equal(result.decision.reason, 'destructiveTestingNotAllowed');
});

// ---- input the endpoint should refuse -------------------------------------------------

test('an endpoint that accepts every malformed value is a finding', async () => {
  const scanner = stub({}, { status: 201, responseBody: { id: 1 } });

  const result = await checkInputValidation(scanner, { baseUrl: at, path: '/api/orders', field: 'title', actor });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'MissingInputValidation');
});

test('an endpoint that refuses any one of them is clean', async () => {
  // The check wants all three accepted before it says anything: one refusal shows the
  // endpoint validates something.
  const scanner = stub({
    'wrong-type': { status: 201 }, empty: { status: 400 }, oversized: { status: 201 }
  });

  const result = await checkInputValidation(scanner, { baseUrl: at, path: '/api/orders', field: 'title', actor });

  assert.equal(result.ok, true);
});

test('the oversized probe is a declared length, not a gigabyte on the wire', async () => {
  const scanner = stub({}, { status: 400 });

  await checkInputValidation(scanner, { baseUrl: at, path: '/api/orders', field: 'title', actor,
                                        maxLength: 5000 });

  const oversized = scanner.sent.find(r => String(r.testId).endsWith(':oversized'));
  assert.equal(oversized.body.title.length, 5000);
  // A scanner that uploads a gigabyte to test a size limit is running a load test.
  assert.ok(JSON.stringify(oversized.body).length < 20_000);
});

test('a refusal stops it', async () => {
  const result = await checkInputValidation(refuses(), { baseUrl: at, path: '/api/orders', field: 'title', actor });
  assert.equal(result.skipped, true);
});

// ---- an identifier the endpoint cannot parse -----------------------------------------

test('a stack trace in the response is a finding', async () => {
  const trace = 'System.FormatException: Input string was not in a correct format\n'
    + '   at QaNxt.Api.Controllers.OrdersController.Get(String id) in '
    + '/src/QaNxt.Api/Controllers/OrdersController.cs:line 42';
  const scanner = stub({}, { status: 500, responseBody: trace, responseText: trace });

  const result = await checkErrorDisclosure(scanner, { baseUrl: at, path: '/api/orders/{id}', actor });

  // Both faults are reported, because they are two different problems with two different
  // fixes: the trace leaks source paths, and the endpoint fell over on input it should have
  // refused. Collapsing them into one would lose whichever the reader did not act on.
  const categories = result.findings.map(f => f.category).sort();
  assert.deepEqual(categories, ['UnhandledInput', 'VerboseErrorDisclosure']);
  const leak = result.findings.find(f => f.category === 'VerboseErrorDisclosure');
  assert.match(leak.description, /stack trace/);
});

test('a 500 with no trace is reported as unhandled input, which is a different fault', async () => {
  // The two are not the same finding: one leaks source paths, the other is an endpoint that
  // falls over on input it should refuse. Reporting either as the other misdirects the fix.
  const scanner = stub({}, { status: 500, responseBody: '{"error":"Internal Server Error"}' });

  const result = await checkErrorDisclosure(scanner, { baseUrl: at, path: '/api/orders/{id}', actor });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'UnhandledInput');
});

test('a clean refusal of an unparseable identifier is clean', async () => {
  const scanner = stub({}, { status: 400, responseText: '{"error":"invalid id"}' });

  const result = await checkErrorDisclosure(scanner, { baseUrl: at, path: '/api/orders/{id}', actor });

  assert.equal(result.findings.length, 0);
});

test('an endpoint that takes no identifier is not probed at all', async () => {
  // There is nothing to make unparseable, so the check says so rather than inventing a probe.
  const scanner = stub({}, { status: 200 });

  const result = await checkErrorDisclosure(scanner, { baseUrl: at, path: '/api/orders', actor });

  assert.equal(result.findings.length, 0);
  assert.equal(scanner.sent.length, 0);
});

test('reading an identifier is passive, because an unauthenticated caller could do it', async () => {
  const scanner = stub({}, { status: 400, responseText: 'no' });

  await checkErrorDisclosure(scanner, { baseUrl: at, path: '/api/orders/{id}', actor });

  assert.ok(scanner.sent.every(r => r.risk === 0 && r.method === 'GET'));
});

test('a refusal stops it', async () => {
  const result = await checkErrorDisclosure(refuses(), { baseUrl: at, path: '/api/orders/{id}', actor });
  assert.equal(result.skipped, true);
});

// ---- too many requests ----------------------------------------------------------------

test('an endpoint that never slows down is a finding', async () => {
  const scanner = stub({}, { status: 200 });

  const result = await checkRateLimit(scanner, { baseUrl: at, path: '/api/orders', attempts: 15, actor });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'NoRateLimit');
  assert.equal(scanner.sent.length, 15);
});

test('a 429 anywhere in the burst is clean, and the report says where', async () => {
  const answers = {};
  for (let i = 1; i <= 15; i += 1) answers[String(i)] = { status: i >= 6 ? 429 : 200 };
  const scanner = stub(answers);

  const result = await checkRateLimit(scanner, { baseUrl: at, path: '/api/orders', attempts: 15, actor });

  assert.equal(result.ok, true);
  assert.match(result.detail, /429 at request 6 of 15/);
});

test('the burst is bounded by what the caller asked for', async () => {
  const scanner = stub({}, { status: 200 });

  await checkRateLimit(scanner, { baseUrl: at, path: '/api/orders', attempts: 3, actor });

  assert.equal(scanner.sent.length, 3);
});

test('a refusal stops it, so the scope limit is not fought with a burst', async () => {
  const result = await checkRateLimit(refuses(), { baseUrl: at, path: '/api/orders', actor });
  assert.equal(result.skipped, true);
});

// ---- more than the client needs -------------------------------------------------------

test('a secret-shaped field name in the response is a finding, matched on the key', async () => {
  const scanner = stub({}, {
    status: 200,
    responseBody: { id: 1, name: 'Alice', passwordHash: '$2b$12$abcdefghijklmnopqrstuv' }
  });

  const result = await checkExcessiveData(scanner, { baseUrl: at, path: '/api/users/1', actor });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'SensitiveDataExposure');
});

test('a nested secret field is found too', async () => {
  const scanner = stub({}, {
    status: 200, responseBody: { data: { user: { salt: 'abc' } } }
  });

  assert.equal((await checkExcessiveData(scanner, { baseUrl: at, path: '/api/users/1', actor })).findings.length, 1);
});

test('an ordinary response is clean', async () => {
  const scanner = stub({}, { status: 200, responseBody: { id: 1, name: 'Alice', email: 'a@b.test' } });

  const result = await checkExcessiveData(scanner, { baseUrl: at, path: '/api/users/1', actor });

  assert.equal(result.ok, true);
  assert.match(result.detail, /no secret-shaped field names/);
});

test('an endpoint that did not answer 200 reaches no verdict and says which status', async () => {
  const scanner = stub({}, { status: 403, responseBody: {} });

  const result = await checkExcessiveData(scanner, { baseUrl: at, path: '/api/users/1', actor });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /answered 403/);
});

test('a refusal stops it', async () => {
  const result = await checkExcessiveData(refuses(), { baseUrl: at, path: '/api/users/1', actor });
  assert.equal(result.skipped, true);
});

// ---- create and then try to delete ----------------------------------------------------

test('nothing is created when there is nowhere to delete it from', async () => {
  // The one outcome this check must not have: an object left behind in somebody's
  // application because it could not reach the address that would remove it. It used to
  // create the object and then throw a TypeError on the missing path.
  const scanner = stub({}, { status: 201, responseBody: { id: 'ord-9' } });

  const result = await checkUnsafeMethods(scanner, { baseUrl: at, createPath: '/api/orders', actor });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /will not create something it cannot then remove/);
  assert.equal(scanner.sent.length, 0, 'and it sent nothing at all');
});

test('nor when there is nowhere to create one', async () => {
  const scanner = stub({}, { status: 201, responseBody: { id: 'ord-9' } });

  const result = await checkUnsafeMethods(scanner, {
    baseUrl: at, deletePath: '/api/orders/{id}', actor });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /no address to create at/);
  assert.equal(scanner.sent.length, 0);
});

test('an unauthenticated DELETE of the probe object that succeeds is a finding', async () => {
  const scanner = stub({
    create: { status: 201, responseBody: { id: 'ord-9' } },
    delete: { status: 204 }
  });

  const result = await checkUnsafeMethods(scanner, {
    baseUrl: at, createPath: '/api/orders', deletePath: '/api/orders/{id}', actor });

  assert.equal(result.findings.length, 1);
  assert.match(scanner.sent.find(r => String(r.testId).endsWith(':delete')).url, /ord-9/);
});

test('a DELETE refused is clean, and the refusal status is reported', async () => {
  for (const status of [401, 403, 405]) {
    const scanner = stub({
      create: { status: 201, responseBody: { id: 'ord-9' } },
      delete: { status }
    });

    const result = await checkUnsafeMethods(scanner, {
      baseUrl: at, createPath: '/api/orders', deletePath: '/api/orders/{id}', actor });

    assert.equal(result.ok, true, String(status));
    assert.match(result.detail, new RegExp(String(status)));
  }
});

test('a create that failed stops it, and it will not delete what it did not create', async () => {
  const scanner = stub({ create: { status: 403, responseBody: {} } });

  const result = await checkUnsafeMethods(scanner, {
    baseUrl: at, createPath: '/api/orders', deletePath: '/api/orders/{id}', actor });

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /will not\s+delete one it did not create/);
  assert.equal(scanner.sent.filter(r => r.method === 'DELETE').length, 0);
});

test('a create that returned no identifier stops it, with nothing to aim at', async () => {
  const scanner = stub({ create: { status: 201, responseBody: { ok: true } } });

  const result = await checkUnsafeMethods(scanner, {
    baseUrl: at, createPath: '/api/orders', deletePath: '/api/orders/{id}', actor });

  assert.equal(result.inconclusive, true);
  assert.equal(scanner.sent.filter(r => r.method === 'DELETE').length, 0);
});

test('a refusal stops it before anything is created', async () => {
  const result = await checkUnsafeMethods(refuses(), {
    baseUrl: at, createPath: '/api/orders', deletePath: '/api/orders/{id}', actor
  });

  assert.equal(result.skipped, true);
  assert.deepEqual(result.findings, []);
});

test('the create it sends is declared state-changing', async () => {
  const scanner = stub({}, { status: 500, responseBody: {} });

  await checkUnsafeMethods(scanner, {
    baseUrl: at, createPath: '/api/orders', deletePath: '/api/orders/{id}', actor
  });

  const create = scanner.sent.find(r => String(r.testId).endsWith(':create'));
  assert.ok(create);
  assert.equal(create.risk, 2);
});
