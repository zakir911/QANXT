/**
 * Proves the security evidence redactor against real secret shapes.
 *
 * It runs before the security suites, for the same reason the ground-truth audit does: if
 * redaction is broken, every piece of evidence the suites go on to write is a liability
 * rather than an asset, and the failure is silent — a leaked token looks exactly like a
 * token that was supposed to be there.
 *
 * It checks both directions. Secrets must not survive, and non-secrets must. An over-eager
 * redactor that turns an account identifier into asterisks destroys the evidence it was
 * meant to protect, which is a quieter failure than a leak and nearly as bad.
 */
import { redactText, redactHeaders, redactBody, writeFindingEvidence } from './evidence.mjs';
import { readFileSync, rmSync } from 'node:fs';

const secrets = {
  bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.abcdefghijklmnop',
  cookie: 'session=sess-a1b2c3d4e5f6; Path=/',
  apiKey: 'sk_test_synthetic_4f8a2c9e1b7d3a5f6c0e',
  bcrypt: '$2b$12$syntheticsynthetichashvaluefortestingonly000000',
  card: '4111111111111111',
  csrf: 'csrf-zz9y8x7w6v5u',
  reset: 'reset-qq1w2e3r4t5y'
};

let failures = 0;
const check = (label, text) => {
  const leaked = Object.entries(secrets).filter(([, v]) => text.includes(v));
  if (leaked.length) { failures++; console.log(`  LEAKED  ${label}: ${leaked.map(([k]) => k).join(', ')}`); }
  else console.log(`  clean   ${label}`);
};

console.log('\nRedaction probe — each of these is a secret shape that must not survive\n');
check('free text', redactText(Object.values(secrets).join(' | ')));
check('headers by name', JSON.stringify(redactHeaders({
  authorization: secrets.bearer, cookie: secrets.cookie, 'x-csrf-token': secrets.csrf,
  'content-type': 'application/json'
})));
check('body by field name', JSON.stringify(redactBody({
  password: 'lab-password', passwordHash: secrets.bcrypt, apiToken: secrets.apiKey,
  nested: { session_id: 'sess-a1b2c3d4e5f6', cardNumber: secrets.card },
  safe: 'this must survive'
})));
check('body by shape, in an unnamed field', JSON.stringify(redactBody({
  message: `Your token is ${secrets.apiKey} and hash ${secrets.bcrypt}`
})));

// Non-secrets must survive: over-redaction destroys the evidence.
const preserved = redactBody({ accountId: 'acc-1002', owner: 'u-bob', balance: 2000, sortCode: '22-22-22' });
const ok = JSON.stringify(preserved).includes('acc-1002') && JSON.stringify(preserved).includes('u-bob');
console.log(ok ? '  clean   non-secrets preserved (acc-1002, u-bob)' : '  LOST    non-secrets were redacted');
if (!ok) failures++;

// The whole writer.
const root = process.env.TMPDIR ? `${process.env.TMPDIR}/aira-redaction-selfcheck` : '/tmp/aira-redaction-selfcheck';
rmSync(root, { recursive: true, force: true });
const result = writeFindingEvidence({
  root, findingId: 'PROBE-001',
  finding: { title: 'Probe', category: 'Test', severity: 'High', confidence: 'Medium',
             status: 'Potential', description: 'A probe.', application: 'probe' },
  exchanges: [{
    method: 'GET', url: 'http://127.0.0.1:4401/api/accounts/acc-1002',
    requestHeaders: { authorization: secrets.bearer, cookie: secrets.cookie },
    status: 200,
    responseHeaders: { 'set-cookie': secrets.cookie },
    responseBody: { account: { id: 'acc-1002', owner: 'u-bob' }, apiToken: secrets.apiKey }
  }],
  literals: ['lab-password']
});
const sanitized = readFileSync(`${root}/PROBE-001/sanitized-request.txt`, 'utf8')
  + readFileSync(`${root}/PROBE-001/sanitized-response.txt`, 'utf8');
check('written sanitized evidence', sanitized);
const raw = readFileSync(`${root}/PROBE-001/request.txt`, 'utf8');
console.log(raw.includes(secrets.bearer) ? '  kept    raw evidence retains what happened' : '  LOST    raw evidence was redacted too');

// Refusing an evidence-free finding.
try {
  writeFindingEvidence({ root, findingId: 'PROBE-002', finding: { title: 'x' }, exchanges: [] });
  console.log('  ACCEPTED an evidence-free finding'); failures++;
} catch (e) { console.log(`  refused an evidence-free finding: ${e.message.slice(0, 60)}...`); }

console.log(failures === 0 ? '\nNo secret survived redaction.\n' : `\n${failures} leak(s).\n`);
process.exit(failures === 0 ? 0 : 1);
