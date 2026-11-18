/**
 * Drives QA NXT's form-level testing engine against Meridian Freight.
 *
 * ## Why this exists, and what it corrects
 *
 * Nine pipeline runs measured `/api/v1/testcases/generate` — the planner that runs when no
 * model provider is configured. They reported 0 of 32 planted defects detected and concluded
 * that the platform has no oracle for business logic.
 *
 * That conclusion was drawn about the wrong engine. QA NXT has a second, deterministic
 * testing path — FormTestDesigner → FormTestingService → the worker's form oracles →
 * DefectService → CoverageService — which reads every discovered form's declared
 * constraints, designs tests across 26 categories, and asserts with purpose-built oracles:
 * was the submission refused, is this field reported invalid, is its error programmatically
 * tied to it, did the server error, how many requests did one submit send, did input come
 * back as live markup, did focus move, did the page overflow sideways.
 *
 * 75 forms were extracted on every one of those nine runs and none of them was used. The
 * oracles were implemented, unit-tested in the worker, and emitted by nothing the pipeline
 * called.
 *
 * So this measures the engine built for the job, against the same 32 planted defects, and
 * reports what it finds on the same terms — including its correlated defects, which is the
 * layer that turns failures into findings a person can act on.
 *
 *   node run-form-engine.mjs [--budget 900] [--max-pages 160]
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  request, newTenant, createProject, registerApplication, runDiscovery, waitForRun
} from '../../verification/golden-tests/platform.mjs';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const BUDGET = Number(arg('budget', 900));
const MAX_PAGES = Number(arg('max-pages', 160));
const FREIGHT = process.env.FREIGHT_URL ?? 'http://127.0.0.1:4400';

const line = (text = '') => console.log(text);
const section = (title) => {
  line();
  line('─'.repeat(74));
  line(`  ${title}`);
  line('─'.repeat(74));
};

const result = { startedAt: new Date().toISOString(), target: FREIGHT, stages: {} };
const groundTruth = JSON.parse(
  await readFile(new URL('./ground-truth.json', import.meta.url), 'utf8'));

line(`\nMeridian Freight at ${FREIGHT}: ${groundTruth.defects.list.length} planted defect(s)`);
line('Engine under test: the form-level testing engine (deterministic, no model).');

// ---- 1. tenant, project, application ---------------------------------------
section('1. Sign up, project with AI off, register the application');
const tenant = await newTenant('FormEngine');
const project = await createProject(tenant, 'Meridian Freight — form engine',
  { aiEnabled: false, aiProvider: 'local', healingPolicy: 'suggest' });
const application = await registerApplication(tenant, project.id, {
  name: 'Meridian Freight', baseUrl: FREIGHT,
  loginUrl: `${FREIGHT}/auth/sign-in`,
  username: 'ops.lead', password: 'Freight!2026', maxPages: MAX_PAGES
});
await request(`/api/v1/applications/${application.id}`, {
  token: tenant.token, method: 'PATCH',
  body: { maxPages: MAX_PAGES, maxCrawlDepth: 6, explorationTimeoutSeconds: BUDGET,
          interactionMode: 'navigation', useSitemap: true }
});
line(`  application ${application.id}, budget ${BUDGET}s, maxPages ${MAX_PAGES}`);
result.stages.application = { id: application.id, budgetSeconds: BUDGET, maxPages: MAX_PAGES };

// ---- 2. discovery -----------------------------------------------------------
section('2. Discovery');
const discovery = await runDiscovery(tenant, application.id, {
  maxPages: MAX_PAGES, maxDepth: 6, timeoutSeconds: BUDGET,
  timeoutMs: (BUDGET + 300) * 1000
});
line(`  status ${discovery.status}, ${discovery.pagesDiscovered ?? '?'} page(s)`);
result.stages.discovery = { status: discovery.status, pages: discovery.pagesDiscovered ?? null };

// ---- 3. the forms the engine has to work from --------------------------------
section('3. Forms the extractor captured');
const forms = await request(`/api/v1/applications/${application.id}/forms`, { token: tenant.token });
const formList = forms.json?.items ?? forms.json ?? [];
line(`  ${formList.length} form(s)`);
const fieldTotal = formList.reduce((sum, f) => sum + (f.fieldCount ?? f.fields?.length ?? 0), 0);
if (fieldTotal) line(`  ${fieldTotal} field(s) across them`);
result.stages.forms = { count: formList.length, fields: fieldTotal };

if (formList.length === 0) {
  line('\n  No forms. The engine has nothing to design from, so there is nothing to measure.');
  await writeFile(new URL('./form-engine-result.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n');
  process.exit(1);
}

// ---- 4. design the suite -----------------------------------------------------
section('4. Design the form-level suite (deterministic, no AI)');
const generated = await request(`/api/v1/applications/${application.id}/form-tests/generate`, {
  token: tenant.token, method: 'POST', body: { suiteName: 'Meridian Freight — form level' }
});
if (!generated.ok) {
  line(`  REFUSED ${generated.status}: ${generated.text.slice(0, 300)}`);
  result.stages.design = { ok: false, status: generated.status, body: generated.text.slice(0, 600) };
  await writeFile(new URL('./form-engine-result.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n');
  process.exit(1);
}
const design = generated.json ?? {};
line(`  suite "${design.testSuiteName ?? '?'}"`);
line(`  ${design.testsCreated ?? '?'} test(s) created, ${design.testsUpdated ?? 0} updated, `
  + `${design.testsUnchanged ?? 0} unchanged, ${design.testsDeprecated ?? 0} deprecated`);
line(`  ${design.forms ?? '?'} form(s) designed from`);
// The three figures that say what the engine knows it cannot do, which is the part worth
// reading: a gap is coverage it could not reach, a human task is a question no machine can
// answer, a finding is something wrong with the form itself rather than with a submission.
line(`  ${design.gaps ?? 0} gap(s), ${design.humanTasks ?? 0} human task(s), `
  + `${design.findings ?? 0} structural finding(s)`);
line(`  usedAi: ${design.usedAi === true}`);
result.stages.design = design;

/**
 * Coverage, which is read twice.
 *
 * Before the run it reports 0%, and says so in words: "260 test(s) exist for 5 form(s) and
 * none has run yet, so coverage is 0%." A suite that exists is not coverage, and the engine
 * refuses to count it as any. That is worth showing, because it is the distinction every
 * coverage number in this exercise has turned on.
 */
async function readCoverage(label) {
  const response = await request(`/api/v1/applications/${application.id}/coverage`,
    { token: tenant.token });
  const cov = response.json ?? {};
  line(`\n  ${label}: ${cov.overallCoveragePercent ?? '?'}% overall`);
  if (cov.statement) line(`  "${cov.statement}"`);
  const s = cov.surface ?? {};
  line(`  surface: ${s.discoveredPages ?? '?'} page(s), ${s.discoveredForms ?? '?'} form(s), `
    + `${s.discoveredFields ?? '?'} field(s), ${s.discoveredEndpoints ?? '?'} endpoint(s)`);
  line(`  tests: ${s.testableTests ?? '?'} testable, ${s.executedTests ?? 0} executed, `
    + `${s.passedTests ?? 0} passed, ${s.failedTests ?? 0} failed`);
  line('  by category (generated / executed / passed / failed / gaps):');
  for (const row of (cov.categories ?? []).filter(r => (r.generated ?? 0) > 0)) {
    line(`    ${String(row.category).padEnd(17)} ${String(row.generated).padStart(4)} / `
      + `${String(row.executed ?? 0).padStart(4)} / ${String(row.passed ?? 0).padStart(4)} / `
      + `${String(row.failed ?? 0).padStart(4)} / ${row.openGaps ?? 0}`
      + `   ${row.coveragePercent ?? 0}%`);
  }
  if ((cov.gaps ?? []).length) {
    line(`\n  ${cov.gaps.length} gap(s) the engine declares it has not covered:`);
    for (const gap of cov.gaps.slice(0, 12)) {
      line(`    ${(gap.reason ?? gap.description ?? JSON.stringify(gap)).slice(0, 96)}`);
    }
  }
  return cov;
}

section('5. Coverage before anything has run');
result.stages.coverageBefore = await readCoverage('before the run');

// ---- 6. run everything, security included ------------------------------------
section('6. Run the whole suite, security included');
const started = await request(`/api/v1/applications/${application.id}/runs`, {
  token: tenant.token, method: 'POST',
  body: { mode: 'all', name: 'Meridian Freight — form level, all',
          browser: 'chromium', headless: true, includeSecurity: true, securityProfile: 'standard',
          // 75 forms design roughly 3,900 tests, which is hours at one at a time. The
          // engine takes a parallelism, so the measurement uses it rather than cutting
          // scope: a narrower suite would answer a different question.
          parallelism: Number(arg('parallelism', 4)) }
});
if (!started.ok) {
  line(`  REFUSED ${started.status}: ${started.text.slice(0, 300)}`);
  result.stages.run = { ok: false, status: started.status, body: started.text.slice(0, 600) };
  await writeFile(new URL('./form-engine-result.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n');
  process.exit(1);
}
const runId = started.json?.testRunId ?? started.json?.runId ?? started.json?.id;
const planned = started.json?.selected ?? started.json?.testCaseCount ?? '?';
line(`  run ${runId} with ${planned} test(s)`);

// Scaled from the work, with a pessimistic floor, for the reason the other driver was.
const waitMs = Math.max(40 * 60 * 1000,
  ((Number(planned) || 600) / 5 + 30) * 60 * 1000);
line(`  waiting up to ${Math.round(waitMs / 60000)} min`);
const finished = await waitForRun(tenant, runId, waitMs);
line(`  status ${finished.status}${finished.waitExpired ? ' (WAIT EXPIRED — figures are not final)' : ''}`);
line(`  passed ${finished.passedCount ?? '?'}  failed ${finished.failedCount ?? '?'}  `
  + `blocked ${finished.blockedCount ?? 0}  skipped ${finished.skippedCount ?? 0}`);

const executions = await request(`/api/v1/testruns/${runId}/executions?pageSize=4000`, { token: tenant.token });
const rows = executions.json?.items ?? executions.json ?? [];
const failures = rows.filter(r => String(r.status).toLowerCase() === 'failed');
line(`  ${rows.length} execution record(s), ${failures.length} failure(s)`);

result.stages.run = {
  runId, status: finished.status, waitExpired: finished.waitExpired ?? false,
  total: rows.length, passed: finished.passedCount ?? null, failed: finished.failedCount ?? null,
  blocked: finished.blockedCount ?? null,
  failures: failures.map(r => ({
    testCaseId: r.testCaseId, name: r.testCaseName ?? r.name ?? null,
    message: (r.failureMessage ?? r.errorMessage ?? '').slice(0, 400),
    category: r.category ?? r.testCategory ?? null
  }))
};

// ---- 6b. coverage, now that it means something -------------------------------
section('6b. Coverage once the suite has run');
result.stages.coverageAfter = await readCoverage('after the run');

// ---- 7. the defects the engine correlated ------------------------------------
section('7. Defects the engine correlated from those failures');
// projectId is required on this endpoint, not optional. Passing only applicationId returned
// nothing and the driver reported "0 defect(s)" while the engine had correlated 23.
const defects = await request(
  `/api/v1/defects?projectId=${project.id}&applicationId=${application.id}`,
  { token: tenant.token });
const defectList = defects.json?.items ?? defects.json ?? [];
line(`  ${defectList.length} defect(s)`);
const bySeverity = {};
for (const d of defectList) bySeverity[d.severity ?? '?'] = (bySeverity[d.severity ?? '?'] ?? 0) + 1;
if (defectList.length) line(`  by severity: ${JSON.stringify(bySeverity)}`);
for (const d of defectList.slice(0, 60)) {
  line(`    [${d.severity ?? '?'}] ${(d.title ?? '').slice(0, 92)}`);
  const where = d.where ?? d.location ?? d.route ?? d.applicationFormId;
  if (where) line(`        at ${String(where).slice(0, 80)}`);
  if (d.occurrenceCount > 1) line(`        seen ${d.occurrenceCount} time(s)`);
}
result.stages.defects = {
  count: defectList.length,
  list: defectList.map(d => ({
    id: d.id, title: d.title ?? null, severity: d.severity ?? null,
    category: d.category ?? null, where: d.where ?? d.location ?? d.route ?? null,
    symptom: d.symptom ?? null, evidence: (d.evidence ?? d.reproduction ?? null)
  }))
};

await writeFile(new URL('./form-engine-result.json', import.meta.url),
  JSON.stringify(result, null, 2) + '\n');
line(`\nWritten to test-lab/freight-platform/form-engine-result.json\n`);
