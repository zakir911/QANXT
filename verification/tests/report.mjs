/**
 * Builds the evidence index and the summary from results.jsonl.
 *
 * Generated rather than written by hand: every count in the final report is derived from a
 * line that a check actually appended, and every evidence path is re-hashed here so the
 * index cannot drift from the files on disk.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { EVIDENCE, hashFile } from './harness.mjs';

const lines = readFileSync(resolve(EVIDENCE, 'reports/results.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

// A check may have been run several times while a defect was being fixed. The last run is
// the state of the product now; the earlier ones are the history, kept in the bug reports.
const latest = new Map();
for (const record of lines) latest.set(record.id, record);
const results = [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));

const passed = results.filter(r => r.result === 'PASS');
const failed = results.filter(r => r.result === 'FAIL');

const rows = results.map(r => {
  const evidence = r.evidence.map(e => {
    const onDisk = resolve(EVIDENCE, e.path);
    const current = existsSync(onDisk) ? hashFile(onDisk) : null;
    return { ...e, present: current !== null, unchanged: current === e.sha256 };
  });
  return { ...r, evidence };
});

const index = [
  '# Evidence index',
  '',
  'Generated from `reports/results.jsonl`. Each row is the most recent execution of that',
  'check. Hashes are SHA-256 of the artifact as it is on disk now, recomputed when this index',
  'was generated — a mismatch would mean the file changed after the check recorded it.',
  '',
  `Generated ${new Date().toISOString()}.`,
  '',
  '| Test ID | Capability | Result | Ran at | Evidence (SHA-256, first 16) |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map(r => {
    const evidence = r.evidence.length
      ? r.evidence.map(e => `\`${e.path}\` (${(e.sha256 ?? '').slice(0, 16)}${e.unchanged ? '' : ' CHANGED'})`).join('<br>')
      : 'inline in `results.jsonl`';
    return `| ${r.id} | ${r.capability} | **${r.result}** | ${r.startedAt.replace('T', ' ').slice(0, 19)}Z | ${evidence} |`;
  }),
  '',
  `**${passed.length} passed, ${failed.length} failed** of ${results.length} checks.`,
  ''
].join('\n');

writeFileSync(resolve(EVIDENCE, 'final-report/EVIDENCE-INDEX.md'), index);

const summary = {
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed: passed.length,
  failed: failed.length,
  bySuite: Object.fromEntries(
    [...new Set(results.map(r => r.suite))].map(suite => [
      suite,
      {
        passed: results.filter(r => r.suite === suite && r.result === 'PASS').length,
        failed: results.filter(r => r.suite === suite && r.result === 'FAIL').length
      }
    ])),
  failures: failed.map(r => ({ id: r.id, capability: r.capability, detail: r.detail })),
  evidenceArtifacts: rows.reduce((total, r) => total + r.evidence.length, 0)
};
writeFileSync(resolve(EVIDENCE, 'final-report/summary.json'), JSON.stringify(summary, null, 2));

console.log(`${passed.length} passed, ${failed.length} failed of ${results.length} checks`);
console.log(`suites: ${JSON.stringify(summary.bySuite)}`);
if (failed.length) console.log('failing:', failed.map(f => f.id).join(', '));
