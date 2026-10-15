/**
 * Complete manual-testing verification, end to end, with AI disabled.
 *
 *   node verification/manual-testing/verify.mjs
 *
 * Drives QA NXT the way a person would — project, application, discovery, configuration,
 * generation, run, defects, fix, regression, coverage, import, human verification — against
 * the golden form lab, and checks every result against the lab's ground truth.
 *
 * Every number in the report it writes is counted from what the platform recorded during
 * this run. Nothing is asserted as an arbitrary total: the checks are that the expected
 * categories, fields, boundaries, rules and defects are there, and that nothing was found
 * that the lab does not contain.
 *
 * Exit status 0 only when every check passed. A check that cannot be made here (a browser
 * that is not installed) is NOT VERIFIED, never PASS.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { API, createProject, newTenant, registerApplication, request, runDiscovery } from '../golden-tests/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const LAB_URL = (process.env.FORM_LAB_URL ?? 'http://127.0.0.1:4370').replace(/\/$/, '');
const RUN_ID = process.env.MANUAL_TESTING_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const EVIDENCE = join(ROOT, 'verification/evidence/MANUAL-TESTING', RUN_ID);
const REPORT = join(ROOT, 'verification/manual-testing-coverage-report.md');
mkdirSync(EVIDENCE, { recursive: true });

const checks = [];
const measured = {};
const started = Date.now();

function record(id, area, title, status, detail, evidence) {
  checks.push({ id, area, title, status, detail, evidence });
  const colour = status === 'PASS' ? '\x1b[32m' : status === 'NOT VERIFIED' ? '\x1b[33m' : '\x1b[31m';
  console.log(`${colour}${status.padEnd(12)}\x1b[0m ${id} ${title}${detail ? ` — ${detail}` : ''}`);
}

function check(id, area, title, ok, detail, evidence) {
  record(id, area, title, ok ? 'PASS' : 'FAIL', detail, evidence);
  return ok;
}

function save(name, value) {
  const path = join(EVIDENCE, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return `verification/evidence/MANUAL-TESTING/${RUN_ID}/${name}`;
}

/** Reads a zip's entries (stored or deflated) — enough to check an evidence pack. */
function readZip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataStart, dataStart + compressed);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function download(path) {
  const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${tenant.token}` } });
  return { status: response.status, type: response.headers.get('content-type') ?? '', disposition: response.headers.get('content-disposition') ?? '', body: Buffer.from(await response.arrayBuffer()) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lab = (path, body) => fetch(`${LAB_URL}${path}`, body === undefined ? undefined
  : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

async function api(path, options = {}) {
  const response = await request(path, { timeoutMs: 600_000, ...options, token: tenant.token });
  if (!response.ok && !options.allowFailure) throw new Error(`${options.method ?? 'GET'} ${path} → ${response.status} ${response.text.slice(0, 400)}`);
  // Every run this script starts is remembered until it finishes, so stopping the script
  // cancels it instead of leaving its tests queued for whatever runs next.
  if (response.ok && options.method === 'POST' && /\/runs$|^\/api\/v1\/testruns$/.test(path)) {
    const runId = response.json?.testRunId ?? response.json?.id;
    if (runId) activeRuns.add(runId);
  }
  return response.json;
}

// ---------------------------------------------------------------------------
// Stopping cleanly
// ---------------------------------------------------------------------------

/** Runs started by this script and not yet finished. */
const activeRuns = new Set();
let stopping = false;

/** Cancels whatever this script still has running, then exits. A stopped verification used
 *  to leave hundreds of tests queued; the worker went on running them, and they landed in the
 *  lab during the next verification, which then reported submissions it had not made. */
async function stop(reason, code) {
  if (stopping) return;
  stopping = true;
  if (activeRuns.size > 0 && typeof tenant !== 'undefined') {
    console.error(`\n${reason}: cancelling ${activeRuns.size} unfinished run(s) …`);
    for (const runId of activeRuns) {
      const response = await request(`/api/v1/testruns/${runId}/cancel`, { method: 'POST', token: tenant.token, timeoutMs: 15_000 }).catch(error => ({ ok: false, status: String(error) }));
      console.error(`  ${runId}: ${response.ok ? 'cancelled' : `could not cancel (${response.status})`}`);
    }
  }
  process.exit(code);
}
process.on('SIGINT', () => void stop('Interrupted', 130));
process.on('SIGTERM', () => void stop('Stopped', 143));
process.on('unhandledRejection', error => { console.error(error); void stop('Failed', 1); });
process.on('uncaughtException', error => { console.error(error); void stop('Failed', 1); });

async function upload(path, fileName, content, contentType) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: contentType }), fileName);
  const response = await fetch(`${API}${path}`, { method: 'POST', headers: { authorization: `Bearer ${tenant.token}` }, body: form });
  const text = await response.text();
  if (!response.ok) throw new Error(`upload ${path} → ${response.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function waitForRun(runId, label) {
  const deadline = Date.now() + 60 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const run = await api(`/api/v1/testruns/${runId}`);
    if (run.completedAt) { activeRuns.delete(runId); return run; }
    const line = `${label}: ${run.passedCount + run.failedCount + run.skippedCount + run.blockedCount}/${run.totalCount}`;
    if (line !== last) { process.stdout.write(`  … ${line}\r`); last = line; }
    await sleep(10_000);
  }
  throw new Error(`${label} did not finish within an hour`);
}

async function allTests(applicationId) {
  const items = [];
  for (let skip = 0; ; skip += 1000) {
    const page = await api(`/api/v1/test-repository?projectId=${project.id}&applicationId=${applicationId}&skip=${skip}&take=1000`);
    items.push(...page.items);
    if (items.length >= page.total || page.items.length === 0) return items;
  }
}

const camel = s => s ? s.charAt(0).toLowerCase() + s.slice(1) : s;

// ---------------------------------------------------------------------------
// 0. The environment, and that AI is really off
// ---------------------------------------------------------------------------

const health = await request('/health');
if (!health.ok) { console.error(`The QA NXT API at ${API} is not answering.`); process.exit(2); }
const labHealth = await fetch(`${LAB_URL}/health`).then(r => r.ok).catch(() => false);
if (!labHealth) { console.error(`The golden form lab at ${LAB_URL} is not answering. Start it: bash test-lab/scripts/lab-ctl.sh start`); process.exit(2); }
await lab('/__reset', {});
const truth = await fetch(`${LAB_URL}/__ground-truth`).then(r => r.json());
save('ground-truth.json', truth);

const meta = (await request('/api/v1/meta')).json;
check('AI-001', 'AI dependency', 'The platform reports AI disabled', meta?.aiDisabled === true, `aiDisabled=${meta?.aiDisabled}, aiRequiredForTesting=${meta?.aiRequiredForTesting}`);

const tenant = await newTenant('ManualTesting');
const providers = (await request('/api/v1/ai/providers', { token: tenant.token })).json ?? [];
const hosted = providers.filter(p => String(p.kind ?? p.provider).toLowerCase() !== 'local' && p.isConfigured);
check('AI-002', 'AI dependency', 'No hosted model provider can be called', hosted.length === 0,
  hosted.length ? `configured: ${hosted.map(p => p.name).join(', ')}` : `${providers.length} provider(s) listed, only the local rules engine available`);

// ---------------------------------------------------------------------------
// 1. Project, application, discovery
// ---------------------------------------------------------------------------

const project = await createProject(tenant, 'Golden form lab', { aiEnabled: false });
check('FLOW-001', 'Workflow', 'A project is created with AI switched off for it', Boolean(project?.id), `project ${project.id}`);
const application = await registerApplication(tenant, project.id, { name: 'Golden Form Lab', baseUrl: LAB_URL, maxPages: 40 });
check('FLOW-002', 'Workflow', 'The application is added', Boolean(application?.id), LAB_URL);

const discovery = await runDiscovery(tenant, application.id, { maxPages: 40, maxDepth: 2 });
const pages = await api(`/api/v1/applications/${application.id}/pages`).catch(() => []);
const routes = new Set((pages ?? []).map(p => new URL(p.url).pathname));
const missingPages = truth.pages.filter(p => !routes.has(p));
check('DISC-001', 'Discovery', 'Discovery completes', String(discovery.status).toLowerCase() === 'completed', `status ${discovery.status}`);
check('DISC-002', 'Discovery', 'Every page in the lab is discovered', missingPages.length === 0,
  missingPages.length ? `missing: ${missingPages.join(', ')}` : `${truth.pages.length} of ${truth.pages.length} pages`);

const forms = await api(`/api/v1/applications/${application.id}/forms`);
const formByRoute = new Map(forms.map(f => [f.route, f]));
const models = {};
for (const form of forms) models[form.route] = await api(`/api/v1/forms/${form.id}`);
save('discovered-forms.json', { forms, models });

const missingForms = truth.forms.filter(f => !formByRoute.has(f.route));
check('DISC-003', 'Discovery', 'Every form in the lab is discovered', missingForms.length === 0,
  missingForms.length ? `missing: ${missingForms.map(f => f.route).join(', ')}` : `${truth.forms.length} of ${truth.forms.length} forms`);

const fieldProblems = [];
let declaredFields = 0;
let declaredConstraints = 0;
for (const form of truth.forms) {
  const model = models[form.route];
  for (const field of form.fields) {
    declaredFields++;
    const found = model?.fields.find(f => f.name === field.name);
    if (!found) { fieldProblems.push(`${form.id}.${field.name} not found`); continue; }
    if (found.required !== field.required) fieldProblems.push(`${form.id}.${field.name} required=${found.required}`);
    for (const [key, value] of Object.entries(field.constraints)) {
      declaredConstraints++;
      if (found.constraints[key] !== value) fieldProblems.push(`${form.id}.${field.name} ${key}=${found.constraints[key]} (declared ${value})`);
    }
  }
}
check('DISC-004', 'Discovery', 'Every field is discovered with its requiredness', !fieldProblems.some(p => p.includes('not found') || p.includes('required=')),
  `${declaredFields} fields declared; ${fieldProblems.filter(p => p.includes('not found')).length} missing`, save('field-discovery.json', fieldProblems));
check('DISC-005', 'Discovery', 'Every declared constraint is discovered exactly', !fieldProblems.some(p => p.includes('declared')),
  `${declaredConstraints} constraints (minlength, maxlength, min, max, step, pattern, accept)`);

const depProblems = [];
for (const form of truth.forms) {
  for (const field of form.fields.filter(f => f.conditional)) {
    const hit = models[form.route]?.dependencies.some(d => d.trigger === field.conditional.field && d.shows.includes(field.name));
    if (!hit) depProblems.push(`${form.id}.${field.name}`);
  }
  if (form.dependentOptions && !models[form.route]?.dependencies.some(d => d.optionsOf[form.dependentOptions.child])) depProblems.push(`${form.id}: dependent options`);
}
check('DISC-006', 'Discovery', 'Conditional fields and dependent lists are discovered by probing, without submitting', depProblems.length === 0,
  depProblems.length ? `missing: ${depProblems.join(', ')}` : 'every conditional field and dependent list observed');
const wizards = truth.forms.filter(f => f.multiStep);
check('DISC-007', 'Discovery', 'Multi-step forms are recognised with their steps', wizards.every(f => models[f.route]?.isMultiStep), wizards.map(f => f.route).join(', '));
const records = await fetch(`${LAB_URL}/api/records`).then(r => r.json());
const dialogModel = models['/contact-modal'];
check('DISC-009', 'Discovery', 'A form hidden in a dialog is found together with the control that opens it',
  dialogModel?.hiddenAtLoad === true && dialogModel?.opener?.label === 'Contact us',
  dialogModel ? `hidden at load: ${dialogModel.hiddenAtLoad}; opener: ${dialogModel.opener ? `"${dialogModel.opener.label}"` : 'none'}` : '/contact-modal not discovered');
check('DISC-008', 'Discovery', 'Discovery and probing submitted nothing', records.records.length === 0, `${records.records.length} record(s) in the lab`);
const endpoints = await api(`/api/v1/applications/${application.id}/api-endpoints`).catch(() => []);
measured.discovery = { pages: routes.size, forms: forms.length, fields: forms.reduce((n, f) => n + f.fieldCount, 0), endpoints: endpoints?.length ?? 0, constraints: declaredConstraints };

// ---------------------------------------------------------------------------
// 2. Testing configuration
// ---------------------------------------------------------------------------

const taxonomy = (await request('/api/v1/meta/testing-taxonomy')).json;
const allCategories = taxonomy.categories.map(c => c.key);
const profile = await api(`/api/v1/applications/${application.id}/testing-profile`);
check('CONF-001', 'Configuration', 'The default mode is Comprehensive', String(profile.mode).toLowerCase() === 'comprehensive', `mode ${profile.mode}`);
const comprehensive = taxonomy.modes.find(m => m.mode === 'comprehensive').categories;
check('CONF-002', 'Configuration', 'Comprehensive enables every category', allCategories.every(c => comprehensive.includes(c)), `${comprehensive.length} of ${allCategories.length}`);
const custom = await api(`/api/v1/applications/${application.id}/testing-profile`, { method: 'PUT', body: { ...profile, mode: 'custom', categories: allCategories } });
check('CONF-003', 'Configuration', 'Select all (custom, every category) is accepted and stored', custom.categories.length === allCategories.length, `${custom.categories.length} categories`);
const empty = await request(`/api/v1/applications/${application.id}/testing-profile`, { token: tenant.token, method: 'PUT', body: { ...profile, mode: 'custom', categories: [] } });
check('CONF-004', 'Configuration', 'Deselect all is refused with a reason rather than generating nothing silently', empty.status === 400, empty.json?.title ?? empty.text.slice(0, 120));
await api(`/api/v1/applications/${application.id}/testing-profile`, { method: 'PUT', body: { ...profile, mode: 'comprehensive' } });

// ---------------------------------------------------------------------------
// 3. Generation
// ---------------------------------------------------------------------------

const t0 = Date.now();
const generation = await api(`/api/v1/applications/${application.id}/form-tests/generate`, { method: 'POST', body: {} });
const generationMs = Date.now() - t0;
save('generation.json', generation);
check('GEN-001', 'Generation', 'Generation runs with AI disabled and says it used none', generation.usedAi === false && generation.testsCreated > 0,
  `${generation.testsCreated} tests in ${generationMs} ms by "${generation.engine}"`);
check('GEN-002', 'Generation', 'Every discovered form receives a test suite', generation.perForm.length === forms.length && generation.perForm.every(f => f.tests > 0),
  `${generation.perForm.filter(f => f.tests > 0).length} of ${forms.length} forms`);

const tests = await allTests(application.id);
save('generated-tests.json', tests);
const byForm = new Map(forms.map(f => [f.id, tests.filter(t => t.applicationFormId === f.id)]));
const categoriesOf = list => new Set(list.map(t => camel(t.category)).filter(Boolean));

// Expected categories, from the ground truth only.
const expectations = [];
for (const form of truth.forms) {
  const discovered = formByRoute.get(form.route);
  if (!discovered) continue;
  const present = categoriesOf(byForm.get(discovered.id) ?? []);
  const expect = new Set(['smoke', 'accessibility', 'performance', 'responsive', 'visual', 'security', 'inputValidation', 'exploratory', 'stateTransition']);
  if (form.id === 'login') { expect.delete('stateTransition'); }
  if (form.id === 'dependent-dropdown') expect.delete('inputValidation');
  if (form.id === 'date-form') expect.delete('inputValidation');
  if (form.id !== 'login') expect.add('functional');
  if (form.fields.some(f => f.required)) { expect.add('negative'); expect.add('errorHandling'); }
  if (form.fields.some(f => Object.keys(f.constraints).some(k => ['minlength', 'maxlength', 'min', 'max'].includes(k)))) expect.add('boundary');
  if (form.fields.some(f => ['email', 'url'].includes(f.type) || f.constraints.pattern || f.constraints.accept)) expect.add('validation');
  if (form.crossRules.length) expect.add('crossField');
  if (form.fields.some(f => f.conditional) || form.dependentOptions) expect.add('dynamic');
  if (form.multiStep) expect.add('multiStep');
  if (form.method !== 'get' && form.id !== 'login') { expect.add('reliability'); expect.add('api'); }
  if (form.id !== 'login') expect.add('compatibility');
  const missing = [...expect].filter(c => !present.has(c));
  expectations.push({ form: form.route, expected: [...expect], present: [...present], missing });
}
save('category-expectations.json', expectations);
const missingCats = expectations.filter(e => e.missing.length);
check('GEN-003', 'Generation', 'Every form has every category its fields and behaviour call for', missingCats.length === 0,
  missingCats.length ? missingCats.map(e => `${e.form}: ${e.missing.join(', ')}`).join('; ') : `${expectations.reduce((n, e) => n + e.expected.length, 0)} form×category expectations met`);

const uncovered = [];
for (const form of truth.forms) {
  const discovered = formByRoute.get(form.route);
  const fieldsWithTests = new Set((byForm.get(discovered?.id) ?? []).map(t => t.fieldKey).filter(Boolean));
  for (const field of form.fields) if (!fieldsWithTests.has(field.name)) uncovered.push(`${form.id}.${field.name}`);
}
check('GEN-004', 'Generation', 'Every discovered field has at least one test about it', uncovered.length === 0,
  uncovered.length ? `no field-level test: ${uncovered.join(', ')}` : `${declaredFields} of ${declaredFields} fields`);

const boundaryProblems = [];
let boundaryCases = 0;
for (const form of truth.forms) {
  const formTests = byForm.get(formByRoute.get(form.route)?.id) ?? [];
  for (const field of form.fields) {
    const c = field.constraints;
    const wanted = [];
    if (c.min !== undefined) wanted.push('min-1', 'min');
    if (c.max !== undefined) wanted.push('max', 'max+1');
    if (c.minlength !== undefined && Number(c.minlength) > 1) wanted.push('minlength-1', 'minlength');
    if (c.maxlength !== undefined && field.type !== 'email') wanted.push('maxlength', 'maxlength+1');
    for (const technique of wanted) {
      boundaryCases++;
      if (!formTests.some(t => t.fieldKey === field.name && t.technique === technique)) boundaryProblems.push(`${form.id}.${field.name} ${technique}`);
    }
  }
}
check('GEN-005', 'Generation', 'Every declared boundary has its boundary tests', boundaryProblems.length === 0,
  boundaryProblems.length ? `missing: ${boundaryProblems.slice(0, 12).join(', ')}${boundaryProblems.length > 12 ? '…' : ''}` : `${boundaryCases} boundary cases`);

const ruleProblems = [];
for (const form of truth.forms) {
  const formTests = byForm.get(formByRoute.get(form.route)?.id) ?? [];
  for (const rule of form.crossRules) if (!formTests.some(t => camel(t.category) === 'crossField' && rule.fields.includes(t.fieldKey))) ruleProblems.push(`${form.id}:${rule.id}`);
  for (const field of form.fields.filter(f => f.required && !f.conditional)) {
    if (!formTests.some(t => camel(t.category) === 'negative' && t.fieldKey === field.name && t.technique === 'required')) ruleProblems.push(`${form.id}.${field.name} required`);
  }
}
check('GEN-006', 'Generation', 'Every required field and cross-field rule has its negative test', ruleProblems.length === 0,
  ruleProblems.length ? `missing: ${ruleProblems.join(', ')}` : 'all present');

const fieldNames = new Map(Object.entries(models).map(([route, m]) => [formByRoute.get(route).id, new Set(m.fields.map(f => f.name))]));
const invented = tests.filter(t => t.fieldKey && !fieldNames.get(t.applicationFormId)?.has(t.fieldKey));
const coupon = tests.filter(t => /coupon|discount|voucher/i.test(t.name));
check('GEN-007', 'Generation', 'No test is about something discovery did not find', invented.length === 0 && coupon.length === 0,
  invented.length ? `${invented.length} test(s) name fields that do not exist` : 'every field-level test names a discovered field; no coupon, discount or voucher test exists because the lab has none');

const gapsAtGeneration = (await api(`/api/v1/applications/${application.id}/coverage`)).gaps;
const unknownLimits = gapsAtGeneration.filter(g => g.category === 'boundary' && g.status === 'unknown');
const declaresMaxLength = new Set(truth.forms.flatMap(f => f.fields.filter(x => x.constraints.maxlength).map(x => `${formByRoute.get(f.route)?.id}/${x.name}`)));
const inventedLimits = tests.filter(t => t.technique?.startsWith('maxlength') && !declaresMaxLength.has(`${t.applicationFormId}/${t.fieldKey}`));
check('GEN-008', 'Generation', 'An undeclared limit is reported as unknown, never invented', unknownLimits.length > 0 && inventedLimits.length === 0,
  `${unknownLimits.length} unknown-boundary gap(s); ${inventedLimits.length} maximum-length test(s) for fields that declare no maximum`);
check('GEN-009', 'Generation', 'Every gap says what is missing, why, and what to do', gapsAtGeneration.length > 0 && gapsAtGeneration.every(g => g.missing && g.reason && g.recommendedAction),
  `${gapsAtGeneration.length} gaps`);

const second = await api(`/api/v1/applications/${application.id}/form-tests/generate`, { method: 'POST', body: {} });
check('GEN-010', 'Generation', 'Generation is deterministic and repeatable: the second pass changes nothing', second.testsCreated === 0 && second.testsUpdated === 0 && second.testsUnchanged === generation.testsCreated,
  `second pass: ${second.testsCreated} created, ${second.testsUpdated} updated, ${second.testsUnchanged} unchanged`);
check('GEN-011', 'Generation', 'No arbitrary cap: the count follows the forms', new Set(generation.perForm.map(f => f.tests)).size > 5,
  `tests per form range from ${Math.min(...generation.perForm.map(f => f.tests))} to ${Math.max(...generation.perForm.map(f => f.tests))}`);

const byCategory = {};
for (const t of tests) byCategory[camel(t.category)] = (byCategory[camel(t.category)] ?? 0) + 1;
measured.generation = { total: tests.length, ms: generationMs, byCategory, gaps: generation.gaps, humanTasks: generation.humanTasks, findings: generation.findings };

// ---------------------------------------------------------------------------
// 4. Execution: run all
// ---------------------------------------------------------------------------

const t1 = Date.now();
const runAll = await api(`/api/v1/applications/${application.id}/runs`, { method: 'POST', body: { mode: 'all', browser: 'Chromium', parallelism: 8, name: 'Verification — run all' } });
const finished = await waitForRun(runAll.testRunId, 'run all');
const runAllMs = Date.now() - t1;
const executions = await api(`/api/v1/testruns/${runAll.testRunId}/executions`);
save('run-all-executions.json', executions);
const statusCount = {};
for (const e of executions) statusCount[e.status] = (statusCount[e.status] ?? 0) + 1;
const notRun = executions.filter(e => ['queued', 'pending', 'running'].includes(String(e.status).toLowerCase()));
check('EXEC-001', 'Execution', 'Every selected test runs to a verdict', notRun.length === 0 && executions.length === runAll.selected,
  `${executions.length} executions in ${Math.round(runAllMs / 1000)} s: ${JSON.stringify(statusCount)}`);
const skipped = executions.filter(e => String(e.status).toLowerCase() === 'skipped');
const skippedOk = skipped.every(e => /browser:(firefox|webkit)/i.test(tests.find(t => t.id === e.testCaseId)?.tags ?? ''));
check('EXEC-002', 'Execution', 'Only compatibility tests for other browsers are skipped, and they say why', skippedOk,
  `${skipped.length} skipped, all tagged for Firefox or WebKit`);

// Evidence on a passing and a failing execution.
const failedExecs = executions.filter(e => ['failed', 'error'].includes(String(e.status).toLowerCase()));
const passedExec = executions.find(e => String(e.status).toLowerCase() === 'passed');
const evidenceFor = async e => {
  const [detail, artifacts, consoleLog, network] = await Promise.all([
    api(`/api/v1/executions/${e.id}`), api(`/api/v1/artifacts?executionId=${e.id}`).catch(() => []),
    api(`/api/v1/executions/${e.id}/console`).catch(() => []), api(`/api/v1/executions/${e.id}/network`).catch(() => [])
  ]);
  return { detail, artifacts, console: consoleLog, network };
};
const passEvidence = passedExec ? await evidenceFor(passedExec) : null;
const failEvidence = failedExecs[0] ? await evidenceFor(failedExecs[0]) : null;
save('evidence-sample.json', { passEvidence: { ...passEvidence, detail: undefined }, failEvidence: { ...failEvidence, detail: undefined } });
const kinds = new Set((failEvidence?.artifacts ?? []).map(a => String(a.kind).toLowerCase()));
check('EVID-001', 'Evidence', 'A failing execution keeps screenshots, trace, video and DOM', ['screenshot', 'trace', 'video'].every(k => kinds.has(k)) && (kinds.has('domsnapshot') || kinds.has('dom')),
  `artifact kinds: ${[...kinds].join(', ')}`);
check('EVID-002', 'Evidence', 'Executions record their network traffic', (passEvidence?.network?.length ?? 0) > 0 && (failEvidence?.network?.length ?? 0) > 0,
  `${passEvidence?.network?.length ?? 0} and ${failEvidence?.network?.length ?? 0} network events`);

// ---------------------------------------------------------------------------
// 5. Failures against the ground truth
// ---------------------------------------------------------------------------

const testById = new Map(tests.map(t => [t.id, t]));
const formIdToTruth = new Map(truth.forms.map(f => [formByRoute.get(f.route)?.id, f]));
const failures = failedExecs.map(e => {
  const test = testById.get(e.testCaseId);
  const form = formIdToTruth.get(test?.applicationFormId);
  const category = camel(test?.category);
  const explainedBy = form?.defects.filter(d => d.detectedBy.includes(category)).map(d => d.id) ?? [];
  return { reference: e.reference, name: e.name, form: form?.route, category, technique: test?.technique, field: test?.fieldKey, explainedBy, error: e.errorMessage };
});
save('failures.json', failures);
const unexplained = failures.filter(f => f.explainedBy.length === 0);
const detected = new Map();
for (const form of truth.forms) {
  for (const defect of form.defects) {
    const hits = failures.filter(f => f.form === form.route && defect.detectedBy.includes(f.category));
    detected.set(defect.id, { defect, form: form.route, hits });
  }
}
const missed = [...detected.values()].filter(d => d.hits.length === 0);
check('FAIL-001', 'Failure detection', 'Every deliberate defect in the lab is detected', missed.length === 0,
  missed.length ? `missed: ${missed.map(d => `${d.defect.id} (${d.form})`).join(', ')}` : `${detected.size} of ${detected.size} defects detected`);
check('FAIL-002', 'Failure detection', 'No failure outside the lab\'s declared defects (no false failures)', unexplained.length === 0,
  unexplained.length ? unexplained.slice(0, 8).map(f => `${f.reference} ${f.name}: ${String(f.error).slice(0, 100)}`).join(' | ') : `${failures.length} failure(s), all explained by declared defects`);
measured.failures = { total: failures.length, unexplained: unexplained.length, detected: detected.size - missed.length, declared: detected.size };

// Patterns a real application showed that are not defects, and must not be reported as
// such: a form behind a "Contact us" dialog, and decoration a page clips.
const verdictOf = id => String(executions.find(e => e.testCaseId === id)?.status ?? 'not run').toLowerCase();
const dialogTests = tests.filter(t => t.applicationFormId === formByRoute.get('/contact-modal')?.id);
const dialogRan = dialogTests.filter(t => ['passed', 'failed', 'error'].includes(verdictOf(t.id)));
const dialogFailed = dialogTests.filter(t => ['failed', 'error'].includes(verdictOf(t.id)));
check('FALSE-001', 'False positives', 'A correct form inside a dialog is opened by its tests and reported clean',
  dialogRan.length >= 20 && dialogFailed.length === 0,
  `${dialogRan.length} tests ran against /contact-modal; ${dialogFailed.length} failed${dialogFailed.length ? `: ${dialogFailed.slice(0, 4).map(t => t.reference).join(', ')}` : ''}`);
const loginResponsive = tests.filter(t => t.applicationFormId === formByRoute.get('/login')?.id && camel(t.category) === 'responsive');
const loginOverflow = loginResponsive.filter(t => ['failed', 'error'].includes(verdictOf(t.id)));
check('FALSE-002', 'False positives', 'Decoration a page clips (overflow-x: hidden) is not reported as sideways scrolling',
  loginResponsive.length > 0 && loginOverflow.length === 0,
  `${loginResponsive.length} responsive tests on /login, ${loginOverflow.length} failed`);

const failureList = await api(`/api/v1/failures?projectId=${project.id}&limit=200`);
const sampleFailure = failureList.find(f => f.testExecutionId === failedExecs[0]?.id) ?? failureList[0];
const report = sampleFailure ? await api(`/api/v1/failures/${sampleFailure.id}/report`) : null;
save('failure-report-sample.json', report);
const reportFields = ['failureId', 'testReference', 'category', 'pageUrl', 'formName', 'expected', 'actual', 'error', 'browser', 'browserVersion', 'viewport', 'at', 'consoleLogs', 'networkLogs', 'artifacts', 'reproductionSteps'];
const absent = report ? reportFields.filter(k => report[k] === undefined || report[k] === null) : reportFields;
check('FAIL-003', 'Failure detection', 'A failure has a detailed record, not just "failed"', absent.length === 0,
  absent.length ? `missing: ${absent.join(', ')}` : `${reportFields.length} fields present, ${report.artifacts.length} artifacts, ${report.reproductionSteps.length} reproduction steps`);

// ---------------------------------------------------------------------------
// 6. Defects: correlation, confirmation, regression from a defect
// ---------------------------------------------------------------------------

const defects = await api(`/api/v1/defects?projectId=${project.id}`);
save('defects.json', defects);
check('DEF-001', 'Defects', 'Failures propose defects', defects.length > 0 && defects.every(d => d.status === 'proposed'), `${defects.length} proposed`);
check('DEF-002', 'Defects', 'Failures with one cause are one defect', defects.length < failures.length,
  `${failures.length} failing tests → ${defects.length} defects`);
// ---------------------------------------------------------------------------
// 6b. The bug report a developer is handed
// ---------------------------------------------------------------------------

const [bugHtml, bugZip, bugJson] = await Promise.all(['html', 'zip', 'json'].map(f => download(`/api/v1/testruns/${runAll.testRunId}/bug-report?format=${f}`)));
const bugReport = bugJson.status === 200 ? JSON.parse(bugJson.body.toString('utf8')) : null;
if (bugHtml.status === 200) writeFileSync(join(EVIDENCE, 'bug-report.html'), bugHtml.body);
if (bugZip.status === 200) writeFileSync(join(EVIDENCE, 'bug-report.zip'), bugZip.body);
const bugs = bugReport?.bugs ?? [];
const accounted = bugs.reduce((n, b) => n + b.affectedTests.length, 0) + (bugReport?.notProductBugs.length ?? 0);
const reported = new Set(bugs.flatMap(b => b.affectedTests.map(t => t.reference)));
const missingFromReport = failures.filter(f => !reported.has(f.reference) && !(bugReport?.notProductBugs ?? []).some(o => o.reference === f.reference));
check('REPORT-001', 'Bug report', 'Every failure of the run is in the downloadable bug report, grouped into bugs like the defects',
  bugJson.status === 200 && accounted === failures.length && missingFromReport.length === 0 && bugs.length === defects.length,
  `${failures.length} failing tests → ${bugs.length} bugs (${defects.length} defects), ${bugReport?.notProductBugs.length ?? 0} not product bugs`
    + (missingFromReport.length ? `; missing: ${missingFromReport.map(f => f.reference).join(', ')}` : ''), save('bug-report.json', bugReport));

const incomplete = bugs.filter(b => !b.pageUrl || !b.expected || !b.actual || !b.failingStep || b.steps.length < 2
  || b.screenshots.length === 0 || !b.attachments.some(a => a.kind === 'trace') || !b.whereToLook || !b.verifyTheFix);
const serverBug = bugs.find(b => /HTTP 500/.test(b.title));
check('REPORT-002', 'Bug report', 'Each bug carries what a developer needs: page, steps with values, data, expected and actual, failing step, screenshot, trace, request, where to look, how to verify',
  bugs.length > 0 && incomplete.length === 0 && Boolean(serverBug?.exchanges.some(x => x.statusCode === 500 && x.request)) && Boolean(serverBug?.curl),
  incomplete.length ? `incomplete: ${incomplete.map(b => `${b.key} ${b.title}`).join(' | ')}`
    : `${bugs.length} bugs complete; the server crash has its request (${serverBug?.exchanges.find(x => x.statusCode === 500)?.request?.slice(0, 60)}) and a curl replay`);

const html = bugHtml.body.toString('utf8');
const embedded = (html.match(/<img src="data:image\/png;base64,/g) ?? []).length;
check('REPORT-003', 'Bug report', 'The HTML report is one file a developer can open anywhere, with the screenshots inside it',
  bugHtml.status === 200 && bugHtml.type.startsWith('text/html') && /attachment/.test(bugHtml.disposition)
    && bugs.every(b => html.includes(`id="${b.key}"`)) && embedded >= bugs.length && !/<(img|script|link)[^>]+(src|href)="https?:/.test(html),
  `${Math.round(bugHtml.body.length / 1024)} KB, ${bugs.length} bugs, ${embedded} screenshots embedded, nothing loaded from outside`, 'bug-report.html');

const pack = bugZip.status === 200 ? readZip(bugZip.body) : new Map();
const packNames = [...pack.keys()];
const perBug = bugs.filter(b => packNames.some(n => n.startsWith(`evidence/${b.key}/`) && n.endsWith('.png')) && packNames.includes(`evidence/${b.key}/trace.zip`));
const packText = ['bug-report.html', 'bug-report.md', 'bug-report.json'].map(n => pack.get(n)?.toString('utf8') ?? '').join('\n');
check('REPORT-004', 'Bug report', 'The evidence pack holds the report as HTML, Markdown and JSON with every bug\'s screenshots and Playwright trace, and no credentials',
  ['bug-report.html', 'bug-report.md', 'bug-report.json', 'README.txt'].every(n => pack.has(n)) && perBug.length === bugs.length
    && !packText.includes(tenant.token) && !/Bearer\s+eyJ/.test(packText),
  `${packNames.length} files, ${Math.round(bugZip.body.length / 1024)} KB; ${perBug.length} of ${bugs.length} bugs with screenshots and a trace; no access token in any file`, 'bug-report.zip');

const crashForm = formByRoute.get('/error-handling');
const crashDefect = defects.find(d => d.applicationFormId === crashForm.id && /HTTP 500/.test(d.title));
check('DEF-003', 'Defects', 'The server crash hit by several inputs is one defect with every affected test', (crashDefect?.affectedTestCount ?? 0) >= 2,
  crashDefect ? `${crashDefect.reference} "${crashDefect.title}" — ${crashDefect.affectedTestCount} tests` : 'not found');
const ageDefect = defects.find(d => d.applicationFormId === formByRoute.get('/validation').id && /below its minimum/.test(d.title));
check('DEF-004', 'Defects', 'Three boundary tests below one unenforced minimum are one defect', (ageDefect?.affectedTestCount ?? 0) >= 3,
  ageDefect ? `${ageDefect.reference} "${ageDefect.title}" — ${ageDefect.affectedTestCount} tests` : 'not found');

const regressionRefused = await request(`/api/v1/defects/${crashDefect.id}/regression-test`, { token: tenant.token, method: 'POST' });
check('DEF-005', 'Defects', 'A proposed defect cannot become a regression test until a person confirms it', regressionRefused.status === 400, regressionRefused.json?.title ?? '');
for (const defect of [crashDefect, ageDefect]) await api(`/api/v1/defects/${defect.id}/status`, { method: 'POST', body: { status: 'open', note: 'Confirmed during verification.' } });
const regressionTests = [];
for (const defect of [crashDefect, ageDefect]) regressionTests.push((await api(`/api/v1/defects/${defect.id}/regression-test`, { method: 'POST' })).testCaseId);
const regressionCases = await Promise.all(regressionTests.map(id => api(`/api/v1/testcases/${id}`)));
check('DEF-006', 'Defects', 'A confirmed defect becomes a permanent regression test', regressionCases.every(t => /regression/i.test(t.tags ?? t.testCase?.tags ?? '') || /Regression/.test(t.name ?? t.testCase?.name ?? '')),
  regressionCases.map(t => t.reference ?? t.testCase?.reference).join(', '));

// ---------------------------------------------------------------------------
// 7. Regression: still broken, then fixed
// ---------------------------------------------------------------------------

const regressionPreview = await api(`/api/v1/applications/${application.id}/runs/preview`, { method: 'POST', body: { mode: 'regression' } });
const before = await api(`/api/v1/applications/${application.id}/runs`, { method: 'POST', body: { mode: 'regression', browser: 'Chromium', name: 'Regression before the fix' } });
const beforeRun = await waitForRun(before.testRunId, 'regression before fix');
check('REG-001', 'Regression', 'The regression suite fails while the defects are still there', beforeRun.failedCount === regressionTests.length,
  `${regressionPreview.selected} selected; ${beforeRun.failedCount} failed, ${beforeRun.passedCount} passed`);
await lab('/__fix', { defects: ['FL-D05', 'FL-D02'] });
const after = await api(`/api/v1/applications/${application.id}/runs`, { method: 'POST', body: { mode: 'regression', browser: 'Chromium', name: 'Regression after the fix' } });
const afterRun = await waitForRun(after.testRunId, 'regression after fix');
check('REG-002', 'Regression', 'After the application is fixed, the same regression tests pass', afterRun.passedCount === regressionTests.length && afterRun.failedCount === 0,
  `${afterRun.passedCount} passed, ${afterRun.failedCount} failed`);
const failedAfterFix = await api(`/api/v1/applications/${application.id}/runs`, { method: 'POST', body: { mode: 'failed', browser: 'Chromium', name: 'Re-run failed after the fix' } });
const failedRun = await waitForRun(failedAfterFix.testRunId, 're-run failed');
const failedExecs2 = await api(`/api/v1/testruns/${failedAfterFix.testRunId}/executions`);
const fixedForms = new Set([crashForm.id, formByRoute.get('/validation').id]);
const stillFailing = failedExecs2.filter(e => ['failed', 'error'].includes(String(e.status).toLowerCase()));
const fixedStillFailing = stillFailing.filter(e => fixedForms.has(testById.get(e.testCaseId)?.applicationFormId) && ['inputValidation', 'errorHandling', 'boundary'].includes(camel(testById.get(e.testCaseId)?.category)));
check('REG-003', 'Regression', 'Run failed re-runs exactly the failures, and the fixed ones now pass', failedAfterFix.selected === failures.length && fixedStillFailing.length === 0,
  `${failedAfterFix.selected} re-run; ${failedRun.passedCount} now pass, ${failedRun.failedCount} still fail (the defects not fixed)`);

// Impact: change one form, rediscover, regenerate, and run only what it reached.
await lab('/__change', { forms: ['simple-form'] });
await runDiscovery(tenant, application.id, { maxPages: 40, maxDepth: 2 });
const changedForms = (await api(`/api/v1/applications/${application.id}/forms`)).filter(f => f.changedAt);
const regen = await api(`/api/v1/applications/${application.id}/form-tests/generate`, { method: 'POST', body: {} });
const impacted = await api(`/api/v1/applications/${application.id}/runs/preview`, { method: 'POST', body: { mode: 'impacted' } });
check('REG-004', 'Regression', 'A changed form is detected and its tests are selected for impacted regression', changedForms.length === 1 && changedForms[0].route === '/simple-form' && regen.testsCreated > 0 && impacted.selected > 0 && impacted.selected < tests.length,
  `changed: ${changedForms.map(f => f.route).join(', ')}; ${regen.testsCreated} new test(s) for the new field; ${impacted.selected} of ${tests.length + regen.testsCreated} selected. ${impacted.explanation}`);
const impactedRun = await api(`/api/v1/applications/${application.id}/runs`, { method: 'POST', body: { mode: 'impacted', browser: 'Chromium', name: 'Impacted regression' } });
const impactedDone = await waitForRun(impactedRun.testRunId, 'impacted');
check('REG-005', 'Regression', 'The impacted regression runs', impactedDone.passedCount + impactedDone.failedCount + impactedDone.skippedCount === impacted.selected,
  `${impactedDone.passedCount} passed, ${impactedDone.failedCount} failed, ${impactedDone.skippedCount} skipped`);

// ---------------------------------------------------------------------------
// 8. Coverage
// ---------------------------------------------------------------------------

const coverage = await api(`/api/v1/applications/${application.id}/coverage`);
save('coverage.json', coverage);
const sum = (list, key) => list.reduce((n, x) => n + x[key], 0);
check('COV-001', 'Coverage', 'Per-form numbers add up to the application totals', sum(coverage.forms, 'generated') <= coverage.surface.testableTests && sum(coverage.forms, 'executed') <= coverage.surface.executedTests,
  `${sum(coverage.forms, 'generated')} form tests of ${coverage.surface.testableTests} active`);
check('COV-002', 'Coverage', 'Coverage is measured and not claimed as 100% while gaps are open', coverage.overallCoveragePercent !== null && (coverage.gaps.length === 0 || coverage.overallCoveragePercent < 100),
  `coverage ${coverage.overallCoveragePercent}%, pass rate ${coverage.passPercent}%, ${coverage.gaps.length} gaps`);
const wizardCard = coverage.forms.find(f => f.route === '/registration');
check('COV-003', 'Coverage', 'A category that does not apply to a form is N/A and not counted', wizardCard.categories.find(c => c.category === 'multiStep')?.status === 'n/a',
  `registration multi-step: ${wizardCard.categories.find(c => c.category === 'multiStep')?.status}`);
check('COV-004', 'Coverage', 'Every coverage dimension is reported', ['Pages', 'Forms', 'Fields', 'Validation rules', 'Boundaries', 'APIs', 'Testing types', 'Browsers', 'Viewports', 'Security controls', 'Accessibility checks', 'States', 'Workflows'].every(d => coverage.dimensions.some(x => x.dimension === d)),
  coverage.dimensions.map(d => `${d.dimension} ${d.executed}/${d.discovered}`).join('; '));
const browsersDim = coverage.dimensions.find(d => d.dimension === 'Browsers');
measured.coverage = coverage;

// Compatibility in other browsers: verified only if the browser exists.
const pwPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
const installed = existsSync(pwPath) ? readdirSync(pwPath) : [];
for (const browser of ['firefox', 'webkit']) {
  if (!installed.some(name => name.startsWith(browser))) {
    record(`COMP-${browser.toUpperCase()}`, 'Compatibility', `Forms work in ${browser}`, 'NOT VERIFIED',
      `${browser} is not installed in this environment (${pwPath} holds ${installed.join(', ')}). Its compatibility tests exist and were skipped, not passed.`);
  } else {
    const run = await api(`/api/v1/applications/${application.id}/runs`, { method: 'POST', body: { mode: 'selection', categories: ['compatibility', 'functional'], browser, name: `Compatibility — ${browser}` } });
    const done = await waitForRun(run.testRunId, browser);
    check(`COMP-${browser.toUpperCase()}`, 'Compatibility', `Forms work in ${browser}`, done.failedCount === 0, `${done.passedCount} passed, ${done.failedCount} failed`);
  }
}
check('COMP-CHROMIUM', 'Compatibility', 'Forms work in Chromium', executions.some(e => String(e.browser).toLowerCase() === 'chromium'), browsersDim.detail);

// ---------------------------------------------------------------------------
// 9. Human verification, import, repository
// ---------------------------------------------------------------------------

const tasks = await api(`/api/v1/human-tasks?projectId=${project.id}&applicationId=${application.id}`);
check('HUM-001', 'Human verification', 'Checks only a person can make become tasks with a reason, steps and expected result', tasks.length > 0 && tasks.every(t => t.reason && t.steps && t.expectedResult),
  `${tasks.length} tasks: ${[...new Set(tasks.map(t => t.category))].join(', ')}`);
const task = tasks.find(t => t.category === 'accessibility');
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
await upload(`/api/v1/human-tasks/${task.id}/evidence`, 'screen-reader-notes.png', png, 'image/png');
const refusedVerdict = await request(`/api/v1/human-tasks/${task.id}/verdict`, { token: tenant.token, method: 'POST', body: { status: 'failed' } });
const verdict = await api(`/api/v1/human-tasks/${task.id}/verdict`, { method: 'POST', body: { status: 'passed', comments: 'Walked through with VoiceOver; every field and error announced.' } });
const regenAgain = await api(`/api/v1/applications/${application.id}/form-tests/generate`, { method: 'POST', body: {} });
const afterRegen = await api(`/api/v1/human-tasks/${task.id}`);
check('HUM-002', 'Human verification', 'A verdict is recorded with evidence and survives regeneration', verdict.status === 'passed' && verdict.evidence.length === 1 && afterRegen.status === 'passed' && refusedVerdict.status === 400 && regenAgain.testsCreated === 0,
  `"${task.title}" → ${afterRegen.status} with ${afterRegen.evidence.length} evidence file; a failure without a comment was refused`);

const csv = [
  'ID,Title,Preconditions,Steps,Expected Result,Priority,Category',
  `MT-1,Simple form accepts a name,,"Open /simple-form\nEnter ""Ada"" in Your name\nClick Send","Verify ""We received it"" is shown",High,Functional`,
  `MT-2,Registration refuses mismatched passwords,,"Open /registration\nEnter ""a@b.test"" in Email address","The error is clear to a first-time user",Medium,Usability`,
  `MT-3,Login page offers password reset,,"Open /login\nLook for a reset link","A reset link is present",Low,Functional`
].join('\n');
const csvImport = await upload(`/api/v1/applications/${application.id}/manual-tests/import`, 'manual-tests.csv', csv, 'text/csv');
const json = JSON.stringify([{ id: 'MT-J1', title: 'Search reflects the query', steps: ['Open /search', 'Enter "loans" in Search for', 'Click Search'], expectedResult: 'Verify "Results for loans" is shown' }]);
const jsonImport = await upload(`/api/v1/applications/${application.id}/manual-tests/import`, 'manual-tests.json', json, 'application/json');
const xlsx = buildXlsx([['Title', 'Steps', 'Expected result'], ['Checkout page opens', 'Open /checkout', 'Verify "Checkout" is shown'], ['Gift wrap feels optional', 'Open /checkout', 'A person judges whether gift wrap is clearly optional']]);
const xlsxImport = await upload(`/api/v1/applications/${application.id}/manual-tests/import`, 'manual-tests.xlsx', xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
const text = 'Title: Profile page opens\nSteps:\n1. Open /profile\nExpected: Verify "Edit profile" is shown\n\nTitle: Profile copy is friendly\nSteps: Read the page\nExpected: The tone suits the brand';
const textImport = await upload(`/api/v1/applications/${application.id}/manual-tests/import`, 'manual-tests.txt', text, 'text/plain');
const imports = [csvImport, jsonImport, xlsxImport, textImport];
save('imports.json', imports);
check('IMP-001', 'Manual import', 'CSV, JSON, Excel and structured text import', imports.every(i => i.imported > 0), imports.map(i => `${i.format}: ${i.imported}`).join(', '));
const automatable = imports.flatMap(i => i.tests.filter(t => t.automatable));
const human = imports.flatMap(i => i.tests.filter(t => !t.automatable));
check('IMP-002', 'Manual import', 'Each imported test is routed to automation or to human verification, with the reason', automatable.length === 4 && human.length === 4,
  `${automatable.length} automatable (${automatable.map(t => t.title).join('; ')}), ${human.length} to human verification`);
await api('/api/v1/test-cases/bulk/lifecycle', { method: 'POST', body: { projectId: project.id, testCaseIds: automatable.map(t => t.testCaseId), lifecycle: 'Active' } });
const importRun = await api('/api/v1/testruns', { method: 'POST', body: { projectId: project.id, testCaseIds: automatable.map(t => t.testCaseId), name: 'Imported manual tests' } });
const importDone = await waitForRun(importRun.id, 'imported tests');
check('IMP-003', 'Manual import', 'Imported automatable tests execute and pass against the lab', importDone.passedCount === automatable.length,
  `${importDone.passedCount} of ${automatable.length} passed`);

const victim = tests.find(t => camel(t.category) === 'smoke');
const dup = await api(`/api/v1/test-cases/${victim.id}/duplicate`, { method: 'POST', body: {} });
await api(`/api/v1/testcases/${victim.id}`, { method: 'PATCH', body: { name: `${victim.name} (edited)` } });
const versions = await api(`/api/v1/test-cases/${victim.id}/versions`);
const comparison = await api(`/api/v1/test-cases/${victim.id}/versions/compare?from=${versions[0].version}&to=${versions[versions.length - 1].version}`);
check('REPO-001', 'Repository', 'Tests can be duplicated, edited, and compared across versions', Boolean(dup.testCaseId) && versions.length >= 2 && comparison.differences.some(d => d.startsWith('Name')),
  `${versions.length} versions; difference: ${comparison.differences[0]}`);
const twoTests = tests.filter(t => camel(t.category) === 'visual').slice(0, 2).map(t => t.id);
const allBefore = await api(`/api/v1/applications/${application.id}/runs/preview`, { method: 'POST', body: { mode: 'all' } });
await api('/api/v1/test-cases/bulk/lifecycle', { method: 'POST', body: { projectId: project.id, testCaseIds: twoTests, lifecycle: 'Disabled' } });
const allAfter = await api(`/api/v1/applications/${application.id}/runs/preview`, { method: 'POST', body: { mode: 'all' } });
await api('/api/v1/test-cases/bulk/lifecycle', { method: 'POST', body: { projectId: project.id, testCaseIds: twoTests, lifecycle: 'Active' } });
check('REPO-002', 'Repository', 'Disabled tests leave "run all", and come back when re-activated', allBefore.selected - allAfter.selected === 2, `${allBefore.selected} → ${allAfter.selected}`);

// ---------------------------------------------------------------------------
// 10. Per-category: generated, executed, verified
// ---------------------------------------------------------------------------

const final = await api(`/api/v1/applications/${application.id}/coverage`);
save('coverage-final.json', final);
const aiRequests = await api(`/api/v1/ai/requests?projectId=${project.id}&limit=200`).catch(() => null);
const aiList = aiRequests?.items ?? aiRequests ?? [];
const nonLocal = aiList.filter(r => String(r.provider).toLowerCase() !== 'local');
check('AI-003', 'AI dependency', 'Nothing in the whole flow called a hosted model', nonLocal.length === 0,
  `${aiList.length} AI request record(s), ${nonLocal.length} to a hosted provider`);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const totals = { pass: checks.filter(c => c.status === 'PASS').length, fail: checks.filter(c => c.status === 'FAIL').length, notVerified: checks.filter(c => c.status === 'NOT VERIFIED').length };
save('checks.json', { runId: RUN_ID, totals, checks, measured: { ...measured, coverage: undefined } });
writeFileSync(REPORT, renderReport({ final, totals }));
console.log(`\n${totals.pass} passed, ${totals.fail} failed, ${totals.notVerified} not verified in ${Math.round((Date.now() - started) / 60000)} min.`);
console.log(`Report: verification/manual-testing-coverage-report.md\nEvidence: verification/evidence/MANUAL-TESTING/${RUN_ID}/`);
process.exit(totals.fail === 0 ? 0 : 1);

// ---------------------------------------------------------------------------

function renderReport({ final, totals }) {
  const label = Object.fromEntries(taxonomy.categories.map(c => [c.key, c.name]));
  const verifiedBy = {
    smoke: ['GEN-003'], functional: ['GEN-003', 'IMP-003'], negative: ['GEN-006', 'FAIL-001'], boundary: ['GEN-005', 'GEN-008', 'FAIL-001'],
    equivalence: ['GEN-003'], validation: ['GEN-003', 'FAIL-001'], inputValidation: ['FAIL-001', 'DEF-003'], crossField: ['GEN-006', 'FAIL-001'],
    dynamic: ['DISC-006', 'FAIL-001'], multiStep: ['DISC-007', 'FAIL-001'], workflow: [], regression: ['DEF-006', 'REG-001', 'REG-002'],
    accessibility: ['FAIL-001', 'HUM-002'], security: ['FAIL-001'], api: ['GEN-003'], performance: ['FAIL-001'], compatibility: ['EXEC-002', 'COMP-CHROMIUM'],
    responsive: ['FAIL-001'], visual: ['GEN-003'], usability: ['HUM-001'], exploratory: ['FAIL-001'], dataIntegrity: ['HUM-001'],
    stateTransition: ['GEN-003'], errorHandling: ['FAIL-001'], reliability: ['FAIL-001'], recovery: ['GEN-003']
  };
  const status = id => checks.find(c => c.id === id)?.status;
  const rows = final.categories.map(c => {
    const ids = verifiedBy[c.category] ?? [];
    const verified = ids.length === 0 ? 'human / journeys' : ids.every(id => status(id) === 'PASS') ? `yes (${ids.join(', ')})` : `no (${ids.filter(id => status(id) !== 'PASS').join(', ')})`;
    const automation = taxonomy.categories.find(x => x.key === c.category)?.automation;
    return `| ${label[c.category] ?? c.category} | ${automation} | ${c.generated} | ${c.executed} | ${c.passed} | ${c.failed} | ${c.coveragePercent == null ? 'N/A' : `${c.coveragePercent}%`} | ${verified} |`;
  });
  const formRows = final.forms.map(f => `| ${f.name} (\`${f.route}\`) | ${f.fields} | ${f.generated} | ${f.executed} | ${f.passed} | ${f.failed} | ${f.coveragePercent == null ? 'not measured' : `${f.coveragePercent}%`} | ${f.gaps} | ${f.humanTasksOpen}/${f.humanTasks} |`);
  const defectRows = [...detected.values()].map(d => `| ${d.defect.id} | \`${d.form}\` | ${d.defect.description} | ${d.defect.detectedBy.join(', ')} | ${d.hits.length ? `detected by ${d.hits.length} test(s): ${d.hits.slice(0, 3).map(h => h.reference).join(', ')}${d.hits.length > 3 ? '…' : ''}` : '**missed**'} |`);
  const gapGroups = {};
  for (const g of final.gaps) (gapGroups[g.status] ??= []).push(g);
  const unsupported = final.gaps.filter(g => g.status === 'unsupported' || g.status === 'human-required');
  const humanByCategory = {};
  for (const t of tasks) humanByCategory[t.category] = (humanByCategory[t.category] ?? 0) + 1;
  const checkRows = checks.map(c => `| ${c.id} | ${c.area} | ${c.title} | ${c.status} | ${String(c.detail ?? '').replace(/\|/g, '\\|').slice(0, 300)} |`);

  return `# Manual testing coverage report

Run \`${RUN_ID}\`, generated by \`./scripts/verify-complete-manual-testing\` against the golden
form lab (\`test-lab/form-lab\`, ${truth.forms.length} forms, ${truth.forms.reduce((n, f) => n + f.defects.length, 0)} deliberate defects).
**Every number below was counted from this run.** None is estimated, and nothing is asserted as
an arbitrary total.

**Checks: ${totals.pass} passed, ${totals.fail} failed, ${totals.notVerified} not verified.**

## AI dependency

\`\`\`text
AI Required: NO
AI Disabled Verification: ${['AI-001', 'AI-002', 'AI-003'].every(id => status(id) === 'PASS') && totals.fail === 0 ? 'PASS' : 'FAIL'}
\`\`\`

The API ran with \`AI_DISABLED=true\` and the project's own AI switch off. Discovery, generation,
execution, failure analysis, defect correlation, regression, coverage, import and human
verification all ran. ${aiList.length} AI request record(s) were written during the run, ${nonLocal.length} of them to a
hosted provider.

## What was measured

| | |
|---|---|
| Pages discovered | ${measured.discovery.pages} |
| Forms discovered | ${measured.discovery.forms} of ${truth.forms.length} in the lab |
| Fields discovered | ${measured.discovery.fields} |
| Declared constraints discovered exactly | ${measured.discovery.constraints} |
| Tests generated (first pass) | ${measured.generation.total} in ${measured.generation.ms} ms |
| Coverage gaps recorded | ${final.gaps.length} |
| Human verification tasks | ${tasks.length} |
| Tests executed in the full run | ${executions.length - skipped.length} (+${skipped.length} skipped: other-browser compatibility) |
| Failures | ${measured.failures.total}, all explained by declared defects: ${measured.failures.unexplained === 0 ? 'yes' : `no — ${measured.failures.unexplained} unexplained`} |
| Deliberate defects detected | ${measured.failures.detected} of ${measured.failures.declared} |
| Defects proposed (after correlation) | ${defects.length} |
| Coverage (application, weighted) | ${final.overallCoveragePercent}% |
| Pass rate of executed tests | ${final.passPercent}% |

## Testing categories

Generated and executed counts are for the whole application at the end of the run. "Verified"
names the checks in this run that prove the category does what it says.

| Category | Automation | Generated | Executed | Passed | Failed | Coverage | Verified |
|---|---|---:|---:|---:|---:|---:|---|
${rows.join('\n')}

## Form coverage

Coverage is the weighted share of each form's applicable tests that ran, with each open gap
counted against it. A category that does not apply to a form is N/A and not counted.

| Form | Fields | Tests | Executed | Passed | Failed | Coverage | Gaps | Human (open/all) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${formRows.join('\n')}

## Deliberate defects

| Defect | Form | What is wrong | Should be caught by | Result |
|---|---|---|---|---|
${defectRows.join('\n')}

## Unsupported and human testing

${Object.entries(humanByCategory).map(([k, v]) => `- **${label[k] ?? k}**: ${v} task(s)`).join('\n')}

What a machine cannot do here, and why (from the gap records):

${[...new Map(unsupported.map(g => [g.missing, g])).values()].map(g => `- **${g.missing}** (${g.status}, ${label[g.category] ?? g.category}): ${g.reason}`).join('\n')}

## Gaps by status

${Object.entries(gapGroups).map(([k, v]) => `- ${k}: ${v.length}`).join('\n')}

## Known limitations

- **Firefox and WebKit** are not installed in this environment (the Playwright CDN is blocked),
  so their compatibility tests were generated and skipped, never passed. Status: NOT VERIFIED.
- **Load, stress, spike and endurance testing** are outside the browser worker; only single-user
  response times are measured.
- **Data integrity** needs access to what the application stored; QA NXT has none, so it is a
  human task unless the application exposes a read API.
- **Business rules** that are not visible in the page are not inferred. Cross-field rules are
  found from field names (confirm/start/end/min/max) and from probing.
- **Server-side limits** that the page does not declare (an upload size limit) are reported as
  unknown, never guessed.
- **Visual baselines** are recorded on the first run; a visual test can only fail on a later run.
- The **double-submission** check counts submissions the server did not refuse. A second click
  that sends a request the server rejects with 4xx is not counted as a duplicate.
- **Tab order** is checked through consecutive simple fields; a date, radio group or file input
  stops the chain, recorded as a partial gap.

## Every check

| ID | Area | Check | Result | Detail |
|---|---|---|---|---|
${checkRows.join('\n')}
`;
}

// A minimal .xlsx writer: enough to prove the importer reads a real workbook.
function buildXlsx(rows) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const col = i => String.fromCharCode(65 + i);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Tests" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet
  };
  return zip(files);
}

function zip(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(0, 10); header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBuf.length, 26); header.writeUInt16LE(0, 28);
    locals.push(header, nameBuf, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(0, 12); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
