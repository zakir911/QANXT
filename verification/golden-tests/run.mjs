#!/usr/bin/env node
/**
 * The golden-test runner.
 *
 * Executes one suite, several, or all of them, writes the evidence and prints a summary.
 * Exits non-zero if any critical test failed — the quality gate a pipeline keys off.
 *
 * Usage:
 *   node verification/golden-tests/run.mjs --all
 *   node verification/golden-tests/run.mjs --suite discovery --suite healing
 *   node verification/golden-tests/run.mjs --list
 */
import { requireEnvironment } from './platform.mjs';
import { BUILD, RUN_ID, results } from './harness.mjs';

const SUITES = {
  discovery: () => import('./suites/discovery.mjs'),
  generation: () => import('./suites/generation.mjs'),
  execution: () => import('./suites/execution.mjs'),
  assertions: () => import('./suites/assertions.mjs'),
  'failure-detection': () => import('./suites/failure-detection.mjs'),
  'failure-analysis': () => import('./suites/failure-analysis.mjs'),
  healing: () => import('./suites/self-healing.mjs'),
  'api-testing': () => import('./suites/api-testing.mjs'),
  security: () => import('./suites/security.mjs'),
  reliability: () => import('./suites/reliability.mjs'),
  performance: () => import('./suites/performance.mjs')
};

const argv = process.argv.slice(2);

if (argv.includes('--list')) {
  // Listing must not require the platform to be up: a reader asking what exists should not
  // have to start a stack to find out.
  for (const name of Object.keys(SUITES)) console.log(name);
  process.exit(0);
}

const requested = [];
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === '--all') requested.push(...Object.keys(SUITES));
  else if (argv[index] === '--suite') requested.push(argv[++index]);
  else if (argv[index].startsWith('--suite=')) requested.push(argv[index].slice('--suite='.length));
}
if (requested.length === 0) requested.push(...Object.keys(SUITES));

const unknown = requested.filter(name => !(name in SUITES));
if (unknown.length) {
  console.error(`Unknown suite(s): ${unknown.join(', ')}. Known: ${Object.keys(SUITES).join(', ')}`);
  process.exit(2);
}

console.log(`Golden tests — run ${RUN_ID}, build ${BUILD.commit}${BUILD.dirty ? ' (working tree dirty)' : ''}`);
await requireEnvironment();

const started = Date.now();
for (const name of [...new Set(requested)]) {
  const module = await SUITES[name]();
  try {
    await module.default();
  } catch (error) {
    // A suite that cannot even set itself up is a failure of the thing under test until
    // proven otherwise, so it is reported loudly rather than swallowed.
    console.error(`\n\u001b[31mSuite ${name} could not complete: ${String(error?.stack ?? error).split('\n').slice(0, 3).join('\n')}\u001b[0m`);
    process.exitCode = 1;
  }
}

const all = results();
const passed = all.filter(record => record.result === 'PASS');
const failed = all.filter(record => record.result === 'FAIL');
const notVerified = all.filter(record => record.result === 'NOT_VERIFIED');
const criticalFailures = failed.filter(record => record.severity === 'critical');

console.log(`\n${'─'.repeat(72)}`);
console.log(`${passed.length} passed, ${failed.length} failed, ${notVerified.length} not verified `
  + `of ${all.length} golden tests in ${Math.round((Date.now() - started) / 1000)}s`);
if (failed.length) {
  console.log('\nFailures:');
  for (const record of failed) console.log(`  ${record.severity.padEnd(8)} ${record.testId}  ${record.detail}`);
}
console.log(`\nEvidence: verification/evidence/<TEST-ID>/${RUN_ID}/`);
console.log(`Results:  verification/reports/golden-results.jsonl`);

if (criticalFailures.length > 0) process.exitCode = 1;
