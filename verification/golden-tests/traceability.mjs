/**
 * Requirements traceability, checked rather than asserted.
 *
 * A traceability matrix maintained by hand is a document that agrees with reality on the
 * day it is written and never again. This one is checked against what actually ran, and
 * fails on each of the four ways it can be wrong:
 *
 *   - a requirement naming no test at all;
 *   - a requirement naming a test id that does not exist in any suite;
 *   - a requirement whose tests did not all pass in the run being reported;
 *   - a test that exists and is claimed by no requirement.
 *
 * The last one matters more than it looks. A test nobody can connect to a requirement is
 * either verifying something undocumented or verifying nothing, and both are worth
 * knowing. It is reported rather than failed, because a test can legitimately exist to
 * cover a defect that no requirement anticipated.
 *
 * Usage: node verification/golden-tests/traceability.mjs [--run <RUN_ID>]
 * Exits non-zero when a requirement is unverified.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { VERIFICATION, ROOT } from './harness.mjs';

const RESULTS = resolve(VERIFICATION, 'reports/golden-results.jsonl');
const SUITES = resolve(ROOT, 'verification/golden-tests/suites');

const argv = process.argv.slice(2);
const runIndex = argv.indexOf('--run');
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

// Which matrix to check. The default is the continuous-quality one, and the security
// capability brings its own — same checks, different requirements and a different set of
// suites to call its own. Parameterised rather than copied, because two copies of this file
// would drift and the whole point of it is that it does not.
const REQUIREMENTS = resolve(VERIFICATION, flag('requirements', 'continuous-quality-requirements.json'));
const OUT = resolve(VERIFICATION, flag('out', 'reports/TRACEABILITY.md'));

const { requirements, title, note, suites } = JSON.parse(readFileSync(REQUIREMENTS, 'utf8'));

/**
 * Every test id that can be shown to exist.
 *
 * Two sources, because neither alone is sufficient.
 *
 * The suite source catches a requirement naming a test that was never written, even when
 * that suite was not executed in this run — which is the case a run-only check would miss.
 *
 * But a static scan only sees ids written as literals. Several suites build theirs in a
 * loop (the healing suite's HEAL-G01..n, the execution suite's per-browser cases), and at
 * the time of writing 70 of the ids that have actually run appear nowhere as a literal.
 * Treating those as non-existent would report BROKEN REFERENCE for a test that demonstrably
 * ran, which is the one kind of wrong answer a traceability matrix must not give.
 *
 * So a test id counts as existing if it is written in a suite OR has appeared in a recorded
 * result. Having executed is stronger evidence of existence than matching a regex, not
 * weaker: an id that satisfies neither is still a broken reference.
 */
const declared = new Set();
/** id → the suite file that declares it, so an orphan can be attributed to a suite. */
const declaredIn = new Map();
for (const file of readdirSync(SUITES).filter(name => name.endsWith('.mjs'))) {
  const source = readFileSync(resolve(SUITES, file), 'utf8');
  for (const match of source.matchAll(/\bid:\s*['"`]([A-Z][A-Z0-9]*-[A-Z0-9]+)['"`]/g)) {
    declared.add(match[1]);
    if (!declaredIn.has(match[1])) declaredIn.set(match[1], file.replace(/\.mjs$/, ''));
  }
}
const literal = new Set(declared);

/** The suites this matrix's requirements are about. The rest belong to another matrix. */
const CQ_SUITES = new Set(suites ?? [
  'api-testing', 'api-contracts', 'correlation', 'regression-selection', 'ci-integration',
  'ci-simulation', 'scheduling', 'notifications', 'test-data', 'release', 'accessibility', 'visual'
]);

// Results, when there are any. Traceability is still worth producing without them — it
// answers "is every requirement claimed by a test" independently of whether tests ran.
let results = new Map();
let runId = null;
if (existsSync(RESULTS)) {
  const lines = readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  runId = runIndex >= 0 ? argv[runIndex + 1] : lines.at(-1)?.runId ?? null;
  for (const record of lines.filter(entry => entry.runId === runId)) results.set(record.testId, record);
  // An id that has ever run exists, whether or not it is written as a literal anywhere.
  for (const record of lines) {
    declared.add(record.testId);
    if (!declaredIn.has(record.testId) && record.suite) declaredIn.set(record.testId, record.suite);
  }
}
const generated = [...declared].filter(id => !literal.has(id)).length;

const claimed = new Set();
const rows = [];

for (const requirement of requirements) {
  const tests = requirement.verifiedBy ?? [];
  for (const id of tests) claimed.add(id);

  const missing = tests.filter(id => !declared.has(id));
  const ran = tests.filter(id => results.has(id));
  const failed = ran.filter(id => results.get(id).result !== 'PASS');
  const notRun = tests.filter(id => !results.has(id) && declared.has(id));

  const status =
    tests.length === 0 ? 'NO TEST'
    : missing.length > 0 ? 'BROKEN REFERENCE'
    : failed.length > 0 ? 'FAILED'
    : notRun.length === tests.length ? 'NOT RUN'
    : notRun.length > 0 ? 'PARTIALLY RUN'
    : 'VERIFIED';

  rows.push({ ...requirement, tests, missing, failed, notRun, status });
}

const orphans = [...declared].filter(id => !claimed.has(id)).sort();
// Counted rather than asserted: a sentence about where the orphans come from is only worth
// printing if the document works it out from the suites themselves.
const orphansOutside = orphans.filter(id => !CQ_SUITES.has(declaredIn.get(id) ?? '')).length;

// A requirement is unverified when it names nothing, names something that does not exist,
// or names something that did not pass. "Not run" is reported separately: it means this
// invocation did not cover it, which is a different statement from "it does not hold".
const unverified = rows.filter(row =>
  row.status === 'NO TEST' || row.status === 'BROKEN REFERENCE' || row.status === 'FAILED');
const notRun = rows.filter(row => row.status === 'NOT RUN' || row.status === 'PARTIALLY RUN');

// ---------------------------------------------------------------------------

const badge = status => ({
  VERIFIED: 'VERIFIED',
  FAILED: '**FAILED**',
  'NO TEST': '**NO TEST**',
  'BROKEN REFERENCE': '**BROKEN REFERENCE**',
  'NOT RUN': 'not run',
  'PARTIALLY RUN': 'partially run'
}[status] ?? status);

const document = [
  `# ${title}`,
  '',
  note,
  '',
  runId ? `Checked against golden run \`${runId}\`.` : 'No golden results were available; test verdicts are not shown.',
  '',
  `**${rows.filter(r => r.status === 'VERIFIED').length} of ${rows.length} requirements verified.**`
    + (unverified.length > 0 ? ` ${unverified.length} unverified.` : '')
    + (notRun.length > 0 ? ` ${notRun.length} not covered by this run.` : ''),
  '',
  '| Requirement | Verified by | Status |',
  '| --- | --- | --- |',
  ...rows.map(row => {
    const tests = row.tests.map(id => {
      const record = results.get(id);
      if (!declared.has(id)) return `~~${id}~~`;
      if (!record) return id;
      return record.result === 'PASS' ? id : `**${id} ${record.result}**`;
    }).join(', ') || '—';
    return `| **${row.id}** ${row.statement} | ${tests} | ${badge(row.status)} |`;
  }),
  ''
];

if (unverified.length > 0) {
  document.push('## Unverified', '');
  for (const row of unverified) {
    document.push(`- **${row.id}** — ${row.status}.`
      + (row.missing.length > 0 ? ` No such test: ${row.missing.join(', ')}.` : '')
      + (row.failed.length > 0 ? ` Failed: ${row.failed.join(', ')}.` : '')
      + (row.tests.length === 0 ? ' No test claims to verify this.' : ''));
  }
  document.push('');
}

document.push(
  '## Tests claimed by no requirement',
  '',
  orphans.length === 0
    ? 'None. Every test is connected to a requirement.'
    : `${orphans.length} test(s). A test nobody can connect to a requirement is either `
      + 'verifying something undocumented or verifying nothing. This is reported rather '
      + 'than failed, because a test can legitimately exist to cover a defect no '
      + `requirement anticipated. ${orphansOutside} of them belong to suites this matrix does `
      + 'not cover — they are the product certification\'s, not this document\'s — and '
      + `${orphans.length - orphansOutside} are continuous-quality tests that no requirement above names.`,
  '',
  `${declared.size} test id(s) are known to exist: ${declared.size - generated} written as `
    + `literals in a suite, ${generated} built at run time and proven by having executed.`,
  '',
  ...(orphans.length === 0 ? [] : ['```', ...chunk(orphans, 12).map(line => line.join('  ')), '```', '']));

writeFileSync(OUT, `${document.join('\n')}\n`);

// ---------------------------------------------------------------------------

const green = text => `\u001b[32m${text}\u001b[0m`;
const red = text => `\u001b[31m${text}\u001b[0m`;
const dim = text => `\u001b[2m${text}\u001b[0m`;

console.log('');
console.log(`Traceability: ${rows.filter(r => r.status === 'VERIFIED').length}/${rows.length} requirements verified`
  + (runId ? dim(` against run ${runId}`) : ''));

for (const row of unverified) {
  console.log(red(`  ${row.status.padEnd(18)} ${row.id} ${row.statement.slice(0, 70)}`));
}
for (const row of notRun) {
  console.log(dim(`  ${row.status.padEnd(18)} ${row.id} ${row.statement.slice(0, 70)}`));
}
// Only the orphans inside this matrix's own suites are worth printing. Every test in every
// other suite is an orphan as far as this matrix is concerned, and reporting 342 of them
// buries the two or three that actually mean something.
const orphansHere = orphans.filter(id => CQ_SUITES.has(declaredIn.get(id) ?? ''));
if (orphansHere.length > 0) {
  console.log(dim(`  ${orphansHere.length} test(s) in this matrix's suites claimed by no requirement: `
    + orphansHere.slice(0, 8).join(', ') + (orphansHere.length > 8 ? ' …' : '')));
}
if (orphansOutside > 0) {
  console.log(dim(`  ${orphansOutside} further test(s) belong to suites this matrix does not cover.`));
}

console.log(dim(`  Written to ${relative(ROOT, OUT)}`));
console.log('');

if (unverified.length > 0) {
  console.log(red('Some requirements are not verified.'));
  process.exit(1);
}
// Two different green messages, because they are two different claims. Saying "or by one
// this run did not cover" when every requirement was in fact covered understates the result;
// omitting it when some were not overstates it.
console.log(notRun.length === 0
  ? green(`Every requirement is claimed by a test that passed in run ${runId}.`)
  : green(`Every requirement is claimed by a test that passed, or by one this run did not cover `
      + `(${notRun.length} of ${rows.length}).`));

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
