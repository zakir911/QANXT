/**
 * Captures the screenshots the user manual uses.
 *
 * A manual illustrated with empty screens teaches nothing, so this seeds a realistic
 * workspace first — a project, an application, a crawl, generated tests, a run that passes,
 * a run that fails, a healing proposal, an agent pass and an authorized security scan — and
 * only then photographs each page. Every image is a real browser looking at a real platform
 * holding real results.
 *
 * Needs QA NXT and the demo bank running.
 *
 *   node test-lab/scripts/capture-user-manual.mjs
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  createProject, execute, generateTests, importJourney, journey, newTenant,
  registerApplication, request, runDiscovery, step
} from '../../verification/golden-tests/platform.mjs';

const CONSOLE = process.env.CONSOLE_URL ?? 'http://127.0.0.1:5173';
const BANK = process.env.DEMO_BANK_URL ?? 'http://127.0.0.1:4200';
const OUT = new URL('../../docs/images/manual/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const scenario = (patch) => fetch(`${BANK}/__control/scenario`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch)
}).then(response => response.json());
const resetBank = () => fetch(`${BANK}/__control/reset`, { method: 'POST' }).then(r => r.json());

// ---------------------------------------------------------------------------
// Seed a workspace worth photographing
// ---------------------------------------------------------------------------

console.log('Seeding a workspace:');
await resetBank();

const tenant = await newTenant('Manual');
console.log(`  organization ready (${tenant.email})`);

const project = await createProject(tenant, 'Retail Banking');
const application = await registerApplication(tenant, project.id, {
  name: 'Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
  username: 'alice', password: 'Password123!'
});
console.log(`  project ${project.key}, application registered`);

const discovery = await runDiscovery(tenant, application.id, { timeoutMs: 300_000 });
console.log(`  discovery ${discovery.status}`);

const generated = await generateTests(tenant, {
  applicationId: application.id,
  requirement: 'Customer can sign in and view their account balance.',
  suiteName: 'Account access', maxScenarios: 5
});
console.log(`  ${generated.json?.casesCreated ?? 0} test case(s) generated`
  + `${generated.ok ? '' : ` — generation answered ${generated.status}: ${generated.text.slice(0, 160)}`}`);

// A recorded journey, so the manual can show a test a person wrote rather than one the
// platform proposed — and so there is something stable to run twice.
const signIn = [
  step.navigate(`${BANK}/login`),
  step.fill('username', 'alice', `${BANK}/login`),
  step.fill('password', '${secret:app_password}', `${BANK}/login`),
  step.click('login-submit', `${BANK}/login`)
];
const imported = await importJourney(tenant, {
  projectId: project.id, applicationId: application.id,
  journey: journey({
    name: 'Customer signs in and reads their balance',
    startUrl: `${BANK}/login`,
    steps: [...signIn, step.assertText('total-balance', '£16,976.65', `${BANK}/dashboard`)]
  })
});
console.log(`  journey imported as ${imported.testCaseReference}`);

const healthy = await execute(tenant, {
  projectId: project.id, testCaseId: imported.testCaseId, name: 'Nightly regression'
});
console.log(`  run against a healthy application: ${healthy.run?.status}`);
if (healthy.run?.status !== 'passed') {
  // A manual whose first screenshot shows a red baseline teaches the reader that red is
  // normal. It is not.
  throw new Error(`the baseline run did not pass (${healthy.run?.status}): `
    + `${healthy.detail?.errorMessage ?? 'no message'}`);
}

// A failure worth analysing: the balance is wrong, so the assertion is right and the
// application is not.
await scenario({ wrongBalance: true });
const broken = await execute(tenant, {
  projectId: project.id, testCaseId: imported.testCaseId, name: 'Nightly regression (after a change)'
});
console.log(`  run against a broken application: ${broken.run?.status}`);
await resetBank();

// A healing proposal: rename the control the test clicks, and let the default policy
// propose a replacement rather than apply one.
await scenario({ renameLoginButton: true });
const healed = await execute(tenant, {
  projectId: project.id, testCaseId: imported.testCaseId, name: 'Nightly regression (renamed control)'
});
const healingEvents = healed.detail?.healingEvents ?? [];
console.log(`  run after a locator change: ${healed.run?.status}, ${healingEvents.length} healing event(s)`);
await resetBank();

// An agent pass, so the manual shows the agent's own report rather than "No passes yet".
console.log('  starting an agent pass…');
const agentStart = await request('/api/v1/agent/runs', {
  token: tenant.token, method: 'POST',
  body: {
    applicationId: application.id, name: 'First autonomous pass',
    objective: 'Cover the account pages', explore: true, execute: true,
    maxPages: 8, maxDepth: 2, maxTargets: 3, maxGeneratedTests: 4, timeBudgetSeconds: 240
  }
});
let agentRun = agentStart.json ?? null;
if (agentStart.ok && agentRun?.id) {
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    const poll = await request(`/api/v1/agent/runs/${agentRun.id}`, { token: tenant.token });
    // The detail endpoint wraps the summary; reading `status` off the envelope gave
    // undefined, and the first version of this script left the loop immediately.
    agentRun = poll.json?.summary ?? poll.json ?? agentRun;
    if (!['running', 'queued', 'pending'].includes(String(agentRun?.status).toLowerCase())) break;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  console.log(`  agent pass: ${agentRun?.status}`);
} else {
  console.log(`  agent pass could not start: ${agentStart.status} ${agentStart.text.slice(0, 140)}`);
}

// ---------------------------------------------------------------------------
// Authorize the application for security testing, and scan it
// ---------------------------------------------------------------------------
//
// The scope is written first because nothing can be scanned without one, and a screenshot of
// the Security page with no scope would illustrate the refusal rather than the feature. The
// note is a real sentence for the same reason the product demands one: a manual showing
// "authorized: yes" teaches the opposite of what the field is for.

const scope = await request(`/api/v1/security/applications/${application.id}/scope`, {
  token: tenant.token, method: 'PUT',
  body: {
    enabled: true,
    authorizationNote:
      'Authorized by R. Patel, Head of Engineering, for this staging instance of Demo Bank '
      + 'only. Ticket SEC-114, 2026-09-24.',
    allowedDomains: new URL(BANK).hostname,
    allowedApiDomains: new URL(BANK).hostname,
    allowedPaths: null,
    blockedPaths: null,
    environmentId: null,
    maxRequestsPerSecond: 10,
    maxConcurrentRequests: 2,
    maxScanDurationMinutes: 10,
    allowActiveTesting: true,
    allowDestructiveTesting: false,
    allowProduction: false
  }
});
console.log(`  security scope ${scope.ok ? 'authorized' : `refused: ${scope.status} ${scope.text.slice(0, 160)}`}`);

let securityScan = null;
if (scope.ok) {
  const started = await request('/api/v1/security/scans/start', {
    token: tenant.token, method: 'POST', body: { applicationId: application.id }
  });
  if (started.ok) {
    const scanId = started.json.securityScanId;
    // Waited for deliberately. A queued scan has issued no requests, and the page says so —
    // truthfully, and uselessly as an illustration of what a scan finds.
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const poll = await request(`/api/v1/security/scans/${scanId}`, { token: tenant.token });
      securityScan = poll.json ?? securityScan;
      if (securityScan?.status && securityScan.status !== 'queued') break;
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    console.log(`  security scan ${securityScan?.reference ?? scanId}: ${securityScan?.status ?? 'never reported'}`
      + `${securityScan?.gate ? ` — gate ${securityScan.gate.outcome}` : ''}`);
  } else {
    console.log(`  security scan could not start: ${started.status} ${started.text.slice(0, 160)}`);
  }
}

const generatedList = await request(
  `/api/v1/testcases?projectId=${project.id}&testSuiteId=${generated.json?.testSuiteId}`,
  { token: tenant.token });
const firstGenerated = (generatedList.json ?? [])[0];

// ---------------------------------------------------------------------------
// Photograph it
// ---------------------------------------------------------------------------

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1380, height: 900 }, deviceScaleFactor: 2 });
const shots = [];

const settle = async () => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.locator('[role="status"]', { hasText: /loading|…/i })
    .first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(600);
};

/**
 * Photographs a page, optionally after proving it shows what the caption claims.
 *
 * `expect` is a locator the page must be showing. Without it, a page whose data had not
 * arrived was photographed in its empty state and captioned as though it were full — the
 * agent screenshot said "No passes yet" under a caption about an agent's report. A manual
 * illustrated with the wrong screen is worse than one with no screens, so a missing
 * expectation is a hard failure rather than a warning.
 */
const shot = async (name, note, expect) => {
  await settle();
  if (expect) {
    await expect.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
      throw new Error(`${name}: the page never showed what the caption claims (${note})`);
    });
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: `${OUT}${name}.png` });
  shots.push(name);
  console.log(`  ${name}.png — ${note}`);
};

/**
 * Proves a locator is actually in the photographed frame.
 *
 * `shot`'s expectation uses Playwright's idea of visible, which means the element has a box
 * and is not hidden — not that it is on the screen. A caption about the decision log passed
 * that check while the decision log was a thousand pixels below the fold, which is the same
 * class of wrongness the expectation exists to prevent, one level down.
 */
const inFrame = async (locator, name) => {
  const box = await locator.first().boundingBox();
  const size = page.viewportSize();
  if (!box || !size) throw new Error(`${name}: could not measure what the caption claims`);
  if (box.y + box.height < 0 || box.y > size.height) {
    throw new Error(
      `${name}: what the caption claims is outside the frame (y=${Math.round(box.y)}, `
      + `viewport ${size.height}px)`);
  }
};

const openPath = async (path) => { await page.goto(`${CONSOLE}${path}`, { waitUntil: 'domcontentloaded' }); };

try {
  console.log('\nCapturing:');

  await page.goto(`${CONSOLE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(tenant.email);
  await page.getByLabel('Password', { exact: true }).fill(tenant.password);
  await shot('01-sign-in', 'signing in');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 30_000 });

  await shot('02-dashboard', 'the dashboard, with real runs behind it', page.getByText(/pass rate|executions/i));

  await openPath('/projects');
  await shot('03-projects', 'projects');

  await openPath('/applications');
  await shot('04-applications', 'the registered application', page.getByText('Demo Bank'));

  await openPath(`/applications/${application.id}/graph`);
  await shot('05-application-model', 'the model discovery built');

  await openPath('/discovery');
  await shot('06-discovery', 'discovery runs', page.getByText(/completed/i));

  await openPath('/tests');
  await shot('07-test-cases', 'the test case list', page.getByText('TC-0006'));

  if (firstGenerated) {
    await openPath(`/tests/${firstGenerated.id}`);
    await shot('08-generated-test', 'a generated test, with its steps and assertions');
  }

  await openPath(`/tests/${imported.testCaseId}`);
  await shot('09-recorded-test', 'a test imported from a recorded journey');

  await openPath('/runs');
  await shot('10-test-runs', 'test runs', page.getByText('Nightly regression'));

  if (broken.run?.id) {
    await openPath(`/runs/${broken.run.id}`);
    await shot('11-run-detail', 'a run that failed, and why');
  }

  const failedExecution = broken.executions?.[0]?.id ?? healthy.executions?.[0]?.id;
  if (failedExecution) {
    await openPath(`/executions/${failedExecution}`);
    await shot('12-execution-evidence', 'the evidence one execution left behind');
  }

  await openPath('/failures');
  await shot('13-failures', 'failures, grouped and explained', page.getByText(/assertion|defect/i));

  await openPath('/healing');
  await shot('14-healing', 'a healing proposal awaiting review', page.getByRole('button', { name: 'Approve' }));

  await openPath('/agent');
  // The seeded pass stops for a plan decision and stays there, so this is a pass waiting on a
  // person rather than a finished one. The caption said "after a completed pass" for one
  // capture, proved only by the run's name being on screen — which is true of a pass in any
  // state. The expectation is now the thing the caption actually claims.
  await shot('15-agent', 'a pass stopped for a plan decision, with the plan it is waiting on',
    page.getByText('The agent is waiting for an answer'));

  // The page is taller than the viewport, and everything that makes the pass auditable — the
  // order things happened in, and each decision with the evidence under it — is below the fold.
  // One screenshot of the summary would illustrate the claim that the agent reports, and leave
  // the claim that it can be argued with unillustrated.
  // Two shots rather than one. The first draft scrolled to the timeline and captioned the
  // decision log "beneath it" — the decision log was a thousand pixels further down, so the
  // caption described something no reader of that image could see. Each is now photographed
  // where it is, and each caption is proved against the frame it is in.
  const scrollTo = async (heading, name) => {
    await page.getByRole('heading', { name: heading })
      .evaluate(node => node.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await inFrame(page.getByRole('heading', { name: heading }), name);
  };

  await scrollTo('Timeline', '15b-agent-timeline');
  await shot('15b-agent-timeline', 'the run timeline: every phase and decision in order',
    page.getByRole('heading', { name: 'Timeline' }));

  await scrollTo(/^Decisions \(\d+\)$/, '15c-agent-decisions');
  await shot('15c-agent-decisions', 'the decision log, with the evidence under each decision',
    page.getByRole('heading', { name: /^Decisions \(\d+\)$/ }));

  await openPath('/insights');
  // An empty question box teaches nothing; the answer is the feature.
  await page.getByRole('button', { name: 'Which failures are likely application defects?' }).click();
  await page.getByRole('heading', { name: 'Answer' }).waitFor({ timeout: 60_000 }).catch(() => {});
  await shot('16-insights', 'a question asked, and answered from stored runs', page.getByRole('heading', { name: 'Answer' }));

  await openPath('/verification');
  await shot('17-verification', 'the Verification Center', page.getByText(/quality gates/i));

  await openPath('/settings');
  await shot('18-settings', 'settings: people, gates and providers');

  await openPath('/security');
  // The authorization card is what the caption claims, and it is the one part of this page
  // that is present whether or not a worker ever reported. Proving the gate summary instead
  // would make the shot fail for a reason the manual does not care about.
  await shot('19-security', 'security: who authorized this application, and for what',
    page.getByTestId('security-scope'));

  // Two shots, because the page is taller than a viewport and the half below the fold is the
  // half that says what was *not* covered. A manual that showed only the authorization would
  // illustrate the permission and skip the honesty.
  await page.getByTestId('security-surface-summary').scrollIntoViewIfNeeded().catch(() => {});
  await shot('20-security-surface', 'the trend, and the attack surface with its caveats first',
    page.getByTestId('security-surface-summary'));

  await page.getByTestId('security-findings').scrollIntoViewIfNeeded().catch(() => {});
  await shot('21-security-findings', 'the findings a real scan of the demo bank produced',
    page.getByTestId('security-findings'));

  console.log(`\n${shots.length} screenshot(s) written to docs/images/manual/`);
  console.log(`Workspace: project ${project.key}, application ${application.id}`);
} finally {
  await browser.close();
}
