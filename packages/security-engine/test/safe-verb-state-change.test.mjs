import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStateChangeBySafeVerb } from '../src/checks-request.mjs';

/**
 * The check that closes "a GET changed state".
 *
 * Its whole value rests on one thing: it must not report a finding because a page moved on
 * its own. A scanner that flags every link on any page carrying a clock, a counter or a
 * rotating token is worse than one that flags none, because somebody has to read it.
 *
 * So the control is what these tests are mostly about. A stub scanner stands in for the
 * network and records what was asked, which also lets the ordering be asserted: the witness
 * is read twice before the probe is issued, never after it.
 */

/** A scanner that answers from a script and remembers the questions. */
function stub(responses) {
  const asked = [];
  return {
    asked,
    async request({ url, testId, method = 'GET' }) {
      asked.push({ url, testId, method });
      const next = responses.shift();
      if (!next) throw new Error(`no scripted response left for ${testId}`);
      return { allowed: true, status: 200, responseText: '', ...next };
    }
  };
}

const page = (body) => ({ status: 200, responseText: body });
const actor = { label: 'receptionist', role: 'readonly', cookie: 'session=x' };

const run = (scanner) => checkStateChangeBySafeVerb(scanner, {
  baseUrl: 'http://app.test',
  path: '/approve.asp?id=5',
  witnessPath: '/view.asp?id=5',
  actor
});

test('a stable witness that differs after the probe is a finding', async () => {
  const scanner = stub([
    page('<a href="/approve.asp?id=5">Approve this permit</a>'),
    page('<a href="/approve.asp?id=5">Approve this permit</a>'),
    page('Permit approved.'),
    page('<a href="/revoke.asp?id=5">Revoke this permit</a>')
  ]);

  const result = await run(scanner);

  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.category, 'StateChangeBySafeVerb');
  assert.equal(finding.httpMethod, 'GET');
  assert.equal(finding.endpoint, '/approve.asp?id=5');
  assert.equal(finding.observedAsRole, 'receptionist');
  assert.equal(finding.cwe, 'CWE-352');
  assert.match(finding.description, /read identically twice beforehand/);
});

test('the witness is read twice before the probe is ever issued', async () => {
  const scanner = stub([
    page('stable'), page('stable'), page('done'), page('changed')
  ]);

  await run(scanner);

  assert.deepEqual(scanner.asked.map(a => a.testId), [
    'SECA-SAFEVERB:witness-1',
    'SECA-SAFEVERB:witness-2',
    'SECA-SAFEVERB:probe',
    'SECA-SAFEVERB:witness-3'
  ], 'the control must come before the probe, or it establishes nothing');
});

test('a witness that moves on its own reports nothing, however much it changes later', async () => {
  // The page carries a visit counter. Two reads already differ, so a third difference is not
  // evidence of anything. This is the false positive the check exists to avoid.
  const scanner = stub([
    page('Permit PRM-1 <span>viewed 41 times</span>'),
    page('Permit PRM-1 <span>viewed 42 times</span>'),
    page('Permit approved.'),
    page('Permit PRM-1 <span>viewed 43 times</span> APPROVED')
  ]);

  const result = await run(scanner);

  assert.equal(result.findings.length, 0);
  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /differs between two reads with nothing done in between/);
  assert.equal(result.ok, undefined, 'an unevaluated check is not a pass');
});

test('a clock in the page does not stop a real change being seen', async () => {
  // The timestamp moves every read and is stripped; the status does not, and is what the
  // finding rests on.
  const scanner = stub([
    page('<footer>2026-11-23T04:10:00Z</footer><b>Status: pending</b>'),
    page('<footer>2026-11-23T04:10:31Z</footer><b>Status: pending</b>'),
    page('Permit approved.'),
    page('<footer>2026-11-23T04:11:02Z</footer><b>Status: approved</b>')
  ]);

  const result = await run(scanner);

  assert.equal(result.findings.length, 1, 'stripping the clock must not hide the status change');
});

test('a clock alone is not a state change', async () => {
  // Nothing but the timestamp moves. Stripping it leaves the page identical, so there is
  // nothing to report — and nothing to claim either.
  const scanner = stub([
    page('<footer>2026-11-23T04:10:00Z</footer><b>Status: pending</b>'),
    page('<footer>2026-11-23T04:10:31Z</footer><b>Status: pending</b>'),
    page('Nothing to do.'),
    page('<footer>2026-11-23T04:11:02Z</footer><b>Status: pending</b>')
  ]);

  const result = await run(scanner);

  assert.equal(result.findings.length, 0);
  assert.equal(result.inconclusive, true);
});

test('an unchanged witness is not evaluated rather than passed', async () => {
  const scanner = stub([
    page('Status: pending'), page('Status: pending'),
    page('Nothing happened.'),
    page('Status: pending')
  ]);

  const result = await run(scanner);

  assert.equal(result.findings.length, 0);
  assert.equal(result.inconclusive, true);
  assert.equal(result.ok, undefined,
    'the request may have changed something this page does not show; that is not a pass');
  assert.match(result.reason, /cannot conclude there was none/);
});

test('a refused probe is a pass, because the refusal is the observation', async () => {
  const scanner = stub([
    page('Status: pending'), page('Status: pending'),
    { status: 403, responseText: 'Forbidden' }
  ]);

  const result = await run(scanner);

  assert.equal(result.findings.length, 0);
  assert.equal(result.ok, true);
  assert.match(result.detail, /refused a GET from receptionist with 403/);
});

test('a witness that cannot be read is not evaluated', async () => {
  const scanner = stub([{ status: 404, responseText: 'No such permit' }]);

  const result = await run(scanner);

  assert.equal(result.findings.length, 0);
  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /needs a page it can read/);
});

test('a probe the scope refuses is skipped, not reported either way', async () => {
  const scanner = stub([
    page('Status: pending'), page('Status: pending'),
    { allowed: false, decision: 'stateChangingNotAllowed', status: 0 }
  ]);

  const result = await run(scanner);

  assert.equal(result.skipped, true);
  assert.equal(result.findings.length, 0);
  assert.equal(result.decision, 'stateChangingNotAllowed');
});

test('a rotating anti-forgery token does not make the witness unusable', async () => {
  const scanner = stub([
    page('<input name="csrf" value="aaaaaaaaaaaa"><b>pending</b>'),
    page('<input name="csrf" value="bbbbbbbbbbbb"><b>pending</b>'),
    page('Approved.'),
    page('<input name="csrf" value="cccccccccccc"><b>approved</b>')
  ]);

  const result = await run(scanner);

  assert.equal(result.findings.length, 1);
});

test('the probe is declared state-changing so the scope guard governs it', async () => {
  const seen = [];
  const scanner = {
    async request(options) {
      seen.push(options);
      return { allowed: true, status: 200, responseText: options.testId.includes('witness-3') ? 'b' : 'a' };
    }
  };

  await checkStateChangeBySafeVerb(scanner, {
    baseUrl: 'http://app.test', path: '/cancel', witnessPath: '/orders', actor
  });

  const probe = seen.find(s => s.testId.endsWith(':probe'));
  assert.equal(probe.risk, 2, 'SECURITY_RISK.STATE_CHANGING');
  const witnesses = seen.filter(s => s.testId.includes('witness'));
  assert.ok(witnesses.every(w => w.risk === 0), 'reading the witness changes nothing');
});

/**
 * The shapes a rotating per-render value arrives in. Each one has to be stripped or the page
 * carrying it can never serve as a witness — two reads would always differ and the check
 * would report "not evaluated" on every application that emits an anti-forgery token, which
 * is most of them.
 */
const ROTATING = [
  ['a hidden input naming and carrying the token', '<input name="csrf" value="{T}">'],
  ['the same with an underscore prefix', '<input name="_csrf" value="{T}">'],
  ['ASP.NET request verification', '<input name="__RequestVerificationToken" value="{T}">'],
  ['a meta tag', '<meta name="csrf-token" content="{T}">'],
  ['a JSON field', '{"csrf":"{T}"}'],
  ['a query parameter', 'csrf={T}'],
  ['a script nonce', '<script nonce="{T}">'],
  ['a cache-busting query', '/app.js?cachebust={T}'],
  ['a request id', 'X-Request-Id: {T}']
];

for (const [label, markup] of ROTATING) {
  test(`${label} does not make a page unusable as a witness`, async () => {
    // Only the token rotates. An earlier version of this test rotated every long run of
    // characters in the fixture, which renamed the attribute as well and made two of these
    // cases unmatchable for reasons that had nothing to do with the code under test.
    let n = 0;
    const rotate = () => markup.replace('{T}', `r0tating${n++}value`);
    const scanner = stub([
      page(`${rotate()}<b>Status: pending</b>`),
      page(`${rotate()}<b>Status: pending</b>`),
      page('Approved.'),
      page(`${rotate()}<b>Status: approved</b>`)
    ]);

    const result = await run(scanner);

    assert.equal(result.findings.length, 1,
      `${label}: the rotating value must be stripped so the status change is what is compared`);
  });
}

test('real content is never mistaken for a rotating token', async () => {
  // The witness must still be able to carry evidence. These are the strings a finding would
  // rest on, and stripping that ate them would make every check inconclusive.
  const scanner = stub([
    page('<b>Status: pending</b> Permit PRM-0041 <a href="/approve.asp?id=5">Approve</a>'),
    page('<b>Status: pending</b> Permit PRM-0041 <a href="/approve.asp?id=5">Approve</a>'),
    page('Approved.'),
    page('<b>Status: approved</b> Permit PRM-0041 <a href="/revoke.asp?id=5">Revoke</a>')
  ]);

  const result = await run(scanner);
  assert.equal(result.findings.length, 1);
});

test('the address under test cannot witness itself', async () => {
  // Reading the witness happens twice, before the probe. Letting it default to the address
  // under test would perform the state change twice before deciding whether to perform it,
  // then compare an already-changed record against an already-changed record and report
  // nothing. No request should be made at all.
  const asked = [];
  const scanner = { async request(o) { asked.push(o.testId); return { allowed: true, status: 200, responseText: 'x' }; } };

  for (const witnessPath of [undefined, null, '', '/approve.asp?id=5']) {
    const result = await checkStateChangeBySafeVerb(scanner, {
      baseUrl: 'http://app.test', path: '/approve.asp?id=5', witnessPath, actor
    });
    assert.equal(result.findings.length, 0);
    assert.equal(result.inconclusive, true);
    assert.match(result.reason, /cannot witness itself/);
  }

  assert.deepEqual(asked, [], 'nothing is issued when there is no usable witness');
});
