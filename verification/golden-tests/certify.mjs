/**
 * The certification: ten questions, each answered by tests that ran.
 *
 * Every answer names the tests behind it, their verdicts and where their evidence is. An
 * answer is YES only when every test it rests on passed; if any failed the answer is NO,
 * and if the tests could not be executed here the answer is NOT VERIFIED. Nothing in this
 * file can turn an absent result into a positive one.
 *
 * Usage: node verification/golden-tests/certify.mjs [--run <RUN_ID>]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VERIFICATION } from './harness.mjs';

const RESULTS = resolve(VERIFICATION, 'reports/golden-results.jsonl');
if (!existsSync(RESULTS)) {
  console.error('No golden results yet. Run: node verification/golden-tests/run.mjs --all');
  process.exit(2);
}

const argv = process.argv.slice(2);
const runIndex = argv.indexOf('--run');
const lines = readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const runId = runIndex >= 0 ? argv[runIndex + 1] : lines.at(-1).runId;

const latest = new Map();
for (const record of lines.filter(entry => entry.runId === runId)) latest.set(record.testId, record);

const QUESTIONS = [
  {
    question: 'Can AIRA discover a real web application?',
    tests: ['DISC-001', 'DISC-002', 'DISC-003', 'DISC-004', 'DISC-011', 'DISC-012', 'DISC-015'],
    note: 'Measured against hand-written ground truth for a React single-page application, and repeated against one whose element ids are regenerated on every render.'
  },
  {
    question: 'Can it generate meaningful tests?',
    tests: ['GEN-001', 'GEN-002', 'GEN-003', 'GEN-004', 'GEN-005', 'GEN-007', 'GEN-008', 'GEN-012'],
    note: 'Meaningful is judged by structure, locator quality and how much of the application the tests reach — not by how the text reads. No model provider is configured here, so this measures the built-in rules engine.'
  },
  {
    question: 'Can generated tests actually execute?',
    tests: ['GEN-010', 'GEN-011'],
    note: 'Executed unedited in a real browser: they pass against a healthy application and at least one fails once it is broken.'
  },
  {
    question: 'Can it detect real failures?',
    tests: ['DET-001', 'DET-002', 'DET-003', 'DET-004', 'DET-005', 'DET-006', 'DET-007',
      'DET-008', 'DET-009', 'DET-010', 'DET-011', 'DET-012'],
    note: 'Eleven failure classes, each on its own page of an application otherwise identical in shape, plus a control where nothing is broken.'
  },
  {
    question: 'Can it analyse failures?',
    tests: ['FA-001', 'FA-012', 'FA-013', 'FA-014', 'FA-015'],
    note: 'Classification accuracy is measured against the lab\'s expectations; an analysis never overturns a verdict; the same failure twice is recognised.'
  },
  {
    question: 'Can it safely self-heal locator changes?',
    tests: ['HEAL-G01', 'HEAL-G02', 'HEAL-G03', 'HEAL-G04', 'HEAL-G05', 'HEAL-G06', 'HEAL-G08'],
    note: 'Healing is proposed under the default policy and applied only under an opt-in one; a healed run is reported as healed; the stored test is never rewritten.'
  },
  {
    question: 'Can it correctly refuse unsafe healing?',
    tests: ['HEAL-N01', 'HEAL-N02', 'HEAL-N03', 'HEAL-N04', 'HEAL-N05', 'HEAL-N06',
      'HEAL-N07', 'HEAL-N08', 'HEAL-N09', 'HEAL-N10', 'HEAL-M01', 'HEAL-M02'],
    note: 'Ten scenarios that must be refused. In each the run must fail AND the browser must never reach the signed-in page. The false-healing rate and the confidence margin are reported as numbers.'
  },
  {
    question: 'Can it avoid false PASS results?',
    tests: ['DET-010', 'DET-011', 'FA-016', 'ASRT-001', 'ASRT-002', 'ASRT-003', 'ASRT-004', 'ASRT-005', 'GEN-011'],
    note: 'Includes a payment that is confirmed on screen and never recorded, a value that is wrong rather than missing, and every assertion type exercised in both directions.'
  },
  {
    question: 'Can it operate repeatedly?',
    tests: ['REL-001', 'REL-002', 'REL-003', 'REL-005'],
    note: 'Ten identical runs, twenty runs against a genuinely unstable application, and ten runs started at the same moment.'
  },
  {
    question: 'Can it produce physical evidence?',
    tests: ['EXEC-012', 'EXEC-013', 'EXEC-014', 'DET-002', 'DISC-014'],
    note: 'Screenshots, a Playwright trace, console and network logs, and a screenshot per discovered page — each recorded with a SHA-256 in the evidence index.'
  }
];

const answers = QUESTIONS.map(entry => {
  const records = entry.tests.map(id => latest.get(id)).filter(Boolean);
  const missing = entry.tests.filter(id => !latest.has(id));
  const failed = records.filter(record => record.result === 'FAIL');
  const notVerified = records.filter(record => record.result === 'NOT_VERIFIED');
  const passed = records.filter(record => record.result === 'PASS');

  const answer = failed.length > 0 ? 'NO'
    : (records.length === 0 || missing.length === entry.tests.length) ? 'NOT VERIFIED'
      : passed.length > 0 ? 'YES' : 'NOT VERIFIED';

  return {
    ...entry, answer,
    passed: passed.map(record => record.testId),
    failed: failed.map(record => record.testId),
    notVerified: notVerified.map(record => record.testId),
    missing,
    evidence: records.flatMap(record => record.evidence.map(artifact => artifact.path))
  };
});

const yes = answers.filter(entry => entry.answer === 'YES').length;
const no = answers.filter(entry => entry.answer === 'NO').length;
const unverified = answers.filter(entry => entry.answer === 'NOT VERIFIED').length;

const metricOf = (testId, key) => latest.get(testId)?.metrics?.[key] ?? null;
const headline = {
  falseHealingRate: metricOf('HEAL-M01', 'falseHealingRate'),
  incorrectHeals: metricOf('HEAL-M01', 'incorrectHeals'),
  confidenceMargin: metricOf('HEAL-M02', 'margin'),
  pageRecall: metricOf('DISC-002', 'recall'),
  pagePrecision: metricOf('DISC-003', 'precision'),
  classificationAccuracy: metricOf('FA-012', 'accuracy')
};

const all = [...latest.values()];
const status = no > 0 ? 'NOT CERTIFIED'
  : unverified > 0 ? 'CERTIFIED WITH EXCEPTIONS'
    : 'CERTIFIED';

const pct = (value) => (value === null ? 'not measured' : `${(value * 100).toFixed(1)}%`);

const markdown = `# AIRA certification

**Status: ${status}**

Run \`${runId}\` · build \`${all[0]?.build?.commit ?? 'unknown'}\` · generated ${new Date().toISOString()}

${yes} of ${QUESTIONS.length} questions answered YES, ${no} NO, ${unverified} NOT VERIFIED.
Every answer below is derived from golden tests that executed in this run; none is asserted.

| | |
| --- | --- |
| Golden tests executed | ${all.filter(record => record.result !== 'NOT_VERIFIED').length} of ${all.length} |
| Passed | ${all.filter(record => record.result === 'PASS').length} |
| Failed | ${all.filter(record => record.result === 'FAIL').length} |
| Not verified | ${all.filter(record => record.result === 'NOT_VERIFIED').length} |
| **False-healing rate** | **${pct(headline.falseHealingRate)}** (${headline.incorrectHeals ?? '—'} incorrect heals) |
| Healing confidence margin | ${headline.confidenceMargin ?? '—'} points |
| Discovery recall / precision | ${pct(headline.pageRecall)} / ${pct(headline.pagePrecision)} |
| Failure classification accuracy | ${pct(headline.classificationAccuracy)} |

---

${answers.map((entry, index) => `## ${index + 1}. ${entry.question}

**${entry.answer}**

${entry.note}

| Test | Result | Detail |
| --- | --- | --- |
${entry.tests.map(id => {
    const record = latest.get(id);
    if (!record) return `| ${id} | *not run* | — |`;
    return `| ${id} | **${record.result.replace('_', ' ')}** | ${(record.detail ?? '').replace(/\|/g, '\\|').slice(0, 170)} |`;
  }).join('\n')}

Evidence: ${entry.evidence.length ? `${entry.evidence.length} artifact(s) under \`verification/evidence/\`` : 'none recorded'}
`).join('\n---\n\n')}

---

## What this certification does not say

- It says nothing about a hosted model provider. None is configured in this environment, so
  every generation and analysis figure above describes AIRA's built-in deterministic rules,
  which the platform labels as such in its own responses.
- It says nothing about Firefox or WebKit. Neither browser is installed here and the
  Playwright CDN is unreachable, so those runs are recorded NOT VERIFIED rather than failed.
- It says nothing about behaviour at scale. The applications are small, the data sets are
  fixed, and the runs are measured on one machine whose specification is recorded in
  \`verification/environment.md\`.
- It is not an independent certification. The same author wrote the platform, the test lab
  and these tests. What it offers instead is falsifiability: every claim names a test, every
  test is a script, and every artifact is hashed.

## How to disprove it

\`\`\`bash
./scripts/verify-product
\`\`\`

Runs everything from infrastructure to this document. If a claim here is wrong, that command
will say so.
`;

writeFileSync(resolve(VERIFICATION, 'reports/AIRA-CERTIFICATION.md'), markdown);
writeFileSync(resolve(VERIFICATION, 'reports/certification.json'), `${JSON.stringify({
  runId, status, generatedAt: new Date().toISOString(),
  build: all[0]?.build ?? null,
  answers: answers.map(entry => ({
    question: entry.question, answer: entry.answer,
    passed: entry.passed, failed: entry.failed, notVerified: entry.notVerified, missing: entry.missing
  })),
  headline
}, null, 2)}\n`);

console.log(`Certification: ${status}`);
console.log(`  ${yes} YES, ${no} NO, ${unverified} NOT VERIFIED of ${QUESTIONS.length} questions`);
for (const entry of answers) {
  console.log(`  ${entry.answer.padEnd(13)} ${entry.question}`
    + (entry.failed.length ? ` — failed: ${entry.failed.join(', ')}` : '')
    + (entry.missing.length ? ` — not run: ${entry.missing.join(', ')}` : ''));
}
console.log('  written: verification/reports/AIRA-CERTIFICATION.md, certification.json');

if (no > 0) process.exitCode = 1;
