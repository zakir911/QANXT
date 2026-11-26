import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCommandInjection, checkNoSqlInjection, checkSqlInjection, checkTemplateInjection
} from '../src/checks-injection.mjs';

/**
 * The four injection checks.
 *
 * 26.8% line coverage and no test file, on the family with the highest cost of being wrong in
 * either direction. A missed SQL injection is the worst finding to miss; a false one sends a
 * team hunting a flaw that is not there, and after two or three of those nobody reads the
 * report.
 *
 * Each of these checks is detection only — it looks for the signature of a flaw and never
 * extracts data, stacks a second statement or runs a command. The tests below assert that
 * restraint as well as the verdicts, because "it found the injection" and "it exploited the
 * injection" are not the same product.
 */

/** A scanner that answers from a script keyed by the part of the test id after the colon. */
function stub(answers) {
  const sent = [];
  return {
    sent,
    async request(options) {
      sent.push(options);
      const id = String(options.testId).split(':')[1] ?? '';
      const answer = answers[id];
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

// ---- SQL ------------------------------------------------------------------------------

test('a database error and a widened result set together are a finding', () => {
  // Two independent indicators: the application complained like a database, and the tautology
  // returned more rows than the benign value did.
  const scanner = stub({
    baseline: { status: 200, responseText: 'ok', responseBody: { matched: 2, rows: [1, 2] } },
    'unbalanced-quote': { status: 500, responseText: 'SQLSTATE[42000]: syntax error near' },
    tautology: { status: 200, responseText: 'ok', responseBody: { matched: 97, rows: [] } }
  });

  return checkSqlInjection(scanner, { baseUrl: at, path: '/search', parameter: 'q' })
    .then(result => {
      assert.equal(result.findings.length, 1);
      const [found] = result.findings;
      assert.equal(found.category, 'SqlInjection');
      assert.equal(found.cwe, 'CWE-89');
      assert.match(found.description, /SQLSTATE/);
      assert.match(found.description, /widening from 2 to 97/);
      // Detection only, and the finding says so rather than leaving it to be assumed.
      assert.match(found.description, /No data was extracted/);
      assert.match(found.coverageNote, /No extraction/);
    });
});

test('an error signature alone is still a finding, but on one indicator', async () => {
  const scanner = stub({
    baseline: { status: 200, responseText: 'ok', responseBody: { matched: 2 } },
    'unbalanced-quote': { status: 500, responseText: 'You have an error in your SQL syntax' },
    tautology: { status: 200, responseText: 'ok', responseBody: { matched: 2 } }
  });

  const result = await checkSqlInjection(scanner, { baseUrl: at, path: '/search', parameter: 'q' });

  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].description, /SQL syntax/);
  assert.ok(!result.findings[0].description.includes('widening'));
});

test('a widened result set alone is a finding, because it is the behavioural indicator', async () => {
  const scanner = stub({
    baseline: { status: 200, responseText: 'ok', responseBody: { rows: [1] } },
    'unbalanced-quote': { status: 200, responseText: 'nothing unusual' },
    tautology: { status: 200, responseText: 'ok', responseBody: { rows: [1, 2, 3, 4] } }
  });

  const result = await checkSqlInjection(scanner, { baseUrl: at, path: '/search', parameter: 'q' });

  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].description, /widening from 1 to 4/);
});

test('an application that handles the input cleanly reads as clean, with the numbers', async () => {
  const scanner = stub({
    baseline: { status: 200, responseText: 'ok', responseBody: { matched: 2 } },
    'unbalanced-quote': { status: 400, responseText: 'That is not a valid search term.' },
    tautology: { status: 200, responseText: 'ok', responseBody: { matched: 2 } }
  });

  const result = await checkSqlInjection(scanner, { baseUrl: at, path: '/search', parameter: 'q' });

  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
  assert.match(result.detail, /no database error signature/);
  assert.match(result.detail, /2 row\(s\) against a baseline of 2/);
});

test('a result set that shrinks is not a finding, because that is not the shape of the flaw', async () => {
  const scanner = stub({
    baseline: { status: 200, responseText: 'ok', responseBody: { matched: 9 } },
    'unbalanced-quote': { status: 200, responseText: 'ok' },
    tautology: { status: 200, responseText: 'ok', responseBody: { matched: 0 } }
  });

  assert.equal((await checkSqlInjection(scanner, { baseUrl: at, path: '/s', parameter: 'q' })).ok, true);
});

test('a response that is not countable reads as clean rather than as a finding', async () => {
  // An HTML page has no row count. Guessing one would invent the indicator.
  const scanner = stub({
    baseline: { status: 200, responseText: '<html>results</html>', responseBody: '<html>results</html>' },
    'unbalanced-quote': { status: 200, responseText: '<html>none</html>' },
    tautology: { status: 200, responseText: '<html>lots</html>', responseBody: '<html>lots</html>' }
  });

  const result = await checkSqlInjection(scanner, { baseUrl: at, path: '/s', parameter: 'q' });

  assert.equal(result.ok, true);
  assert.match(result.detail, /\? row\(s\) against a baseline of \?/);
});

test('every probe it sends is declared active, and it sends exactly three', async () => {
  const scanner = stub({
    baseline: { status: 200, responseText: 'ok', responseBody: { matched: 1 } },
    'unbalanced-quote': { status: 200, responseText: 'ok' },
    tautology: { status: 200, responseText: 'ok', responseBody: { matched: 1 } }
  });

  await checkSqlInjection(scanner, { baseUrl: at, path: '/search', parameter: 'q' });

  assert.equal(scanner.sent.length, 3);
  assert.ok(scanner.sent.every(r => r.risk === 1), 'every probe declares active risk');
  // And it never sends a stacked statement or a sleep.
  const everything = scanner.sent.map(r => r.url).join(' ');
  assert.ok(!/;|sleep|benchmark|waitfor/i.test(decodeURIComponent(everything)));
});

test('a refusal from the scope guard stops the check and is reported, not swallowed', async () => {
  const result = await checkSqlInjection(refuses(), { baseUrl: at, path: '/s', parameter: 'q' });

  assert.equal(result.skipped, true);
  assert.equal(result.decision.reason, 'activeTestingNotAllowed');
  assert.deepEqual(result.findings, []);
});

test('the known database error signatures are all recognised', async () => {
  for (const text of ['SQLSTATE[42000]', 'unclosed quotation mark after', 'ORA-01756: quoted',
                      'PG::SyntaxError: ERROR', 'SQLiteException: near', 'mysql_fetch_array()',
                      'Npgsql.PostgresException', 'unterminated quoted string at or near']) {
    const scanner = stub({
      baseline: { status: 200, responseText: 'ok', responseBody: { matched: 1 } },
      'unbalanced-quote': { status: 500, responseText: text },
      tautology: { status: 200, responseText: 'ok', responseBody: { matched: 1 } }
    });
    const result = await checkSqlInjection(scanner, { baseUrl: at, path: '/s', parameter: 'q' });
    assert.equal(result.findings.length, 1, text);
  }
});

// ---- NoSQL ----------------------------------------------------------------------------

test('a query operator accepted where a string belongs is a finding', async () => {
  // The benign wrong password was refused; the operator object signed in.
  const scanner = stub({
    baseline: { status: 401, responseText: 'no' },
    operator: { status: 200, responseText: '{"token":"x"}' }
  });

  const result = await checkNoSqlInjection(scanner, { baseUrl: at, path: '/api/session' });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'NoSqlInjection');
});

test('an operator refused the same way as a wrong string is clean', async () => {
  const scanner = stub({
    baseline: { status: 401, responseText: 'no' },
    operator: { status: 401, responseText: 'no' }
  });

  const result = await checkNoSqlInjection(scanner, { baseUrl: at, path: '/api/session' });

  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
});

test('nothing is concluded when even the benign value was accepted', async () => {
  // If the wrong password signs in, the endpoint is not checking anything and the operator
  // probe says nothing about operators.
  const scanner = stub({
    baseline: { status: 200, responseText: 'welcome' },
    operator: { status: 200, responseText: 'welcome' }
  });

  assert.equal((await checkNoSqlInjection(scanner, { baseUrl: at, path: '/api/session' })).ok, true);
});

test('the operator probe sends an object, not a string that looks like one', async () => {
  const scanner = stub({
    baseline: { status: 401, responseText: 'no' },
    operator: { status: 401, responseText: 'no' }
  });

  await checkNoSqlInjection(scanner, { baseUrl: at, path: '/api/session' });

  const probe = scanner.sent.find(r => String(r.testId).endsWith(':operator'));
  assert.deepEqual(probe.body.password, { $ne: null });
});

test('a refusal stops it', async () => {
  const result = await checkNoSqlInjection(refuses(), { baseUrl: at, path: '/api/session' });
  assert.equal(result.skipped, true);
});

// ---- shell ----------------------------------------------------------------------------

test('a shell error signature is a finding', async () => {
  const scanner = stub({
    baseline: { status: 200, responseText: 'PING localhost ok' },
    metacharacter: { status: 500, responseText: '/bin/sh: 1: qanxt: not found' }
  });

  const result = await checkCommandInjection(scanner, { baseUrl: at, path: '/tools/ping', parameter: 'host' });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'CommandInjection');
});

test('no shell error is clean', async () => {
  const scanner = stub({
    baseline: { status: 200, responseText: 'PING localhost ok' },
    metacharacter: { status: 400, responseText: 'That is not a valid host.' }
  });

  const result = await checkCommandInjection(scanner, { baseUrl: at, path: '/tools/ping', parameter: 'host' });

  assert.equal(result.ok, true);
});

test('the shell signatures a real server returns are recognised', async () => {
  for (const text of ['/bin/bash: line 1:', 'command not found',
                      "'qanxt' is not recognized as an internal or external command",
                      'sh: 1: Syntax error: word unexpected']) {
    const scanner = stub({
      baseline: { status: 200, responseText: 'ok' },
      metacharacter: { status: 500, responseText: text }
    });
    const result = await checkCommandInjection(scanner, { baseUrl: at, path: '/t', parameter: 'host' });
    assert.equal(result.findings.length, 1, text);
  }
});

test('it never asks the application to run a command that does anything', async () => {
  const scanner = stub({
    baseline: { status: 200, responseText: 'ok' },
    metacharacter: { status: 200, responseText: 'ok' }
  });

  await checkCommandInjection(scanner, { baseUrl: at, path: '/tools/ping', parameter: 'host' });

  const sent = decodeURIComponent(scanner.sent.map(r => r.url).join(' '));
  for (const dangerous of ['rm ', 'curl', 'wget', 'nc ', 'bash -i', '/etc/passwd', 'whoami']) {
    assert.ok(!sent.includes(dangerous), `${dangerous} must not be sent`);
  }
});

test('a refusal stops it', async () => {
  const result = await checkCommandInjection(refuses(), { baseUrl: at, path: '/t', parameter: 'host' });
  assert.equal(result.skipped, true);
});

// ---- template -------------------------------------------------------------------------

test('arithmetic the server evaluated is a finding', async () => {
  const scanner = stub({
    baseline: { status: 200, responseText: 'Hello qanxt-template-baseline' },
    handlebars: { status: 200, responseText: 'Hello 49' },
    'erb-jinja': { status: 200, responseText: 'Hello 49' },
    'razor-angular': { status: 200, responseText: 'Hello 49' }
  });

  const result = await checkTemplateInjection(scanner, { baseUrl: at, path: '/greet', parameter: 'name' });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'TemplateInjection');
});

test('arithmetic returned unevaluated is clean', async () => {
  const scanner = stub({
    baseline: { status: 200, responseText: 'Hello qanxt-template-baseline' },
    handlebars: { status: 200, responseText: 'Hello {{7*7}}' },
    'erb-jinja': { status: 200, responseText: 'Hello ${7*7}' },
    'razor-angular': { status: 200, responseText: 'Hello {{ 7 * 7 }}' }
  });

  const result = await checkTemplateInjection(scanner, { baseUrl: at, path: '/greet', parameter: 'name' });

  assert.equal(result.ok, true);
  assert.match(result.detail, /unevaluated/);
});

test('a page that already says 49 reaches no verdict rather than a false one', async () => {
  // The marker is 7*7, and a page that happens to contain 49 would make every probe look
  // evaluated. Saying so is the only honest answer.
  const scanner = stub({
    baseline: { status: 200, responseText: 'You have 49 unread messages' }
  });

  const result = await checkTemplateInjection(scanner, { baseUrl: at, path: '/inbox', parameter: 'q' });

  assert.equal(result.inconclusive, true);
  assert.equal(result.findings.length, 0);
  assert.equal(scanner.sent.length, 1, 'and it stops rather than sending probes it cannot read');
});

test('a refusal stops it', async () => {
  const result = await checkTemplateInjection(refuses(), { baseUrl: at, path: '/g', parameter: 'n' });
  assert.equal(result.skipped, true);
});
