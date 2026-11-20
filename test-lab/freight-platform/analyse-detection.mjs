/**
 * Re-derives the detection verdict from a stored pipeline result.
 *
 * Separate from run-pipeline.mjs so the join can be corrected and re-run without spending
 * twenty minutes re-crawling. It reads pipeline-result.json, applies the classification in
 * detection.mjs, and writes detection-analysis.json alongside it.
 *
 *   node analyse-detection.mjs [--result pipeline-result.json]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { detect, classifyFailure } from './detection.mjs';

const which = process.argv.indexOf('--result');
const resultFile = which === -1 ? 'pipeline-result.json' : process.argv[which + 1];

const groundTruth = JSON.parse(await readFile(new URL('./ground-truth.json', import.meta.url), 'utf8'));
const result = JSON.parse(await readFile(new URL(`./${resultFile}`, import.meta.url), 'utf8'));

const execution = result.stages?.execution ?? {};
const security = result.stages?.security ?? {};
const discovery = result.stages?.discovery ?? {};

const analysis = detect({
  defects: groundTruth.defects.list,
  failures: execution.failures ?? [],
  findings: security.list ?? [],
  reachedPaths: discovery.discoveredPaths ?? []
});

const line = (text = '') => console.log(text);
const rule = (char = '─') => line(char.repeat(76));

line();
rule('═');
line('DETECTION — what the platform found against the 32 planted defects');
rule('═');

line(`\n  Run: discovery ${discovery.status}, ${discovery.declaredReached}/${discovery.declaredTotal} screens`);
line(`       generation ${result.stages?.generation?.totalCases ?? '?'} cases `
  + `(${result.stages?.generation?.duplication?.distinct ?? '?'} distinct)`);
line(`       execution ${execution.passed ?? '?'} passed, ${execution.failed ?? '?'} failed, `
  + `${execution.blocked ?? 0} blocked`);
line(`       security ${security.findings ?? 0} finding(s)`);

// ---- what the failures actually were -------------------------------------

line();
rule();
line('  What the failures were');
rule();
const fa = analysis.failureAnalysis;
line(`\n  ${fa.total} failure(s) reported by the run:`);
line(`    ${String(fa.applicationFailures).padStart(3)}  the application behaving wrongly`);
line(`    ${String(fa.toolErrors).padStart(3)}  the test tool unable to drive the page`);
line(`    ${String(fa.unreliableTests ?? 0).padStart(3)}  a test that could not tell a pass from a failure`);
if (fa.unknown) line(`    ${String(fa.unknown).padStart(3)}  no message to classify`);

if (fa.unreliableTests) {
  line('\n  The unreliable tests, by cause:');
  for (const [kind, entry] of Object.entries(fa.unreliableBreakdown ?? {})
    .sort((a, b) => b[1].count - a[1].count)) {
    line(`    ${String(entry.count).padStart(3)}  ${kind.padEnd(38)} ${entry.explain}`);
    for (const example of entry.examples) line(`         e.g. ${example.slice(0, 68)}`);
  }
  line('\n  These say nothing about the application either way. Counting them as');
  line('  application failures would credit the platform with finding something;');
  line('  counting them as tool errors would imply the browser refused. Neither is true.');
}

if (fa.toolErrors) {
  line('\n  The tool errors, by cause:');
  for (const [kind, entry] of Object.entries(fa.toolErrorBreakdown).sort((a, b) => b[1].count - a[1].count)) {
    line(`    ${String(entry.count).padStart(3)}  ${kind.padEnd(20)} ${entry.explain}`);
    for (const example of entry.examples) line(`         e.g. ${example.slice(0, 68)}`);
  }
  line('\n  These are generated tests that cannot run, by construction. They report as');
  line('  failures, indistinguishable in the summary from a real defect, so a team sees a');
  line(`  run with ${fa.total} failures and goes looking for ${fa.total} bugs that do not exist.`);
}

// ---- detection ------------------------------------------------------------

line();
rule();
line('  Detection');
rule();
const c = analysis.counts;
line(`\n    found       ${String(c.found).padStart(2)}  a failure or finding named the screen and the symptom`);
line(`    possible    ${String(c.possible).padStart(2)}  two independent symptom keywords, screen not named`);
line(`    missed      ${String(c.missed).padStart(2)}  the screen was discovered and nothing reported it`);
line(`    unreachable ${String(c.unreachable).padStart(2)}  discovery never reached the screen`);

if (c.found) {
  line('\n  Found:');
  for (const verdict of analysis.verdicts.filter(v => v.verdict === 'found')) {
    line(`    ${verdict.id} (${verdict.severity})`);
    if (verdict.evidence) line(`      evidence: ${verdict.evidence}`);
  }
}
if (c.possible) {
  line('\n  Possible, not claimed:');
  for (const verdict of analysis.verdicts.filter(v => v.verdict === 'possible')) {
    line(`    ${verdict.id} (${verdict.severity})`);
    if (verdict.evidence) line(`      evidence: ${verdict.evidence}`);
  }
}

const byCategory = {};
for (const verdict of analysis.verdicts) {
  byCategory[verdict.category] ??= { total: 0, found: 0, reachable: 0 };
  byCategory[verdict.category].total += 1;
  if (verdict.verdict === 'found') byCategory[verdict.category].found += 1;
  if (verdict.screenReached) byCategory[verdict.category].reachable += 1;
}
line('\n  By category (found / on a reached screen / planted):');
for (const [category, figures] of Object.entries(byCategory).sort()) {
  line(`    ${category.padEnd(16)} ${figures.found} / ${figures.reachable} / ${figures.total}`);
}

line('\n  The honest reading:');
if (c.found === 0) {
  line(`    The platform generated tests, executed them, and detected none of the`);
  line(`    ${analysis.verdicts.length} planted defects.`);
} else {
  line(`    ${c.found} of ${analysis.verdicts.length} planted defects were detected.`);
}
line(`    ${c.unreachable} of them sat on screens discovery never reached, so nothing downstream`);
line('    could have found them whatever the generator did.');
// Said from the figures rather than from what was true of an earlier run: a report that
// hard-codes last run's conclusion cannot tell you when the conclusion has changed.
if (fa.total > 0) {
  const share = (n) => `${n} of ${fa.total}`;
  line(`    Of the ${fa.total} failure(s) it did report: ${share(fa.toolErrors)} were the tool`);
  line(`    unable to drive the page, ${share(fa.unreliableTests ?? 0)} were tests that could not`);
  line(`    tell a pass from a failure, and ${share(fa.applicationFailures)} were the application`);
  line('    behaving wrongly — none of which matched a planted defect.');
}

await writeFile(new URL('./detection-analysis.json', import.meta.url),
  JSON.stringify({
    analysedAt: new Date().toISOString(),
    source: resultFile,
    note: 'A failure is classified as a tool error or an application failure before it is '
        + 'matched to a defect. Only an application failure can evidence one: a Playwright '
        + 'timeout says nothing about whether the application is correct, whatever words '
        + 'happen to be in its message.',
    run: {
      discovery: { status: discovery.status, reached: discovery.declaredReached, total: discovery.declaredTotal },
      generation: result.stages?.generation?.duplication ?? null,
      execution: { passed: execution.passed, failed: execution.failed, blocked: execution.blocked },
      security: { findings: security.findings ?? 0, status: security.status ?? null }
    },
    ...analysis
  }, null, 2) + '\n');

if ((analysis.deadKeywords ?? []).length) {
  line('\n────────────────────────────────────────────────────────────────────────────');
  line('  Keyword lists that match nothing in this run');
  line('────────────────────────────────────────────────────────────────────────────\n');
  line('  These defects cannot be scored at all: whatever the run found, no signal');
  line('  contains any of their words. Either the defect genuinely produced nothing, or');
  line('  the list was written against wording the oracles do not use — which is how');
  line('  FP_D25 and FP_D26 read as missed while both were being detected.\n');
  for (const dead of analysis.deadKeywords) {
    line(`    ${dead.id.padEnd(38)} ${dead.keywords.join(', ')}`);
  }
}

line(`\n  Written to detection-analysis.json\n`);
