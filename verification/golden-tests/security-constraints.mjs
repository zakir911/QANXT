/**
 * Checks the constraint map against what actually ran.
 *
 * `docs/security/constraints.md` maps each of the brief's eighteen rules to the requirement
 * that states it and the tests that hold it. A map like that is true on the day it is written
 * and rots quietly afterwards: a test gets renamed, a requirement is reworded, and the table
 * goes on claiming coverage that nothing provides. The claim is the most load-bearing thing in
 * the security documentation, so it is checked rather than maintained.
 *
 * Four ways it can be wrong, all of them failures:
 *
 *   - a constraint naming no requirement or no test;
 *   - a requirement id that does not exist in the requirements file;
 *   - a test id that did not run in the run being checked;
 *   - a test id that ran and did not pass.
 *
 * Usage: node verification/golden-tests/security-constraints.mjs [--run <RUN_ID>]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, VERIFICATION } from './harness.mjs';

const DOC = resolve(ROOT, 'docs/security/constraints.md');
const REQUIREMENTS = resolve(VERIFICATION, 'security-requirements.json');
const RESULTS = resolve(VERIFICATION, 'reports/golden-results.jsonl');

const argv = process.argv.slice(2);
const runIndex = argv.indexOf('--run');

const green = t => `\u001b[32m${t}\u001b[0m`;
const red = t => `\u001b[31m${t}\u001b[0m`;
const dim = t => `\u001b[2m${t}\u001b[0m`;

if (!existsSync(DOC)) {
  console.error(red('docs/security/constraints.md is missing. The constraint map is not optional: '
    + 'it is how "we follow these rules" stops being an assertion.'));
  process.exit(2);
}

const doc = readFileSync(DOC, 'utf8');
const { requirements } = JSON.parse(readFileSync(REQUIREMENTS, 'utf8'));
const knownRequirements = new Set(requirements.map(r => r.id));

const lines = readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const runId = runIndex >= 0 ? argv[runIndex + 1] : lines.at(-1)?.runId;
const results = new Map();
for (const record of lines.filter(r => r.runId === runId)) results.set(record.testId, record);

/**
 * The table rows, parsed rather than hand-listed here.
 *
 * Deliberately keyed on the row shape rather than on the constraint text: the wording of a
 * rule may be tightened, and a checker that broke when somebody improved a sentence would be
 * removed within a week.
 */
const rows = doc.split('\n')
  .filter(line => /^\|\s*\d+\s*\|/.test(line))
  .map(line => {
    const cells = line.split('|').map(cell => cell.trim());
    return {
      number: Number(cells[1]),
      constraint: cells[2],
      requirements: [...cells[3].matchAll(/SEC-R\d+/g)].map(m => m[0]),
      tests: [...cells[4].matchAll(/`([A-Z][A-Z0-9-]*)`/g)].map(m => m[1]),
      ranges: [...cells[4].matchAll(/`([A-Z][A-Z0-9-]*)`–`([A-Z][A-Z0-9-]*)`/g)]
    };
  });

const problems = [];

if (rows.length !== 18) {
  problems.push(`The map has ${rows.length} row(s); the brief names 18 constraints. `
    + 'A row that quietly disappeared takes its coverage claim with it.');
}

for (const row of rows) {
  if (row.requirements.length === 0) {
    problems.push(`Constraint ${row.number} names no requirement.`);
  }
  if (row.tests.length === 0) {
    problems.push(`Constraint ${row.number} names no test.`);
  }

  for (const id of row.requirements) {
    if (!knownRequirements.has(id)) {
      problems.push(`Constraint ${row.number} names ${id}, which is not in the requirements file.`);
    }
  }

  for (const testId of row.tests) {
    const record = results.get(testId);
    if (!record) {
      problems.push(`Constraint ${row.number} names ${testId}, which did not run in ${runId}.`);
      continue;
    }
    if (record.result !== 'PASS') {
      problems.push(`Constraint ${row.number} names ${testId}, which ${record.result} in ${runId}.`);
    }
  }
}

const citedTests = new Set(rows.flatMap(row => row.tests));
const citedRequirements = new Set(rows.flatMap(row => row.requirements));

console.log('');
if (problems.length > 0) {
  console.log(red(`The constraint map does not hold: ${problems.length} problem(s).`));
  for (const problem of problems) console.log(red(`  ${problem}`));
  console.log('');
  process.exit(1);
}

console.log(green(`All ${rows.length} constraints map to a requirement and to tests that passed.`));
console.log(dim(`  ${citedRequirements.size} requirement(s) and ${citedTests.size} test(s) cited, `
  + `checked against run ${runId}.`));
console.log(dim('  Two constraints are held by an absent code path rather than a check, and '
  + 'docs/security/constraints.md says which and why.'));
console.log('');
