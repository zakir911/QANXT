/**
 * Drives the `qanxt` CLI the way a pipeline does, against the running stack.
 *
 * Phase 7's definition of done is "the CLI drives a real run against a local API and emits
 * a JUnit file that a CI system can consume", and each half is checked literally: the run
 * is real, and the XML is parsed by a browser's XML parser rather than by a regular
 * expression that would happily accept a malformed file.
 *
 * It also checks the half that only matters when things go wrong — that a broken
 * application makes the command exit non-zero — because a gate that cannot fail a build is
 * not a gate.
 */
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const cli = resolve(repo, 'packages/cli/dist/qanxt.js');

const api = process.env.QANXT_API_URL ?? 'http://127.0.0.1:5080';
const bank = process.env.QANXT_DEMO_BANK_URL ?? 'http://localhost:4200';
const org = process.env.QANXT_ORG ?? 'northwind-bank';
const email = process.env.QANXT_EMAIL ?? 'qa.lead@northwind.test';
const password = process.env.QANXT_PASSWORD ?? 'Str0ngPassphrase!2026';

const fail = (message) => { console.log(`FAIL  ${message}`); process.exitCode = 1; };
const pass = (message) => console.log(`PASS  ${message}`);
const die = (message) => { fail(message); process.exit(1); };

/** Runs the CLI and returns what a pipeline would see. */
function runCli(args, env = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repo,
      env: { ...process.env, QANXT_API_URL: api, ...env }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

const setScenario = (patch) => fetch(`${bank}/__control/scenario`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(patch)
});

// ---- Set up --------------------------------------------------------------
const auth = await fetch(`${api}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ organizationSlug: org, email, password })
});
if (!auth.ok) die(`could not sign in to ${api} (${auth.status})`);
const token = (await auth.json()).accessToken;
const env = { QANXT_TOKEN: token };

const projects = await (await fetch(`${api}/api/v1/projects`, {
  headers: { authorization: `Bearer ${token}` }
})).json();
const project = projects[0];
if (!project) die('no project exists to run against');

const suites = await (await fetch(`${api}/api/v1/test-suites?projectId=${project.id}`, {
  headers: { authorization: `Bearer ${token}` }
})).json();
// The largest suite exercises the most of the application.
const suite = suites.slice().sort((a, b) => (b.testCaseCount ?? 0) - (a.testCaseCount ?? 0))[0];
if (!suite) die('no test suite exists to run');
pass(`signed in and found the suite "${suite.name}"`);

// ---- Misuse is reported as misuse, not as a test failure -------------------
const badFlag = await runCli(['run', '--juint', './a.xml'], env);
if (badFlag.code !== 2) fail(`a mistyped flag should exit 2, got ${badFlag.code}`);
else pass('a mistyped option exits 2 rather than being ignored');

const badToken = await runCli(
  ['status', '--project', project.id], { QANXT_TOKEN: 'not-a-real-token', QANXT_CONFIG: '/nonexistent' });
if (badToken.code !== 3) fail(`a rejected token should exit 3, got ${badToken.code}`);
else pass('a rejected token exits 3, distinct from a test failure');

const badApi = await runCli(
  ['status', '--project', project.id], { QANXT_API_URL: 'http://127.0.0.1:1', ...env });
if (badApi.code !== 4) fail(`an unreachable platform should exit 4, got ${badApi.code}`);
else pass('an unreachable platform exits 4, distinct from a test failure');

// ---- A healthy application: the gate passes --------------------------------
await setScenario({ breakTransactionsApi: false });
await rm('/tmp/qanxt-cli-check', { recursive: true, force: true });

const healthy = await runCli([
  'run', '--project', project.id, '--suite', suite.id,
  '--name', 'CLI check (healthy)', '--report-dir', '/tmp/qanxt-cli-check',
  '--timeout', '600', '--quiet'
], env);

if (healthy.code !== 0) {
  fail(`a healthy application should exit 0, got ${healthy.code}\n${healthy.stderr.slice(0, 600)}`);
} else pass('a passing run with a satisfied quality gate exits 0');

// ---- The JUnit file is parseable by a real XML parser ----------------------
const xml = await readFile('/tmp/qanxt-cli-check/junit.xml', 'utf8');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();

const parsed = await page.evaluate(source => {
  const document_ = new DOMParser().parseFromString(source, 'application/xml');
  const error = document_.querySelector('parsererror');
  if (error) return { ok: false, message: error.textContent?.slice(0, 300) ?? 'unknown parse error' };
  const suites = [...document_.querySelectorAll('testsuite')];
  const cases = [...document_.querySelectorAll('testcase')];
  const root = document_.documentElement;
  return {
    ok: true,
    root: root.tagName,
    declaredTests: Number(root.getAttribute('tests')),
    declaredFailures: Number(root.getAttribute('failures')),
    declaredErrors: Number(root.getAttribute('errors')),
    suiteCount: suites.length,
    caseCount: cases.length,
    failureCount: document_.querySelectorAll('testcase > failure').length,
    errorCount: document_.querySelectorAll('testcase > error').length,
    everyCaseNamed: cases.every(node => (node.getAttribute('name') ?? '').length > 0),
    everyCaseTimed: cases.every(node => Number.isFinite(Number(node.getAttribute('time'))))
  };
}, xml);

if (!parsed.ok) die(`the JUnit file is not well-formed XML: ${parsed.message}`);
pass('the JUnit file parses as XML');

if (parsed.root !== 'testsuites') fail(`the root element should be <testsuites>, got <${parsed.root}>`);
else pass('the document has the root element a CI parser looks for');

if (parsed.caseCount !== parsed.declaredTests) {
  fail(`the header declares ${parsed.declaredTests} tests but the file contains ${parsed.caseCount}`);
} else pass(`the declared count matches the ${parsed.caseCount} test cases present`);

if (parsed.failureCount !== parsed.declaredFailures || parsed.errorCount !== parsed.declaredErrors) {
  fail(`declared failures/errors (${parsed.declaredFailures}/${parsed.declaredErrors}) do not match `
    + `the elements present (${parsed.failureCount}/${parsed.errorCount})`);
} else pass('the declared failure and error counts match the elements present');

if (!parsed.everyCaseNamed) fail('a test case has no name');
else if (!parsed.everyCaseTimed) fail('a test case has no parseable time');
else pass('every test case carries a name and a time');

// ---- A broken application: the gate blocks ---------------------------------
await setScenario({ breakTransactionsApi: true });
await rm('/tmp/qanxt-cli-check-broken', { recursive: true, force: true });

const broken = await runCli([
  'run', '--project', project.id, '--suite', suite.id,
  '--name', 'CLI check (broken)', '--report-dir', '/tmp/qanxt-cli-check-broken',
  '--timeout', '600', '--quiet'
], env);

await setScenario({ breakTransactionsApi: false });

if (broken.code !== 1) {
  fail(`a blocked quality gate should exit 1, got ${broken.code}\n${broken.stderr.slice(0, 600)}`);
} else pass('a failing quality gate exits 1 and would block a pipeline');

const brokenReport = JSON.parse(await readFile('/tmp/qanxt-cli-check-broken/report.json', 'utf8'));
if (brokenReport.qualityGate.passed) fail('the report claims the gate passed on a failing run');
else pass(`the report explains why: ${brokenReport.qualityGate.summary}`);

const failed = brokenReport.tests.filter(t => t.verdict === 'failed');
if (failed.length === 0) fail('no test is recorded as failed, though the run failed');
else pass(`${failed.length} test(s) are recorded as failed, with messages`);

const brokenXml = await readFile('/tmp/qanxt-cli-check-broken/junit.xml', 'utf8');
const brokenParsed = await page.evaluate(source => {
  const document_ = new DOMParser().parseFromString(source, 'application/xml');
  if (document_.querySelector('parsererror')) return { ok: false };
  return {
    ok: true,
    failures: [...document_.querySelectorAll('testcase > failure')]
      .map(node => ({ message: node.getAttribute('message'), type: node.getAttribute('type') }))
  };
}, brokenXml);

if (!brokenParsed.ok) fail('the failing run produced a JUnit file that is not well-formed');
else if (brokenParsed.failures.length === 0) fail('the JUnit file records no <failure> for a failed test');
else pass(`the JUnit file carries the failure: "${brokenParsed.failures[0].message}"`);

// ---- Reports can be regenerated for a run that already finished -------------
await rm('/tmp/qanxt-cli-check-again', { recursive: true, force: true });
const runId = brokenReport.run.id;
const again = await runCli(
  ['report', runId, '--report-dir', '/tmp/qanxt-cli-check-again', '--quiet'], env);
if (again.code !== 1) fail(`report should mirror the run's gate and exit 1, got ${again.code}`);
else pass('reports can be regenerated later and still mirror the gate');

await browser.close();

console.log(process.exitCode ? '\nThe CLI does not yet behave as a pipeline needs.' : '\nThe CLI drives real runs and emits CI-consumable reports.');
