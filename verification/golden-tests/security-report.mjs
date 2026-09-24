/**
 * The security verification report.
 *
 * Every number here comes from `reports/golden-results.jsonl`, which only the harness
 * writes and only after a check has actually run. Nothing in this file can produce a
 * result; it can only summarise ones that exist. That is the point — a security report
 * generated from intentions rather than executions is how a team ends up believing
 * something nobody tested.
 *
 * The report distinguishes seven states, because collapsing them is how security reporting
 * misleads:
 *
 *   IMPLEMENTED    the code exists
 *   EXECUTED       it ran in this run
 *   VERIFIED       it ran and the expected behaviour was observed with evidence
 *   FAILED         it ran and did not behave as expected
 *   NOT VERIFIED   declared, and deliberately not executed, with the reason recorded
 *   NOT TESTED     no test covers it at all
 *   LIMITATION     a known boundary of what these tests can establish
 *
 * And it never says an application is secure. It says what was tested, what was found, and
 * what was not reached.
 *
 * Usage: node verification/golden-tests/security-report.mjs [--run <RUN_ID>]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ROOT, VERIFICATION, hashFile } from './harness.mjs';

const RESULTS = resolve(VERIFICATION, 'reports/golden-results.jsonl');
const REQUIREMENTS = resolve(VERIFICATION, 'security-requirements.json');
const MARKDOWN = resolve(VERIFICATION, 'reports/SECURITY-VERIFICATION-REPORT.md');
const HTML = resolve(VERIFICATION, 'reports/security-verification-report.html');
const GROUND_TRUTH = resolve(ROOT, 'test-lab/security/ground-truth.json');
const TAXONOMY_DIR = resolve(VERIFICATION, 'security/taxonomy');

const argv = process.argv.slice(2);
const runIndex = argv.indexOf('--run');
const requestedRun = runIndex >= 0 ? argv[runIndex + 1] : null;

if (!existsSync(RESULTS)) {
  console.error('No golden results yet. Run: ./scripts/verify-security');
  process.exit(2);
}

const lines = readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const runId = requestedRun ?? lines.at(-1).runId;

const latest = new Map();
for (const record of lines.filter(r => r.runId === runId)) latest.set(record.testId, record);

/** The security suites. Everything else in the run belongs to another report. */
const SECURITY_SUITES = new Set(['Security scanning', 'Security gate, regression and triage',
                                 'Security scopes, scans and findings', 'Security scans AIRA runs itself',
                                 'Security and multi-tenancy']);
const results = [...latest.values()]
  .filter(r => SECURITY_SUITES.has(r.suite))
  .sort((a, b) => a.testId.localeCompare(b.testId));

if (results.length === 0) {
  console.error(`No security results in run ${runId}. Run ./scripts/verify-security.`);
  process.exit(2);
}

const passed = results.filter(r => r.result === 'PASS');
const failed = results.filter(r => r.result === 'FAIL');
const notVerified = results.filter(r => r.result === 'NOT_VERIFIED');

const group = prefix => results.filter(r => r.testId.startsWith(prefix));
const rateOf = prefix => {
  const rows = group(prefix);
  return { total: rows.length, passed: rows.filter(r => r.result === 'PASS').length };
};

const families = [
  ['SECD-', 'Detection', 'The flaw is switched on alone and the check reports it'],
  ['SECP-', 'Precision', 'The flaw is switched off and the check reports nothing'],
  ['SECM-', 'Classification', 'CWE, OWASP category and severity band match the ground truth'],
  ['SECS-', 'False positives', 'Endpoints the ground truth calls correct stay quiet'],
  ['SECG-', 'Scope guard', 'What security testing refuses to do, and the one thing it allows'],
  ['SECE-', 'Evidence', 'Findings without evidence are refused; secrets are redacted'],
  ['SECF-', 'Scan profiles', 'Each profile refuses the risk levels above it'],
  ['SECQ-', 'Security gate', 'What stops a build, and what a clean result is allowed to say'],
  ['SECB-', 'Regression', 'What changed since the last scan, and what absence does not prove'],
  ['SECT-', 'Triage', 'Suppression needs a reason and a name'],
  ['SECX-', 'Coverage honesty', 'What this scan cannot decide'],
  ['SECR-', 'Measured rates', 'Detection and false positives, as measured'],
  ['SECPL-', 'Stored scans', 'Scopes, scans, findings and triage through AIRA\'s own API'],
  ['SEC-G', 'AIRA itself', 'Tenancy, credentials, target policy and headers in the platform']
];

// ---------------------------------------------------------------------------
// What was measured, read from the tests that measured it
// ---------------------------------------------------------------------------

const rates = latest.get('SECR-001')?.metrics ?? {};
const groundTruth = existsSync(GROUND_TRUTH) ? JSON.parse(readFileSync(GROUND_TRUTH, 'utf8')) : null;
const plantedFlaws = groundTruth
  ? groundTruth.applications.reduce((n, a) => n + a.expectedFindings.length, 0) : null;
const safeEndpoints = groundTruth
  ? groundTruth.applications.reduce((n, a) => n + (a.safeEndpoints?.length ?? 0), 0) : null;

const scenarioCount = rates.scenarios ?? group('SECD-').length;
const untestableFlaws = plantedFlaws === null ? '—' : plantedFlaws - scenarioCount;

const taxonomy = ['owasp-api-top10.json', 'owasp-web-top10.json']
  .map(name => {
    const path = resolve(TAXONOMY_DIR, name);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { name, edition: parsed.edition, verified: parsed.verifiedAgainstSource === true };
  })
  .filter(Boolean);

const { requirements } = existsSync(REQUIREMENTS)
  ? JSON.parse(readFileSync(REQUIREMENTS, 'utf8')) : { requirements: [] };
const requirementStatus = requirements.map(requirement => {
  const tests = requirement.verifiedBy ?? [];
  const records = tests.map(id => latest.get(id));
  if (tests.length === 0) return { ...requirement, status: 'NOT TESTED' };
  if (records.some(r => r === undefined)) return { ...requirement, status: 'NOT VERIFIED' };
  if (records.some(r => r.result === 'FAIL')) return { ...requirement, status: 'FAILED' };
  return { ...requirement, status: 'VERIFIED' };
});

const evidenceFiles = results.flatMap(r => r.evidence ?? []);
const evidenceIntact = evidenceFiles.filter(file => {
  const path = resolve(VERIFICATION, file.path);
  return existsSync(path) && hashFile(path) === file.sha256;
});

// ---------------------------------------------------------------------------
// The statement. This is the part that has to be right.
// ---------------------------------------------------------------------------

const VERDICT = failed.length === 0
  ? 'AIRA\'s security testing behaved as specified against its own lab in this run.'
  : `AIRA's security testing did NOT behave as specified: ${failed.length} test(s) failed.`;

const DISCLAIMER = [
  'What this report is, and is not',
  '',
  'This report describes AIRA\'s security *testing*. It says that the checks detect the flaws',
  'planted in the security lab, stay quiet on the endpoints that are correct, refuse everything',
  'the scope does not authorize, and record what they could not reach.',
  '',
  'It is not a security assessment of any application. It does not say that AIRA is secure, that',
  'the lab is secure, or that any application AIRA scans is secure. No scan can support those',
  'claims, and nothing here should be quoted as though it did.',
  '',
  'The detection rate below is measured against a lab whose flaws were written alongside the',
  'checks that find them. That is the right way to test a detector and the wrong way to estimate',
  'how it will do against an application nobody has seen. The number describes this lab.'
].join('\n');

const markdown = [
  '# AIRA — security verification report',
  '',
  `**${VERDICT}**`,
  '',
  `Run \`${runId}\` · ${results.length} security test(s) · `
  + `${passed.length} passed, ${failed.length} failed, ${notVerified.length} not verified`,
  '',
  '> ' + DISCLAIMER.split('\n').join('\n> '),
  '',
  '## What was measured',
  '',
  '| | |',
  '| --- | --- |',
  `| Flaws planted in the lab | ${plantedFlaws ?? '—'} |`,
  `| Detection scenarios run | ${scenarioCount} |`,
  // The gap between the two is not a rounding error and must not read like one. A planted
  // flaw with no scenario is one this scan cannot decide, and it is named below.
  `| Planted flaws this scan cannot decide | ${untestableFlaws} — see "What was NOT tested" |`,
  `| Flaws detected | ${rates.detected ?? '—'} |`,
  `| False positives on the corrected application | ${rates.falsePositives ?? '—'} |`,
  `| Endpoints the ground truth calls correct | ${safeEndpoints ?? '—'} |`,
  `| Findings reported against those endpoints | ${group('SECS-').filter(r => r.result !== 'PASS').length} |`,
  `| Evidence files recorded | ${evidenceFiles.length} |`,
  `| Evidence files whose hash still matches | ${evidenceIntact.length} |`,
  '',
  '## Results by family',
  '',
  '| Family | Passed | What it establishes |',
  '| --- | --- | --- |',
  ...families.map(([prefix, name, what]) => {
    const rate = rateOf(prefix);
    if (rate.total === 0) return null;
    const mark = rate.passed === rate.total ? `${rate.passed}/${rate.total}` : `**${rate.passed}/${rate.total}**`;
    return `| ${name} | ${mark} | ${what} |`;
  }).filter(Boolean),
  '',
  '## Requirements',
  '',
  `${requirementStatus.filter(r => r.status === 'VERIFIED').length} of ${requirementStatus.length} `
  + 'security requirements verified in this run. The full matrix, including which test verifies '
  + 'each one, is in `SECURITY-TRACEABILITY.md`.',
  ''
];

const notVerifiedRows = requirementStatus.filter(r => r.status !== 'VERIFIED');
if (notVerifiedRows.length > 0) {
  markdown.push('| Requirement | Status |', '| --- | --- |',
    ...notVerifiedRows.map(r => `| **${r.id}** ${r.statement} | ${r.status} |`), '');
}

// ---- The section the brief asks for by name ---------------------------------
markdown.push(
  '## What was NOT tested',
  '',
  'Distinguishing tested coverage from untested areas is a requirement, not a courtesy. These are',
  'recorded in the golden results as NOT VERIFIED rather than omitted, so they survive into every',
  'report generated from that run.',
  ''
);
if (notVerified.length === 0) {
  markdown.push('_Nothing was declared and left unexecuted in this run._', '');
} else {
  markdown.push('| Test | What it would have established | Why it did not run |', '| --- | --- | --- |',
    ...notVerified.map(r => `| \`${r.testId}\` | ${r.objective} | ${r.detail} |`), '');
}

markdown.push(
  '### Known limitations',
  '',
  '- **DOM-based cross-site scripting is not detected.** The source never reaches the server and',
  '  the sink runs in the browser, so a response-only scan cannot see it. `SECX-001` records it as',
  '  not testable rather than absent. A browser-driven security scan would reach it; none exists.',
  '- **Cloud metadata endpoints are never probed by default.** SSRF detection uses loopback and',
  '  private-range destinations. That area is untested, not clean.',
  '- **Production scanning has never been exercised in its permitted form.** Only its refusal is',
  '  verified (`SECG-016`, `SECG-017`).',
  '- **The detection rate does not generalise.** Every flaw in the lab was written alongside the',
  '  check that finds it.',
  '- **A scan is only as wide as discovery.** Targets come from what the crawler walked, so a page',
  '  or endpoint discovery never reached is untested and does not appear in the coverage fraction',
  '  as a gap. `SECW-011` records the caveat; it does not close it.',
  '- **Nothing schedules a security scan.** A scan is started by a person or a pipeline calling',
  '  `POST /api/v1/security/scans/start`. There is no recurring security scan, so an application',
  '  scanned once and never again reads as its last scan indefinitely.',
  '- **A scan whose worker stops is ended, but not retried.** A sweep marks it abandoned with the',
  '  reason on the row; its gate still reads NOT SCANNED. Queueing another is a decision for a',
  '  person, and nobody is notified — a scan that never ran is a coverage gap, not a finding.',
  ''
);

if (taxonomy.length > 0) {
  markdown.push(
    '### The OWASP taxonomy',
    '',
    ...taxonomy.map(t => `- \`${t.name}\` — edition ${t.edition}, `
      + (t.verified
        ? 'verified against the published source.'
        : '**not verified against the published source**: outbound network access was blocked in the '
          + 'environment where it was written, so the categories were recorded from knowledge and '
          + 'flagged. `scripts/refresh-owasp-taxonomy` fetches and replaces them, and fails loudly '
          + 'rather than silently keeping the unverified copy.')),
    ''
  );
}

if (failed.length > 0) {
  markdown.push('## Failures', '', '| Test | Severity | What happened |', '| --- | --- | --- |',
    ...failed.map(r => `| \`${r.testId}\` | ${r.severity} | ${r.detail} |`), '');
}

markdown.push(
  '## Every security test in this run',
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
// HTML, for the people who will actually read it
// ---------------------------------------------------------------------------

const escape = text => String(text)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const familyRows = families.map(([prefix, name, what]) => {
  const rate = rateOf(prefix);
  if (rate.total === 0) return '';
  const ok = rate.passed === rate.total;
  return `<tr><td>${escape(name)}</td>`
    + `<td class="${ok ? 'ok' : 'bad'}">${rate.passed}/${rate.total}</td>`
    + `<td class="muted">${escape(what)}</td></tr>`;
}).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIRA security verification</title>
<style>
  :root { --ink:#16181d; --muted:#6b7280; --line:#e5e7eb; --ok:#15803d; --bad:#b91c1c; --warn:#a16207; --bg:#fff; --panel:#f9fafb; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --ink:#e5e7eb; --muted:#9ca3af; --line:#2b2f36; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; --bg:#0f1115; --panel:#171a20; } }
  :root[data-theme="dark"] { --ink:#e5e7eb; --muted:#9ca3af; --line:#2b2f36; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; --bg:#0f1115; --panel:#171a20; }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--ink); margin: 0; padding: 0 16px 64px;
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 40px 0 8px; }
  h2 { font-size: 1.15rem; margin: 36px 0 10px; padding-top: 18px; border-top: 1px solid var(--line); }
  h3 { font-size: 1rem; margin: 24px 0 8px; }
  .verdict { font-size: 1.05rem; font-weight: 600; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: .9rem; margin-bottom: 24px; }
  .disclaimer { background: var(--panel); border-left: 3px solid var(--warn); padding: 14px 16px;
                border-radius: 6px; font-size: .92rem; margin: 20px 0; }
  .disclaimer p { margin: 0 0 10px; } .disclaimer p:last-child { margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: .92rem; margin: 12px 0 8px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; }
  td.ok { color: var(--ok); font-weight: 600; } td.bad { color: var(--bad); font-weight: 600; }
  .muted { color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; }
  ul { padding-left: 20px; } li { margin: 6px 0; }
  .scroll { overflow-x: auto; }
  footer { color: var(--muted); font-size: .85rem; margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<main>
  <h1>AIRA — security verification</h1>
  <p class="verdict">${escape(VERDICT)}</p>
  <p class="meta">Run <code>${escape(runId)}</code> · ${results.length} security test(s) ·
     ${passed.length} passed, ${failed.length} failed, ${notVerified.length} not verified</p>

  <div class="disclaimer">
    <p><strong>What this report is, and is not.</strong> It describes AIRA's security
    <em>testing</em>: that the checks detect the flaws planted in the security lab, stay quiet on
    the endpoints that are correct, refuse everything the scope does not authorize, and record
    what they could not reach.</p>
    <p>It is <strong>not</strong> a security assessment of any application. It does not say that
    AIRA is secure, that the lab is secure, or that any application AIRA scans is secure. No scan
    can support those claims.</p>
    <p>The detection rate below is measured against a lab whose flaws were written alongside the
    checks that find them. That is the right way to test a detector and the wrong way to estimate
    how it will do against an application nobody has seen.</p>
  </div>

  <h2>What was measured</h2>
  <div class="scroll"><table>
    <tr><td>Flaws planted in the lab</td><td>${plantedFlaws ?? '—'}</td></tr>
    <tr><td>Detection scenarios run</td><td>${scenarioCount}</td></tr>
    <tr><td>Planted flaws this scan cannot decide</td><td>${untestableFlaws} <span class="muted">— see below</span></td></tr>
    <tr><td>Flaws detected</td><td class="${rates.detected === rates.scenarios ? 'ok' : 'bad'}">${rates.detected ?? '—'}</td></tr>
    <tr><td>False positives on the corrected application</td><td class="${(rates.falsePositives ?? 0) === 0 ? 'ok' : 'bad'}">${rates.falsePositives ?? '—'}</td></tr>
    <tr><td>Endpoints the ground truth calls correct</td><td>${safeEndpoints ?? '—'}</td></tr>
    <tr><td>Evidence files recorded</td><td>${evidenceFiles.length}</td></tr>
    <tr><td>Evidence files whose hash still matches</td><td class="${evidenceIntact.length === evidenceFiles.length ? 'ok' : 'bad'}">${evidenceIntact.length}</td></tr>
  </table></div>

  <h2>Results by family</h2>
  <div class="scroll"><table>
    <tr><th>Family</th><th>Passed</th><th>What it establishes</th></tr>
    ${familyRows}
  </table></div>

  <h2>What was not tested</h2>
  <div class="scroll"><table>
    <tr><th>Test</th><th>What it would have established</th><th>Why it did not run</th></tr>
    ${notVerified.map(r => `<tr><td><code>${escape(r.testId)}</code></td><td>${escape(r.objective)}</td>`
      + `<td class="muted">${escape(r.detail)}</td></tr>`).join('\n') || '<tr><td colspan="3" class="muted">Nothing was declared and left unexecuted.</td></tr>'}
  </table></div>

  <h3>Known limitations</h3>
  <ul>
    <li><strong>DOM-based XSS is not detected.</strong> The source never reaches the server and the
        sink runs in the browser, so a response-only scan cannot see it. Recorded as not testable,
        never as absent.</li>
    <li><strong>Cloud metadata endpoints are never probed by default.</strong> That area is
        untested, not clean.</li>
    <li><strong>Production scanning has never been exercised in its permitted form.</strong> Only
        its refusal is verified.</li>
    <li><strong>The detection rate does not generalise.</strong> Every flaw in the lab was written
        alongside the check that finds it.</li>
    <li><strong>A scan is only as wide as discovery.</strong> Targets come from what the crawler
        walked, so anything it never reached is untested and does not appear in the coverage
        fraction as a gap.</li>
    <li><strong>Nothing schedules a security scan.</strong> An application scanned once and never
        again reads as its last scan indefinitely.</li>
    <li><strong>A scan whose worker stops is ended, but not retried.</strong> A sweep marks it
        abandoned with the reason on the row; its gate still reads NOT SCANNED. Queueing another
        is a decision for a person.</li>
  </ul>

  ${taxonomy.length > 0 ? `<h3>The OWASP taxonomy</h3><ul>${taxonomy.map(t =>
    `<li><code>${escape(t.name)}</code> — edition ${escape(t.edition)}, ${t.verified
      ? 'verified against the published source.'
      : '<strong>not verified against the published source</strong>: outbound network access was '
        + 'blocked where it was written, so the categories were recorded from knowledge and flagged. '
        + '<code>scripts/refresh-owasp-taxonomy</code> replaces them and fails loudly rather than '
        + 'silently keeping the unverified copy.'}</li>`).join('')}</ul>` : ''}

  ${failed.length > 0 ? `<h2>Failures</h2><div class="scroll"><table>
    <tr><th>Test</th><th>Severity</th><th>What happened</th></tr>
    ${failed.map(r => `<tr><td><code>${escape(r.testId)}</code></td><td>${escape(r.severity)}</td>`
      + `<td class="bad">${escape(r.detail)}</td></tr>`).join('')}
  </table></div>` : ''}

  <h2>Every security test in this run</h2>
  <div class="scroll"><table>
    <tr><th>Test</th><th>Result</th><th>Objective</th><th>Evidence</th></tr>
    ${results.map(r => `<tr><td><code>${escape(r.testId)}</code></td>`
      + `<td class="${r.result === 'PASS' ? 'ok' : 'bad'}">${escape(r.result)}</td>`
      + `<td>${escape(r.objective)}</td><td class="muted">${(r.evidence ?? []).length}</td></tr>`).join('\n')}
  </table></div>

  <footer>
    Generated from <code>verification/reports/golden-results.jsonl</code> for run
    <code>${escape(runId)}</code>. Every figure is derived from a recorded execution;
    nothing in this report is asserted.
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
console.log(dim(`  ${results.length} security test(s): ${passed.length} passed, ${failed.length} failed, `
  + `${notVerified.length} not verified`));
console.log(dim(`  Detection: ${rates.detected ?? '?'}/${scenarioCount} scenarios, `
  + `${rates.falsePositives ?? '?'} false positive(s) — against this lab only`));
console.log(dim(`  Written to ${relative(ROOT, MARKDOWN)}`));
console.log(dim(`            ${relative(ROOT, HTML)}`));
console.log('');

process.exit(failed.length === 0 ? 0 : 1);
