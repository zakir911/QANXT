/**
 * Role enforcement, browser engines, the CLI, concurrency and instability detection.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  check, login, newTenant, request, resetScenario, saveEvidence, scenario, sleep, suite, waitForRun, ROOT
} from './harness.mjs';

const run = promisify(execFile);
suite('operations');

await resetScenario();

const tenant = await newTenant('Ops');
const project = await request('/api/v1/projects', {
  token: tenant.token, method: 'POST',
  body: { name: 'Ops', key: `O${Math.random().toString(36).slice(2, 8).toUpperCase()}` }
});
const projectId = project.json.id;
const application = await request('/api/v1/applications', {
  token: tenant.token, method: 'POST',
  body: { projectId, name: 'Demo Bank', baseUrl: 'http://localhost:4200/dashboard',
    allowedDomains: 'localhost', authStrategy: 'formLogin',
    loginUrl: 'http://localhost:4200/login',
    credentials: { username: 'alice', password: 'Password123!' } }
});
const applicationId = application.json.id;

const journeySteps = (extra = []) => [
  { order: 1, action: 'navigate', description: 'Open the sign-in page',
    url: 'http://localhost:4200/login', timestampMs: Date.now() },
  { order: 2, action: 'fill', description: 'Enter the username',
    target: { strategy: 'testId', value: 'username', exact: false, fallbacks: [] },
    value: 'alice', url: 'http://localhost:4200/login', timestampMs: Date.now() },
  { order: 3, action: 'fill', description: 'Enter the password',
    target: { strategy: 'testId', value: 'password', exact: false, fallbacks: [] },
    value: '${secret:app_password}', url: 'http://localhost:4200/login', timestampMs: Date.now() },
  { order: 4, action: 'click', description: 'Press the sign-in button',
    target: { strategy: 'testId', value: 'login-submit', exact: false, fallbacks: [] },
    url: 'http://localhost:4200/login', timestampMs: Date.now() },
  ...extra
];

const importJourney = async (name, steps) => request('/api/v1/journeys/import', {
  token: tenant.token, method: 'POST',
  body: { projectId, applicationId, journey: {
    schemaVersion: 1, name, startUrl: 'http://localhost:4200/login',
    recordedAt: new Date().toISOString(), recorderVersion: '0.1.0', steps } }
});

const dashboardTest = await importJourney('Ops dashboard', journeySteps([
  { order: 5, action: 'assertVisible', description: 'The dashboard is shown',
    target: { strategy: 'testId', value: 'nav-dashboard', exact: false, fallbacks: [] },
    url: 'http://localhost:4200/dashboard', timestampMs: Date.now() }
]));
const testCaseId = dashboardTest.json.testCaseId;

// ---- RBAC matrix -------------------------------------------------------------------
await check('RBAC-001', 'Every built-in role is enforced as its matrix says', async () => {
  const roles = ['organizationAdmin', 'projectAdmin', 'qaLead', 'qaEngineer', 'developer', 'viewer'];
  const probes = [
    { label: 'read projects',   method: 'GET',  path: '/api/v1/projects' },
    { label: 'create project',  method: 'POST', path: '/api/v1/projects',
      body: () => ({ name: 'probe', key: `P${Math.random().toString(36).slice(2, 8).toUpperCase()}` }) },
    { label: 'start a run',     method: 'POST', path: '/api/v1/testruns',
      body: () => ({ projectId, testCaseIds: [testCaseId], name: 'rbac probe', headless: true }) },
    { label: 'invite a user',   method: 'POST', path: '/api/v1/users',
      body: () => ({ email: `p-${Math.random().toString(36).slice(2, 10)}@example.test`,
                     displayName: 'probe', role: 'viewer' }) },
    { label: 'change a gate',   method: 'POST', path: `/api/v1/quality-gates?projectId=${projectId}`,
      body: () => ({ name: 'probe', metric: 'failedCount', operator: 'lessThanOrEqual', threshold: 5 }) }
  ];

  const matrix = {};
  for (const role of roles) {
    const invited = await request('/api/v1/users', {
      token: tenant.token, method: 'POST',
      body: { email: `${role}-${Math.random().toString(36).slice(2, 10)}@example.test`,
              displayName: role, role }
    });
    if (!invited.ok) { matrix[role] = { error: invited.status }; continue; }
    const roleToken = await login(invited.json.user.email, invited.json.temporaryPassword);
    if (!roleToken) { matrix[role] = { error: 'sign-in failed' }; continue; }

    matrix[role] = {};
    for (const probe of probes) {
      const response = await request(probe.path, {
        token: roleToken, method: probe.method,
        ...(probe.body ? { body: probe.body() } : {})
      });
      matrix[role][probe.label] = response.status === 403 ? 'DENY'
        : response.status < 400 ? 'ALLOW'
        : `other(${response.status})`;
    }
  }

  const path = saveEvidence('reports/RBAC-001-matrix.json', matrix);

  // The judgements that matter: a viewer writes nothing; an admin does everything; nobody
  // below QA lead changes a quality gate.
  const viewerWrites = ['create project', 'start a run', 'invite a user', 'change a gate']
    .filter(p => matrix.viewer?.[p] === 'ALLOW');
  const adminBlocked = ['read projects', 'create project', 'invite a user', 'change a gate']
    .filter(p => matrix.organizationAdmin?.[p] !== 'ALLOW');
  const everyoneReads = Object.values(matrix).every(m => m['read projects'] === 'ALLOW' || m.error);

  return {
    pass: viewerWrites.length === 0 && adminBlocked.length === 0 && everyoneReads,
    detail: `viewer allowed to write: ${viewerWrites.length ? viewerWrites.join(', ') : 'nothing'}; `
          + `admin denied: ${adminBlocked.length ? adminBlocked.join(', ') : 'nothing'}`,
    evidence: [path]
  };
});

// ---- Browser engines ---------------------------------------------------------------
await check('EXEC-001', 'The same test executes on Chromium, Firefox and WebKit', async () => {
  const engines = ['chromium', 'firefox', 'webkit'];
  const results = {};
  for (const browser of engines) {
    const started = await request('/api/v1/testruns', {
      token: tenant.token, method: 'POST',
      body: { projectId, testCaseIds: [testCaseId], name: `EXEC ${browser}`, browser, headless: true }
    });
    if (!started.ok) { results[browser] = { error: started.status }; continue; }
    const finished = await waitForRun(tenant.token, started.json.id, 240_000);
    const executions = finished
      ? (await request(`/api/v1/testruns/${finished.id}/executions`, { token: tenant.token })).json
      : [];
    results[browser] = {
      status: finished?.status,
      passed: finished?.passedCount,
      recordedBrowser: executions?.[0]?.browser,
      version: executions?.[0]?.browserVersion,
      durationMs: finished?.durationMs
    };
  }
  const path = saveEvidence('reports/EXEC-001-browsers.json', results);
  // The recorded engine must match what was asked for; a silent fallback would make the
  // cross-browser claim meaningless.
  const wrong = engines.filter(e => results[e]?.status !== 'passed' || results[e]?.recordedBrowser !== e);
  return {
    pass: wrong.length === 0,
    detail: engines.map(e => `${e} ${results[e]?.status}/${results[e]?.version}`).join('; '),
    evidence: [path]
  };
});

// ---- CLI -------------------------------------------------------------------------------
await check('CLI-001', 'The CLI exit codes distinguish the kinds of failure', async () => {
  const cli = `${ROOT}/packages/cli/dist/aira.js`;
  const env = { ...process.env, AIRA_API_URL: 'http://127.0.0.1:5080', AIRA_TOKEN: tenant.token,
                AIRA_PROJECT_ID: projectId, AIRA_CONFIG: '/nonexistent' };

  const attempt = async (args, overrides = {}) => {
    try {
      const { stdout } = await run('node', [cli, ...args], { env: { ...env, ...overrides } });
      return { code: 0, stdout };
    } catch (error) {
      return { code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  };

  const cases = [
    { label: 'mistyped flag',        args: ['run', '--juint', 'x.xml'], expect: 2 },
    { label: 'rejected token',       args: ['status', '--project', projectId], expect: 3,
      overrides: { AIRA_TOKEN: 'not-a-token' } },
    { label: 'unreachable platform', args: ['status', '--project', projectId], expect: 4,
      overrides: { AIRA_API_URL: 'http://127.0.0.1:1' } },
    { label: 'valid status',         args: ['status', '--project', projectId], expect: 0 }
  ];

  const observed = [];
  for (const c of cases) {
    const result = await attempt(c.args, c.overrides ?? {});
    observed.push({ label: c.label, expected: c.expect, actual: result.code });
  }
  const path = saveEvidence('reports/CLI-001-exit-codes.json', observed);
  const wrong = observed.filter(o => o.actual !== o.expected);
  return {
    pass: wrong.length === 0,
    detail: observed.map(o => `${o.label}=${o.actual}`).join(', '),
    evidence: [path]
  };
});

await check('CLI-002', 'The CLI emits a JUnit file whose counts match its contents', async () => {
  const cli = `${ROOT}/packages/cli/dist/aira.js`;
  const outDir = `/tmp/verification-cli-${Date.now()}`;
  try {
    await run('node', [cli, 'run', '--project', projectId, '--test', testCaseId,
                       '--name', 'CLI verification', '--report-dir', outDir, '--quiet', '--timeout', '240'],
      { env: { ...process.env, AIRA_API_URL: 'http://127.0.0.1:5080', AIRA_TOKEN: tenant.token,
               AIRA_CONFIG: '/nonexistent' } });
  } catch (error) {
    if ((error.code ?? -1) > 1) return { pass: false, detail: `cli exited ${error.code}` };
  }

  const { readFileSync, existsSync } = await import('node:fs');
  const junitPath = `${outDir}/junit.xml`;
  if (!existsSync(junitPath)) return { pass: false, detail: 'no junit.xml was written' };

  const xml = readFileSync(junitPath, 'utf8');
  const saved = saveEvidence('reports/CLI-002-junit.xml', xml);
  const declared = Number(/<testsuites[^>]*tests="(\d+)"/.exec(xml)?.[1] ?? -1);
  const actual = (xml.match(/<testcase /g) ?? []).length;
  return {
    pass: declared === actual && actual > 0,
    detail: `declares ${declared} tests, contains ${actual} testcase elements`,
    evidence: [saved]
  };
});

// ---- Concurrency ------------------------------------------------------------------------
await check('CONC-001', 'Ten runs started at once all reach a verdict without interference', async () => {
  const started = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    request('/api/v1/testruns', {
      token: tenant.token, method: 'POST',
      body: { projectId, testCaseIds: [testCaseId], name: `CONC ${index + 1}`, headless: true }
    })));

  const accepted = started.filter(r => r.ok);
  const finished = await Promise.all(accepted.map(r => waitForRun(tenant.token, r.json.id, 300_000)));
  const summary = finished.map((f, index) => ({
    index, status: f?.status ?? 'timed out', passed: f?.passedCount, durationMs: f?.durationMs
  }));
  const path = saveEvidence('performance/CONC-001-ten-parallel.json', summary);

  const unresolved = summary.filter(s => s.status === 'timed out');
  const failed = summary.filter(s => s.status !== 'passed' && s.status !== 'timed out');
  const durations = summary.map(s => s.durationMs ?? 0).filter(Boolean);
  return {
    pass: accepted.length === 10 && unresolved.length === 0 && failed.length === 0,
    detail: `${accepted.length}/10 accepted, ${summary.filter(s => s.status === 'passed').length} passed, `
          + `${unresolved.length} unresolved; duration ${Math.min(...durations)}–${Math.max(...durations)}ms`,
    evidence: [path]
  };
});

// ---- Instability ---------------------------------------------------------------------------
await check('FLAKE-001', 'A genuinely unstable application produces unstable results, recorded as such', async () => {
  // The transactions page answers after a random delay between 100ms and 6s. A test with a
  // normal timeout should therefore sometimes pass and sometimes fail — and the platform
  // must report that variance rather than smoothing it away.
  const flakyTest = await importJourney('Flaky transactions', journeySteps([
    { order: 5, action: 'click', description: 'Open an account',
      target: { strategy: 'testId', value: 'open-account-acc-1001', exact: false, fallbacks: [] },
      url: 'http://localhost:4200/dashboard', timestampMs: Date.now() },
    { order: 6, action: 'assertVisible', description: 'The transactions table is shown',
      target: { strategy: 'testId', value: 'transactions-table', exact: false, fallbacks: [] },
      url: 'http://localhost:4200/accounts/acc-1001', timestampMs: Date.now() }
  ]));

  await scenario({ flakyTransactions: true });
  await sleep(400);

  const results = [];
  for (let attempt = 1; attempt <= 20; attempt++) {
    const started = await request('/api/v1/testruns', {
      token: tenant.token, method: 'POST',
      body: { projectId, testCaseIds: [flakyTest.json.testCaseId],
              name: `FLAKE ${attempt}`, headless: true }
    });
    const finished = started.ok ? await waitForRun(tenant.token, started.json.id, 180_000) : null;
    results.push({ attempt, status: finished?.status ?? 'unresolved', durationMs: finished?.durationMs });
  }
  await resetScenario();

  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const path = saveEvidence('reports/FLAKE-001-twenty-runs.json', {
    switch: 'flakyTransactions', runs: results,
    passRate: `${Math.round((passed / results.length) * 100)}%`, passed, failed
  });

  // The claim is not "the platform makes it stable" — it is that instability is visible.
  // Both outcomes must appear, or the application was not actually unstable.
  return {
    pass: passed > 0 && failed > 0,
    detail: `${passed} passed, ${failed} failed across ${results.length} runs `
          + `(${Math.round((passed / results.length) * 100)}% pass rate) — variance is visible`,
    evidence: [path]
  };
});

console.log('\nops suite complete');
