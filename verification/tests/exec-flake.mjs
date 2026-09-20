/** Cross-browser execution and instability detection, against a worker that has all three engines. */
import { check, newTenant, request, resetScenario, saveEvidence, scenario, sleep, suite, waitForRun } from './harness.mjs';
suite('execution and instability');
await resetScenario();

const tenant = await newTenant('Exec');
const project = await request('/api/v1/projects', { token: tenant.token, method: 'POST',
  body: { name: 'Exec', key: `E${Math.random().toString(36).slice(2,8).toUpperCase()}` } });
const projectId = project.json.id;
const app = await request('/api/v1/applications', { token: tenant.token, method: 'POST',
  body: { projectId, name: 'Demo Bank', baseUrl: 'http://localhost:4200/dashboard',
    allowedDomains: 'localhost', authStrategy: 'formLogin', loginUrl: 'http://localhost:4200/login',
    credentials: { username: 'alice', password: 'Password123!' } } });

const steps = (extra = []) => [
  { order: 1, action: 'navigate', description: 'open', url: 'http://localhost:4200/login', timestampMs: 1 },
  { order: 2, action: 'fill', description: 'user', target: { strategy: 'testId', value: 'username', exact: false, fallbacks: [] }, value: 'alice', url: 'http://localhost:4200/login', timestampMs: 1 },
  { order: 3, action: 'fill', description: 'pass', target: { strategy: 'testId', value: 'password', exact: false, fallbacks: [] }, value: '${secret:app_password}', url: 'http://localhost:4200/login', timestampMs: 1 },
  { order: 4, action: 'click', description: 'sign in', target: { strategy: 'testId', value: 'login-submit', exact: false, fallbacks: [] }, url: 'http://localhost:4200/login', timestampMs: 1 },
  ...extra
];
const importJourney = (name, s) => request('/api/v1/journeys/import', { token: tenant.token, method: 'POST',
  body: { projectId, applicationId: app.json.id, journey: { schemaVersion: 1, name,
    startUrl: 'http://localhost:4200/login', recordedAt: new Date().toISOString(),
    recorderVersion: '0.1.0', steps: s } } });

const dashboard = await importJourney('Dashboard', steps([
  { order: 5, action: 'assertVisible', description: 'dashboard', target: { strategy: 'testId', value: 'nav-dashboard', exact: false, fallbacks: [] }, url: 'http://localhost:4200/dashboard', timestampMs: 1 }
]));

await check('EXEC-001', 'The same test executes on Chromium, Firefox and WebKit', async () => {
  const engines = ['chromium', 'firefox', 'webkit'];
  const results = {};
  for (const browser of engines) {
    const started = await request('/api/v1/testruns', { token: tenant.token, method: 'POST',
      body: { projectId, testCaseIds: [dashboard.json.testCaseId], name: `EXEC ${browser}`, browser, headless: true } });
    const finished = started.ok ? await waitForRun(tenant.token, started.json.id, 300_000) : null;
    const execs = finished ? (await request(`/api/v1/testruns/${finished.id}/executions`, { token: tenant.token })).json : [];
    results[browser] = { status: finished?.status, recordedBrowser: execs?.[0]?.browser,
                         version: execs?.[0]?.browserVersion, durationMs: finished?.durationMs };
  }
  const path = saveEvidence('reports/EXEC-001-browsers.json', results);
  const wrong = engines.filter(e => results[e]?.status !== 'passed' || results[e]?.recordedBrowser !== e);
  return { pass: wrong.length === 0,
    detail: engines.map(e => `${e} ${results[e]?.status} v${results[e]?.version} ${results[e]?.durationMs}ms`).join('; '),
    evidence: [path] };
});

await check('FLAKE-001', 'A genuinely unstable application yields unstable results', async () => {
  const flaky = await importJourney('Flaky transactions', steps([
    { order: 5, action: 'click', description: 'open account', target: { strategy: 'testId', value: 'open-account-acc-1001', exact: false, fallbacks: [] }, url: 'http://localhost:4200/dashboard', timestampMs: 1 },
    { order: 6, action: 'assertVisible', description: 'transactions', target: { strategy: 'testId', value: 'transactions-table', exact: false, fallbacks: [] }, url: 'http://localhost:4200/accounts/acc-1001', timestampMs: 1 }
  ]));

  await scenario({ flakyTransactions: true });
  await sleep(400);
  const results = [];
  for (let attempt = 1; attempt <= 20; attempt++) {
    const started = await request('/api/v1/testruns', { token: tenant.token, method: 'POST',
      body: { projectId, testCaseIds: [flaky.json.testCaseId], name: `FLAKE ${attempt}`, headless: true } });
    const finished = started.ok ? await waitForRun(tenant.token, started.json.id, 180_000) : null;
    results.push({ attempt, status: finished?.status ?? 'unresolved', durationMs: finished?.durationMs });
  }
  await resetScenario();

  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const path = saveEvidence('reports/FLAKE-001-twenty-runs.json',
    { switch: 'flakyTransactions', delaysMs: [150, 600, 2500, 20000], runs: results,
      passed, failed, passRatePercent: Math.round((passed / results.length) * 100) });
  return { pass: passed > 0 && failed > 0,
    detail: `${passed} passed, ${failed} failed of ${results.length} (${Math.round(passed/results.length*100)}% pass rate) — the platform reports the variance rather than smoothing it`,
    evidence: [path] };
});
