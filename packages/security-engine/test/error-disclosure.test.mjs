import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/index.mjs';

/**
 * An identifier the endpoint cannot parse: refused cleanly, or answered with the inside of
 * the application.
 *
 * The check a reviewer makes in the first minute, and one the product had no way to make.
 * Measured: an order API that answers an unparseable id with a Node stack trace and absolute
 * paths, reported by nothing, because the passive checks only ever read responses the
 * application chose to give and no check provoked one.
 */

/** A scanner stub that answers from a table, and records what it was asked. */
function scannerAnswering(answers) {
  const asked = [];
  return {
    asked,
    async request({ url, method, testId, note }) {
      asked.push({ url, method, testId, note });
      const match = Object.entries(answers).find(([fragment]) => url.includes(fragment));
      const answer = match ? match[1] : { status: 404, responseBody: '{"error":"not_found"}' };
      return { allowed: true, url, method, ...answer };
    }
  };
}

const NODE_STACK = [
  'TypeError: Cannot read properties of undefined',
  '    at readOrder (/srv/northwind/orders.js:88:21)',
  '    at processTicksAndRejections (node:internal/process/task_queues:95:5)'
].join('\n');

test('a stack trace in the answer is reported, with the paths as evidence', async () => {
  const scanner = scannerAnswering({ 'not-an-identifier': { status: 500, responseBody: NODE_STACK } });

  const result = await api.checkErrorDisclosure(scanner, {
    baseUrl: 'http://api.test', path: '/api/orders/{id}'
  });

  assert.equal(result.skipped, false);
  const disclosure = result.findings.find(f => f.category === 'VerboseErrorDisclosure');
  assert.ok(disclosure, 'the stack trace should be its own finding');
  assert.equal(disclosure.cwe, 'CWE-209');
  assert.equal(disclosure.parameter, 'id');
  assert.match(disclosure.description, /stack trace/);
});

test('failing where it should refuse is a separate finding from disclosing', async () => {
  // 500 with a sentence: the endpoint failed, and told nobody anything.
  const scanner = scannerAnswering({ '/api/orders/': { status: 500, responseBody: '{"error":"server_error"}' } });

  const result = await api.checkErrorDisclosure(scanner, {
    baseUrl: 'http://api.test', path: '/api/orders/{id}'
  });

  assert.equal(result.findings.some(f => f.category === 'VerboseErrorDisclosure'), false,
    'nothing was disclosed, so nothing should be reported as disclosed');
  const unhandled = result.findings.find(f => f.category === 'UnhandledInput');
  assert.ok(unhandled, 'the 5xx is still a finding on its own');
  assert.equal(unhandled.cwe, 'CWE-20');
});

test('an endpoint that refuses cleanly is reported as fine, with what it answered', async () => {
  const scanner = scannerAnswering({ '/api/orders/': { status: 400, responseBody: '{"error":"bad id"}' } });

  const result = await api.checkErrorDisclosure(scanner, {
    baseUrl: 'http://api.test', path: '/api/orders/{id}'
  });

  assert.equal(result.findings.length, 0);
  assert.equal(result.ok, true);
  assert.match(result.detail, /400/);
});

test('three shapes of unparseable identifier are sent, each once, as GETs', async () => {
  const scanner = scannerAnswering({});

  await api.checkErrorDisclosure(scanner, { baseUrl: 'http://api.test', path: '/api/orders/{id}' });

  assert.equal(scanner.asked.length, 3);
  assert.ok(scanner.asked.every(request => request.method === 'GET'),
    'an error-handling check must not change anything');
  assert.deepEqual(scanner.asked.map(r => r.testId),
    ['SECA-ERRDISC:not-an-identifier', 'SECA-ERRDISC:negative', 'SECA-ERRDISC:oversized']);
});

/** Nothing resembling an attack is sent: this is error handling, and a probe that looked
 *  like an exploit attempt would be refused by the scope guard for the wrong reason. */
test('no probe looks like an attack', async () => {
  const scanner = scannerAnswering({});

  await api.checkErrorDisclosure(scanner, { baseUrl: 'http://api.test', path: '/api/orders/{id}' });

  for (const { url } of scanner.asked) {
    assert.ok(!/\.\.|%2e%2e|<script|union\s+select|;|\|/i.test(decodeURIComponent(url)),
      `probe should carry nothing attack-shaped: ${url}`);
  }
});

test('an endpoint with no identifier reaches no verdict, and says why', async () => {
  // This asserted `skipped: true` with the reason in `decision`, and pinned two mistakes.
  //
  // `skipped` means the scope guard refused the request — the worker's own note for it reads
  // "Refused by the scope guard" — and nothing was refused here. The check simply cannot
  // evaluate an endpoint with no identifier in its path, which is what `inconclusive` is for,
  // and the distinction between "not permitted" and "not evaluable" is one this product is
  // built on.
  //
  // `decision` is the guard's decision object everywhere else it appears. A sentence in that
  // slot meant the worker read `.reason` off a string, got undefined, and logged "Refused by
  // the scope guard: unknown" — so the one sentence explaining what happened went nowhere.
  // Measured on the freight target, where this was the only outcome this check produced.
  const scanner = scannerAnswering({});

  const result = await api.checkErrorDisclosure(scanner, {
    baseUrl: 'http://api.test', path: '/api/orders'
  });

  assert.equal(result.inconclusive, true);
  assert.equal(result.skipped, false, 'nothing refused this; it could not be evaluated');
  assert.match(result.reason, /takes no identifier/);
  assert.equal(result.decision, undefined, 'a sentence in the decision slot is how the reason was lost');
  assert.equal(result.findings.length, 0);
  assert.equal(scanner.asked.length, 0, 'a check that cannot evaluate must send nothing');
});
