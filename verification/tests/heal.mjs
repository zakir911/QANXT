/**
 * Self-healing verification: positive and negative.
 *
 * The positive case only proves something if the test is not touched between the run that
 * passes and the run that heals — the stored locator must be the one that breaks. The
 * negative case matters more: a healer that always finds *something* is worse than no
 * healer, because it turns a broken application into a green build.
 */
import {
  check, login, newTenant, request, resetScenario, saveEvidence, scenario, sleep, suite, waitForRun
} from './harness.mjs';

suite('self-healing');

await resetScenario();

const tenant = await newTenant('Heal');
const project = await request('/api/v1/projects', {
  token: tenant.token, method: 'POST',
  body: { name: 'Healing', key: `H${Math.random().toString(36).slice(2, 8).toUpperCase()}` }
});
const projectId = project.json.id;

const application = await request('/api/v1/applications', {
  token: tenant.token, method: 'POST',
  body: {
    projectId, name: 'Demo Bank', baseUrl: 'http://localhost:4200/dashboard',
    allowedDomains: 'localhost', authStrategy: 'formLogin',
    loginUrl: 'http://localhost:4200/login',
    credentials: { username: 'alice', password: 'Password123!' }
  }
});
if (!application.ok) throw new Error(`could not register the application: ${application.text.slice(0, 300)}`);
const applicationId = application.json.id;

const suiteResponse = await request('/api/v1/test-suites', {
  token: tenant.token, method: 'POST',
  body: { projectId, name: 'Healing verification' }
});

/**
 * Builds a test whose only interesting step targets the sign-in button by test id.
 *
 * There is no API for authoring a test case (BUG-0002), so it is built as a recorded
 * journey and imported — a real product path that happens to give precise control over the
 * stored locator, which is exactly what a healing test needs.
 */
async function createSignInTest(name, targetTestId) {
  const journey = {
    schemaVersion: 1,
    name,
    startUrl: 'http://localhost:4200/login',
    recordedAt: new Date().toISOString(),
    recorderVersion: '0.1.0',
    steps: [
      { order: 1, action: 'navigate', description: 'Open the sign-in page',
        url: 'http://localhost:4200/login', timestampMs: Date.now() },
      { order: 2, action: 'fill', description: 'Enter the username',
        target: { strategy: 'testId', value: 'username', exact: false, fallbacks: [] },
        value: 'alice', url: 'http://localhost:4200/login', timestampMs: Date.now() },
      { order: 3, action: 'fill', description: 'Enter the password',
        target: { strategy: 'testId', value: 'password', exact: false, fallbacks: [] },
        value: '${secret:app_password}', url: 'http://localhost:4200/login', timestampMs: Date.now() },
      // No fallbacks on purpose: the stored locator must be the thing that breaks, or the
      // test would pass through a fallback and prove nothing about healing.
      { order: 4, action: 'click', description: 'Press the sign-in button',
        target: { strategy: 'testId', value: targetTestId, exact: false, fallbacks: [] },
        url: 'http://localhost:4200/login', timestampMs: Date.now() },
      { order: 5, action: 'assertVisible', description: 'The dashboard is shown',
        target: { strategy: 'testId', value: 'nav-dashboard', exact: false, fallbacks: [] },
        url: 'http://localhost:4200/dashboard', timestampMs: Date.now() }
    ]
  };

  const response = await request('/api/v1/journeys/import', {
    token: tenant.token, method: 'POST',
    body: { projectId, applicationId, journey }
  });
  if (!response.ok) throw new Error(`could not import the journey: ${response.status} ${response.text.slice(0, 300)}`);
  return response.json.testCaseId;
}

async function run(testCaseId, label) {
  const started = await request('/api/v1/testruns', {
    token: tenant.token, method: 'POST',
    body: { projectId, testCaseIds: [testCaseId], name: label, headless: true }
  });
  if (!started.ok) return { run: null, detail: `run refused: ${started.status} ${started.text.slice(0, 200)}` };
  const finished = await waitForRun(tenant.token, started.json.id);
  if (!finished) return { run: null, detail: 'the run did not reach a verdict' };

  const executions = await request(`/api/v1/testruns/${finished.id}/executions`, { token: tenant.token });
  const execution = executions.json?.[0];
  const detail = execution
    ? await request(`/api/v1/executions/${execution.id}`, { token: tenant.token })
    : { json: null };
  return { run: finished, execution, detail: detail.json };
}

// ---- HEAL-001 the test passes before anything changes --------------------------------
const healTestId = await createSignInTest('Sign in (healing subject)', 'login-submit');
let baseline;

await check('HEAL-001', 'The test passes against the unchanged application', async () => {
  baseline = await run(healTestId, 'HEAL baseline');
  const path = saveEvidence('reports/heal/HEAL-001-baseline.json', baseline);
  return {
    pass: baseline.run?.status === 'passed',
    detail: `status ${baseline.run?.status}, ${baseline.run?.passedCount}/${baseline.run?.totalCount} passed`,
    evidence: [path]
  };
});

// ---- HEAL-002 the default policy proposes rather than applies ----------------------
// A project defaults to HealingPolicy.Suggest. Under it a broken locator must NOT rescue
// the run: the platform records what it would have done and still reports the failure.
await check('HEAL-002', 'Under the default policy a break is proposed, never silently applied', async () => {
  await scenario({ renameLoginButton: true });
  await sleep(500);

  const suggested = await run(healTestId, 'HEAL rename under Suggest');
  const path = saveEvidence('reports/heal/HEAL-002-suggest-policy.json', suggested);

  const events = await request(`/api/v1/healing?projectId=${projectId}`, { token: tenant.token });
  const event = (events.json ?? [])[0];
  const rescued = ['passed', 'healed'].includes(suggested.run?.status);

  return {
    // The proposal must exist and the run must not have been rescued by it.
    pass: !rescued && Boolean(event) && event.outcome === 'proposed',
    detail: `run ${suggested.run?.status} (not rescued), proposal outcome "${event?.outcome}" `
          + `at ${event?.confidence}% confidence`,
    evidence: [path]
  };
});

await check('HEAL-003', 'The proposal carries what a reviewer needs to judge it', async () => {
  const events = await request(`/api/v1/healing?projectId=${projectId}`, { token: tenant.token });
  const path = saveEvidence('reports/heal/HEAL-003-proposal.json', events.json);
  const event = (events.json ?? [])[0];
  if (!event) return { pass: false, detail: 'no proposal recorded', evidence: [path] };

  const complete = Boolean(event.originalLocator) && Boolean(event.healedLocator)
    && typeof event.confidence === 'number' && event.confidence > 0 && Boolean(event.reason);
  return {
    pass: complete,
    detail: `original "${event.originalLocator}" -> "${event.healedLocator}", `
          + `confidence ${event.confidence}, policy ${event.policyAtTime}, `
          + `producedByAi ${event.producedByAi}`,
    evidence: [path]
  };
});

// ---- HEAL-004 under an opt-in policy the heal is applied and labelled --------------------
await check('HEAL-004', 'Under an auto policy the run heals and is reported as healed', async () => {
  const updated = await request(`/api/v1/projects/${projectId}`, {
    token: tenant.token, method: 'PATCH',
    body: { healingPolicy: 'auto', healingConfidenceThreshold: 85 }
  });
  if (!updated.ok) return { pass: false, detail: `could not set the policy: ${updated.status} ${updated.text.slice(0,150)}` };

  const healed = await run(healTestId, 'HEAL rename under Auto');
  const path = saveEvidence('reports/heal/HEAL-004-auto-policy.json', healed);

  const runs = await request(`/api/v1/testruns?projectId=${projectId}&limit=8`, { token: tenant.token });
  const summary = (runs.json ?? []).find(r => r.name === 'HEAL rename under Auto');
  const action = healed.detail?.actions?.find(a => a.wasHealed);

  return {
    // Healed, and reported as healed rather than as a clean pass — the distinction is the
    // product's whole claim about not hiding what it did.
    pass: (summary?.healedCount ?? 0) > 0 && Boolean(action),
    detail: `run ${healed.run?.status}, healedCount ${summary?.healedCount}, `
          + `healed action at step ${action?.order} using ${action?.locatorDescription ?? 'n/a'}`,
    evidence: [path]
  };
});

await check('HEAL-005', 'The stored test keeps its original locator until a person approves', async () => {
  // Healing at run time must not rewrite the test behind the author's back.
  const testCase = await request(`/api/v1/testcases/${healTestId}`, { token: tenant.token });
  const clickStep = testCase.json?.steps?.find(s => s.action === 'click');
  const path = saveEvidence('reports/heal/HEAL-005-stored-test.json', testCase.json);
  return {
    pass: clickStep?.target?.value === 'login-submit',
    detail: `stored locator is still testId="${clickStep?.target?.value}" after an applied heal`,
    evidence: [path]
  };
});

// ---- HEAL-010 the mandatory negative case ------------------------------------------------
// The element is one that never existed, on a page reached *after* a working sign-in, so
// the test genuinely gets to the step and healing genuinely has to decide.
await check('HEAL-010', 'An element that does not exist is NOT healed to something unrelated', async () => {
  await scenario({ renameLoginButton: false, removeLoginButton: false });
  await sleep(500);

  const absentTestId = await createSignInTest('Click an element that never existed', 'login-submit');
  // Retarget the final click at something absent by importing a second journey instead of
  // editing, so the stored locator is unambiguous.
  const journey = {
    schemaVersion: 1, name: 'Absent element', startUrl: 'http://localhost:4200/login',
    recordedAt: new Date().toISOString(), recorderVersion: '0.1.0',
    steps: [
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
      { order: 5, action: 'click', description: 'Press a control that does not exist',
        target: { strategy: 'testId', value: 'quarterly-audit-export-button', exact: false, fallbacks: [] },
        url: 'http://localhost:4200/dashboard', timestampMs: Date.now() }
    ]
  };
  const imported = await request('/api/v1/journeys/import', {
    token: tenant.token, method: 'POST', body: { projectId, applicationId, journey }
  });
  if (!imported.ok) return { pass: false, detail: `import refused: ${imported.status}` };

  const result = await run(imported.json.testCaseId, 'HEAL negative (absent element)');
  const path = saveEvidence('reports/heal/HEAL-010-absent-element.json', result);

  const status = result.run?.status;
  const rescued = ['passed', 'healed'].includes(status);
  const step5 = result.detail?.actions?.find(a => a.order === 5);

  return {
    pass: !rescued,
    detail: `run ${status} (must not be passed or healed); step 5 ${step5?.status}; `
          + `wasHealed ${step5?.wasHealed}; note: the policy is "auto", so a healer willing `
          + `to guess would have rescued this`,
    evidence: [path]
  };
});

await check('HEAL-011', 'The failure explains itself rather than saying only that it failed', async () => {
  const runs = await request(`/api/v1/testruns?projectId=${projectId}&limit=8`, { token: tenant.token });
  const negative = (runs.json ?? []).find(r => r.name === 'HEAL negative (absent element)');
  if (!negative) return { pass: false, detail: 'the negative run was not found' };

  const executions = await request(`/api/v1/testruns/${negative.id}/executions`, { token: tenant.token });
  const execution = executions.json?.[0];
  const detail = execution
    ? (await request(`/api/v1/executions/${execution.id}`, { token: tenant.token })).json
    : null;
  const path = saveEvidence('reports/heal/HEAL-011-failure-detail.json', { execution, detail });

  const step5 = detail?.actions?.find(a => a.order === 5);
  const message = step5?.errorMessage ?? execution?.errorMessage ?? '';
  const generic = /^(test )?failed\.?$/i.test(message.trim());
  return {
    pass: message.length > 20 && !generic,
    detail: message ? `"${message.slice(0, 150)}"` : 'no message recorded',
    evidence: [path]
  };
});

await check('HEAL-012', 'No heal was applied for the element that never existed', async () => {
  const events = await request(`/api/v1/healing?projectId=${projectId}`, { token: tenant.token });
  const all = events.json ?? [];
  const forAbsent = all.filter(e =>
    (e.originalLocator ?? '').includes('quarterly-audit-export-button'));
  const applied = forAbsent.filter(e => e.outcome === 'applied' || e.outcome === 'healed');
  const path = saveEvidence('reports/heal/HEAL-012-events.json', all);
  return {
    pass: applied.length === 0,
    detail: `${all.length} event(s) total; ${forAbsent.length} concerning the absent element, `
          + `${applied.length} of them applied (0 required)`,
    evidence: [path]
  };
});

await resetScenario();
await request(`/api/v1/projects/${projectId}`, {
  token: tenant.token, method: 'PATCH', body: { healingPolicy: 'suggest' }
});
console.log('\nscenario and policy reset');
