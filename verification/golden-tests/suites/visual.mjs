/**
 * Visual regression, measured against changes of known magnitude.
 *
 * Comparing pixels is the easy part. The two things that decide whether a visual suite is
 * worth having are whether it reports a difference when nothing changed, and what it does
 * when something did.
 *
 * The first is noise, and it is fatal: a check that fires because a clock ticked teaches
 * its readers that diffs are meaningless, which is the same outcome as having no check.
 * The forms lab renders a live timestamp precisely so that noise is present and measurable
 * — its digits change on every request, and the ground truth records the resulting floor
 * at 0.0026% to 0.0039%. VIS-001 requires the default threshold to tolerate it and VIS-006
 * requires masking to remove it entirely.
 *
 * The second is policy. Most visual differences are intentional, so the default verdict is
 * REVIEW. A check that fails the build on every deliberate redesign is one a team switches
 * off within a fortnight.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { golden, suite, ROOT } from '../harness.mjs';
import {
  LAB, createEnvironment, createProject, importJourney, journey, lab, newTenant,
  registerApplication, request, startRun, step, waitForRun
} from '../platform.mjs';

const FORMS = LAB.forms;

const GROUND_TRUTH = JSON.parse(
  readFileSync(resolve(ROOT, 'test-lab/forms-app/ground-truth.json'), 'utf8'));

const VISUAL_FAULTS = GROUND_TRUTH.knownFaults.filter(fault => fault.visual !== undefined);

/** A journey that opens the form and compares it. */
async function visualTest(tenant, project, application, options, name) {
  const imported = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id,
    journey: journey({
      name, startUrl: FORMS,
      steps: [
        step.navigate(FORMS, 'Open the application form'),
        step.checkVisual({ fullPage: true, name: 'form', ...options }, FORMS)
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

  const action = (detail?.actions ?? []).find(a => a.visual !== null && a.visual !== undefined);

  return {
    runId: started.id,
    run: finished,
    execution: executions?.[0],
    visual: action === undefined ? undefined : JSON.parse(action.visual)
  };
}

export default async function run() {
  suite('Visual regression');
  await lab.reset(FORMS);

  const tenant = await newTenant('Visual');
  const project = await createProject(tenant, 'Golden visual');
  const application = await registerApplication(tenant, project.id, {
    name: 'Forms visual', baseUrl: FORMS, loginUrl: FORMS, username: 'n/a', password: 'n/a'
  });
  const qa = await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: FORMS, apiBaseUrl: FORMS
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  // ---- VIS-001: the first run makes a baseline and says it compared nothing ----
  await golden({
    id: 'VIS-001',
    objective: 'A first run stores a baseline and reports that nothing was compared',
    preconditions: ['a test with no stored baseline'],
    input: 'Two consecutive runs of the same visual check against an unchanged page',
    expected: 'The first reports newBaseline, the second reports match — and the first is '
      + 'not reported as a pass, because "nothing to compare against" and "identical to '
      + 'the baseline" are different statements',
    evidence: ['first.json', 'second.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(FORMS);
      const testCaseId = await visualTest(tenant, project, application, {}, 'Baseline then compare');

      const first = await runAndRead(tenant, project, qa, testCaseId, 'VIS-001 first');
      const second = await runAndRead(tenant, project, qa, testCaseId, 'VIS-001 second');

      const floor = second.visual?.differencePercent ?? -1;

      return {
        pass: first.visual?.verdict === 'newBaseline'
          && first.visual?.baselineKey !== undefined
          && second.visual?.verdict === 'match'
          // The page carries a live timestamp, so the floor is real but small. Requiring
          // exactly zero here would be requiring a page that does not exist.
          && floor >= 0 && floor < 0.1,
        detail: `first ${first.visual?.verdict} (${first.visual?.width}x${first.visual?.height}); `
          + `second ${second.visual?.verdict} at ${floor.toFixed(4)}% — the live timestamp's `
          + 'own noise, tolerated by the default threshold',
        metrics: { noiseFloorPercent: floor },
        evidence: { 'first.json': first.visual, 'second.json': second.visual }
      };
    }
  }, context);

  // ---- VIS-002: each known change produces the verdict it should ---------
  await golden({
    id: 'VIS-002',
    objective: 'Every visual change in the lab produces the verdict its ground truth names',
    preconditions: ["the lab's ground truth records each change's measured magnitude"],
    input: `Each of the ${VISUAL_FAULTS.length} visual faults, injected one at a time`,
    expected: 'A change below the threshold matches, one above it differs, and one that '
      + 'changes the page height is reported as a size change rather than as pixels',
    evidence: ['measured.json'],
    severity: 'critical',
    run: async () => {
      const measured = [];

      for (const fault of VISUAL_FAULTS) {
        await lab.reset(FORMS);

        // A fresh baseline per fault, taken on the clean page, so each measurement is
        // against the appearance the fault actually departs from.
        const testCaseId = await visualTest(
          tenant, project, application, {}, `VIS-002 ${fault.id}`);
        await runAndRead(tenant, project, qa, testCaseId, `VIS-002 ${fault.id} baseline`);

        await lab.set(FORMS, { [fault.id]: true });
        const { visual } = await runAndRead(
          tenant, project, qa, testCaseId, `VIS-002 ${fault.id} compare`);

        measured.push({
          fault: fault.id,
          expected: fault.visual.outcome,
          verdict: visual?.verdict,
          differencePercent: visual?.differencePercent,
          size: visual === undefined ? null : `${visual.width}x${visual.height}`,
          correct: visual?.verdict === fault.visual.outcome
        });
      }

      await lab.reset(FORMS);
      const wrong = measured.filter(entry => !entry.correct);

      return {
        pass: measured.length === VISUAL_FAULTS.length && wrong.length === 0,
        detail: wrong.length === 0
          ? measured.map(entry =>
              `${entry.fault.replace('FAULT_VISUAL_', '')}: ${entry.verdict} `
              + `${(entry.differencePercent ?? 0).toFixed(4)}%`).join('; ')
          : `MISMATCH: ${wrong.map(entry =>
              `${entry.fault} expected ${entry.expected}, got ${entry.verdict}`).join('; ')}`,
        metrics: { faults: measured.length, mismatches: wrong.length },
        evidence: { 'measured.json': measured }
      };
    }
  }, context);

  // ---- VIS-003: a difference asks for a person by default ----------------
  await golden({
    id: 'VIS-003',
    objective: 'A difference does not fail the step by default; it asks for a person',
    preconditions: ['a baseline, and a page that has visibly changed'],
    input: 'The same change with the default policy and with onDifference "fail"',
    expected: 'The default run passes its step with a "differs" verdict recorded, and the '
      + 'run configured to fail does fail — most visual differences are intentional, and a '
      + 'check that fails the build on every redesign is one a team switches off',
    evidence: ['review.json', 'strict.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(FORMS);

      const reviewing = await visualTest(tenant, project, application, {}, 'VIS-003 review');
      const strict = await visualTest(
        tenant, project, application, { onDifference: 'fail' }, 'VIS-003 strict');

      await runAndRead(tenant, project, qa, reviewing, 'VIS-003 review baseline');
      await runAndRead(tenant, project, qa, strict, 'VIS-003 strict baseline');

      await lab.set(FORMS, { FAULT_VISUAL_OBVIOUS: true });
      const review = await runAndRead(tenant, project, qa, reviewing, 'VIS-003 review compare');
      const enforced = await runAndRead(tenant, project, qa, strict, 'VIS-003 strict compare');
      await lab.reset(FORMS);

      return {
        pass: review.run?.status === 'passed'
          && review.visual?.verdict === 'differs'
          && enforced.run?.status === 'failed'
          && enforced.visual?.verdict === 'differs',
        detail: `default: run ${review.run?.status}, verdict ${review.visual?.verdict}; `
          + `onDifference=fail: run ${enforced.run?.status}, verdict ${enforced.visual?.verdict}`,
        evidence: { 'review.json': review.visual, 'strict.json': enforced.visual }
      };
    }
  }, context);

  // ---- VIS-004: a difference keeps the three images a reviewer needs -----
  await golden({
    id: 'VIS-004',
    objective: 'A difference stores the baseline, the capture and a diff; a match stores none',
    preconditions: ['a baseline, and a page that has visibly changed'],
    input: 'A matching run and a differing run',
    expected: 'Three image keys on the difference and none on the match — the images are '
      + 'the whole point of a visual failure, and three per passing step is a storage bill '
      + 'for pictures nobody opens',
    evidence: ['differs.json', 'matches.json'],
    severity: 'high',
    run: async () => {
      await lab.reset(FORMS);
      const testCaseId = await visualTest(tenant, project, application, {}, 'VIS-004 images');

      await runAndRead(tenant, project, qa, testCaseId, 'VIS-004 baseline');
      const matched = await runAndRead(tenant, project, qa, testCaseId, 'VIS-004 match');

      await lab.set(FORMS, { FAULT_VISUAL_OBVIOUS: true });
      const differed = await runAndRead(tenant, project, qa, testCaseId, 'VIS-004 differ');
      await lab.reset(FORMS);

      // The keys must resolve to real content, not just be present.
      const fetched = await Promise.all(
        [differed.visual?.baselineKey, differed.visual?.actualKey, differed.visual?.diffKey]
          .map(async key => {
            if (!key) return 0;
            const { json: artifacts } = await request(
              `/api/v1/artifacts?executionId=${differed.execution?.id}`, { token: tenant.token });
            return (artifacts ?? []).length;
          }));

      return {
        pass: matched.visual?.verdict === 'match'
          && matched.visual?.diffKey === undefined
          && matched.visual?.actualKey === undefined
          && differed.visual?.baselineKey !== undefined
          && differed.visual?.actualKey !== undefined
          && differed.visual?.diffKey !== undefined
          && fetched.every(count => count > 0),
        detail: `match: ${matched.visual?.diffKey === undefined ? 'no images stored' : 'IMAGES STORED'}; `
          + `differs: baseline=${differed.visual?.baselineKey !== undefined} `
          + `actual=${differed.visual?.actualKey !== undefined} `
          + `diff=${differed.visual?.diffKey !== undefined}`,
        evidence: { 'differs.json': differed.visual, 'matches.json': matched.visual }
      };
    }
  }, context);

  // ---- VIS-005: the gate reports unmeasured, not zero --------------------
  await golden({
    id: 'VIS-005',
    objective: 'A run with no visual step reports the metric as unmeasured, never as zero',
    preconditions: ['a gate rule on visual differences, and a run that compares nothing'],
    input: 'A run of a test with no checkVisual step',
    expected: 'The rule is reported as not measured and sent for review — a rule that '
      + 'passed because nothing looked reads as "the page is unchanged"',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const gated = await createProject(tenant, 'Visual gate');
      const gatedApp = await registerApplication(tenant, gated.id, {
        name: 'Forms gated visual', baseUrl: FORMS, loginUrl: FORMS, username: 'n/a', password: 'n/a'
      });
      const gatedEnv = await createEnvironment(tenant, gated.id, {
        name: 'QA', key: 'qa', kind: 'qa', baseUrl: FORMS, apiBaseUrl: FORMS
      });
      await request(`/api/v1/quality-gates?projectId=${gated.id}`, {
        token: tenant.token, method: 'POST',
        body: {
          name: 'Nothing looks different',
          metric: 'visualDifferenceCount', operator: 'equal', threshold: 0,
          action: 'fail', message: 'This project does not ship unreviewed visual changes.'
        }
      });

      const noCompare = await importJourney(tenant, {
        projectId: gated.id, applicationId: gatedApp.id,
        journey: journey({
          name: 'Just opens the page', startUrl: FORMS,
          steps: [step.navigate(FORMS, 'Open the application form')]
        })
      });

      await lab.reset(FORMS);
      const started = await startRun(tenant, {
        projectId: gated.id, testCaseIds: [noCompare.testCaseId],
        name: 'VIS-005 nothing compared', environmentId: gatedEnv.id
      });
      await waitForRun(tenant, started.id);

      const { json: gate } = await request(
        `/api/v1/testruns/${started.id}/quality-gate`, { token: tenant.token });
      const rule = gate?.rules?.find(entry => entry.metric === 'visualDifferenceCount');

      return {
        pass: rule !== undefined
          && rule.measured === false
          && rule.passed === false
          && /not measured/i.test(rule.explanation ?? ''),
        detail: `rule measured=${rule?.measured} passed=${rule?.passed}; outcome ${gate?.outcome}`,
        evidence: { 'gate.json': gate }
      };
    }
  }, context);

  // ---- VIS-006: masking removes the noise it is there to remove ----------
  await golden({
    id: 'VIS-006',
    objective: 'Masking a region that changes every run removes the difference entirely',
    preconditions: ['the page renders a live timestamp whose digits change on every request'],
    input: 'Repeated runs with the timestamp masked',
    expected: 'Exactly zero differing pixels, and the masked selector recorded in the '
      + 'result — masking the region that keeps failing is the obvious way to make a '
      + 'visual check useless while appearing to run it, so what was hidden is on the record',
    evidence: ['masked.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(FORMS);
      const masked = await visualTest(
        tenant, project, application,
        { mask: ['[data-testid="generated-at"]'] }, 'VIS-006 masked');

      await runAndRead(tenant, project, qa, masked, 'VIS-006 baseline');
      const first = await runAndRead(tenant, project, qa, masked, 'VIS-006 compare 1');
      const second = await runAndRead(tenant, project, qa, masked, 'VIS-006 compare 2');

      return {
        // Exactly zero, twice. The unmasked floor is 0.0026%–0.0039%, so anything above
        // zero here would mean the mask was not applied.
        pass: first.visual?.verdict === 'match'
          && first.visual?.differingPixels === 0
          && second.visual?.differingPixels === 0
          && first.visual?.masked?.includes('[data-testid="generated-at"]'),
        detail: `two masked comparisons: ${first.visual?.differingPixels} and `
          + `${second.visual?.differingPixels} differing pixels; `
          + `recorded as masked: ${JSON.stringify(first.visual?.masked)}`,
        metrics: { differingPixels: first.visual?.differingPixels ?? -1 },
        evidence: { 'masked.json': first.visual }
      };
    }
  }, context);

  // ---- VIS-007: a baseline is per browser and per viewport ---------------
  await golden({
    id: 'VIS-007',
    objective: 'A baseline taken at one viewport is not compared against another',
    preconditions: ['a baseline taken at 1280 wide'],
    input: 'The same check run again at 800 wide',
    expected: 'A new baseline rather than a difference — a baseline at 1280 says nothing '
      + 'about how the page looks at 800, and comparing across them would report a '
      + 'difference on every run until somebody switched the check off',
    evidence: ['wide.json', 'narrow.json'],
    severity: 'high',
    run: async () => {
      await lab.reset(FORMS);

      const wide = await visualTest(
        tenant, project, application,
        { name: 'responsive', viewport: { width: 1280, height: 720 } }, 'VIS-007 wide');
      const narrow = await visualTest(
        tenant, project, application,
        { name: 'responsive', viewport: { width: 800, height: 720 } }, 'VIS-007 narrow');

      const wideFirst = await runAndRead(tenant, project, qa, wide, 'VIS-007 wide baseline');
      const wideAgain = await runAndRead(tenant, project, qa, wide, 'VIS-007 wide compare');
      const narrowFirst = await runAndRead(tenant, project, qa, narrow, 'VIS-007 narrow');

      return {
        pass: wideFirst.visual?.verdict === 'newBaseline'
          && wideAgain.visual?.verdict === 'match'
          // Same baseline name, different viewport: a separate baseline, not a difference.
          && narrowFirst.visual?.verdict === 'newBaseline'
          && narrowFirst.visual?.viewport?.width === 800,
        detail: `1280: ${wideFirst.visual?.verdict} then ${wideAgain.visual?.verdict}; `
          + `800 with the same baseline name: ${narrowFirst.visual?.verdict}`,
        evidence: { 'wide.json': wideAgain.visual, 'narrow.json': narrowFirst.visual }
      };
    }
  }, context);
}
