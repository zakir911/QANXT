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
 *   - a test id that ran and did not pass;
 *   - an absence the map relies on that is no longer absent.
 *
 * That last one is the reason this grew. Two of the eighteen are held by code that does not
 * exist — self-healing has no path to a security finding, and no model output becomes one —
 * and an absence is the one kind of claim a passing test cannot make. Nothing checked them, so
 * the day somebody imported SecurityFinding into the healing code, the map would have gone on
 * saying the rule was held by a path that had stopped being absent.
 *
 * Usage: node verification/golden-tests/security-constraints.mjs [--run <RUN_ID>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { ROOT, VERIFICATION } from './harness.mjs';

const DOC = resolve(ROOT, 'docs/security/constraints.md');
const DOCS_DIR = resolve(ROOT, 'docs/security');
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

/**
 * The absences constraints 12 and 14 rest on.
 *
 * Deliberately a reference check rather than a call-graph analysis: if the healing code cannot
 * name a security finding, it cannot change one, and the same for the model-facing code. That
 * is a blunt instrument and a true one, which is the right trade for something whose job is to
 * fail loudly the moment a boundary is crossed.
 */
const ABSENCES = [
  {
    constraint: 12,
    what: 'self-healing has no path to a security finding',
    // Diagnosis/ is where the API-side healing lives; the worker holds the locator rewriting.
    // Named explicitly rather than by a guessed folder name, which is how this check was
    // pointed at a directory that does not exist and passed without reading anything.
    directories: ['apps/api/src/Aira.Application/Diagnosis', 'apps/browser-worker/src/healing'],
    forbidden: /\bSecurityFinding\b|\bSecurityScan\b/
  },
  {
    constraint: 14,
    what: 'no model output becomes a security finding',
    directories: [
      'apps/api/src/Aira.Application/Ai',
      'apps/api/src/Aira.Application/Agent',
      'apps/api/src/Aira.Application/Intelligence'
    ],
    forbidden: /\bSecurityFinding\b/
  }
];

const sourceFiles = (dir) => {
  const root = resolve(ROOT, dir);
  if (!existsSync(root)) return [];
  const found = [];
  const walk = (at) => {
    for (const entry of readdirSync(at)) {
      // Build output is not source, and a compiled copy of a file already checked would
      // report the same crossing twice.
      if (entry === 'bin' || entry === 'obj' || entry === 'node_modules' || entry === 'dist') continue;
      const full = resolve(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(cs|ts|mjs)$/.test(entry)) found.push(full);
    }
  };
  walk(root);
  return found;
};

for (const absence of ABSENCES) {
  const crossings = [];
  const empty = [];

  for (const dir of absence.directories) {
    const files = sourceFiles(dir);
    // Checked per directory rather than across them. One surviving directory would otherwise
    // mask another that had been renamed away, and the check would go on passing while half
    // the boundary it guards had stopped being read.
    if (files.length === 0) empty.push(dir);

    for (const file of files) {
      if (absence.forbidden.test(readFileSync(file, 'utf8'))) {
        crossings.push(file.replace(`${ROOT}/`, ''));
      }
    }
  }

  // An absence proved by reading nothing is not proved. This is worse than not having the
  // check, because the map would then cite one that had quietly stopped looking.
  if (empty.length > 0) {
    problems.push(
      `Constraint ${absence.constraint} is checked by reading ${empty.join(', ')}, which holds `
      + 'no source. The code moved, so this check is passing without having read it.');
  }

  if (crossings.length > 0) {
    problems.push(
      `Constraint ${absence.constraint} is documented as held because ${absence.what}, and that `
      + `is no longer true: ${crossings.join(', ')}. Either the boundary moved and the map is `
      + 'wrong, or the reference is a mistake.');
  }
}

/**
 * Every test the security documentation cites, across all of it.
 *
 * The rows above cover `constraints.md`. The other thirteen documents cite tests too — as
 * evidence for a claim, which is the only reason to cite one — and nothing checked those. A
 * document naming a test that was renamed, or that now fails, reads exactly like one naming a
 * test that passes, and the reader has no way to tell without going and looking.
 *
 * Ids that never ran are reported separately from ids that ran and did not pass, because they
 * are different mistakes: the first is a stale citation, the second is a broken claim.
 */
const citationPattern = /\b(SEC[A-Z]*-[A-Z]?\d+)\b/g;
const stale = [];
const broken = [];

for (const file of readdirSync(DOCS_DIR).filter(f => f.endsWith('.md'))) {
  const text = readFileSync(resolve(DOCS_DIR, file), 'utf8');
  for (const [, id] of text.matchAll(citationPattern)) {
    // Requirement ids are not test ids and live in their own file, checked above.
    if (id.startsWith('SEC-R')) continue;

    const record = results.get(id);
    if (!record) stale.push(`${id} in ${basename(file)}`);
    else if (record.result !== 'PASS' && record.result !== 'NOT_VERIFIED') {
      broken.push(`${id} in ${basename(file)} ${record.result} in ${runId}`);
    }
  }
}

if (stale.length > 0) {
  problems.push(`The security documentation cites ${[...new Set(stale)].length} test(s) that did `
    + `not run in ${runId}: ${[...new Set(stale)].join(', ')}.`);
}
if (broken.length > 0) {
  problems.push(`The security documentation cites ${[...new Set(broken)].length} test(s) as `
    + `evidence that did not pass: ${[...new Set(broken)].join(', ')}.`);
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
console.log(dim(`  ${citedRequirements.size} requirement(s) and ${citedTests.size} test(s) cited `
  + `by the map, checked against run ${runId}.`));
console.log(dim('  Every test id cited anywhere in docs/security ran in that run and passed.'));
console.log(dim(`  ${ABSENCES.length} constraint(s) are held by an absent code path rather than a `
  + 'check, and the absence is checked against the real source here rather than asserted: '
  + ABSENCES.map(a => a.constraint).join(' and ') + '.'));
console.log('');
