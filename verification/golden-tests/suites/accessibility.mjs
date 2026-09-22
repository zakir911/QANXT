/**
 * Accessibility checks, measured against ground truth.
 *
 * Two claims are easy to make about an accessibility feature and hard to support. That the
 * scanner finds real problems — "it reported something" is not evidence it reports the
 * right things. And that a clean result means an accessible page — it does not, and a tool
 * that implies it does real harm, because a team stops looking.
 *
 * So these are measured against `test-lab/forms-app`, whose faults each name the axe rule
 * they are built to trip, recorded in its ground truth. Precision and recall both matter:
 * a scanner that reports violations on a clean page is as broken as one that reports none
 * on a bad page, and ACC-001 covers the first while ACC-002 covers the second.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { golden, suite, ROOT } from '../harness.mjs';
import {
  LAB, createEnvironment, createProject, importJourney, journey, lab, newTenant,
  registerApplication, request, startRun, step, waitForRun
} from '../platform.mjs';

const FORMS = LAB.forms;

/** The lab's own record of which fault trips which rule. Read, not restated. */
const GROUND_TRUTH = JSON.parse(
  readFileSync(resolve(ROOT, 'test-lab/forms-app/ground-truth.json'), 'utf8'));

const A11Y_FAULTS = GROUND_TRUTH.knownFaults.filter(fault => fault.accessibility !== undefined);

/** Builds a journey that opens the form and scans it. */
async function accessibilityTest(tenant, project, application, options, name) {
  const imported = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id,
    journey: journey({
      name, startUrl: FORMS,
      steps: [
        step.navigate(FORMS, 'Open the application form'),
        step.checkAccessibility(options, FORMS)
      ]
    })
  });
  return imported.testCaseId;
}

async function runAndRead(tenant, project, environment, testCaseId, name) {
  const started = await startRun(tenant, {
    projectId: project.id, testCaseIds: [testCaseId], name, environmentId: environment.id
  });
  const finished = await waitForRun(tenant, started.id);
  const { json: executions } = await request(
    `/api/v1/testruns/${started.id}/executions`, { token: tenant.token });
  const { json: detail } = await request(
    `/api/v1/executions/${executions?.[0]?.id}`, { token: tenant.token });

  // The scan step is the one carrying a result; a navigate never does. The result is
  // stored as JSON, so it is parsed here rather than by the API — the API returns what the
  // worker reported, verbatim.
  const scan = (detail?.actions ?? [])
    .find(action => action.accessibility !== null && action.accessibility !== undefined);

  return {
    runId: started.id,
    run: finished,
    execution: executions?.[0],
    scan: scan === undefined ? undefined : { ...scan, accessibility: JSON.parse(scan.accessibility) }
  };
}

export default async function run() {
  suite('Accessibility');
  await lab.reset(FORMS);

  const tenant = await newTenant('Accessibility');
  const project = await createProject(tenant, 'Golden accessibility');
  const application = await registerApplication(tenant, project.id, {
    name: 'Forms lab', baseUrl: FORMS, loginUrl: FORMS, username: 'n/a', password: 'n/a'
  });
  const qa = await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: FORMS, apiBaseUrl: FORMS
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  const strict = await accessibilityTest(
    tenant, project, application, { failOn: 'serious' }, 'The form is accessible');
  const reportOnly = await accessibilityTest(
    tenant, project, application, { failOn: null }, 'Accessibility, reported not enforced');

  // ---- ACC-001: a clean page reports clean, and says what it checked ------
  await golden({
    id: 'ACC-001',
    objective: 'A page with no violations passes, and the result says what was actually run',
    preconditions: ['the forms lab with no faults injected'],
    input: 'A checkAccessibility step against the application form',
    expected: 'The step passes, no violations, and the result records the rules that passed '
      + 'and the standards used — so a clean result is readable as "no violations found by '
      + 'these rules" rather than as "accessible"',
    evidence: ['scan.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(FORMS);
      const { run: finished, scan } = await runAndRead(tenant, project, qa, strict, 'ACC-001 clean');
      const result = scan?.accessibility;

      return {
        // A scanner that reports violations on a clean page is as broken as one that
        // reports none on a bad page.
        pass: finished?.status === 'passed'
          && result !== undefined
          && result.violations.length === 0
          && result.passCount >= 15
          && result.standards.includes('wcag21aa')
          && result.engine?.name === 'axe-core',
        detail: `run ${finished?.status}; ${result?.violations?.length ?? '?'} violation(s), `
          + `${result?.passCount ?? '?'} rule(s) passed, ${result?.incompleteCount ?? '?'} incomplete; `
          + `${result?.engine?.name} ${result?.engine?.version}`,
        metrics: { violations: result?.violations?.length ?? -1, rulesPassed: result?.passCount ?? -1 },
        evidence: { 'scan.json': result ?? { nothing: 'was recorded' } }
      };
    }
  }, context);

  // ---- ACC-002: each known fault trips its own rule ----------------------
  await golden({
    id: 'ACC-002',
    objective: 'Every accessibility fault in the lab is found, and found as the rule it is',
    preconditions: ["the lab's ground truth names the axe rule each fault trips"],
    input: `Each of the ${A11Y_FAULTS.length} accessibility faults, injected one at a time`,
    expected: 'Each fault produces exactly the rule its ground truth names, at the impact '
      + 'it names — "the scanner found something" is not evidence it finds the right things',
    evidence: ['measured.json'],
    severity: 'critical',
    run: async () => {
      const measured = [];

      for (const fault of A11Y_FAULTS) {
        await lab.reset(FORMS);
        await lab.set(FORMS, { [fault.id]: true });

        const { scan } = await runAndRead(
          tenant, project, qa, reportOnly, `ACC-002 ${fault.id}`);
        const result = scan?.accessibility;
        const expected = fault.accessibility;

        const found = (result?.violations ?? []).map(violation => violation.id);
        const hit = result?.violations?.find(violation => violation.id === expected.expectedRule);

        measured.push({
          fault: fault.id,
          expects: expected,
          violations: found,
          incomplete: result?.incompleteCount ?? null,
          // A violation and an incomplete are different answers, and the lab records
          // which one each fault is supposed to produce.
          correct: expected.outcome === 'violation'
            ? hit !== undefined && hit.impact === expected.expectedImpact
            : found.length === 0 && (result?.incompleteCount ?? 0) > 0
        });
      }

      await lab.reset(FORMS);
      const wrong = measured.filter(entry => !entry.correct);

      return {
        pass: measured.length === A11Y_FAULTS.length && wrong.length === 0,
        detail: wrong.length === 0
          ? `${measured.length} fault(s), each producing exactly what its ground truth names`
          : `MISMATCH: ${wrong.map(entry =>
              `${entry.fault} expected ${entry.expects.outcome} "${entry.expects.expectedRule}", `
              + `got [${entry.violations.join(', ') || 'none'}] and ${entry.incomplete} incomplete`).join('; ')}`,
        metrics: { faults: measured.length, mismatches: wrong.length },
        evidence: { 'measured.json': measured }
      };
    }
  }, context);

  // ---- ACC-003: the threshold decides, and the finding is kept either way -
  await golden({
    id: 'ACC-003',
    objective: 'failOn decides whether a violation fails the step, and the result is stored either way',
    preconditions: ['a fault producing a critical violation'],
    input: 'The same page scanned with failOn "serious" and with failOn null',
    expected: 'The strict step fails and the report-only step passes — and both record the '
      + 'violations, because a team adopting this on an application that already has '
      + 'findings needs the numbers from day one and the build failing when they choose',
    evidence: ['strict.json', 'reportOnly.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(FORMS);
      await lab.set(FORMS, { FAULT_A11Y_MISSING_LABEL: true });

      const enforced = await runAndRead(tenant, project, qa, strict, 'ACC-003 enforced');
      const observed = await runAndRead(tenant, project, qa, reportOnly, 'ACC-003 observed');
      await lab.reset(FORMS);

      const strictResult = enforced.scan?.accessibility;
      const openResult = observed.scan?.accessibility;

      return {
        pass: enforced.run?.status === 'failed'
          && observed.run?.status === 'passed'
          // Both keep the findings. A failure that says "1 violation" and drops the list
          // is half a report, and a passing report-only scan that stored nothing would be
          // no better than not running.
          && strictResult?.violations?.length === 1
          && openResult?.violations?.length === 1
          && /label/.test(enforced.execution?.errorMessage ?? ''),
        detail: `failOn serious: run ${enforced.run?.status}, `
          + `${strictResult?.violations?.length} violation(s) stored; `
          + `failOn null: run ${observed.run?.status}, `
          + `${openResult?.violations?.length} violation(s) stored`,
        evidence: { 'strict.json': strictResult, 'reportOnly.json': openResult }
      };
    }
  }, context);

  // ---- ACC-004: the failure message is actionable ------------------------
  await golden({
    id: 'ACC-004',
    objective: 'A failing check names the rule, the element and where to read about it',
    preconditions: ['two faults producing critical violations'],
    input: 'A strict scan of a page with a missing label and an unnamed button',
    expected: 'The message carries both rule ids, a CSS selector for each, and the Deque '
      + 'help URL — somebody has to be able to fix this without opening the platform',
    evidence: ['message.txt', 'scan.json'],
    severity: 'high',
    run: async () => {
      await lab.reset(FORMS);
      await lab.set(FORMS, { FAULT_A11Y_MISSING_LABEL: true, FAULT_A11Y_EMPTY_BUTTON: true });

      const { execution, scan } = await runAndRead(tenant, project, qa, strict, 'ACC-004 message');
      await lab.reset(FORMS);

      const message = execution?.errorMessage ?? '';

      return {
        pass: /label/.test(message)
          && /button-name/.test(message)
          && /dequeuniversity\.com/.test(message)
          && scan?.accessibility?.violations?.every(violation => violation.nodes?.[0]?.target?.length > 0),
        detail: `${scan?.accessibility?.violations?.length ?? '?'} violation(s); `
          + `message ${message.length}B, names rules: `
          + `${/label/.test(message) && /button-name/.test(message)}, `
          + `carries help URL: ${/dequeuniversity\.com/.test(message)}`,
        evidence: { 'message.txt': message, 'scan.json': scan?.accessibility }
      };
    }
  }, context);

  // ---- ACC-005: the gate reports unmeasured, not zero --------------------
  await golden({
    id: 'ACC-005',
    objective: 'A run with no accessibility step reports the metric as unmeasured, never as zero',
    preconditions: ['a gate rule on accessibility, and a run that checks nothing'],
    input: 'A run of a test with no checkAccessibility step, against a project with an '
      + 'accessibility gate rule',
    expected: 'The rule is reported as not measured and sent for review — a rule that passed '
      + 'because nothing looked reads as a guarantee that the page is accessible',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const gated = await createProject(tenant, 'Accessibility gate');
      const gatedApp = await registerApplication(tenant, gated.id, {
        name: 'Forms gated', baseUrl: FORMS, loginUrl: FORMS, username: 'n/a', password: 'n/a'
      });
      const gatedEnv = await createEnvironment(tenant, gated.id, {
        name: 'QA', key: 'qa', kind: 'qa', baseUrl: FORMS, apiBaseUrl: FORMS
      });

      await request(`/api/v1/quality-gates?projectId=${gated.id}`, {
        token: tenant.token, method: 'POST',
        body: {
          name: 'No serious accessibility violations',
          metric: 'accessibilitySeriousCount', operator: 'equal', threshold: 0,
          action: 'fail', message: 'This project does not ship serious accessibility violations.'
        }
      });

      // A journey that never scans anything.
      const noScan = await importJourney(tenant, {
        projectId: gated.id, applicationId: gatedApp.id,
        journey: journey({
          name: 'Just opens the page', startUrl: FORMS,
          steps: [step.navigate(FORMS, 'Open the application form')]
        })
      });

      await lab.reset(FORMS);
      const started = await startRun(tenant, {
        projectId: gated.id, testCaseIds: [noScan.testCaseId],
        name: 'ACC-005 nothing checked', environmentId: gatedEnv.id
      });
      await waitForRun(tenant, started.id);

      const { json: gate } = await request(
        `/api/v1/testruns/${started.id}/quality-gate`, { token: tenant.token });

      const rule = gate?.rules?.find(entry => entry.metric === 'accessibilitySeriousCount');

      return {
        pass: rule !== undefined
          && rule.measured === false
          && rule.passed === false
          && /not measured/i.test(rule.explanation ?? ''),
        detail: `rule measured=${rule?.measured} passed=${rule?.passed}; `
          + `outcome ${gate?.outcome}; "${(rule?.explanation ?? '').slice(0, 120)}"`,
        evidence: { 'gate.json': gate }
      };
    }
  }, context);

  // ---- ACC-006: the gate counts what a check found ------------------------
  await golden({
    id: 'ACC-006',
    objective: 'A run that does check reports the number it found, and the gate acts on it',
    preconditions: ['a gate rule on accessibility, and a run that scans a broken page'],
    input: 'A report-only scan of a page with two critical violations',
    expected: 'The metric is measured at 2 and the rule blocks — report-only means the '
      + 'step does not fail, not that the finding disappears',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const gated = await createProject(tenant, 'Accessibility gate measured');
      const gatedApp = await registerApplication(tenant, gated.id, {
        name: 'Forms gated 2', baseUrl: FORMS, loginUrl: FORMS, username: 'n/a', password: 'n/a'
      });
      const gatedEnv = await createEnvironment(tenant, gated.id, {
        name: 'QA', key: 'qa', kind: 'qa', baseUrl: FORMS, apiBaseUrl: FORMS
      });
      await request(`/api/v1/quality-gates?projectId=${gated.id}`, {
        token: tenant.token, method: 'POST',
        body: {
          name: 'No serious accessibility violations',
          metric: 'accessibilitySeriousCount', operator: 'equal', threshold: 0,
          action: 'fail', message: 'This project does not ship serious accessibility violations.'
        }
      });

      const scanning = await accessibilityTest(
        tenant, gated, gatedApp, { failOn: null }, 'Scans but does not enforce');

      await lab.reset(FORMS);
      await lab.set(FORMS, { FAULT_A11Y_MISSING_LABEL: true, FAULT_A11Y_EMPTY_BUTTON: true });

      const started = await startRun(tenant, {
        projectId: gated.id, testCaseIds: [scanning],
        name: 'ACC-006 scanned', environmentId: gatedEnv.id
      });
      const finished = await waitForRun(tenant, started.id);
      await lab.reset(FORMS);

      const { json: gate } = await request(
        `/api/v1/testruns/${started.id}/quality-gate`, { token: tenant.token });
      const rule = gate?.rules?.find(entry => entry.metric === 'accessibilitySeriousCount');

      return {
        // The step passed — failOn was null — and the gate still blocked. That separation
        // is the point: measuring and enforcing are different decisions.
        pass: finished?.status === 'passed'
          && rule?.measured !== false
          && rule?.actualValue === 2
          && rule?.passed === false
          && gate?.outcome === 'fail',
        detail: `run ${finished?.status}; metric measured ${rule?.actualValue}; `
          + `rule passed=${rule?.passed}; gate ${gate?.outcome}`,
        metrics: { measured: rule?.actualValue ?? -1 },
        evidence: { 'gate.json': gate }
      };
    }
  }, context);
}
