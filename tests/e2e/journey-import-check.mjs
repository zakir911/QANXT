/**
 * Closes the recorder loop: takes a journey the browser extension actually recorded,
 * imports it through the platform's own API, and executes the test that import produced.
 *
 * This is the check behind Phase 6's definition of done — "a recorded journey JSON imports
 * and generates an executable test" — and it is deliberately end to end. Asserting that the
 * import endpoint returns 200 would prove almost nothing: the interesting failures are a
 * journey whose locators do not resolve in a real browser, and a recorded password that
 * never resolves back from encrypted storage at run time. Both only show up when the
 * generated test is run.
 *
 * Usage (with the stack running):
 *   node tests/e2e/journey-import-check.mjs [path-to-journey.json]
 */
import { readFile } from 'node:fs/promises';

const api = process.env.AIRA_API_URL ?? 'http://127.0.0.1:5080';
const journeyPath = process.argv[2] ?? '/tmp/aira-journey.json';
const org = process.env.AIRA_ORG ?? 'northwind-bank';
const email = process.env.AIRA_EMAIL ?? 'qa.lead@northwind.test';
const password = process.env.AIRA_PASSWORD ?? 'Str0ngPassphrase!2026';

const fail = (message) => { console.log(`FAIL  ${message}`); process.exitCode = 1; };
const pass = (message) => console.log(`PASS  ${message}`);
const die = (message) => { fail(message); process.exit(1); };

let token;
async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) die(`${init.method ?? 'GET'} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  return body;
}

// ---- Sign in and locate the application -----------------------------------
({ accessToken: token } = await call('/api/v1/auth/login', {
  method: 'POST',
  body: JSON.stringify({ organizationSlug: org, email, password })
}));
pass('signed in to the control plane');

const journey = JSON.parse(await readFile(journeyPath, 'utf8'));
if (!journey.steps?.length) die(`${journeyPath} contains no steps`);

const projects = await call('/api/v1/projects');
const project = projects[0];
if (!project) die('no project exists to import into');

const applications = await call(`/api/v1/applications?projectId=${project.id}`);
// The journey must be imported against the application it was recorded on, because the
// import refuses any URL outside that application's allowed domains.
const journeyHost = new URL(journey.startUrl).host;
const application = applications.find(a => new URL(a.baseUrl).host === journeyHost);
if (!application) {
  die(`no application in "${project.name}" is served from ${journeyHost}; `
    + `known: ${applications.map(a => new URL(a.baseUrl).host).join(', ') || 'none'}`);
}
pass(`the recording matches the registered application "${application.name}"`);

// ---- Import ---------------------------------------------------------------
const imported = await call('/api/v1/journeys/import', {
  method: 'POST',
  body: JSON.stringify({ projectId: project.id, applicationId: application.id, journey })
});

if (imported.stepCount !== journey.steps.length) {
  fail(`the import kept ${imported.stepCount} of ${journey.steps.length} recorded steps`);
} else pass(`the journey imported with all ${imported.stepCount} steps`);

if (!imported.testCaseId) die('the import produced no test case');
pass(`the import generated ${imported.testCaseReference}`);

for (const warning of imported.warnings ?? []) console.log(`      note: ${warning}`);

// ---- The generated test ----------------------------------------------------
const testCase = await call(`/api/v1/testcases/${imported.testCaseId}`);

if (testCase.source !== 'recordedJourney') fail(`the test case is not marked as recorded: ${testCase.source}`);
else pass('the generated test records where it came from');

const stored = JSON.stringify(testCase);
const recorded = JSON.stringify(journey);
// Whatever the recorder captured as a secret must still be a reference, never a value.
if (/\$\{secret:[a-z_]+\}/.test(recorded) && !/\$\{secret:[a-z_]+\}/.test(stored)) {
  fail('a secret reference was lost between the recording and the generated test');
} else pass('secret references survived generation as references');

// ---- Execute ----------------------------------------------------------------
let run = await call('/api/v1/testruns', {
  method: 'POST',
  body: JSON.stringify({
    projectId: project.id,
    testCaseIds: [imported.testCaseId],
    name: `Imported journey — ${journey.name}`,
    headless: true
  })
});

const deadline = Date.now() + 120_000;
while (!['passed', 'failed', 'completed', 'cancelled', 'blocked'].includes(run.status)) {
  if (Date.now() > deadline) die(`the run did not finish within two minutes (last status: ${run.status})`);
  await new Promise(resolve => setTimeout(resolve, 2000));
  run = await call(`/api/v1/testruns/${run.id}`);
}

if (run.status !== 'passed') {
  fail(`the generated test did not pass: status=${run.status} `
    + `passed=${run.passedCount} failed=${run.failedCount} blocked=${run.blockedCount}`);
} else pass(`the generated test executed and passed in ${run.durationMs}ms`);

const [execution] = await call(`/api/v1/testruns/${run.id}/executions`);
if (!execution) die('the run recorded no execution');

const detail = await call(`/api/v1/executions/${execution.id}`);

if (detail.stepsPassed !== journey.steps.length) {
  fail(`${detail.stepsPassed} of ${journey.steps.length} recorded steps ran successfully`);
} else pass(`all ${detail.stepsPassed} steps ran in a real browser`);

// The last step only resolves if the earlier ones genuinely worked, so a passing final
// step on the expected page is what proves the journey was reproduced rather than skipped.
const last = detail.actions.at(-1);
const expectedLastUrl = journey.steps.at(-1)?.url;
if (last?.status !== 'passed') fail(`the final step did not pass: ${last?.status}`);
else pass(`the journey reached "${last.description}"`);
if (expectedLastUrl && last?.url && new URL(last.url).pathname !== new URL(expectedLastUrl).pathname) {
  console.log(`      note: the final step ran on ${last.url}, recorded on ${expectedLastUrl}`);
}

// A password typed during recording must never be readable afterwards, at any layer.
const secretAction = detail.actions.find(a => a.maskedValue?.includes('REDACTED'));
if (/\$\{secret:/.test(recorded) && !secretAction) {
  fail('a recorded secret was not masked in the stored execution');
} else if (secretAction) pass('the secret value is masked in the stored execution');

const evidence = detail.artifacts.filter(a => (a.sizeBytes ?? 0) > 0);
if (evidence.length === 0) fail('the execution produced no evidence');
else pass(`the execution produced ${evidence.length} evidence artifact(s): ${evidence.map(a => a.kind).join(', ')}`);

console.log(process.exitCode ? '\nThe recorder loop is broken.' : '\nRecording → import → generation → execution is closed.');
