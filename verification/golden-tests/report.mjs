/**
 * Builds the golden-test reports and the certification from what was actually recorded.
 *
 * Every number here is derived from `reports/golden-results.jsonl`, which only the harness
 * writes and only after a check has run. Nothing in this file knows how to produce a
 * result; it can only summarise ones that exist. Evidence hashes are recomputed from the
 * files on disk, so an index that disagrees with the bytes is visible rather than silent.
 *
 * Usage: node verification/golden-tests/report.mjs [--run <RUN_ID>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { EVIDENCE_ROOT, ROOT, VERIFICATION, hashFile } from './harness.mjs';

const RESULTS = resolve(VERIFICATION, 'reports/golden-results.jsonl');
const REPORT_DIR = resolve(VERIFICATION, 'reports');

const argv = process.argv.slice(2);
const runIndex = argv.indexOf('--run');
const requestedRun = runIndex >= 0 ? argv[runIndex + 1] : null;

if (!existsSync(RESULTS)) {
  console.error('No golden results yet. Run: node verification/golden-tests/run.mjs --all');
  process.exit(2);
}

const lines = readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

/** The run to report on: the one asked for, or the most recent one recorded. */
const runId = requestedRun ?? lines.at(-1).runId;
const fromRun = lines.filter(record => record.runId === runId);

/**
 * One row per test id: the last time it ran *in this run*. A test executed twice while a
 * defect was being fixed is reported at its final state; the history stays in the ledger.
 */
const latest = new Map();
for (const record of fromRun) latest.set(record.testId, record);
const results = [...latest.values()].sort((a, b) => a.testId.localeCompare(b.testId));

const passed = results.filter(record => record.result === 'PASS');
const failed = results.filter(record => record.result === 'FAIL');
const notVerified = results.filter(record => record.result === 'NOT_VERIFIED');
const criticalFailures = failed.filter(record => record.severity === 'critical');

// ---------------------------------------------------------------------------
// Metrics, pulled from the checks that measured them
// ---------------------------------------------------------------------------

const metricOf = (testId, key) => latest.get(testId)?.metrics?.[key] ?? null;

const metrics = {
  discovery: {
    pageRecall: metricOf('DISC-002', 'recall'),
    pagePrecision: metricOf('DISC-003', 'precision'),
    apiRecall: metricOf('DISC-011', 'apiRecall'),
    stableLocatorShare: metricOf('DISC-013', 'stableLocatorShare'),
    pagesDiscovered: metricOf('DISC-001', 'pages'),
    elementsDiscovered: metricOf('DISC-001', 'elements'),
    discoveryMs: metricOf('DISC-001', 'discoveryMs')
  },
  generation: {
    coverageOfDiscoveredPages: metricOf('GEN-012', 'coverage'),
    stableLocatorShare: metricOf('GEN-007', 'stableShare'),
    generatedTestsExecuted: metricOf('GEN-010', 'executed'),
    generatedTestsPassed: metricOf('GEN-010', 'passed'),
    generatedTestsFailedUnderFault: metricOf('GEN-011', 'failedUnderFault')
  },
  execution: {
    twentyStepJourneyMs: metricOf('EXEC-001', 'durationMs'),
    steps: metricOf('EXEC-001', 'steps'),
    networkEventsCaptured: metricOf('EXEC-014', 'networkEvents'),
    lateContentWaitMs: metricOf('EXEC-017', 'waitMs')
  },
  failureAnalysis: {
    classificationAccuracy: metricOf('FA-012', 'accuracy'),
    classesCorrect: metricOf('FA-012', 'correct'),
    classesTotal: metricOf('FA-012', 'total'),
    classifiedUnknown: metricOf('FA-012', 'unknown')
  },
  healing: {
    opportunities: metricOf('HEAL-M01', 'healingOpportunities'),
    correctHeals: metricOf('HEAL-M01', 'correctHeals'),
    correctRejections: metricOf('HEAL-M01', 'correctRejections'),
    incorrectHeals: metricOf('HEAL-M01', 'incorrectHeals'),
    missedHeals: metricOf('HEAL-M01', 'missedHeals'),
    healingSuccessRate: metricOf('HEAL-M01', 'healingSuccessRate'),
    falseHealingRate: metricOf('HEAL-M01', 'falseHealingRate'),
    confidenceMargin: metricOf('HEAL-M02', 'margin'),
    lowestHealable: metricOf('HEAL-M02', 'lowestHealable'),
    highestWrongTarget: metricOf('HEAL-M02', 'highestWrongTarget')
  },
  reliability: {
    repeatabilityRuns: metricOf('REL-001', 'runs'),
    repeatabilityDistinctVerdicts: metricOf('REL-001', 'distinctVerdicts'),
    flakyRuns: metricOf('REL-002', 'runs'),
    flakyPassed: metricOf('REL-002', 'passed'),
    flakyFailed: metricOf('REL-002', 'failed'),
    concurrentRuns: metricOf('REL-005', 'started'),
    concurrentReachedVerdict: metricOf('REL-005', 'terminal')
  }
};

// False pass and false negative, measured across the checks written to catch them.
const falsePassChecks = ['DET-002', 'DET-003', 'DET-004', 'DET-005', 'DET-006', 'DET-007',
  'DET-008', 'DET-009', 'DET-010', 'DET-011', 'FA-016', 'GEN-011'];
const falseNegativeChecks = ['DET-001', 'DET-012', 'REL-001', 'EXEC-001', 'HEAL-G01'];

const falsePasses = falsePassChecks.filter(id => latest.get(id)?.result === 'FAIL');
const falseNegatives = falseNegativeChecks.filter(id => latest.get(id)?.result === 'FAIL');

metrics.integrity = {
  falsePassChecks: falsePassChecks.filter(id => latest.has(id)).length,
  falsePasses: falsePasses.length,
  falseNegativeChecks: falseNegativeChecks.filter(id => latest.has(id)).length,
  falseNegatives: falseNegatives.length
};

// ---------------------------------------------------------------------------
// Quality gates
// ---------------------------------------------------------------------------

const suiteOf = (prefix) => results.filter(record => record.testId.startsWith(prefix));
const gate = (name, tests, extra = true) => {
  const relevant = tests.filter(record => record.result !== 'NOT_VERIFIED');
  const failures = relevant.filter(record => record.result === 'FAIL');
  return {
    name,
    passed: failures.length === 0 && relevant.length > 0 && extra,
    total: tests.length,
    executed: relevant.length,
    failures: failures.map(record => record.testId),
    notVerified: tests.filter(record => record.result === 'NOT_VERIFIED').map(record => record.testId)
  };
};

const gates = [
  gate('Functional', [...suiteOf('EXEC-'), ...suiteOf('ASRT-')]),
  gate('Discovery', suiteOf('DISC-')),
  gate('AI', [...suiteOf('GEN-'), ...suiteOf('FA-')]),
  gate('Self-healing', suiteOf('HEAL-'), metrics.healing.falseHealingRate === 0),
  gate('Security', suiteOf('SEC-G')),
  gate('Reliability', suiteOf('REL-')),
  gate('Failure detection', suiteOf('DET-')),
  {
    name: 'Evidence',
    passed: results.every(record => record.result === 'NOT_VERIFIED' || record.evidence.length > 0),
    total: results.length,
    executed: results.filter(record => record.result !== 'NOT_VERIFIED').length,
    failures: results.filter(record => record.result !== 'NOT_VERIFIED' && record.evidence.length === 0)
      .map(record => record.testId),
    notVerified: []
  }
];

const overall = gates.every(entry => entry.passed) && criticalFailures.length === 0;

// ---------------------------------------------------------------------------
// Evidence index
// ---------------------------------------------------------------------------

const evidenceRows = [];
let evidenceBytes = 0;
for (const record of results) {
  for (const artifact of record.evidence) {
    const path = resolve(VERIFICATION, artifact.path);
    const present = existsSync(path);
    const current = present ? hashFile(path) : null;
    evidenceBytes += present ? statSync(path).size : 0;
    evidenceRows.push({
      testId: record.testId, file: artifact.file, path: artifact.path,
      bytes: artifact.bytes, sha256: artifact.sha256,
      present, unchanged: current === artifact.sha256
    });
  }
}

// ---------------------------------------------------------------------------
// Writing it out
// ---------------------------------------------------------------------------

mkdirSync(REPORT_DIR, { recursive: true });

const summary = {
  runId,
  generatedAt: new Date().toISOString(),
  build: results[0]?.build ?? null,
  totals: {
    total: results.length,
    passed: passed.length,
    failed: failed.length,
    notVerified: notVerified.length,
    criticalFailures: criticalFailures.length
  },
  bySeverity: ['critical', 'high', 'medium', 'low'].map(severity => ({
    severity,
    total: results.filter(record => record.severity === severity).length,
    failed: failed.filter(record => record.severity === severity).length
  })),
  bySuite: [...new Set(results.map(record => record.suite))].map(name => ({
    suite: name,
    total: results.filter(record => record.suite === name).length,
    passed: results.filter(record => record.suite === name && record.result === 'PASS').length,
    failed: results.filter(record => record.suite === name && record.result === 'FAIL').length,
    notVerified: results.filter(record => record.suite === name && record.result === 'NOT_VERIFIED').length
  })),
  metrics,
  gates,
  overall,
  evidence: {
    artifacts: evidenceRows.length,
    bytes: evidenceBytes,
    missing: evidenceRows.filter(row => !row.present).length,
    changed: evidenceRows.filter(row => row.present && !row.unchanged).length
  },
  tests: results.map(record => ({
    id: record.testId, suite: record.suite, objective: record.objective,
    severity: record.severity, result: record.result, detail: record.detail,
    durationMs: record.durationMs, evidence: record.evidence.map(artifact => artifact.path)
  }))
};

writeFileSync(join(REPORT_DIR, 'golden-test-report.json'), `${JSON.stringify(summary, null, 2)}\n`);

// ---- Markdown --------------------------------------------------------------
const pct = (value) => (value === null || value === undefined ? 'not measured' : `${(value * 100).toFixed(1)}%`);
const tick = (ok) => (ok ? 'PASS' : 'FAIL');

const markdown = `# Golden test report

Run \`${runId}\` · build \`${summary.build?.commit ?? 'unknown'}\`${summary.build?.dirty ? ' (working tree dirty)' : ''} · generated ${summary.generatedAt}

**${passed.length} passed, ${failed.length} failed, ${notVerified.length} not verified** of ${results.length} golden tests.
${criticalFailures.length === 0 ? 'No critical test failed.' : `**${criticalFailures.length} critical failure(s):** ${criticalFailures.map(record => record.testId).join(', ')}`}

## Quality gates

| Gate | Result | Executed | Failures | Not verified |
| --- | --- | --- | --- | --- |
${gates.map(entry => `| ${entry.name} | **${tick(entry.passed)}** | ${entry.executed}/${entry.total} | ${entry.failures.join(', ') || '—'} | ${entry.notVerified.join(', ') || '—'} |`).join('\n')}

**Overall: ${overall ? 'PASS' : 'FAIL'}** — a gate is green only when every executed test in it passed.

## Metrics

### Discovery
| | |
| --- | --- |
| Page recall against ground truth | ${pct(metrics.discovery.pageRecall)} |
| Page precision | ${pct(metrics.discovery.pagePrecision)} |
| API endpoint recall | ${pct(metrics.discovery.apiRecall)} |
| Elements preferring a stable locator | ${pct(metrics.discovery.stableLocatorShare)} |
| Pages / elements discovered | ${metrics.discovery.pagesDiscovered ?? '—'} / ${metrics.discovery.elementsDiscovered ?? '—'} |
| Crawl duration | ${metrics.discovery.discoveryMs ? `${Math.round(metrics.discovery.discoveryMs / 1000)}s` : '—'} |

### Generation
| | |
| --- | --- |
| Discovered pages reached by generated tests | ${pct(metrics.generation.coverageOfDiscoveredPages)} |
| Generated steps using a stable locator | ${pct(metrics.generation.stableLocatorShare)} |
| Generated tests executed / passed on a healthy application | ${metrics.generation.generatedTestsExecuted ?? '—'} / ${metrics.generation.generatedTestsPassed ?? '—'} |
| Generated tests that failed once the application was broken | ${metrics.generation.generatedTestsFailedUnderFault ?? '—'} |

### Self-healing
| | |
| --- | --- |
| Healing opportunities | ${metrics.healing.opportunities ?? '—'} |
| Correct heals | ${metrics.healing.correctHeals ?? '—'} |
| Correct rejections | ${metrics.healing.correctRejections ?? '—'} |
| **Incorrect heals** | **${metrics.healing.incorrectHeals ?? '—'}** |
| Missed heals | ${metrics.healing.missedHeals ?? '—'} |
| Healing success rate | ${pct(metrics.healing.healingSuccessRate)} |
| **False-healing rate** | **${pct(metrics.healing.falseHealingRate)}** |
| Confidence margin (lowest healable − highest wrong target) | ${metrics.healing.confidenceMargin ?? '—'} points (${metrics.healing.lowestHealable ?? '—'}% vs ${metrics.healing.highestWrongTarget ?? '—'}%) |

### Failure analysis
| | |
| --- | --- |
| Classification accuracy | ${pct(metrics.failureAnalysis.classificationAccuracy)} (${metrics.failureAnalysis.classesCorrect ?? '—'}/${metrics.failureAnalysis.classesTotal ?? '—'}) |
| Classified "unknown" | ${metrics.failureAnalysis.classifiedUnknown ?? '—'} |

### Reliability
| | |
| --- | --- |
| Repeatability | ${metrics.reliability.repeatabilityRuns ?? '—'} runs, ${metrics.reliability.repeatabilityDistinctVerdicts ?? '—'} distinct verdict(s) |
| Flaky application | ${metrics.reliability.flakyPassed ?? '—'} passed / ${metrics.reliability.flakyFailed ?? '—'} failed of ${metrics.reliability.flakyRuns ?? '—'} |
| Concurrency | ${metrics.reliability.concurrentReachedVerdict ?? '—'}/${metrics.reliability.concurrentRuns ?? '—'} concurrent runs reached a verdict |

### Result integrity
| | |
| --- | --- |
| Checks that would catch a false pass | ${metrics.integrity.falsePassChecks} |
| **False passes observed** | **${metrics.integrity.falsePasses}** |
| Checks that would catch a false failure | ${metrics.integrity.falseNegativeChecks} |
| **False failures observed** | **${metrics.integrity.falseNegatives}** |

## Results

| ID | Suite | Severity | Result | Objective | Detail |
| --- | --- | --- | --- | --- | --- |
${results.map(record => `| ${record.testId} | ${record.suite} | ${record.severity} | **${record.result}** | ${record.objective} | ${(record.detail ?? '').replace(/\|/g, '\\|').slice(0, 200)} |`).join('\n')}

## Evidence

${evidenceRows.length} artifact(s), ${(evidenceBytes / 1024).toFixed(0)} KiB, under \`verification/evidence/<TEST-ID>/${runId}/\`.
${summary.evidence.missing} missing, ${summary.evidence.changed} changed since they were recorded.

Full index with SHA-256 per artifact: \`verification/reports/EVIDENCE-INDEX.md\`.
`;

writeFileSync(join(REPORT_DIR, 'GOLDEN-TEST-REPORT.md'), markdown);

// ---- Evidence index --------------------------------------------------------
const index = `# Evidence index — run \`${runId}\`

Every artifact a golden test produced, with the SHA-256 recorded when it was written and
recomputed from the file on disk when this index was generated. A mismatch means the file
changed after the test recorded it.

| Test | Artifact | Bytes | SHA-256 | On disk | Unchanged |
| --- | --- | --- | --- | --- | --- |
${evidenceRows.map(row => `| ${row.testId} | \`${row.file}\` | ${row.bytes} | \`${(row.sha256 ?? '').slice(0, 32)}\` | ${row.present ? 'yes' : '**no**'} | ${row.unchanged ? 'yes' : '**no**'} |`).join('\n')}

**${evidenceRows.length} artifact(s)**, ${(evidenceBytes / 1024).toFixed(0)} KiB total.
`;
writeFileSync(join(REPORT_DIR, 'EVIDENCE-INDEX.md'), index);

// ---- HTML ------------------------------------------------------------------
const html = buildHtml(summary, results, gates, evidenceRows);
writeFileSync(join(REPORT_DIR, 'golden-test-report.html'), html);

console.log(`Golden test report for run ${runId}`);
console.log(`  ${passed.length} passed, ${failed.length} failed, ${notVerified.length} not verified of ${results.length}`);
console.log(`  gates: ${gates.map(entry => `${entry.name}=${tick(entry.passed)}`).join(' ')}`);
console.log(`  overall: ${overall ? 'PASS' : 'FAIL'}`);
console.log(`  evidence: ${evidenceRows.length} artifact(s), ${(evidenceBytes / 1024).toFixed(0)} KiB`);
console.log(`  written: reports/golden-test-report.{json,html}, GOLDEN-TEST-REPORT.md, EVIDENCE-INDEX.md`);

if (!overall) process.exitCode = 1;

/** A single self-contained page: no network, no build step, opens from the filesystem. */
function buildHtml(report, rows, qualityGates, artifacts) {
  const badge = (result) => `<span class="badge ${result.toLowerCase().replace('_', '-')}">${result.replace('_', ' ')}</span>`;
  const metric = (label, value) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AIRA golden test report — ${report.runId}</title>
<style>
:root { --ink:#101a2b; --muted:#5b6b82; --line:#e2e8f2; --bg:#f6f8fb; --ok:#12855a; --bad:#c02626; --warn:#b26b00; --accent:#0b5fff; }
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:#0b2545;color:#fff;padding:26px 32px}
header h1{margin:0 0 6px;font-size:22px}
header p{margin:0;color:rgba(255,255,255,.75);font-size:13px}
main{max-width:1180px;margin:0 auto;padding:24px 32px 60px}
h2{font-size:17px;margin:28px 0 12px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:#f0f4fa;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
tr:last-child td{border-bottom:0}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}
.badge.pass{background:#e6f5ee;color:var(--ok)} .badge.fail{background:#fdecec;color:var(--bad)}
.badge.not-verified{background:#fdf4e3;color:var(--warn)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:12px;margin-bottom:8px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card h3{margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.metric{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:13px}
.metric span{color:var(--muted)}
.gates{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:10px}
.gate{background:#fff;border:1px solid var(--line);border-left-width:4px;border-radius:8px;padding:12px 14px}
.gate.ok{border-left-color:var(--ok)} .gate.bad{border-left-color:var(--bad)}
.gate strong{display:block;font-size:14px} .gate span{font-size:12px;color:var(--muted)}
.overall{font-size:15px;font-weight:700;padding:12px 16px;border-radius:8px;margin:14px 0}
.overall.ok{background:#e6f5ee;color:var(--ok)} .overall.bad{background:#fdecec;color:var(--bad)}
code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.muted{color:var(--muted);font-size:12px}
</style>
</head>
<body>
<header>
  <h1>AIRA — golden test report</h1>
  <p>Run ${report.runId} · build ${report.build?.commit ?? 'unknown'}${report.build?.dirty ? ' (working tree dirty)' : ''} · generated ${report.generatedAt}</p>
</header>
<main>
  <div class="overall ${report.overall ? 'ok' : 'bad'}">
    Overall: ${report.overall ? 'PASS' : 'FAIL'} —
    ${report.totals.passed} passed, ${report.totals.failed} failed,
    ${report.totals.notVerified} not verified of ${report.totals.total};
    ${report.totals.criticalFailures} critical failure(s)
  </div>

  <h2>Quality gates</h2>
  <div class="gates">
    ${qualityGates.map(entry => `<div class="gate ${entry.passed ? 'ok' : 'bad'}">
      <strong>${entry.name}: ${entry.passed ? 'PASS' : 'FAIL'}</strong>
      <span>${entry.executed}/${entry.total} executed${entry.failures.length ? ` · failed: ${entry.failures.join(', ')}` : ''}${entry.notVerified.length ? ` · not verified: ${entry.notVerified.join(', ')}` : ''}</span>
    </div>`).join('')}
  </div>

  <h2>Metrics</h2>
  <div class="cards">
    <div class="card"><h3>Discovery</h3>
      ${metric('Page recall', pct(report.metrics.discovery.pageRecall))}
      ${metric('Page precision', pct(report.metrics.discovery.pagePrecision))}
      ${metric('API recall', pct(report.metrics.discovery.apiRecall))}
      ${metric('Stable locators', pct(report.metrics.discovery.stableLocatorShare))}
    </div>
    <div class="card"><h3>Self-healing</h3>
      ${metric('Opportunities', report.metrics.healing.opportunities ?? '—')}
      ${metric('Correct heals', report.metrics.healing.correctHeals ?? '—')}
      ${metric('Correct rejections', report.metrics.healing.correctRejections ?? '—')}
      ${metric('Incorrect heals', report.metrics.healing.incorrectHeals ?? '—')}
      ${metric('False-healing rate', pct(report.metrics.healing.falseHealingRate))}
      ${metric('Confidence margin', `${report.metrics.healing.confidenceMargin ?? '—'} pts`)}
    </div>
    <div class="card"><h3>Generation</h3>
      ${metric('Page coverage', pct(report.metrics.generation.coverageOfDiscoveredPages))}
      ${metric('Stable locators', pct(report.metrics.generation.stableLocatorShare))}
      ${metric('Executed / passed', `${report.metrics.generation.generatedTestsExecuted ?? '—'} / ${report.metrics.generation.generatedTestsPassed ?? '—'}`)}
      ${metric('Failed when broken', report.metrics.generation.generatedTestsFailedUnderFault ?? '—')}
    </div>
    <div class="card"><h3>Failure analysis</h3>
      ${metric('Classification accuracy', pct(report.metrics.failureAnalysis.classificationAccuracy))}
      ${metric('Correct', `${report.metrics.failureAnalysis.classesCorrect ?? '—'}/${report.metrics.failureAnalysis.classesTotal ?? '—'}`)}
      ${metric('Unknown', report.metrics.failureAnalysis.classifiedUnknown ?? '—')}
    </div>
    <div class="card"><h3>Reliability</h3>
      ${metric('Repeatability', `${report.metrics.reliability.repeatabilityRuns ?? '—'} runs, ${report.metrics.reliability.repeatabilityDistinctVerdicts ?? '—'} verdict(s)`)}
      ${metric('Flaky app', `${report.metrics.reliability.flakyPassed ?? '—'} / ${report.metrics.reliability.flakyFailed ?? '—'} of ${report.metrics.reliability.flakyRuns ?? '—'}`)}
      ${metric('Concurrency', `${report.metrics.reliability.concurrentReachedVerdict ?? '—'}/${report.metrics.reliability.concurrentRuns ?? '—'}`)}
    </div>
    <div class="card"><h3>Result integrity</h3>
      ${metric('False passes', report.metrics.integrity.falsePasses)}
      ${metric('False failures', report.metrics.integrity.falseNegatives)}
      ${metric('Evidence artifacts', report.evidence.artifacts)}
      ${metric('Missing / changed', `${report.evidence.missing} / ${report.evidence.changed}`)}
    </div>
  </div>

  <h2>Results</h2>
  <table>
    <thead><tr><th>ID</th><th>Suite</th><th>Severity</th><th>Result</th><th>Objective</th><th>Detail</th></tr></thead>
    <tbody>
      ${rows.map(record => `<tr>
        <td><code>${record.testId}</code></td><td>${record.suite}</td><td>${record.severity}</td>
        <td>${badge(record.result)}</td><td>${escapeHtml(record.objective)}</td>
        <td class="muted">${escapeHtml((record.detail ?? '').slice(0, 260))}</td>
      </tr>`).join('')}
    </tbody>
  </table>

  <h2>Evidence</h2>
  <p class="muted">${artifacts.length} artifact(s), ${(report.evidence.bytes / 1024).toFixed(0)} KiB, hashed with SHA-256 when written and re-hashed for this report.</p>
  <table>
    <thead><tr><th>Test</th><th>Artifact</th><th>Bytes</th><th>SHA-256</th><th>Unchanged</th></tr></thead>
    <tbody>
      ${artifacts.map(row => `<tr>
        <td><code>${row.testId}</code></td><td><code>${row.file}</code></td><td>${row.bytes}</td>
        <td><code>${(row.sha256 ?? '').slice(0, 24)}…</code></td>
        <td>${row.unchanged ? 'yes' : '<strong>no</strong>'}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
