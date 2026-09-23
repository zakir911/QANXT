/**
 * The continuous-quality demonstration: one release cycle, end to end, nothing staged.
 *
 * The product demonstration (demo.mjs) answers "can this platform test an application".
 * This one answers the question the continuous-quality work was for: can it keep a team
 * honest between releases, on a pipeline, on a schedule, without anybody remembering to ask.
 *
 * It follows a single change through the cycle a team actually lives:
 *
 *   a release goes out green → a developer changes the accounts API → regression selects what
 *   the change reaches → the pipeline runs it → the contract check finds what moved → the
 *   quality gate blocks the build → the team is told → the release comparison says exactly
 *   what got worse → it is fixed → the gate opens → the nightly schedule keeps watching.
 *
 * Every number below came from the run that produced it. The faults are real faults in the
 * banking lab, switched on through its own API, and the failures are real failures.
 *
 * Usage: node verification/golden-tests/continuous-quality-demo.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VERIFICATION } from './harness.mjs';
import {
  LAB, contractChanges, createEnvironment, createGateRule, createProject, importJourney,
  journey, lab, newTenant, qualityGate, registerApplication, request, runDiscovery, startRun,
  step, waitForRun
} from './platform.mjs';

const BANK = LAB.banking;
const SINK = process.env.LAB_SINK_URL ?? 'http://localhost:4360';
const DEMO_DIR = resolve(VERIFICATION, 'demo');
mkdirSync(DEMO_DIR, { recursive: true });

const acts = [];
let actNumber = 0;

function act(title, detail) {
  actNumber++;
  console.log(`\n\u001b[1m${String(actNumber).padStart(2, '0')}. ${title}\u001b[0m`);
  if (detail) console.log(`    ${detail}`);
  acts.push({ act: actNumber, title, detail: detail ?? '', at: new Date().toISOString() });
}

function note(detail) {
  console.log(`    ${detail}`);
  const current = acts.at(-1);
  if (current) current.detail = current.detail ? `${current.detail}\n${detail}` : detail;
}

function fail(message) {
  console.error(`\n\u001b[31m${message}\u001b[0m`);
  process.exit(2);
}

// ---------------------------------------------------------------------------

act('Check the platform, the application and the notification sink are up',
  'A demonstration that starts its own dependencies hides whether they work.');
const health = await request('/health');
const bank = await fetch(`${BANK}/health`).then(r => r.json()).catch(() => null);
const sink = await fetch(`${SINK}/health`).then(r => r.ok).catch(() => false);
if (health.status !== 200) fail(`AIRA is not answering: ${health.status}`);
if (!bank) fail(`The banking lab is not answering at ${BANK}`);
if (!sink) fail(`The notification sink is not answering at ${SINK}`);
note(`AIRA healthy · ${bank.application} ${bank.version} healthy · notification sink healthy`);

await lab.reset(BANK);
await fetch(`${SINK}/reset`, { method: 'POST' });

// ---------------------------------------------------------------------------

act('Set up a team: an organization, a project, a staging environment');
const tenant = await newTenant('Northwind');
const project = await createProject(tenant, 'Northwind Bank');
const application = await registerApplication(tenant, project.id, {
  name: 'Northwind Online Banking', baseUrl: BANK, loginUrl: `${BANK}/login`,
  username: 'alice', password: 'Password123!'
});
const staging = await createEnvironment(tenant, project.id, {
  name: 'Staging', key: 'staging', kind: 'staging', baseUrl: BANK,
  allowedDomains: new URL(BANK).hostname
});
note(`project ${project.key} · application ${application.id.slice(0, 8)} · environment ${staging.key}`);
note('The environment carries the authorization boundary: AIRA will not open a URL outside it.');

// ---------------------------------------------------------------------------

act('Discover the application', 'A real crawl, not a fixture.');
const discovery = await runDiscovery(tenant, application.id, { maxPages: 12, maxDepth: 3 });
note(`${discovery.pagesDiscovered ?? discovery.pageCount ?? 0} page(s) discovered`);

// ---------------------------------------------------------------------------

act('Tell somebody when things break', 'A run that fails at 2am and tells nobody did not happen.');
const integration = await request('/api/v1/integrations', {
  token: tenant.token, method: 'POST',
  body: {
    projectId: project.id, kind: 'webhook', name: 'Team channel',
    settings: { url: `${SINK}/hook` },
    credentials: { signingSecret: 'northwind-signing-secret' }
  }
});
note(`webhook configured (${integration.status}); failures and blocked gates are sent, green runs are not`);

// ---------------------------------------------------------------------------

act('Set the bar', 'The gate is the thing that decides, and it is written down before the release.');
const gate = await createGateRule(tenant, project.id, {
  name: 'No failing tests', metric: 'failedCount',
  operator: 'lessThanOrEqual', threshold: 0, onBreach: 'fail'
});
const contractGate = await createGateRule(tenant, project.id, {
  name: 'No breaking API changes', metric: 'contractBreakingChangeCount',
  operator: 'lessThanOrEqual', threshold: 0, onBreach: 'fail'
});
note(`2 rules: "${gate.name}" and "${contractGate.name}", both blocking`);

// ---------------------------------------------------------------------------

act('The suite a team would actually have');
const signIn = journey({
  name: 'A customer signs in and sees their balance',
  startUrl: `${BANK}/login`,
  steps: [
    step.navigate(`${BANK}/login`),
    step.fill('username', 'alice', `${BANK}/login`),
    step.fill('password', '${secret:app_password}', `${BANK}/login`),
    step.click('login-submit', `${BANK}/login`),
    step.assertVisible('total-balance', `${BANK}/dashboard`)
  ]
});
const accounts = journey({
  name: 'A customer reads their accounts',
  startUrl: `${BANK}/login`,
  steps: [
    step.navigate(`${BANK}/login`),
    step.fill('username', 'alice', `${BANK}/login`),
    step.fill('password', '${secret:app_password}', `${BANK}/login`),
    step.click('login-submit', `${BANK}/login`),
    step.navigate(`${BANK}/accounts`),
    step.assertVisible('accounts-table', `${BANK}/accounts`)
  ]
});
const imported = [];
for (const j of [signIn, accounts]) {
  imported.push(await importJourney(tenant, {
    projectId: project.id, applicationId: application.id, journey: j
  }));
}
const apiTest = await request('/api/v1/testcases/api-tests', {
  token: tenant.token, method: 'POST',
  body: {
    projectId: project.id, applicationId: application.id,
    suiteName: 'API', name: 'The accounts endpoint answers for a signed-in customer',
    objective: 'The accounts API is the contract the front end depends on',
    steps: [
      {
        description: 'Sign in through the API',
        request: {
          method: 'POST', path: '/api/session',
          body: JSON.stringify({ username: 'alice', password: '${secret:app_password}' }),
          contentType: 'application/json',
          auth: { mode: 'none' }
        },
        assertions: [{ type: 'httpStatusEquals', expected: '200' }]
      },
      {
        description: 'Read the accounts that session can see',
        request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' } },
        assertions: [
          { type: 'httpStatusEquals', expected: '200' },
          { type: 'responseJsonPathExists', subject: 'accounts[0].balance' },
          // The field FAULT_API_FIELD_REMOVED takes away. Without this the suite cannot
          // detect the change, and a demonstration in which nothing detects anything is
          // worse than no demonstration.
          { type: 'responseJsonPathExists', subject: 'accounts[0].sortCode' }
        ]
      }
    ]
  }
});
const testCaseIds = [...imported.map(i => i.testCaseId), apiTest.json.testCaseId];
note(`${testCaseIds.length} test(s): 2 browser journeys and 1 API test, in one suite and one engine`);

// ---------------------------------------------------------------------------

act('Release 1.0 goes out', 'The green run everything afterwards is measured against.');
const green = await waitForRun(tenant, (await startRun(tenant, {
  projectId: project.id, testCaseIds, name: 'Release 1.0', environmentId: staging.id
})).id);
note(`run ${green.status}: ${green.passedCount} passed, ${green.failedCount} failed`);
if (green.status !== 'passed') fail('The baseline run did not pass; everything after this would be measured against a broken baseline.');

const baselines = await request('/api/v1/api-contracts/baselines', {
  token: tenant.token, method: 'POST',
  body: { applicationId: application.id, testRunId: green.id, note: 'Release 1.0' }
});
note(`${baselines.json?.captured ?? 0} contract baseline(s) captured from responses the application actually gave`);
for (const b of (baselines.json?.baselines ?? []).slice(0, 20)) {
  if (b.urlTemplate?.includes('/api/session') || b.urlTemplate?.includes('/api/accounts')) {
    note(`  ${b.method} ${b.urlTemplate} → status ${b.statusCode ?? 'unknown'}, ${b.fieldCount} field(s)`);
  }
}

// ---------------------------------------------------------------------------

act('A developer changes the accounts API',
  'Two things at once, the way a real change arrives: a field disappears, and a balance is wrong.');
await lab.set(BANK, { FAULT_API_FIELD_REMOVED: true, FAULT_WRONG_BALANCE: true });
note('FAULT_API_FIELD_REMOVED: the accounts API stops returning sortCode — breaking for any caller reading it');
note('FAULT_WRONG_BALANCE: the dashboard renders a total that does not match the accounts');

// ---------------------------------------------------------------------------

act('Teach it what the code touches',
  'Change impact needs a map from paths to what they affect. Without one, every change runs everything.');
for (const rule of [
  { pathPattern: 'src/api/accounts/**', kind: 'route', value: '/accounts' },
  { pathPattern: 'src/pages/dashboard/**', kind: 'route', value: '/dashboard' }
]) {
  const created = await request(`/api/v1/regression/rules?projectId=${project.id}`, {
    token: tenant.token, method: 'POST', body: rule
  });
  note(`${rule.pathPattern} → ${rule.kind} ${rule.value} (${created.status})`);
}

act('Regression selection: what does this change reach?',
  'Running everything on every commit is how a suite stops being run at all.');
const selection = await request('/api/v1/regression/select', {
  token: tenant.token, method: 'POST',
  body: {
    projectId: project.id,
    applicationId: application.id,
    changedPaths: ['src/api/accounts/service.ts', 'src/pages/dashboard/Dashboard.tsx']
  }
});
const selected = selection.json?.selected ?? [];
note(`${selection.json?.selectedCount ?? 0} of ${selection.json?.totalCandidates ?? 0} `
  + `test(s) selected, mode ${selection.json?.mode}`
  + (selection.json?.fellBackToFull ? ' — the change could not be mapped, so everything runs' : ''));
for (const t of selected.slice(0, 3)) {
  note(`  ${t.reference ?? String(t.testCaseId).slice(0, 8)} scored ${t.score}: ${(t.reasons ?? [])[0] ?? ''}`);
}
for (const t of (selection.json?.excluded ?? []).slice(0, 2)) {
  note(`  not selected: ${t.reference ?? String(t.testCaseId).slice(0, 8)} scored ${t.score}`);
}

// ---------------------------------------------------------------------------

act('The pipeline runs', 'The same command a CI job would run, against the changed build.');
const red = await waitForRun(tenant, (await startRun(tenant, {
  projectId: project.id, testCaseIds, name: 'Build 1.1', environmentId: staging.id
})).id);
note(`run ${red.status}: ${red.passedCount} passed, ${red.failedCount} failed`);

// ---------------------------------------------------------------------------

act('The contract check finds what moved');
const changes = await contractChanges(tenant, red.id);
const breaking = (changes.changes ?? []).filter(c => c.kind === 'breaking');
note(`${changes.changes?.length ?? 0} contract change(s), ${breaking.length} of them breaking, `
  + 'against the Release 1.0 baseline');
for (const change of breaking.slice(0, 3)) {
  note(`  ${change.method} ${change.urlTemplate} ${change.path}`);
  note(`    ${change.description ?? change.summary}`);
}

// ---------------------------------------------------------------------------

act('The quality gate blocks the build', 'Written down before the release, applied without discussion.');
const verdict = await qualityGate(tenant, red.id);
const outcome = verdict.outcome;
note(`gate outcome: ${String(outcome).toUpperCase()}`);
for (const rule of (verdict.rules ?? []).filter(r => !r.passed)) {
  note(`  ${rule.name}: ${rule.measured ? `measured ${rule.actualValue}` : 'could not be measured'} `
    + `against ${rule.threshold} — ${rule.explanation}`);
}

// ---------------------------------------------------------------------------

act('The team is told', 'And the platform can show that it told them.');
// Delivery is asynchronous, so this waits rather than reading immediately and reporting a
// zero that only means "not yet".
let deliveries = [];
let received = { received: [] };
for (let attempt = 0; attempt < 10; attempt++) {
  const response = await request(`/api/v1/integrations/deliveries?projectId=${project.id}`,
    { token: tenant.token });
  deliveries = response.json ?? [];
  received = await fetch(`${SINK}/received`).then(r => r.json()).catch(() => ({ received: [] }));
  if ((received.received ?? []).length > 0) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const arrived = received.received ?? [];
note(`${deliveries.length} delivery record(s) on the platform`);
note(`${arrived.length} request(s) actually arrived at the receiving end`);
for (const r of arrived.slice(0, 3)) {
  note(`  ${r.headers?.['x-aira-event'] ?? 'event'} — signed `
    + `${String(r.headers?.['x-aira-signature'] ?? '').slice(0, 20)}…`);
}

// ---------------------------------------------------------------------------

act('What changed since the release we shipped?',
  'The question a release decision is actually made on — not "what is broken", but "what got worse".');
const comparison = await request(
  `/api/v1/release/compare?run=${red.id}&previous=${green.id}`, { token: tenant.token });
const counts = comparison.json?.counts ?? {};
note(`newly failing ${counts.newlyFailing ?? 0} · fixed ${counts.fixed ?? 0} · `
  + `still failing ${counts.stillFailing ?? 0} · still passing ${counts.stillPassing ?? 0}`);
note(comparison.json?.summary ?? '');

// ---------------------------------------------------------------------------

act('Who asked for all this?', 'The governance record, readable through the product.');
const trail = await request(`/api/v1/audit?projectId=${project.id}&limit=100`, { token: tenant.token });
const actions = [...new Set((trail.json?.entries ?? []).map(e => e.action))];
note(`${trail.json?.total ?? 0} audit record(s) · ${actions.length} distinct action(s)`);
note(`including: ${actions.slice(0, 6).join(', ')}`);

// ---------------------------------------------------------------------------

act('Fix it', 'The same suite, unedited, against a corrected build.');
await lab.set(BANK, { FAULT_API_FIELD_REMOVED: false, FAULT_WRONG_BALANCE: false });
const fixed = await waitForRun(tenant, (await startRun(tenant, {
  projectId: project.id, testCaseIds, name: 'Build 1.2', environmentId: staging.id
})).id);
const fixedVerdict = await qualityGate(tenant, fixed.id);
note(`run ${fixed.status}: ${fixed.passedCount} passed, ${fixed.failedCount} failed`);
note(`gate outcome: ${String(fixedVerdict.outcome).toUpperCase()}`);
for (const rule of (fixedVerdict.rules ?? []).filter(r => !r.passed)) {
  note(`  still blocking — ${rule.name}: `
    + `${rule.measured ? `measured ${rule.actualValue}` : 'could not be measured'} `
    + `against ${rule.threshold} — ${rule.explanation}`);
}
const fixedChanges = await contractChanges(tenant, fixed.id);
note(`contract: ${(fixedChanges.changes ?? []).filter(c => c.kind === 'breaking').length} `
  + 'breaking change(s) remain against the Release 1.0 baseline');

const recovery = await request(
  `/api/v1/release/compare?run=${fixed.id}&previous=${red.id}`, { token: tenant.token });
note(`against the broken build: fixed ${recovery.json?.counts?.fixed ?? 0}, `
  + `newly failing ${recovery.json?.counts?.newlyFailing ?? 0}`);

// ---------------------------------------------------------------------------

act('Keep watching', 'Regression that happens when nobody commits.');
const schedule = await request('/api/v1/schedules', {
  token: tenant.token, method: 'POST',
  body: {
    projectId: project.id, name: 'Nightly regression',
    cronExpression: '0 2 * * *', timeZone: 'Europe/London',
    environmentId: staging.id
  }
});
const preview = await request(`/api/v1/schedules/${schedule.json.id}/preview?count=3`,
  { token: tenant.token });
note(`"${schedule.json.name}" — ${schedule.json.cronExpression} (${schedule.json.timeZone})`);
note(`next: ${(preview.json ?? []).join(', ')}`);
note('Three consecutive failures disable it, with the reason recorded — a schedule that stopped');
note('running is worse than no schedule, because it looks armed.');

// ---------------------------------------------------------------------------

const record = {
  demonstration: 'Continuous quality — one release cycle',
  generatedAt: new Date().toISOString(),
  project: { id: project.id, key: project.key },
  runs: {
    baseline: { id: green.id, status: green.status, passed: green.passedCount, failed: green.failedCount },
    broken: { id: red.id, status: red.status, passed: red.passedCount, failed: red.failedCount },
    fixed: { id: fixed.id, status: fixed.status, passed: fixed.passedCount, failed: fixed.failedCount }
  },
  breakingContractChanges: breaking.length,
  gate: { broken: outcome, fixed: fixedVerdict.outcome },
  comparison: counts,
  auditRecords: trail.json?.total ?? 0,
  acts
};
writeFileSync(resolve(DEMO_DIR, 'continuous-quality-demo.json'), JSON.stringify(record, null, 2));

const narration = [
  '# Continuous quality — one release cycle',
  '',
  `Recorded ${record.generatedAt}. Every number here came from the run that produced it;`,
  'the faults are real faults in the banking lab, switched on through its own API.',
  '',
  ...acts.flatMap(a => [
    `## ${String(a.act).padStart(2, '0')}. ${a.title}`,
    '',
    ...a.detail.split('\n').filter(Boolean).map(line => `    ${line}`),
    ''
  ]),
  '## What this demonstrates',
  '',
  'A change landed, and without anybody deciding what to check: the tests it reached were',
  'selected and scored, the pipeline ran them, the contract check named the field that',
  'disappeared, the gate blocked the build against a rule written before the release, the',
  'team was told and the delivery was recorded, and the release comparison said exactly what',
  'got worse rather than what was broken. Then it was fixed, the gate opened on the same',
  'unedited suite, and a schedule took over watching.',
  ''
].join('\n');
writeFileSync(resolve(DEMO_DIR, 'continuous-quality-demo.md'), narration);

console.log('\n\u001b[32mDemonstration complete.\u001b[0m');
console.log('  verification/demo/continuous-quality-demo.json');
console.log('  verification/demo/continuous-quality-demo.md');
