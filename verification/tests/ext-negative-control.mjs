/**
 * Negative controls for the extension suite.
 *
 * A check that has only ever passed is not evidence. Each mutation below breaks one
 * property of the real extension, rebuilds it, and re-runs the suite: the check that owns
 * that property must go red, and it must be the one that goes red. The source is never
 * touched — the mutation is applied to the built bundle and reverted afterwards, and the
 * suite is rebuilt and re-run clean at the end.
 *
 * Results are written to reports/negative-controls.jsonl, not to the main ledger: these
 * runs describe deliberately broken builds, not the product.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EVIDENCE, ROOT, saveEvidence } from './harness.mjs';

const DIST = resolve(ROOT, 'apps/browser-extension/dist');

const MUTATIONS = [
  {
    id: 'EXT-002',
    name: 'the service worker stops serialising its handlers',
    file: 'background.js',
    edits: [['const result = pending.then(work, work);', 'const result = work();']],
    why: 'restores the read-modify-write race that used to drop steps arriving in one tick'
  },
  {
    id: 'EXT-003',
    name: 'the recorder captures the password it typed',
    file: 'content.js',
    edits: [['value: isSecret ? "${secret:app_password}" : input.value,', 'value: input.value,']],
    why: 'the literal credential would reach the export, the extension storage and the platform'
  },
  {
    id: 'EXT-004',
    name: 'recorded test ids drift, and candidates are no longer checked against the page',
    file: 'content.js',
    // Drifting the test id alone is not observable: the recorder checks every candidate
    // against the live document and drops one that matches nothing, which is a property
    // worth knowing. Both edits together produce what this check exists to catch — a
    // plausible-looking locator that addresses no element.
    edits: [
      ['if (value) return value;', 'if (value) return value + "-drifted";'],
      ['if (found.length === 0) return;', 'if (found.length === 0) { candidates.push(candidate); return; }']
    ],
    why: 'locators that look plausible but address nothing in a fresh browser'
  },
  {
    id: 'EXT-005',
    name: 'the recorder injects a node into the page it is recording',
    file: 'content.js',
    edits: [[
      'var RECORDING_ATTRIBUTE = "data-aira-recorder";',
      'var RECORDING_ATTRIBUTE = "data-aira-recorder";'
      + ' if (document.body) document.body.appendChild(document.createElement("aira-probe"));'
    ]],
    why: 'a recorder that modifies the application is recording something the user never had'
  },
  {
    id: 'EXT-007',
    name: 'consecutive edits to one field are compared by their serialised form again',
    file: 'background.js',
    edits: [['sameTarget(previous.target, step.target)',
      'JSON.stringify(previous.target) === JSON.stringify(step.target)']],
    why: 'the comparison BUG-0006 was about: never true, so every change event became a step'
  }
];

const build = () => execFileSync('node', ['build.mjs'], {
  cwd: resolve(ROOT, 'apps/browser-extension'), encoding: 'utf8'
});

function runSuite(label) {
  const ledger = 'reports/negative-controls.jsonl';
  try {
    const stdout = execFileSync('node', ['ext.mjs'], {
      cwd: resolve(EVIDENCE, 'tests'),
      encoding: 'utf8',
      env: { ...process.env, AIRA_VERIFY_RESULTS: ledger },
      timeout: 900_000
    });
    return { label, exitCode: 0, stdout };
  } catch (error) {
    return { label, exitCode: error.status ?? -1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const verdicts = (stdout) => Object.fromEntries(
  stdout.split('\n')
    .map(line => /^(PASS|FAIL)\s+(EXT-\d+)/.exec(line.trim()))
    .filter(Boolean)
    .map(match => [match[2], match[1]]));

build();
const outcomes = [];

for (const mutation of MUTATIONS) {
  const path = resolve(DIST, mutation.file);
  const original = readFileSync(path, 'utf8');
  const absent = mutation.edits.filter(([from]) => !original.includes(from)).map(([from]) => from);
  if (absent.length > 0) {
    // A mutation that no longer applies is not a passing control: the bundle has moved and
    // the control has stopped testing anything, which must be visible rather than quiet.
    outcomes.push({
      id: mutation.id, mutation: mutation.name, applied: false,
      detail: `the built bundle no longer contains: ${absent.join(' | ')}`
    });
    console.log(`\nNOT APPLIED  ${mutation.id}: the bundle no longer contains the anchor`);
    continue;
  }

  writeFileSync(path, mutation.edits.reduce((text, [from, to]) => text.replace(from, to), original));
  console.log(`\n--- mutation for ${mutation.id}: ${mutation.name}`);
  const run = runSuite(mutation.id);
  writeFileSync(path, original);

  const results = verdicts(run.stdout);
  const targetFailed = results[mutation.id] === 'FAIL';
  const collateral = Object.entries(results)
    .filter(([id, verdict]) => id !== mutation.id && verdict === 'FAIL')
    .map(([id]) => id);

  saveEvidence(`evidence/extension/negative-controls/${mutation.id}.txt`,
    `Mutation: ${mutation.name}\nApplied to dist/${mutation.file}\n`
    + mutation.edits.map(([from, to]) => `  ${from}\n→ ${to}\n`).join('')
    + `\n${run.stdout}`);

  outcomes.push({
    id: mutation.id, mutation: mutation.name, why: mutation.why, applied: true,
    detected: targetFailed, verdicts: results, alsoFailed: collateral
  });
  console.log(`${targetFailed ? 'DETECTED' : 'NOT DETECTED'}  ${mutation.id}`
    + (collateral.length ? ` (also failed: ${collateral.join(', ')})` : ''));
}

// Back to the real extension, and one clean run so the ledger ends on the truth.
build();
const clean = runSuite('clean');
const cleanVerdicts = verdicts(clean.stdout);
saveEvidence('evidence/extension/negative-controls/clean-rebuild.txt', clean.stdout);

const summaryPath = saveEvidence('evidence/extension/negative-controls.json', {
  generatedAt: new Date().toISOString(),
  note: 'Each mutation breaks one property of the real extension. A check that does not go '
    + 'red for its own mutation is not evidence of anything.',
  mutations: outcomes,
  cleanRebuild: { verdicts: cleanVerdicts, exitCode: clean.exitCode }
});

const undetected = outcomes.filter(o => o.applied && !o.detected).map(o => o.id);
const skipped = outcomes.filter(o => !o.applied).map(o => o.id);
console.log(`\nNegative controls: ${outcomes.length - undetected.length - skipped.length} of ${outcomes.length} detected`);
console.log(`Clean rebuild: ${Object.entries(cleanVerdicts).map(([id, v]) => `${id}=${v}`).join(' ')}`);
console.log(`Summary: ${summaryPath}`);
if (undetected.length || skipped.length || clean.exitCode !== 0) process.exitCode = 1;
