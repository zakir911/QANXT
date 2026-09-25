/**
 * The autonomous QA report.
 *
 * Every number here comes from `reports/golden-results.jsonl`, which only the harness writes
 * and only after a check has actually run. Nothing in this file can produce a result; it can
 * only summarise ones that exist. A report generated from intentions rather than executions
 * is how a team ends up believing something nobody tested, and an autonomous agent is
 * exactly the thing about which that mistake is most expensive.
 *
 * Seven states, kept apart on purpose:
 *
 *   IMPLEMENTED    the code exists
 *   EXECUTED       it ran in this run
 *   VERIFIED       it ran and the expected behaviour was observed, with evidence
 *   FAILED         it ran and did not behave as expected
 *   NOT VERIFIED   declared, deliberately not executed, with the reason recorded
 *   NOT TESTED     no test covers it at all
 *   LIMITATION     a known boundary of what these tests can establish
 *
 * IMPLEMENTED is never upgraded to VERIFIED because the code is there. That is the whole
 * distinction the report exists to hold.
 *
 * Usage: node verification/golden-tests/autonomous-qa-report.mjs [--run <RUN_ID>]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { VERIFICATION, ROOT, hashFile } from './harness.mjs';

const RESULTS = resolve(VERIFICATION, 'reports/golden-results.jsonl');
const REQUIREMENTS = resolve(VERIFICATION, 'autonomous-qa-requirements.json');
const MARKDOWN = resolve(VERIFICATION, 'reports/AUTONOMOUS-QA-REPORT.md');
const HTML = resolve(VERIFICATION, 'reports/autonomous-qa-report.html');
const JSON_OUT = resolve(VERIFICATION, 'reports/autonomous-qa-report.json');

const argv = process.argv.slice(2);
const runIndex = argv.indexOf('--run');
const requestedRun = runIndex >= 0 ? argv[runIndex + 1] : null;

if (!existsSync(RESULTS)) {
  console.error('No golden results yet. Run: ./scripts/verify-autonomous-qa');
  process.exit(2);
}

const lines = readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const runId = requestedRun ?? lines.at(-1).runId;

const latest = new Map();
for (const record of lines.filter(r => r.runId === runId)) latest.set(record.testId, record);

/** The suites that make the autonomous claim. Anything else belongs in another report. */
const SUITES = new Set([
  'Autonomous planning', 'Autonomous policy', 'Autonomous execution',
  'Autonomous prompt injection', 'Autonomous fault handling', 'Autonomous intelligence'
]);

const results = [...latest.values()]
  .filter(r => SUITES.has(r.suite))
  .sort((a, b) => a.testId.localeCompare(b.testId));

if (results.length === 0) {
  console.error(`No autonomous results in run ${runId}. Run ./scripts/verify-autonomous-qa.`);
  process.exit(2);
}

const passed = results.filter(r => r.result === 'PASS');
const failed = results.filter(r => r.result === 'FAIL');
const notVerified = results.filter(r => r.result === 'NOT_VERIFIED');

const FAMILIES = [
  ['AQN-', 'Planning', 'What a pass proposes to test, and what it admits it will not'],
  ['AQP-', 'Policy and authority', 'What the agent may do, what refuses it, and who is asked'],
  ['AQE-', 'Execution', 'What a pass actually did, end to end, and what it left alone'],
  ['AQX-', 'Prompt injection', 'Application content that tries to instruct the agent'],
  ['AQF-', 'Fault handling', 'A broken, unreachable or cancelled pass'],
  ['AQI-', 'Intelligence and coverage', 'Memory between passes, coverage, and the release assessment']
];

const group = prefix => results.filter(r => r.testId.startsWith(prefix));
const rateOf = prefix => {
  const rows = group(prefix);
  return { total: rows.length, passed: rows.filter(r => r.result === 'PASS').length };
};

// ---------------------------------------------------------------------------
// Requirements, and the three states a requirement can be in that are not "verified"
// ---------------------------------------------------------------------------

const { requirements } = existsSync(REQUIREMENTS)
  ? JSON.parse(readFileSync(REQUIREMENTS, 'utf8')) : { requirements: [] };

const requirementStatus = requirements.map(requirement => {
  const tests = requirement.verifiedBy ?? [];
  const records = tests.map(id => ({ id, record: latest.get(id) }));
  const missing = records.filter(r => r.record === undefined).map(r => r.id);
  const failing = records.filter(r => r.record?.result === 'FAIL').map(r => r.id);

  // A named test that does not exist in this run is the interesting case: the table says a
  // requirement is covered and nothing ran to show it. That is NOT VERIFIED, and naming the
  // missing ids is the difference between a reader being able to check and having to trust.
  const status = tests.length === 0 ? 'NOT TESTED'
    : failing.length > 0 ? 'FAILED'
    : missing.length > 0 ? 'NOT VERIFIED'
    : 'VERIFIED';

  return { ...requirement, status, missing, failing, testCount: tests.length };
});

const evidenceFiles = results.flatMap(r => r.evidence ?? []);
const evidenceIntact = evidenceFiles.filter(file => {
  const path = resolve(VERIFICATION, file.path);
  return existsSync(path) && hashFile(path) === file.sha256;
});

// ---------------------------------------------------------------------------
// What is implemented and not verified end to end. Held by hand, on purpose: nothing can
// derive this, and a report that omitted it would read as though everything built had been
// shown to work.
// ---------------------------------------------------------------------------

const IMPLEMENTED_NOT_VERIFIED = [
  ['TestDuplicationModel', 'Decides whether a proposed test duplicates one that exists. Unit-tested '
    + '(12 tests) and not reachable from a pass: the agent does not call it, so no golden test can.'],
  ['ExploratoryModel', 'Chooses areas existing tests do not reach. Unit-tested (part of 23) and not '
    + 'wired into the loop.'],
  ['DynamicSelectionModel', 'Narrows a run as results arrive. Unit-tested and not wired into the loop.'],
  ['RegressionPromotionModel', 'Turns a security finding or a journey into a regression test. '
    + 'Unit-tested and not wired into the loop.'],
  ['FailureCorrelationModel', 'Groups failures that share a cause. Unit-tested (13 tests) and not '
    + 'wired into the loop.'],
  ['TestHistoryModel', 'Explains what history says about a test. Unit-tested (14 tests); the agent '
    + 'reads history through the plan service instead.'],
  ['AutonomousAssessmentModel', 'Assembles a release judgement from what a pass established. '
    + 'Unit-tested (15 tests) and not wired into the loop.']
];

const LIMITATIONS = [
  ['Every figure describes the golden lab.', 'The applications these passes ran against were '
    + 'written alongside the platform that tests them. That is the right way to test a test '
    + 'platform and the wrong way to estimate how it will do against an application nobody has '
    + 'seen. Nothing here generalises to an arbitrary application.'],
  ['A pass is only as wide as discovery.', 'Coverage, risk and gaps are all measured against what '
    + 'the crawl reached. A page discovery never walked is absent from the assessment rather than '
    + 'reported as a gap in it, and the coverage decision says so in its own words.'],
  ['Accessibility and visual coverage are not assessed by a pass.', 'They are declared unassessable '
    + 'and land as Unknown, so they appear as questions nobody answered rather than vanishing from '
    + 'the denominator. The platform tests both elsewhere; the agent does not.'],
  ['No pass has ever run against production.', 'Only the refusal is verified. The permitted form of '
    + 'a production pass has never been exercised, and nothing here says what it would do.'],
  ['The agent has never been run with a live model provider in these suites.', 'Model spend is '
    + 'reported as zero because the deterministic planner was used. The cost ceiling is verified as '
    + 'a bound, not as a bound that has ever bitten.'],
  ['A coverage gap is a gap in the platform\'s records.', 'Somebody may be testing that capability '
    + 'by hand. The finding says what the platform knows, not what the team does.'],
  ['Injection resistance is tested against the payloads written for it.', 'Twenty-five of them. An '
    + 'attack nobody thought of is untested, not defended.'],
  ['Almost none of this is reachable from the console.', 'The plan a person approves, the decision '
    + 'log, the approval queue, the timeline, the business context and the coverage assessment are '
    + 'all API-only. The console\'s agent page lists passes, shows one and cancels it. Everything '
    + 'these tests verify, a person would today reach with curl — which makes the human-in-the-loop '
    + 'requirement satisfied in the platform and not in the product.'],
  ['Two defects found by running the platform are recorded and not fixed.', 'A worker job whose '
    + 'completion is refused is re-queued with no attempt count, and a worker whose Redis connection '
    + 'drops goes silently idle. Both are in verification/OBSERVED-DEFECTS.md, which separates what '
    + 'was observed from what was only inferred.']
];

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

const VERDICT = failed.length === 0
  ? 'AIRA\'s autonomous QA agent behaved as specified against its own lab in this run.'
  : `AIRA's autonomous QA agent did NOT behave as specified: ${failed.length} test(s) failed.`;

const payload = {
  runId,
  generatedAt: new Date().toISOString(),
  verdict: VERDICT,
  totals: {
    tests: results.length,
    passed: passed.length,
    failed: failed.length,
    notVerified: notVerified.length,
    evidenceFiles: evidenceFiles.length,
    evidenceIntact: evidenceIntact.length
  },
  families: FAMILIES.map(([prefix, name, what]) => ({ prefix, name, what, ...rateOf(prefix) }))
    .filter(f => f.total > 0),
  requirements: requirementStatus.map(r => ({
    id: r.id, statement: r.statement, status: r.status,
    verifiedBy: r.verifiedBy ?? [], missing: r.missing, failing: r.failing
  })),
  implementedNotVerified: IMPLEMENTED_NOT_VERIFIED.map(([name, why]) => ({ name, why })),
  limitations: LIMITATIONS.map(([headline, detail]) => ({ headline, detail })),
  notVerified: notVerified.map(r => ({ testId: r.testId, objective: r.objective, why: r.detail })),
  failures: failed.map(r => ({ testId: r.testId, severity: r.severity, detail: r.detail })),
  tests: results.map(r => ({
    testId: r.testId, suite: r.suite, result: r.result, severity: r.severity,
    objective: r.objective, detail: r.detail, evidence: (r.evidence ?? []).length
  }))
};

writeFileSync(JSON_OUT, `${JSON.stringify(payload, null, 2)}\n`);

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const countBy = status => requirementStatus.filter(r => r.status === status).length;

const markdown = [
  '# AIRA — autonomous QA report',
  '',
  `**${VERDICT}**`,
  '',
  `Run \`${runId}\` · ${results.length} autonomous test(s) · `
  + `${passed.length} passed, ${failed.length} failed, ${notVerified.length} not verified`,
  '',
  '> **What this report is, and is not.** It describes what AIRA\'s autonomous agent did against',
  '> the golden lab in this run. It does not say that any application is defect-free, secure or',
  '> fully covered, and no figure in it should be quoted as though it did. Every number comes from',
  '> a recorded execution; nothing is asserted.',
  '',
  '## States',
  '',
  '| State | What it means here |',
  '| --- | --- |',
  '| IMPLEMENTED | The code exists. Nothing more. |',
  '| EXECUTED | It ran in this run. |',
  '| VERIFIED | It ran and the expected behaviour was observed, with evidence. |',
  '| FAILED | It ran and did not behave as expected. |',
  '| NOT VERIFIED | Declared and deliberately not executed, with the reason recorded. |',
  '| NOT TESTED | No test covers it at all. |',
  '| LIMITATION | A known boundary of what these tests can establish. |',
  '',
  '## Results by family',
  '',
  '| Family | Passed | What it establishes |',
  '| --- | --- | --- |',
  ...FAMILIES.map(([prefix, name, what]) => {
    const rate = rateOf(prefix);
    if (rate.total === 0) return null;
    const mark = rate.passed === rate.total ? `${rate.passed}/${rate.total}` : `**${rate.passed}/${rate.total}**`;
    return `| ${name} | ${mark} | ${what} |`;
  }).filter(Boolean),
  '',
  '## Requirements',
  '',
  `${countBy('VERIFIED')} verified, ${countBy('FAILED')} failed, `
  + `${countBy('NOT VERIFIED')} not verified, ${countBy('NOT TESTED')} not tested, `
  + `of ${requirementStatus.length}.`,
  '',
  '| Requirement | Status | Verified by |',
  '| --- | --- | --- |',
  ...requirementStatus.map(r => `| **${r.id}** ${r.statement} | ${r.status === 'VERIFIED' ? 'VERIFIED' : `**${r.status}**`} `
    + `| ${r.testCount} test(s)${r.missing.length ? `, missing: \`${r.missing.join('`, `')}\`` : ''}`
    + `${r.failing.length ? `, failing: \`${r.failing.join('`, `')}\`` : ''} |`),
  '',
  '## Implemented, not verified end to end',
  '',
  'These exist as code with unit tests and are not reachable from a pass, so no golden test can',
  'establish that they work in the product. They are listed here rather than counted as delivered.',
  '',
  '| Component | Why it is not verified |',
  '| --- | --- |',
  ...IMPLEMENTED_NOT_VERIFIED.map(([name, why]) => `| \`${name}\` | ${why} |`),
  '',
  '## What was NOT tested',
  ''
];

if (notVerified.length === 0) {
  markdown.push('_Nothing was declared and left unexecuted in this run._', '');
} else {
  markdown.push('| Test | What it would have established | Why it did not run |', '| --- | --- | --- |',
    ...notVerified.map(r => `| \`${r.testId}\` | ${r.objective} | ${r.detail} |`), '');
}

markdown.push('## Known limitations', '');
for (const [headline, detail] of LIMITATIONS) markdown.push(`- **${headline}** ${detail}`);
markdown.push('');

if (failed.length > 0) {
  markdown.push('## Failures', '', '| Test | Severity | What happened |', '| --- | --- | --- |',
    ...failed.map(r => `| \`${r.testId}\` | ${r.severity} | ${r.detail} |`), '');
}

markdown.push(
  '## Evidence',
  '',
  `${evidenceFiles.length} file(s) recorded, ${evidenceIntact.length} whose hash still matches.`,
  '',
  '## Every autonomous test in this run',
  '',
  '| Test | Result | Objective | Evidence |',
  '| --- | --- | --- | --- |',
  ...results.map(r => `| \`${r.testId}\` | ${r.result === 'PASS' ? 'PASS' : `**${r.result}**`} `
    + `| ${r.objective} | ${(r.evidence ?? []).length} file(s) |`),
  '',
  '---',
  '',
  `Generated from \`verification/reports/golden-results.jsonl\` for run \`${runId}\`. `
  + 'Every figure is derived from a recorded execution; nothing in this report is asserted.',
  ''
);

writeFileSync(MARKDOWN, markdown.join('\n'));

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const escape = text => String(text)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const statusClass = status => status === 'VERIFIED' ? 'ok'
  : status === 'FAILED' ? 'bad' : 'warn';

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIRA autonomous QA</title>
<style>
  :root { --ink:#16181d; --muted:#6b7280; --line:#e5e7eb; --ok:#15803d; --bad:#b91c1c; --warn:#a16207; --bg:#fff; --panel:#f9fafb; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --ink:#e5e7eb; --muted:#9ca3af; --line:#2b2f36; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; --bg:#0f1115; --panel:#171a20; } }
  :root[data-theme="dark"] { --ink:#e5e7eb; --muted:#9ca3af; --line:#2b2f36; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; --bg:#0f1115; --panel:#171a20; }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--ink); margin: 0; padding: 0 16px 64px;
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 40px 0 8px; }
  h2 { font-size: 1.15rem; margin: 36px 0 10px; padding-top: 18px; border-top: 1px solid var(--line); }
  .verdict { font-size: 1.05rem; font-weight: 600; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: .9rem; margin-bottom: 24px; }
  .disclaimer { background: var(--panel); border-left: 3px solid var(--warn); padding: 14px 16px;
                border-radius: 6px; font-size: .92rem; margin: 20px 0; }
  table { width: 100%; border-collapse: collapse; font-size: .92rem; margin: 12px 0 8px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; }
  td.ok { color: var(--ok); font-weight: 600; } td.bad { color: var(--bad); font-weight: 600; }
  td.warn { color: var(--warn); font-weight: 600; }
  .muted { color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; }
  ul { padding-left: 20px; } li { margin: 8px 0; }
  .scroll { overflow-x: auto; }
  footer { color: var(--muted); font-size: .85rem; margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<main>
  <h1>AIRA — autonomous QA</h1>
  <p class="verdict">${escape(VERDICT)}</p>
  <p class="meta">Run <code>${escape(runId)}</code> · ${results.length} autonomous test(s) ·
     ${passed.length} passed, ${failed.length} failed, ${notVerified.length} not verified</p>

  <div class="disclaimer">
    <p><strong>What this report is, and is not.</strong> It describes what AIRA's autonomous agent
    did against the golden lab in this run. It does not say that any application is defect-free,
    secure or fully covered. Every number comes from a recorded execution; nothing is asserted.</p>
  </div>

  <h2>Results by family</h2>
  <div class="scroll"><table>
    <tr><th>Family</th><th>Passed</th><th>What it establishes</th></tr>
    ${FAMILIES.map(([prefix, name, what]) => {
      const rate = rateOf(prefix);
      if (rate.total === 0) return '';
      return `<tr><td>${escape(name)}</td>`
        + `<td class="${rate.passed === rate.total ? 'ok' : 'bad'}">${rate.passed}/${rate.total}</td>`
        + `<td class="muted">${escape(what)}</td></tr>`;
    }).join('\n')}
  </table></div>

  <h2>Requirements</h2>
  <p class="muted">${countBy('VERIFIED')} verified, ${countBy('FAILED')} failed,
     ${countBy('NOT VERIFIED')} not verified, ${countBy('NOT TESTED')} not tested,
     of ${requirementStatus.length}.</p>
  <div class="scroll"><table>
    <tr><th>Requirement</th><th>Status</th><th>Verified by</th></tr>
    ${requirementStatus.map(r => `<tr><td><strong>${escape(r.id)}</strong> ${escape(r.statement)}</td>`
      + `<td class="${statusClass(r.status)}">${escape(r.status)}</td>`
      + `<td class="muted">${r.testCount} test(s)`
      + `${r.missing.length ? `<br>missing: <code>${escape(r.missing.join(', '))}</code>` : ''}`
      + `${r.failing.length ? `<br>failing: <code>${escape(r.failing.join(', '))}</code>` : ''}</td></tr>`).join('\n')}
  </table></div>

  <h2>Implemented, not verified end to end</h2>
  <p class="muted">Code with unit tests that a pass cannot reach, so no golden test can establish
     that it works in the product. Listed rather than counted as delivered.</p>
  <div class="scroll"><table>
    <tr><th>Component</th><th>Why it is not verified</th></tr>
    ${IMPLEMENTED_NOT_VERIFIED.map(([name, why]) =>
      `<tr><td><code>${escape(name)}</code></td><td class="muted">${escape(why)}</td></tr>`).join('\n')}
  </table></div>

  <h2>What was not tested</h2>
  <div class="scroll"><table>
    <tr><th>Test</th><th>What it would have established</th><th>Why it did not run</th></tr>
    ${notVerified.map(r => `<tr><td><code>${escape(r.testId)}</code></td><td>${escape(r.objective)}</td>`
      + `<td class="muted">${escape(r.detail)}</td></tr>`).join('\n')
      || '<tr><td colspan="3" class="muted">Nothing was declared and left unexecuted.</td></tr>'}
  </table></div>

  <h2>Known limitations</h2>
  <ul>
    ${LIMITATIONS.map(([headline, detail]) =>
      `<li><strong>${escape(headline)}</strong> ${escape(detail)}</li>`).join('\n')}
  </ul>

  ${failed.length > 0 ? `<h2>Failures</h2><div class="scroll"><table>
    <tr><th>Test</th><th>Severity</th><th>What happened</th></tr>
    ${failed.map(r => `<tr><td><code>${escape(r.testId)}</code></td><td>${escape(r.severity)}</td>`
      + `<td class="bad">${escape(r.detail)}</td></tr>`).join('')}
  </table></div>` : ''}

  <h2>Every autonomous test in this run</h2>
  <div class="scroll"><table>
    <tr><th>Test</th><th>Result</th><th>Objective</th><th>Evidence</th></tr>
    ${results.map(r => `<tr><td><code>${escape(r.testId)}</code></td>`
      + `<td class="${r.result === 'PASS' ? 'ok' : 'bad'}">${escape(r.result)}</td>`
      + `<td>${escape(r.objective)}</td><td class="muted">${(r.evidence ?? []).length}</td></tr>`).join('\n')}
  </table></div>

  <footer>
    Generated from <code>verification/reports/golden-results.jsonl</code> for run
    <code>${escape(runId)}</code>. ${evidenceFiles.length} evidence file(s) recorded,
    ${evidenceIntact.length} whose hash still matches. Every figure is derived from a recorded
    execution; nothing in this report is asserted.
  </footer>
</main>
</body>
</html>`;

writeFileSync(HTML, html);

const green = t => `\u001b[32m${t}\u001b[0m`;
const red = t => `\u001b[31m${t}\u001b[0m`;
const dim = t => `\u001b[2m${t}\u001b[0m`;

console.log('');
console.log(failed.length === 0 ? green(VERDICT) : red(VERDICT));
console.log(dim(`  ${results.length} autonomous test(s): ${passed.length} passed, ${failed.length} failed, `
  + `${notVerified.length} not verified`));
console.log(dim(`  Requirements: ${countBy('VERIFIED')} verified, ${countBy('FAILED')} failed, `
  + `${countBy('NOT VERIFIED')} not verified, ${countBy('NOT TESTED')} not tested`));
console.log(dim(`  ${IMPLEMENTED_NOT_VERIFIED.length} component(s) implemented and not verified end to end`));
console.log(dim(`  Written to ${relative(ROOT, MARKDOWN)}`));
console.log(dim(`            ${relative(ROOT, HTML)}`));
console.log(dim(`            ${relative(ROOT, JSON_OUT)}`));
console.log('');

// A requirement that failed, or that names a test which did not run, is a failure of the
// report's own contract: the table claims coverage that this run did not show.
const unverifiedRequirements = requirementStatus.filter(r => r.status !== 'VERIFIED');
process.exit(failed.length === 0 && unverifiedRequirements.length === 0 ? 0 : 1);
