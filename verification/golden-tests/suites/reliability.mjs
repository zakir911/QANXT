/**
 * Reliability: does the platform behave the same way twice, and behave sensibly when
 * something it depends on misbehaves?
 *
 * Repeatability is measured by running the same test ten times and counting the verdicts.
 * Flakiness is measured against an application that is genuinely unstable — the failure
 * lab's flaky case answers after 100ms, 800ms, 2.5s or 6s, chosen at random — run twenty
 * times, with the application's own record of the delays it served as the control.
 *
 * The AI checks are the ones that matter most for trust: when a provider cannot be reached,
 * the platform must degrade honestly. A missing analysis is acceptable. A fabricated one,
 * or a failure quietly turned into a pass, is not.
 */
import { golden, notVerified, sleep, suite } from '../harness.mjs';
import {
  LAB, createProject, execute, importJourney, journey, lab, newTenant, registerApplication,
  request, startRun, step, testCase, waitForRun
} from '../platform.mjs';

const BANK = LAB.banking;
const FAIL_LAB = LAB.failure;

export default async function run() {
  suite('Reliability');
  await lab.resetAll();

  const tenant = await newTenant('Reliability');
  const project = await createProject(tenant, 'Golden reliability');
  const bank = await registerApplication(tenant, project.id, {
    name: 'QA NXT Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
    username: 'alice', password: 'Password123!'
  });
  // The flaky work lives in its own project with a two-second action timeout. The lab's
  // flaky case answers after 100ms, 800ms, 2.5s or 6s, so with that timeout two of the
  // four delays pass and two do not — genuine instability. Under the default 30-second
  // timeout every delay passes and there is nothing to measure.
  const flakyProject = await createProject(tenant, 'Golden reliability — flaky', {
    defaultActionTimeoutMs: 2000, defaultRetries: 0
  });
  const failureApp = await registerApplication(tenant, flakyProject.id, {
    name: 'QA NXT Failure Lab', baseUrl: FAIL_LAB, maxPages: 15
  });
  const context = { tenant, project, applicationVersion: '1.0.0' };

  const steadyTest = await importJourney(tenant, {
    projectId: project.id, applicationId: bank.id,
    journey: journey({
      name: 'Sign in and read the balance',
      startUrl: `${BANK}/login`,
      steps: [
        step.navigate(`${BANK}/login`),
        step.fill('username', 'alice', `${BANK}/login`),
        step.fill('password', '${secret:app_password}', `${BANK}/login`),
        step.click('login-submit', `${BANK}/login`),
        step.assertVisible('total-balance', `${BANK}/dashboard`)
      ]
    })
  });

  // ---- REL-001: ten runs, one answer -------------------------------------
  await golden({
    id: 'REL-001',
    objective: 'A deterministic test gives the same verdict ten times running',
    preconditions: ['the lab bank is healthy and unchanged between runs'],
    input: 'The same test case executed ten times',
    expected: 'Ten passes, no other verdict',
    evidence: ['repeatability.json'],
    severity: 'critical',
    run: async () => {
      const runs = [];
      for (let attempt = 1; attempt <= 10; attempt++) {
        const result = await execute(tenant, {
          projectId: project.id, testCaseId: steadyTest.testCaseId, name: `REL repeat ${attempt}`
        });
        runs.push({
          attempt, status: result.run?.status,
          durationMs: result.detail?.durationMs,
          stepsPassed: result.detail?.stepsPassed
        });
      }
      const verdicts = new Set(runs.map(entry => entry.status));
      const durations = runs.map(entry => entry.durationMs ?? 0);
      return {
        pass: verdicts.size === 1 && verdicts.has('passed'),
        detail: `${runs.filter(entry => entry.status === 'passed').length}/10 passed; `
          + `verdicts: ${[...verdicts].join(', ')}; `
          + `duration ${Math.min(...durations)}–${Math.max(...durations)}ms `
          + `(median ${durations.sort((a, b) => a - b)[5]}ms)`,
        metrics: {
          runs: runs.length, distinctVerdicts: verdicts.size,
          minMs: Math.min(...durations), maxMs: Math.max(...durations)
        },
        evidence: { 'repeatability.json': runs }
      };
    }
  }, context);

  // ---- REL-002: twenty runs against something genuinely unstable ---------
  const flakyTest = await importJourney(tenant, {
    projectId: flakyProject.id, applicationId: failureApp.id,
    journey: journey({
      name: 'The intermittently slow case',
      startUrl: `${FAIL_LAB}/case/flaky`,
      steps: [
        step.navigate(`${FAIL_LAB}/case/flaky`),
        step.click('run-case', `${FAIL_LAB}/case/flaky`),
        step.assertText('outcome', 'OK 42', `${FAIL_LAB}/case/flaky`)
      ]
    })
  });

  let flakyRuns = [];

  await golden({
    id: 'REL-002',
    objective: 'An unstable application produces unstable results, and they are recorded',
    preconditions: ['the flaky case answers after 100ms, 800ms, 2.5s or 6s at random',
      'the project\'s action timeout is two seconds, so two of those four delays are too slow'],
    input: 'The same test executed twenty times with no retries',
    expected: 'Both verdicts occur, and the application\'s own record of the delays explains them',
    evidence: ['flakiness.json'],
    severity: 'high',
    run: async () => {
      await lab.reset(FAIL_LAB);
      for (let attempt = 1; attempt <= 20; attempt++) {
        const result = await execute(tenant, {
          projectId: flakyProject.id, testCaseId: flakyTest.testCaseId,
          name: `REL flaky ${attempt}`, maxRetries: 0
        });
        flakyRuns.push({
          attempt, status: result.run?.status,
          durationMs: result.detail?.durationMs,
          error: result.detail?.actions?.find(action => action.status !== 'passed')?.errorMessage ?? null
        });
      }
      const served = await fetch(`${FAIL_LAB}/__flaky`).then(response => response.json()).catch(() => ({ delays: [] }));

      const passed = flakyRuns.filter(entry => entry.status === 'passed').length;
      const failed = flakyRuns.length - passed;
      return {
        pass: passed > 0 && failed > 0,
        detail: `${passed} passed, ${failed} failed across 20 runs; `
          + `delays the application served: `
          + `${[...new Set(served.delays.map(entry => entry.delayMs))].sort((a, b) => a - b).join('ms, ')}ms`,
        metrics: {
          runs: flakyRuns.length, passed, failed,
          flakinessRate: Number((failed / flakyRuns.length).toFixed(4))
        },
        evidence: { 'flakiness.json': { runs: flakyRuns, delaysServed: served.delays } }
      };
    }
  }, context);

  // ---- REL-003: the platform notices the instability ---------------------
  await golden({
    id: 'REL-003',
    objective: 'The platform records instability against the test rather than leaving it to a reader',
    preconditions: ['REL-002 ran the same test twenty times with mixed results'],
    input: 'The test case\'s own execution history',
    expected: 'Pass and fail counts reflect what happened, and a flakiness score is maintained',
    evidence: ['flakiness-score.json'],
    severity: 'high',
    run: async () => {
      const detail = await testCase(tenant, flakyTest.testCaseId);
      const listed = await request(`/api/v1/testcases?projectId=${flakyProject.id}`, { token: tenant.token });
      const summary = (listed.json ?? []).find(entry => entry.id === flakyTest.testCaseId);
      const passed = flakyRuns.filter(entry => entry.status === 'passed').length;

      return {
        pass: (summary?.executionCount ?? 0) >= 20
          && (summary?.passCount ?? 0) > 0 && (summary?.failCount ?? 0) > 0
          && typeof summary?.flakinessScore === 'number',
        detail: `the platform records ${summary?.executionCount} execution(s): `
          + `${summary?.passCount} passed, ${summary?.failCount} failed, `
          + `flakiness score ${summary?.flakinessScore}; this suite observed ${passed}/20 passing`,
        metrics: {
          executionCount: summary?.executionCount, passCount: summary?.passCount,
          failCount: summary?.failCount, flakinessScore: summary?.flakinessScore
        },
        evidence: { 'flakiness-score.json': { summary, observedPassed: passed, testCase: { name: detail?.name, lastStatus: detail?.lastStatus } } }
      };
    }
  }, context);

  // ---- REL-004: retries are recorded, not hidden -------------------------
  await golden({
    id: 'REL-004',
    objective: 'A test that only passes on a retry is not reported as a clean pass',
    preconditions: ['the flaky case fails roughly half the time at a two-second action timeout'],
    input: 'Six runs of the flaky test with two retries allowed',
    expected: 'Retried runs are recorded with their attempt number and reported as flaky rather than passed',
    evidence: ['retries.json'],
    severity: 'critical',
    run: async () => {
      const runs = [];
      for (let attempt = 1; attempt <= 6; attempt++) {
        const started = await startRun(tenant, {
          projectId: flakyProject.id, testCaseIds: [flakyTest.testCaseId],
          name: `REL retry ${attempt}`, maxRetries: 2
        });
        const finished = await waitForRun(tenant, started.id, 300_000);
        const executions = await request(`/api/v1/testruns/${finished.id}/executions`, { token: tenant.token });
        runs.push({
          attempt, status: finished?.status,
          flakyCount: finished?.flakyCount,
          executions: (executions.json ?? []).map(entry => ({ attempt: entry.attempt, status: entry.status }))
        });
      }

      const retried = runs.filter(entry => entry.executions.length > 1);
      const retriedReportedClean = retried.filter(entry => entry.status === 'passed' && (entry.flakyCount ?? 0) === 0);
      return {
        pass: retried.length === 0 || retriedReportedClean.length === 0,
        detail: `${retried.length}/6 run(s) needed a retry; `
          + `verdicts: ${runs.map(entry => `${entry.status}${entry.executions.length > 1 ? `(${entry.executions.length} attempts)` : ''}`).join(', ')}`,
        metrics: { runs: runs.length, retried: retried.length },
        evidence: { 'retries.json': runs }
      };
    }
  }, context);

  // ---- REL-005: ten runs at once -----------------------------------------
  await golden({
    id: 'REL-005',
    objective: 'Ten runs started at the same moment all reach a verdict',
    preconditions: ['the lab bank is healthy'],
    input: 'Ten test runs started concurrently',
    expected: 'Every one reaches a terminal status; none is left running',
    evidence: ['concurrency.json'],
    severity: 'high',
    run: async () => {
      const started = await Promise.all(Array.from({ length: 10 }, (_, index) =>
        startRun(tenant, {
          projectId: project.id, testCaseIds: [steadyTest.testCaseId], name: `REL concurrent ${index + 1}`
        })));
      const finished = await Promise.all(started.map(entry => waitForRun(tenant, entry.id, 420_000)));

      const terminal = finished.filter(Boolean);
      const passed = terminal.filter(entry => entry.status === 'passed');
      return {
        pass: terminal.length === started.length && passed.length === started.length,
        detail: `${terminal.length}/10 reached a verdict, ${passed.length} passed; `
          + `statuses: ${[...new Set(terminal.map(entry => entry.status))].join(', ')}`,
        metrics: { started: started.length, terminal: terminal.length, passed: passed.length },
        evidence: {
          'concurrency.json': finished.map((entry, index) => ({
            index: index + 1, status: entry?.status ?? 'never reached a verdict',
            durationMs: entry?.durationMs
          }))
        }
      };
    }
  }, context);

  // ---- REL-006: an unreachable AI provider degrades honestly -------------
  await golden({
    id: 'REL-006',
    objective: 'When the configured model provider cannot be reached, nothing is fabricated',
    preconditions: ['a project configured to use a hosted provider for which no key exists'],
    input: 'A failing test in that project',
    expected: 'The run still fails, an analysis is still produced by the deterministic rules, and no result is invented',
    evidence: ['ai-unavailable.json'],
    severity: 'critical',
    run: async () => {
      const aiProject = await createProject(tenant, 'Unreachable provider', {
        aiProvider: 'openAi', aiModel: 'gpt-4o-mini', aiEnabled: true
      });
      const aiApp = await registerApplication(tenant, aiProject.id, {
        name: 'QA NXT Failure Lab', baseUrl: FAIL_LAB, maxPages: 5
      });
      const imported = await importJourney(tenant, {
        projectId: aiProject.id, applicationId: aiApp.id,
        journey: journey({
          name: 'A failure to analyse with no provider',
          startUrl: `${FAIL_LAB}/case/http-500`,
          steps: [
            step.navigate(`${FAIL_LAB}/case/http-500`),
            step.click('run-case', `${FAIL_LAB}/case/http-500`),
            step.assertText('outcome', 'OK 42', `${FAIL_LAB}/case/http-500`)
          ]
        })
      });
      const result = await execute(tenant, {
        projectId: aiProject.id, testCaseId: imported.testCaseId, name: 'REL no provider'
      });
      const analysis = result.detail?.failure?.analysis ?? null;

      return {
        pass: result.run?.status !== 'passed' && Boolean(analysis) && analysis.producedByAi === false,
        detail: `run ${result.run?.status}; analysis ${analysis ? 'present' : 'absent'}`
          + (analysis ? `, produced by ${analysis.provider}${analysis.producedByAi ? ' (a model)' : ' (deterministic rules)'}` : ''),
        evidence: { 'ai-unavailable.json': { status: result.run?.status, failure: result.detail?.failure } }
      };
    }
  }, context);

  // ---- REL-007: a run whose worker disappears still reaches a verdict ----
  const strandedMinutes = Number(process.env.QANXT_STRANDED_AFTER_MINUTES ?? '10');
  if (strandedMinutes > 3) {
    notVerified({
      id: 'REL-007',
      objective: 'An execution whose worker dies is reconciled rather than left running forever',
      expected: 'The stranded-execution reaper moves it to a terminal status',
      severity: 'high'
    }, `this deployment reconciles stranded executions after ${strandedMinutes} minutes, which is `
      + 'longer than this suite is willing to wait. Set Execution:StrandedAfterMinutes to 1 and '
      + 'QANXT_STRANDED_AFTER_MINUTES=1 to include it. The mechanism itself is covered by the '
      + 'product\'s own tests (BUG-0005).');
  } else {
    await golden({
      id: 'REL-007',
      objective: 'An execution whose worker dies is reconciled rather than left running forever',
      preconditions: [`the deployment reconciles stranded executions after ${strandedMinutes} minute(s)`],
      input: 'A run whose worker is stopped mid-execution',
      expected: 'The execution reaches a terminal status without the worker returning',
      evidence: ['stranded.json'],
      severity: 'high',
      run: async () => {
        const started = await startRun(tenant, {
          projectId: project.id, testCaseIds: [steadyTest.testCaseId], name: 'REL stranded'
        });
        await sleep(1500);
        const { execSync } = await import('node:child_process');
        execSync('bash scripts/worker-ctl.sh stop', { cwd: process.cwd() });
        const finished = await waitForRun(tenant, started.id, (strandedMinutes + 2) * 60_000);
        execSync('bash scripts/worker-ctl.sh start', { cwd: process.cwd() });

        return {
          pass: Boolean(finished) && finished.status !== 'running',
          detail: `the run reached ${finished?.status ?? 'no verdict'} after its worker was stopped`,
          evidence: { 'stranded.json': finished }
        };
      }
    }, context);
  }

  await lab.resetAll();
  return context;
}
