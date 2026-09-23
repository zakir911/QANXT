/**
 * Release quality: what changed, rather than what is broken.
 *
 * The distinction is the whole point. A run summary answers "is it broken now"; a release
 * decision needs "what changed", and twelve failing tests are not a reason to stop a
 * release if the same twelve failed last week and somebody already knows why. One test
 * that used to pass is.
 *
 * So these are executed against real pairs of runs whose results genuinely differ, made to
 * differ by injecting a fault into the deployment between them rather than by editing the
 * tests. A comparison that only ever sees identical runs proves nothing about the thing it
 * exists to detect.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { golden, suite, ROOT } from '../harness.mjs';
import {
  API, LAB, createEnvironment, createProject, lab, newTenant, registerApplication,
  request, requireApiTest, startRun, waitForRun
} from '../platform.mjs';

const BANK = LAB.banking;
const CREDENTIALS = { username: 'alice', password: 'Password123!' };

function cli(args, { token, projectId } = {}) {
  const result = spawnSync(process.execPath, [resolve(ROOT, 'packages/cli/dist/aira.js'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 180_000,
    env: {
      ...process.env, AIRA_API_URL: API, AIRA_TOKEN: token ?? '',
      AIRA_PROJECT_ID: projectId ?? '', AIRA_ENVIRONMENT_ID: '', NO_COLOR: '1'
    }
  });
  return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const compare = (tenant, runId, previousId) =>
  request(`/api/v1/release/compare?run=${runId}${previousId ? `&previous=${previousId}` : ''}`,
    { token: tenant.token });

export default async function run() {
  suite('Release quality');
  await lab.reset(BANK);

  const tenant = await newTenant('Release');
  const project = await createProject(tenant, 'Golden release');
  const application = await registerApplication(tenant, project.id, {
    name: 'Lab Bank release', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
  });
  const qa = await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };
  const shared = { projectId: project.id, applicationId: application.id };

  // Always passes: the control, so a movement can be told from a run that simply broke.
  const health = await requireApiTest(tenant, {
    ...shared, suiteName: 'Release', name: 'The application answers', tags: 'smoke',
    steps: [{
      description: 'Health check',
      request: { method: 'GET', path: '/health', auth: { mode: 'none' } },
      assertions: [{ type: 'httpStatusEquals', expected: '200' }]
    }]
  });

  // Passes against a healthy deployment and fails when FAULT_API_FIELD_REMOVED is on, so
  // the movement between runs is caused by the application rather than written into a test.
  const accounts = await requireApiTest(tenant, {
    ...shared, suiteName: 'Release', name: 'An account carries its sort code', tags: 'accounts',
    steps: [
      {
        description: 'Sign in',
        request: {
          method: 'POST', path: '/api/session', contentType: 'application/json',
          body: JSON.stringify({ username: CREDENTIALS.username, password: '${secret:app_password}' }),
          auth: { mode: 'none' }
        },
        assertions: [{ type: 'httpStatusEquals', expected: '200' }]
      },
      {
        description: 'Read the accounts',
        request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' } },
        assertions: [
          { type: 'httpStatusEquals', expected: '200' },
          { type: 'responseJsonPathExists', subject: 'accounts[0].sortCode' }
        ]
      }
    ]
  });

  /** Runs the given tests against the deployment in whatever state it is in. */
  async function runNow(testCaseIds, { name, buildRef } = {}) {
    const started = await request('/api/v1/testruns', {
      token: tenant.token, method: 'POST',
      body: {
        projectId: project.id, testCaseIds, environmentId: qa.id, headless: true,
        name: name ?? 'Release run',
        ci: buildRef ? { applicationBuildRef: buildRef } : undefined
      }
    });
    if (!started.ok) throw new Error(`run refused: ${started.status} ${started.text.slice(0, 200)}`);
    return waitForRun(tenant, started.json.id);
  }

  // Two runs, with a defect deployed between them. Built once and reused: each run costs
  // a real execution against a real browser worker.
  await lab.reset(BANK);
  const greenRun = await runNow([health.testCaseId, accounts.testCaseId],
    { name: 'Release green', buildRef: 'v2.4.0' });

  await lab.set(BANK, { FAULT_API_FIELD_REMOVED: true });
  const brokenRun = await runNow([health.testCaseId, accounts.testCaseId],
    { name: 'Release broken', buildRef: 'v2.4.1' });

  await lab.reset(BANK);
  const fixedRun = await runNow([health.testCaseId, accounts.testCaseId],
    { name: 'Release fixed', buildRef: 'v2.4.2' });

  // ---- RLS-001: a regression is named as a regression ---------------------
  await golden({
    id: 'RLS-001',
    objective: 'A test that passed before and fails now is reported as newly failing',
    preconditions: ['two runs of the same tests, with a defect deployed between them'],
    input: 'GET /api/v1/release/compare for the second run',
    expected: 'The broken test is newlyFailing and the healthy one is stillPassing — the '
      + 'distinction a release decision is made from',
    evidence: ['comparison.json'],
    severity: 'critical',
    run: async () => {
      const { json: comparison, status } = await compare(tenant, brokenRun.id, greenRun.id);

      const broken = comparison?.tests?.find(test => test.reference === accounts.reference);
      const healthy = comparison?.tests?.find(test => test.reference === health.reference);

      return {
        pass: status === 200
          && broken?.movement === 'newlyFailing'
          && healthy?.movement === 'stillPassing'
          && comparison.counts?.newlyFailing === 1
          && comparison.unchanged === false
          && /used to pass now fail/.test(comparison.summary ?? ''),
        detail: `${accounts.reference}: ${broken?.movement}; ${health.reference}: ${healthy?.movement}; `
          + `"${comparison?.summary}"`,
        metrics: { newlyFailing: comparison?.counts?.newlyFailing ?? -1 },
        evidence: { 'comparison.json': comparison }
      };
    }
  }, context);

  // ---- RLS-002: a fix is named as a fix -----------------------------------
  await golden({
    id: 'RLS-002',
    objective: 'A test that failed before and passes now is reported as fixed',
    preconditions: ['a broken run followed by a healthy one'],
    input: 'GET /api/v1/release/compare for the third run against the second',
    expected: 'The test is fixed, nothing is newly failing, and the headline says so — '
      + 'evidence that a fix worked is worth as much as evidence that something broke',
    evidence: ['comparison.json'],
    severity: 'high',
    run: async () => {
      const { json: comparison } = await compare(tenant, fixedRun.id, brokenRun.id);
      const fixed = comparison?.tests?.find(test => test.reference === accounts.reference);

      return {
        pass: fixed?.movement === 'fixed'
          && comparison.counts?.newlyFailing === 0
          && comparison.counts?.fixed === 1
          && /now pass/.test(comparison.summary ?? ''),
        detail: `${accounts.reference}: ${fixed?.movement}; "${comparison?.summary}"`,
        evidence: { 'comparison.json': comparison }
      };
    }
  }, context);

  // ---- RLS-003: an old failure is not a new one ---------------------------
  await golden({
    id: 'RLS-003',
    objective: 'A failure present in both runs is still failing, never newly failing',
    preconditions: ['two runs against the same broken deployment'],
    input: 'A comparison of two runs that both failed the same way',
    expected: 'stillFailing and nothing newly failing, so a pipeline gated on regressions '
      + 'does not block on a defect somebody already knows about',
    evidence: ['comparison.json'],
    severity: 'critical',
    run: async () => {
      await lab.set(BANK, { FAULT_API_FIELD_REMOVED: true });
      const first = await runNow([health.testCaseId, accounts.testCaseId], { name: 'Broken A' });
      const second = await runNow([health.testCaseId, accounts.testCaseId], { name: 'Broken B' });
      await lab.reset(BANK);

      const { json: comparison } = await compare(tenant, second.id, first.id);
      const known = comparison?.tests?.find(test => test.reference === accounts.reference);

      return {
        pass: known?.movement === 'stillFailing'
          && comparison.counts?.newlyFailing === 0
          && comparison.counts?.fixed === 0
          && comparison.unchanged === true
          && /Nothing changed/.test(comparison.summary ?? ''),
        detail: `${accounts.reference}: ${known?.movement}; unchanged=${comparison?.unchanged}; `
          + `"${comparison?.summary}"`,
        evidence: { 'comparison.json': comparison }
      };
    }
  }, context);

  // ---- RLS-004: a test that stopped running is visible --------------------
  await golden({
    id: 'RLS-004',
    objective: 'A test that ran before and not this time is reported, not silently dropped',
    preconditions: ['a run of two tests followed by a run of one'],
    input: 'A comparison where the second run selected fewer tests',
    expected: 'The absent test is reported as removed. Coverage that quietly stopped being '
      + 'selected is coverage nobody decided to drop, and it is invisible unless something says so',
    evidence: ['comparison.json'],
    severity: 'high',
    run: async () => {
      await lab.reset(BANK);
      const both = await runNow([health.testCaseId, accounts.testCaseId], { name: 'Both tests' });
      const one = await runNow([health.testCaseId], { name: 'Only the smoke test' });

      const { json: comparison } = await compare(tenant, one.id, both.id);
      const dropped = comparison?.tests?.find(test => test.reference === accounts.reference);

      return {
        pass: dropped?.movement === 'removed'
          && comparison.counts?.removed === 1
          && /did not run this time/.test(comparison.summary ?? ''),
        detail: `${accounts.reference}: ${dropped?.movement}; "${comparison?.summary}"`,
        evidence: { 'comparison.json': comparison }
      };
    }
  }, context);

  // ---- RLS-005: the release report over a whole build ---------------------
  await golden({
    id: 'RLS-005',
    objective: 'A release report covers every run that tested one build and says what changed',
    preconditions: ['runs tagged with an application build reference'],
    input: 'GET /api/v1/release/quality for build v2.4.1',
    expected: 'The build\'s runs, its failing tests, and a comparison against the previous '
      + 'build — a release tested across several runs is one thing to decide about',
    evidence: ['report.json'],
    severity: 'critical',
    run: async () => {
      const { json: report, status } = await request(
        `/api/v1/release/quality?projectId=${project.id}&build=v2.4.1`, { token: tenant.token });

      return {
        pass: status === 200
          && report?.buildRef === 'v2.4.1'
          && report.runCount >= 1
          && report.outstandingFailures?.length === 1
          && report.outstandingFailures[0].reference === accounts.reference
          && report.comparedWith === 'v2.4.0'
          && report.comparison?.counts?.newlyFailing === 1,
        detail: `build ${report?.buildRef}: ${report?.runCount} run(s), `
          + `${report?.outstandingFailures?.length} failing, compared with ${report?.comparedWith}; `
          + `"${report?.summary}"`,
        metrics: { runs: report?.runCount ?? 0 },
        evidence: { 'report.json': report }
      };
    }
  }, context);

  // ---- RLS-006: no comparison is said, not implied ------------------------
  await golden({
    id: 'RLS-006',
    objective: 'A run with nothing to compare against says so rather than reporting zeros',
    preconditions: ['a project whose first run has just finished'],
    input: 'A comparison of the first run in a fresh project',
    expected: 'Refused with an explanation. Zeros would read as "nothing changed", which is '
      + 'a claim, and "there is nothing to compare with" is the truth',
    evidence: ['refusal.json'],
    severity: 'critical',
    run: async () => {
      const fresh = await createProject(tenant, 'Release first run');
      const freshApp = await registerApplication(tenant, fresh.id, {
        name: 'Lab Bank first', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
      });
      const freshEnv = await createEnvironment(tenant, fresh.id, {
        name: 'QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
      });
      const freshTest = await requireApiTest(tenant, {
        projectId: fresh.id, applicationId: freshApp.id, name: 'The application answers',
        steps: [{
          description: 'Health check',
          request: { method: 'GET', path: '/health', auth: { mode: 'none' } },
          assertions: [{ type: 'httpStatusEquals', expected: '200' }]
        }]
      });

      await lab.reset(BANK);
      const started = await startRun(tenant, {
        projectId: fresh.id, testCaseIds: [freshTest.testCaseId],
        name: 'The only run', environmentId: freshEnv.id
      });
      await waitForRun(tenant, started.id);

      const response = await compare(tenant, started.id, null);

      return {
        pass: response.status === 400
          && /no earlier finished run/i.test(response.json?.title ?? ''),
        detail: `${response.status}: ${response.json?.title ?? response.text?.slice(0, 200)}`,
        evidence: { 'refusal.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  // ---- RLS-007: the CLI gates on regressions, not on failures -------------
  await golden({
    id: 'RLS-007',
    objective: 'aira release compare --fail-on-new-failures exits 1 on a regression and 0 on a known failure',
    preconditions: ['the CLI is built', 'a regression pair and a both-broken pair'],
    input: 'The CLI against each pair',
    expected: 'Exit 1 for the regression, exit 0 for the pair that was already failing — '
      + 'the one reason to put this in a pipeline is to stop on a regression and not on a '
      + 'defect somebody already knows about',
    evidence: ['cli.txt', 'comparison.md'],
    severity: 'critical',
    run: async () => {
      const options = { token: tenant.token, projectId: project.id };
      const directory = mkdtempSync(join(tmpdir(), 'aira-release-'));
      const markdown = join(directory, 'comparison.md');

      const regression = cli([
        'release', 'compare', '--run', brokenRun.id, '--previous', greenRun.id,
        '--fail-on-new-failures', '--markdown', markdown
      ], options);

      // Both runs failed the same way, so there is no regression to stop on.
      await lab.set(BANK, { FAULT_API_FIELD_REMOVED: true });
      const first = await runNow([health.testCaseId, accounts.testCaseId], { name: 'Known A' });
      const second = await runNow([health.testCaseId, accounts.testCaseId], { name: 'Known B' });
      await lab.reset(BANK);

      const known = cli([
        'release', 'compare', '--run', second.id, '--previous', first.id, '--fail-on-new-failures'
      ], options);

      const rendered = existsSync(markdown) ? readFileSync(markdown, 'utf8') : '';

      return {
        pass: regression.code === 1
          && known.code === 0
          && rendered.startsWith('#### ❌ 1 test(s) that used to pass now fail')
          && rendered.includes(accounts.reference)
          // Still-failing tests are context, not news, and belong behind a fold.
          && /Still failing/.test(known.output),
        detail: `regression exit ${regression.code} (expected 1); `
          + `already-failing exit ${known.code} (expected 0); `
          + `markdown headline "${rendered.split('\n')[0]}"`,
        metrics: { regressionExit: regression.code, knownExit: known.code },
        evidence: {
          'cli.txt': `$ aira release compare (regression)\n[exit ${regression.code}]\n${regression.output}\n\n`
            + `$ aira release compare (already failing)\n[exit ${known.code}]\n${known.output}`,
          'comparison.md': rendered
        }
      };
    }
  }, context);
}
