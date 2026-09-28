/**
 * Runs every CI simulation scenario and prints what happened.
 *
 *   node test-lab/ci-simulation/run.mjs
 *   node test-lab/ci-simulation/run.mjs --only production-refused
 *
 * Exits non-zero if any scenario did not produce what it claimed it would. The golden suite
 * `ci-simulation` runs the same scenarios through the verification harness, with evidence;
 * this runner exists so that a person can watch a pipeline happen without waiting for a
 * whole certification.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scenarios } from './definitions.mjs';
import { ROOT } from './scenarios.mjs';
import { requireEnvironment } from '../../verification/golden-tests/platform.mjs';

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : undefined;
const verbose = process.argv.includes('--verbose');

const bold = text => `\u001b[1m${text}\u001b[0m`;
const green = text => `\u001b[32m${text}\u001b[0m`;
const red = text => `\u001b[31m${text}\u001b[0m`;
const dim = text => `\u001b[2m${text}\u001b[0m`;

await requireEnvironment();

const chosen = only ? scenarios.filter(s => s.id === only) : scenarios;
if (chosen.length === 0) {
  console.error(`No scenario called "${only}". Known: ${scenarios.map(s => s.id).join(', ')}`);
  process.exit(2);
}

console.log(bold(`\nCI simulation — ${chosen.length} scenario(s)\n`));

const context = await (await import('./definitions.mjs')).buildContext();
const results = [];

for (const scenario of chosen) {
  process.stdout.write(`  ${scenario.id} … `);
  const started = Date.now();
  let outcome;
  try {
    outcome = await scenario.run(context);
  } catch (error) {
    outcome = { pass: false, detail: `threw: ${error.message}` };
  }
  const ms = Date.now() - started;
  results.push({ ...scenario, ...outcome, ms });
  console.log(outcome.pass ? green(`pass ${dim(`${ms}ms`)}`) : red(`FAIL ${dim(`${ms}ms`)}`));
  console.log(`      ${dim(outcome.detail ?? '')}`);
  if (verbose && outcome.log) console.log(outcome.log.split('\n').map(l => `      ${dim(l)}`).join('\n'));
}

const failed = results.filter(result => !result.pass);

const report = [
  '# CI simulation',
  '',
  'Every scenario below ran `test-lab/ci-simulation/pipeline.sh` against the real platform',
  'and the real lab bank. No CI system was involved.',
  '',
  `Run at ${new Date().toISOString()}.`,
  '',
  '| Scenario | Expected | Exit | Pipeline | Result |',
  '| --- | --- | --- | --- | --- |',
  ...results.map(result => `| \`${result.id}\` | ${result.expectation} | `
    + `${result.qanxtExit ?? '—'} | ${result.pipelineExit ?? '—'} | `
    + `${result.pass ? 'pass' : '**FAIL**'} |`),
  '',
  '## What each scenario showed',
  '',
  ...results.flatMap(result => [
    `### \`${result.id}\``,
    '',
    result.description,
    '',
    `${result.pass ? '**Passed.**' : '**FAILED.**'} ${result.detail ?? ''}`,
    ''
  ])
].join('\n');

const path = join(ROOT, 'verification/reports/CI-SIMULATION.md');
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, report);

console.log('');
console.log(failed.length === 0
  ? green(bold(`All ${results.length} scenarios produced what they claimed.`))
  : red(bold(`${failed.length} of ${results.length} scenarios did not.`)));
console.log(dim(`Report: verification/reports/CI-SIMULATION.md`));
process.exit(failed.length === 0 ? 0 : 1);
