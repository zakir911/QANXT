/**
 * Failure detection: does a broken application produce a failed run?
 *
 * The failure lab presents one page per failure class, every page identical in shape. The
 * same test — press the button, expect "OK 42" — is run against each, so the only variable
 * is the failure itself.
 *
 * The healthy case is run first and must pass. Without it, ten failures prove only that
 * the test fails everywhere, which is not detection.
 */
import { golden, suite } from '../harness.mjs';
import {
  LAB, artifactsFor, createProject, execute, importJourney, journey, lab, newTenant,
  registerApplication, step
} from '../platform.mjs';

const FAIL_LAB = LAB.failure;

/** The same five-step test, pointed at one case of the failure lab. */
const caseJourney = (name) => journey({
  name: `Calculate the answer (${name})`,
  startUrl: `${FAIL_LAB}/case/${name}`,
  steps: [
    step.navigate(`${FAIL_LAB}/case/${name}`),
    step.assertVisible('run-case', `${FAIL_LAB}/case/${name}`),
    step.click('run-case', `${FAIL_LAB}/case/${name}`),
    step.assertText('outcome', 'OK 42', `${FAIL_LAB}/case/${name}`)
  ]
});

const CASES = [
  ['DET-001', 'healthy', 'passes', 'critical'],
  ['DET-002', 'http-400', 'fails', 'high'],
  ['DET-003', 'http-401', 'fails', 'high'],
  ['DET-004', 'http-403', 'fails', 'high'],
  ['DET-005', 'http-404', 'fails', 'high'],
  ['DET-006', 'http-500', 'fails', 'critical'],
  ['DET-007', 'timeout', 'fails', 'high'],
  ['DET-008', 'connection-reset', 'fails', 'high'],
  ['DET-009', 'js-error', 'fails', 'high'],
  ['DET-010', 'wrong-value', 'fails', 'critical'],
  ['DET-011', 'missing-element', 'fails', 'critical']
];

export default async function run() {
  suite('Failure detection');
  await lab.reset(FAIL_LAB);

  const tenant = await newTenant('Detection');
  const project = await createProject(tenant, 'Golden failure detection');
  const application = await registerApplication(tenant, project.id, {
    name: 'AIRA Failure Lab', baseUrl: FAIL_LAB, maxPages: 15
  });

  const context = { tenant, project, application, applicationVersion: '1.0.0' };
  const outcomes = [];

  for (const [id, name, expectation, severity] of CASES) {
    const imported = await importJourney(tenant, {
      projectId: project.id, applicationId: application.id, journey: caseJourney(name)
    });

    await golden({
      id,
      objective: expectation === 'passes'
        ? 'A working application produces a passing run'
        : `A ${name.replace('-', ' ')} failure is detected and reported as a failure`,
      preconditions: ['the failure lab is running', `the test targets /case/${name}`],
      input: `The same four-step test: open /case/${name}, press the button, expect "OK 42"`,
      expected: expectation === 'passes'
        ? 'The run passes and every step passes'
        : 'The run FAILS, with the failing step, an error message and a screenshot',
      evidence: [`${id}-execution.json`],
      severity,
      run: async () => {
        const result = await execute(tenant, {
          projectId: project.id, testCaseId: imported.testCaseId,
          name: `DET ${name}`, timeoutMs: 300_000
        });
        const artifacts = await artifactsFor(tenant, result.executions?.[0]?.id);
        const failingStep = (result.detail?.actions ?? []).find(action => action.status !== 'passed');
        const record = {
          id, case: name, expectation,
          status: result.run?.status,
          stepsPassed: result.detail?.stepsPassed,
          stepsTotal: result.detail?.stepsTotal,
          failure: result.detail?.failure ?? null,
          failingStep: failingStep && {
            order: failingStep.order, action: failingStep.action, error: failingStep.errorMessage
          },
          consoleErrors: result.detail?.consoleErrorCount,
          networkErrors: result.detail?.networkErrorCount,
          screenshots: artifacts.filter(artifact => String(artifact.kind).toLowerCase() === 'screenshot').length
        };
        outcomes.push(record);

        const passed = result.run?.status === 'passed';
        const correct = expectation === 'passes' ? passed : !passed;
        const evidencePresent = expectation === 'passes'
          ? true
          : Boolean(failingStep?.errorMessage) && record.screenshots > 0;

        return {
          pass: correct && evidencePresent,
          detail: `${result.run?.status}, ${record.stepsPassed}/${record.stepsTotal} steps`
            + (failingStep ? `; failed at step ${failingStep.order} (${failingStep.action}): `
              + `${String(failingStep.errorMessage ?? '').slice(0, 90)}` : '')
            + `; ${record.screenshots} screenshot(s)`
            + (record.failure ? `; classified ${record.failure.category}` : ''),
          metrics: { screenshots: record.screenshots, consoleErrors: record.consoleErrors },
          evidence: { [`${id}-execution.json`]: record }
        };
      }
    }, context);
  }

  // ---- DET-012: the control — nothing fails when nothing is broken --------
  await golden({
    id: 'DET-012',
    objective: 'With every case made healthy, none of the tests fails',
    preconditions: ['FAULT_ALL_CASES_HEALTHY makes every case behave correctly'],
    input: 'The three failure tests that produced the clearest failures, re-run against a healthy application',
    expected: 'All three pass — a suite that fails whatever the application does is measuring nothing',
    evidence: ['false-positive-control.json'],
    severity: 'critical',
    run: async () => {
      await lab.set(FAIL_LAB, { FAULT_ALL_CASES_HEALTHY: true });
      const rerun = [];
      for (const name of ['http-500', 'timeout', 'connection-reset']) {
        const imported = await importJourney(tenant, {
          projectId: project.id, applicationId: application.id, journey: caseJourney(name)
        });
        const result = await execute(tenant, {
          projectId: project.id, testCaseId: imported.testCaseId, name: `DET ${name} (healthy)`
        });
        rerun.push({ case: name, status: result.run?.status, stepsFailed: result.detail?.stepsFailed });
      }
      await lab.reset(FAIL_LAB);

      const allPassed = rerun.every(entry => entry.status === 'passed');
      return {
        pass: allPassed,
        detail: rerun.map(entry => `${entry.case}: ${entry.status}`).join(', '),
        evidence: { 'false-positive-control.json': { note: 'The same tests that failed above, against an application where nothing is broken.', rerun } }
      };
    }
  }, context);

  return { ...context, outcomes };
}
