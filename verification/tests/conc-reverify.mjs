/** BUG-0004/0005 re-verification: ten parallel runs must all reach a verdict. */
import { check, newTenant, request, resetScenario, saveEvidence, suite, waitForRun } from './harness.mjs';
suite('concurrency re-verification');
await resetScenario();

const tenant = await newTenant('Reverify');
const project = await request('/api/v1/projects', { token: tenant.token, method: 'POST',
  body: { name: 'Reverify', key: `R${Math.random().toString(36).slice(2,8).toUpperCase()}` } });
const app = await request('/api/v1/applications', { token: tenant.token, method: 'POST',
  body: { projectId: project.json.id, name: 'Demo Bank', baseUrl: 'http://localhost:4200/dashboard',
    allowedDomains: 'localhost', authStrategy: 'formLogin', loginUrl: 'http://localhost:4200/login',
    credentials: { username: 'alice', password: 'Password123!' } } });

const imported = await request('/api/v1/journeys/import', { token: tenant.token, method: 'POST',
  body: { projectId: project.json.id, applicationId: app.json.id, journey: {
    schemaVersion: 1, name: 'Parallel', startUrl: 'http://localhost:4200/login',
    recordedAt: new Date().toISOString(), recorderVersion: '0.1.0', steps: [
      { order: 1, action: 'navigate', description: 'open', url: 'http://localhost:4200/login', timestampMs: 1 },
      { order: 2, action: 'fill', description: 'user', target: { strategy: 'testId', value: 'username', exact: false, fallbacks: [] }, value: 'alice', url: 'http://localhost:4200/login', timestampMs: 1 },
      { order: 3, action: 'fill', description: 'pass', target: { strategy: 'testId', value: 'password', exact: false, fallbacks: [] }, value: '${secret:app_password}', url: 'http://localhost:4200/login', timestampMs: 1 },
      { order: 4, action: 'click', description: 'sign in', target: { strategy: 'testId', value: 'login-submit', exact: false, fallbacks: [] }, url: 'http://localhost:4200/login', timestampMs: 1 },
      { order: 5, action: 'assertVisible', description: 'dashboard', target: { strategy: 'testId', value: 'nav-dashboard', exact: false, fallbacks: [] }, url: 'http://localhost:4200/dashboard', timestampMs: 1 }
    ] } } });

const startedAt = Date.now();

await check('CONC-001', 'Twenty-five runs started at once all reach a verdict without interference', async () => {
  const started = await Promise.all(Array.from({ length: 25 }, (_, i) =>
    request('/api/v1/testruns', { token: tenant.token, method: 'POST',
      body: { projectId: project.json.id, testCaseIds: [imported.json.testCaseId],
              name: `CONCR25 ${i + 1}`, headless: true } })));
  const accepted = started.filter(r => r.ok);
  const finished = await Promise.all(accepted.map(r => waitForRun(tenant.token, r.json.id, 300_000)));
  const summary = finished.map((f, i) => ({ index: i, status: f?.status ?? 'timed out',
    passed: f?.passedCount, durationMs: f?.durationMs }));
  const path = saveEvidence('performance/CONC-001-reverify.json', summary);
  const unresolved = summary.filter(s => s.status === 'timed out');
  const passed = summary.filter(s => s.status === 'passed');
  const durations = summary.map(s => s.durationMs ?? 0).filter(Boolean);
  return {
    pass: accepted.length === 25 && unresolved.length === 0 && passed.length === 25,
    detail: `${accepted.length}/25 accepted, ${passed.length} passed, ${unresolved.length} unresolved; `
          + `duration ${Math.min(...durations)}–${Math.max(...durations)}ms`,
    evidence: [path]
  };
});

await check('CONC-002', 'No worker request was throttled during the parallel run', async () => {
  // Reads wherever the worker actually logs. A containerised worker writes to Docker, not
  // to the file, and an earlier version of this check read the empty file and passed on
  // finding nothing — a check that cannot fail is not a check, so an empty window is now a
  // failure rather than a pass.
  const { readFileSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');

  let lines = [];
  let source = 'none';

  try {
    const containers = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' })
      .split('\n').filter(n => n.includes('worker'));
    if (containers.length > 0) {
      lines = execFileSync('docker', ['logs', '--since', '10m', containers[0]],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean);
      source = `docker logs ${containers[0]}`;
    }
  } catch { /* fall through to the file */ }

  if (lines.length === 0 && existsSync('/tmp/aira-worker.log')) {
    lines = readFileSync('/tmp/aira-worker.log', 'utf8').split('\n').filter(Boolean);
    source = '/tmp/aira-worker.log';
  }

  const recent = lines.filter(line => {
    const match = /"timestamp":"([^"]+)"/.exec(line);
    return match ? new Date(match[1]).getTime() >= startedAt : false;
  });

  const path = saveEvidence('failures/BUG-0004/logs/after-fix-worker-window.log',
    `source: ${source}\nwindow start: ${new Date(startedAt).toISOString()}\n\n${recent.join('\n')}`);

  if (recent.length === 0) {
    return {
      pass: false,
      detail: `no worker log lines found in the window via ${source} — cannot confirm the absence `
            + 'of throttling, so this is recorded as unproven rather than passed',
      evidence: [path]
    };
  }

  const throttled = recent.filter(l => l.includes('429')).length;
  const dropped = recent.filter(l => l.includes('could not be uploaded and will not be referenced')).length;
  return {
    pass: throttled === 0 && dropped === 0,
    detail: `${recent.length} line(s) from ${source}: ${throttled} throttled, ${dropped} dropped artifact(s)`,
    evidence: [path]
  };
});
