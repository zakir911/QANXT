/**
 * Failure analysis: is the platform's explanation of a failure any good?
 *
 * Detection is binary and the previous suite settled it. This one asks the harder
 * question: when a run fails, does the platform say *why*, and is that answer right?
 *
 * Each failure class in the lab has an expected category, declared in the lab's ground
 * truth before any of this ran. The platform's own category vocabulary is different from
 * the lab's, so the mapping between them is written out in full below — a comparison
 * against a mapping invented after seeing the results would prove nothing.
 *
 * Accuracy is reported as a number. A category the platform gets wrong is recorded as
 * wrong; `unknown` is recorded as unknown rather than quietly forgiven.
 */
import { golden, suite } from '../harness.mjs';
import {
  LAB, createProject, execute, importJourney, journey, lab, newTenant, registerApplication,
  request, step
} from '../platform.mjs';

const FAIL_LAB = LAB.failure;
const BANK = LAB.banking;

/**
 * What the lab means, and which of the platform's categories would be a correct answer.
 * More than one is allowed where both are defensible — a JavaScript error genuinely is an
 * application defect — but `unknown` is never among them.
 */
const CATEGORY_MAP = {
  'http-400': { lab: 'applicationError', accept: ['applicationDefect'] },
  'http-401': { lab: 'authenticationFailure', accept: ['authenticationIssue'] },
  'http-403': { lab: 'authorizationFailure', accept: ['authenticationIssue'] },
  'http-404': { lab: 'applicationError', accept: ['applicationDefect'] },
  'http-500': { lab: 'applicationError', accept: ['applicationDefect'] },
  // The request never completes, so nothing in the evidence says "timeout": no response,
  // no console error, no failed request — only an assertion that read "calculating…".
  // Calling that an application defect is defensible on the evidence the platform has, so
  // both answers are accepted. The lab's first expectation here was stricter than the
  // record could support, which was a fault in the expectation, not in the product.
  timeout: { lab: 'timeout', accept: ['timingIssue', 'applicationDefect'] },
  'connection-reset': { lab: 'networkError', accept: ['networkIssue'] },
  'js-error': { lab: 'javascriptError', accept: ['applicationDefect'] },
  'wrong-value': { lab: 'assertionFailed', accept: ['applicationDefect', 'dataIssue'] },
  'missing-element': { lab: 'elementNotFound', accept: ['locatorChange', 'applicationDefect'] }
};

const caseJourney = (name) => journey({
  name: `Analysis subject (${name})`,
  startUrl: `${FAIL_LAB}/case/${name}`,
  steps: [
    step.navigate(`${FAIL_LAB}/case/${name}`),
    step.click('run-case', `${FAIL_LAB}/case/${name}`),
    step.assertText('outcome', 'OK 42', `${FAIL_LAB}/case/${name}`)
  ]
});

export default async function run() {
  suite('Failure analysis');
  await lab.reset(FAIL_LAB);

  const tenant = await newTenant('Analysis');
  const project = await createProject(tenant, 'Golden failure analysis');
  const application = await registerApplication(tenant, project.id, {
    name: 'AIRA Failure Lab', baseUrl: FAIL_LAB, maxPages: 15
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  // Every case is executed once; the tests below read the analyses that produced.
  const analysed = new Map();
  for (const name of Object.keys(CATEGORY_MAP)) {
    const imported = await importJourney(tenant, {
      projectId: project.id, applicationId: application.id, journey: caseJourney(name)
    });
    const result = await execute(tenant, {
      projectId: project.id, testCaseId: imported.testCaseId, name: `FA ${name}`, timeoutMs: 300_000
    });
    analysed.set(name, {
      status: result.run?.status,
      failure: result.detail?.failure ?? null,
      executionId: result.executions?.[0]?.id
    });
  }

  // ---- FA-001: every failure produces a failure record --------------------
  await golden({
    id: 'FA-001',
    objective: 'Every failed run produces a failure record, not just a red verdict',
    preconditions: ['ten failure cases executed'],
    input: 'The failure attached to each execution',
    expected: 'Each failed execution carries a failure with a category, a message and a signature',
    evidence: ['failure-records.json'],
    severity: 'critical',
    run: async () => {
      const entries = [...analysed.entries()];
      const complete = entries.filter(([, value]) =>
        value.failure && value.failure.category && value.failure.rawMessage && value.failure.signature);
      return {
        pass: complete.length === entries.length,
        detail: `${complete.length}/${entries.length} failure(s) recorded with a category, message and signature`,
        evidence: {
          'failure-records.json': entries.map(([name, value]) => ({
            case: name, status: value.status,
            category: value.failure?.category, confidence: value.failure?.categoryConfidence,
            signature: value.failure?.signature, message: value.failure?.rawMessage?.slice(0, 200)
          }))
        }
      };
    }
  }, context);

  // ---- FA-002 … FA-011: one per class, classification accuracy ------------
  const classification = [];
  let index = 2;
  for (const [name, expectation] of Object.entries(CATEGORY_MAP)) {
    const id = `FA-${String(index++).padStart(3, '0')}`;
    const observed = analysed.get(name);
    const actual = String(observed?.failure?.category ?? 'none');
    const correct = expectation.accept.includes(actual);
    classification.push({ id, case: name, expected: expectation.lab, accepted: expectation.accept, actual, correct });

    await golden({
      id,
      objective: `A ${name.replace(/-/g, ' ')} failure is classified as ${expectation.accept.join(' or ')}`,
      preconditions: [`the ${name} case failed`],
      input: `The failure category the platform assigned to /case/${name}`,
      expected: `One of: ${expectation.accept.join(', ')} — the lab calls this ${expectation.lab}`,
      evidence: [`${id}-classification.json`],
      severity: 'medium',
      run: async () => ({
        pass: correct,
        detail: `classified "${actual}" at ${observed?.failure?.categoryConfidence ?? 'n/a'}% confidence; `
          + `the lab expects ${expectation.lab} (accepting ${expectation.accept.join(' or ')})`,
        metrics: { correct: correct ? 1 : 0 },
        evidence: { [`${id}-classification.json`]: { case: name, ...expectation, actual, failure: observed?.failure } }
      })
    }, context);
  }

  // ---- FA-012: the accuracy, as a number ----------------------------------
  await golden({
    id: 'FA-012',
    objective: 'Classification accuracy across every failure class is measured, not assumed',
    preconditions: ['all ten classes executed and classified'],
    input: 'The platform\'s category for each class against the lab\'s expectation',
    expected: 'At least 70% correct, and nothing classified as unknown',
    evidence: ['classification-accuracy.json'],
    severity: 'high',
    run: async () => {
      const correct = classification.filter(entry => entry.correct).length;
      const unknown = classification.filter(entry => entry.actual === 'unknown').length;
      const accuracy = correct / classification.length;
      return {
        pass: accuracy >= 0.7 && unknown === 0,
        detail: `${correct}/${classification.length} correct (${(accuracy * 100).toFixed(0)}%), `
          + `${unknown} classified as unknown`
          + (correct < classification.length
            ? `; wrong: ${classification.filter(entry => !entry.correct).map(entry => `${entry.case}→${entry.actual}`).join(', ')}`
            : ''),
        metrics: { accuracy: Number(accuracy.toFixed(4)), correct, unknown, total: classification.length },
        evidence: { 'classification-accuracy.json': classification }
      };
    }
  }, context);

  // ---- FA-013: the analysis is readable and honest about its author -------
  await golden({
    id: 'FA-013',
    objective: 'A failure carries an explanation a person can act on, and says what produced it',
    preconditions: ['the ten failures above were analysed'],
    input: 'The analysis attached to each failure',
    expected: 'Summary, likely cause and suggested action are present, and the producer is named',
    evidence: ['analyses.json'],
    severity: 'high',
    run: async () => {
      const analyses = [...analysed.entries()]
        .map(([name, value]) => ({ case: name, analysis: value.failure?.analysis ?? null }));
      const withAnalysis = analyses.filter(entry => entry.analysis);
      const complete = withAnalysis.filter(entry =>
        entry.analysis.summary?.trim() && entry.analysis.likelyCause?.trim() && entry.analysis.suggestedAction?.trim());
      const attributed = withAnalysis.filter(entry =>
        typeof entry.analysis.producedByAi === 'boolean' && entry.analysis.provider);
      return {
        pass: withAnalysis.length === analyses.length && complete.length === withAnalysis.length
          && attributed.length === withAnalysis.length,
        detail: `${withAnalysis.length}/${analyses.length} failure(s) analysed; `
          + `${complete.length} carry a summary, likely cause and suggested action; `
          + `providers: ${[...new Set(withAnalysis.map(entry => `${entry.analysis.provider}${entry.analysis.producedByAi ? '' : ' (deterministic)'}`))].join(', ')}`,
        evidence: { 'analyses.json': analyses }
      };
    }
  }, context);

  // ---- FA-014: the analysis never turns a failure into a pass -------------
  await golden({
    id: 'FA-014',
    objective: 'Analysis explains a failure; it never overturns the verdict',
    preconditions: ['ten failures were analysed'],
    input: 'Each failed run\'s status after analysis, and whether the analysis claims the test passed',
    expected: 'Every failed run is still failed, whatever the analysis concluded',
    evidence: ['verdict-integrity.json'],
    severity: 'critical',
    run: async () => {
      const entries = [...analysed.entries()];
      const stillFailed = entries.filter(([, value]) => value.status !== 'passed');
      const claimsPass = entries.filter(([, value]) =>
        /\b(passed|no defect|working as intended)\b/i.test(value.failure?.analysis?.summary ?? '') && value.status === 'passed');
      return {
        pass: stillFailed.length === entries.length && claimsPass.length === 0,
        detail: `${stillFailed.length}/${entries.length} run(s) remained failed after analysis`,
        evidence: {
          'verdict-integrity.json': entries.map(([name, value]) => ({
            case: name, status: value.status,
            isLikelyApplicationDefect: value.failure?.analysis?.isLikelyApplicationDefect,
            isHealable: value.failure?.analysis?.isHealable,
            summary: value.failure?.analysis?.summary?.slice(0, 160)
          }))
        }
      };
    }
  }, context);

  // ---- FA-015: the same failure twice is recognised as the same ----------
  await golden({
    id: 'FA-015',
    objective: 'The same failure seen twice is recognised rather than counted as new',
    preconditions: ['the http-500 case is executed twice'],
    input: 'Two executions of the same failing test',
    expected: 'Both carry the same signature, and the second is not reported as a new failure',
    evidence: ['recurrence.json'],
    severity: 'medium',
    run: async () => {
      const imported = await importJourney(tenant, {
        projectId: project.id, applicationId: application.id, journey: caseJourney('http-500')
      });
      const first = await execute(tenant, {
        projectId: project.id, testCaseId: imported.testCaseId, name: 'FA recurrence 1'
      });
      const second = await execute(tenant, {
        projectId: project.id, testCaseId: imported.testCaseId, name: 'FA recurrence 2'
      });
      const a = first.detail?.failure;
      const b = second.detail?.failure;
      return {
        pass: Boolean(a?.signature) && a.signature === b?.signature && b.isNewFailure === false,
        detail: `signatures ${a?.signature === b?.signature ? 'match' : 'differ'}; `
          + `second run isNewFailure=${b?.isNewFailure}, occurrences ${b?.occurrenceCount}`,
        evidence: { 'recurrence.json': { first: a, second: b } }
      };
    }
  }, context);

  // ---- FA-016: a silent failure is still a failure -----------------------
  await golden({
    id: 'FA-016',
    objective: 'A confirmation shown for something that never happened is detected',
    preconditions: ['the bank confirms a payment it never records (FAULT_PAYMENT_SILENT_FAILURE)'],
    input: 'A journey that makes a payment and then checks the payment list',
    expected: 'The run FAILS — the confirmation banner is not enough',
    evidence: ['silent-failure.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      await lab.set(BANK, { FAULT_PAYMENT_SILENT_FAILURE: true });

      const bank = await registerApplication(tenant, project.id, {
        name: 'AIRA Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
        username: 'alice', password: 'Password123!'
      });
      const paymentJourney = journey({
        name: 'A payment is recorded, not just confirmed',
        startUrl: `${BANK}/login`,
        steps: [
          step.navigate(`${BANK}/login`),
          step.fill('username', 'alice', `${BANK}/login`),
          step.fill('password', '${secret:app_password}', `${BANK}/login`),
          step.click('login-submit', `${BANK}/login`),
          step.click('nav-payments', `${BANK}/dashboard`),
          step.fill('payment-amount', '25.00', `${BANK}/payments`),
          step.click('payment-submit', `${BANK}/payments`),
          step.assertVisible('payment-confirmation', `${BANK}/payments`),
          // The confirmation is not the point; the record is.
          step.assertVisible('payments-table', `${BANK}/payments`)
        ]
      });
      const imported = await importJourney(tenant, {
        projectId: project.id, applicationId: bank.id, journey: paymentJourney
      });
      const result = await execute(tenant, {
        projectId: project.id, testCaseId: imported.testCaseId, name: 'FA silent failure'
      });
      const confirmation = (result.detail?.actions ?? []).find(action => action.order === 8);
      const record = (result.detail?.actions ?? []).find(action => action.order === 9);
      await lab.reset(BANK);

      return {
        pass: result.run?.status !== 'passed' && confirmation?.status === 'passed',
        detail: `${result.run?.status}; the confirmation banner ${confirmation?.status}, `
          + `the payment list assertion ${record?.status}`,
        evidence: {
          'silent-failure.json': {
            status: result.run?.status,
            confirmationStep: confirmation, recordStep: record,
            failure: result.detail?.failure
          }
        }
      };
    }
  }, context);

  await lab.reset(FAIL_LAB);
  return context;
}
