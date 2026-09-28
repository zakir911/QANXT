/**
 * UI/API correlation: what the API was doing when a UI step failed.
 *
 * The claim is narrow and worth testing precisely. QA NXT has always recorded both the steps
 * a test took and the requests the page made; what it could not do was say which step made
 * which request, because the column holding that link was never written (BUG-0020). The
 * difference between "server errors happened somewhere in these twenty steps" and "the step
 * that failed asked for /api/accounts and was answered 500" is the difference between a
 * report someone reads and a report someone acts on.
 *
 * Every scenario here breaks the lab bank in a specific way and then reads back what the
 * diagnosis said about it. The most interesting one is the last: an application whose API
 * answers perfectly and whose page shows the wrong number.
 */
import { golden, suite } from '../harness.mjs';
import {
  LAB, createEnvironment, createProject, execute, importJourney, journey, lab, networkLog,
  newTenant, registerApplication, requireApiTest, request, step
} from '../platform.mjs';

const BANK = LAB.banking;
const CREDENTIALS = { username: 'alice', password: 'Password123!' };

export default async function run() {
  suite('UI/API correlation');
  await lab.reset(BANK);

  const tenant = await newTenant('Correlation');
  const project = await createProject(tenant, 'Golden correlation');
  const application = await registerApplication(tenant, project.id, {
    name: 'Lab Bank correlation', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
  });
  await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  /** A UI journey that opens an account and asserts its transactions are listed. */
  async function transactionsJourney(name) {
    return importJourney(tenant, {
      projectId: project.id,
      applicationId: application.id,
      journey: journey({
        name,
        startUrl: `${BANK}/dashboard`,
        steps: [
          step.navigate(`${BANK}/dashboard`, 'Open the dashboard'),
          step.click('nav-accounts', `${BANK}/dashboard`),
          step.click('open-account-acc-1001', `${BANK}/accounts`),
          step.assertVisible('transactions-table', `${BANK}/accounts/acc-1001`,
            'The transactions table is shown')
        ]
      })
    });
  }

  /** Runs a test with faults on and returns the run, the execution detail and the diagnosis. */
  async function diagnose(testCaseId, faults, name) {
    await lab.reset(BANK);
    if (Object.keys(faults).length > 0) await lab.set(BANK, faults);
    const result = await execute(tenant, {
      projectId: project.id, testCaseId, name, timeoutMs: 180_000
    });
    await lab.reset(BANK);
    return { ...result, analysis: result.detail?.failure?.analysis ?? null };
  }

  // ---- COR-001: the evidence knows which step made which call ------------
  await golden({
    id: 'COR-001',
    objective: 'Every recorded request is attributed to the step that made it',
    preconditions: ['the lab bank is running with no faults'],
    input: 'A three-step UI journey through the accounts pages',
    expected: 'The execution reports its API calls with the step each belongs to, so a '
      + 'reader sees the step and the request underneath it in one place',
    evidence: ['api-calls.json'],
    severity: 'critical',
    run: async () => {
      const imported = await transactionsJourney('Correlation — attribution');
      const { detail, run: testRun } = await diagnose(imported.testCaseId, {}, 'COR-001');

      const calls = detail?.apiCalls ?? [];
      const attributed = calls.filter(call => typeof call.actionOrder === 'number');
      const orders = new Set(attributed.map(call => call.actionOrder));

      return {
        // Without this, everything below is a coincidence of timestamps.
        pass: testRun?.status === 'passed' && calls.length > 0 && attributed.length === calls.length,
        detail: `${calls.length} API call(s) recorded, ${attributed.length} attributed to a step, `
          + `across step(s) ${[...orders].sort((a, b) => a - b).join(', ')}`,
        metrics: { calls: calls.length, attributed: attributed.length },
        evidence: { 'api-calls.json': calls }
      };
    }
  }, context);

  // ---- COR-002: a UI failure is traced to the call underneath it ---------
  await golden({
    id: 'COR-002',
    objective: 'A UI step that fails because its own API call returned 500 is diagnosed as that',
    preconditions: ['FAULT_TRANSACTIONS_API_500 is enabled: sign-in works, the transactions call does not'],
    input: 'The same journey while the call the account page makes answers 500',
    expected: 'A diagnosis that names the endpoint and the status rather than counting '
      + 'errors somewhere in the execution. Whether the call is attributed to the failing '
      + 'step or to the one before it depends on when the page issues the fetch, and both '
      + 'are correct answers; what must not happen is a verdict that names neither',
    evidence: ['analysis.json', 'api-calls.json'],
    severity: 'critical',
    run: async () => {
      const imported = await transactionsJourney('Correlation — server error');
      const { detail, run: testRun, analysis } = await diagnose(
        imported.testCaseId, { FAULT_TRANSACTIONS_API_500: true }, 'COR-002');

      const calls = detail?.apiCalls ?? [];
      const failed = calls.filter(call => call.isFailed || (call.statusCode ?? 0) >= 400);

      return {
        pass: testRun?.status !== 'passed'
          && analysis !== null
          && analysis.category === 'applicationDefect'
          && analysis.confidence >= 90
          // Either correlated form, but a correlated one: the uncorrelated verdict says
          // "server errors during this execution" and names nothing.
          && /the API call it made|The step before this one/.test(analysis.summary ?? '')
          && analysis.evidence?.includes('/api/accounts/acc-1001/transactions'),
        detail: analysis === null
          ? `run ${testRun?.status} with no analysis recorded`
          : `${analysis.category} at ${analysis.confidence}%: "${analysis.summary}" — `
            + `${failed.length} failed call(s) recorded`,
        metrics: { confidence: analysis?.confidence ?? null },
        evidence: { 'analysis.json': analysis, 'api-calls.json': calls }
      };
    }
  }, context);

  // ---- COR-003: an API test's own failure names its endpoint -------------
  await golden({
    id: 'COR-003',
    objective: "An API test's failure is diagnosed from the call the failing step made",
    preconditions: ['FAULT_API_500 is enabled'],
    input: 'An API test whose sign-in request is answered 500',
    expected: 'A diagnosis at high confidence naming the method, the path and the status',
    evidence: ['analysis.json'],
    severity: 'critical',
    run: async () => {
      const apiTest = await requireApiTest(tenant, {
        projectId: project.id,
        applicationId: application.id,
        suiteName: 'Correlation — API',
        name: 'Sign in over the API',
        steps: [{
          description: 'Sign in',
          request: {
            method: 'POST', path: '/api/session', contentType: 'application/json',
            body: JSON.stringify({ username: CREDENTIALS.username, password: '${secret:app_password}' }),
            auth: { mode: 'none' }
          },
          assertions: [{ type: 'httpStatusEquals', expected: '200' }]
        }]
      });

      const { analysis, run: testRun } = await diagnose(
        apiTest.testCaseId, { FAULT_API_500: true }, 'COR-003');

      const names = text => text?.includes('/api/session') && text?.includes('500');

      return {
        pass: testRun?.status === 'failed'
          && analysis?.category === 'applicationDefect'
          && analysis.confidence >= 90
          && (names(analysis.summary) || names(analysis.likelyCause) || names(analysis.evidence)),
        detail: analysis === null
          ? `run ${testRun?.status} with no analysis`
          : `${analysis.category} at ${analysis.confidence}%: "${analysis.summary}" / `
            + `"${(analysis.likelyCause ?? '').slice(0, 120)}"`,
        metrics: { confidence: analysis?.confidence ?? null },
        evidence: { 'analysis.json': analysis }
      };
    }
  }, context);

  // ---- COR-004: a dropped request is a network issue, named --------------
  await golden({
    id: 'COR-004',
    objective: 'A request that never completed is diagnosed as a network issue and named',
    preconditions: ['FAULT_NETWORK_ERROR is enabled'],
    input: 'An API test whose request is destroyed at the network layer',
    expected: 'A networkIssue diagnosis naming the endpoint, not an application defect',
    evidence: ['analysis.json'],
    severity: 'critical',
    run: async () => {
      const apiTest = await requireApiTest(tenant, {
        projectId: project.id,
        applicationId: application.id,
        suiteName: 'Correlation — API',
        name: 'Sign in over the API, with the connection dropped',
        steps: [{
          description: 'Sign in',
          request: {
            method: 'POST', path: '/api/session', contentType: 'application/json',
            body: JSON.stringify({ username: CREDENTIALS.username, password: '${secret:app_password}' }),
            auth: { mode: 'none' }, timeoutMs: 8000
          },
          assertions: [{ type: 'httpStatusEquals', expected: '200' }]
        }]
      });

      const { analysis, run: testRun } = await diagnose(
        apiTest.testCaseId, { FAULT_NETWORK_ERROR: true }, 'COR-004');

      return {
        // Reporting this as an application defect sends someone to the wrong team.
        pass: testRun?.status === 'failed'
          && analysis?.category === 'networkIssue'
          && analysis.isLikelyApplicationDefect === false,
        detail: analysis === null
          ? `run ${testRun?.status} with no analysis`
          : `${analysis.category} at ${analysis.confidence}%: "${analysis.summary}"`,
        evidence: { 'analysis.json': analysis }
      };
    }
  }, context);

  // ---- COR-005: a correct API and a wrong page ---------------------------
  await golden({
    id: 'COR-005',
    objective: 'A failure where the API answered correctly is attributed to the front end',
    preconditions: ['FAULT_WRONG_BALANCE is enabled: the accounts are right and the total is not'],
    input: 'A UI assertion on the dashboard total while every API call succeeds',
    expected: 'A diagnosis saying the API answered correctly and the page showed something '
      + 'else, rather than a generic assertion failure',
    evidence: ['analysis.json', 'api-calls.json'],
    severity: 'critical',
    run: async () => {
      // This is the case nothing could say before. The dashboard endpoint returns the
      // correct accounts and an inflated total; every request is a 200, and the number on
      // the screen is wrong. Whoever reads this should be sent to the rendering, not to
      // the service.
      const imported = await importJourney(tenant, {
        projectId: project.id,
        applicationId: application.id,
        journey: journey({
          name: 'Correlation — the total is wrong',
          startUrl: `${BANK}/dashboard`,
          steps: [
            step.navigate(`${BANK}/dashboard`, 'Open the dashboard'),
            step.assertText('total-balance', '£74,343.08', `${BANK}/dashboard`,
              'The dashboard shows the sum of the accounts')
          ]
        })
      });

      const { detail, run: testRun, analysis } = await diagnose(
        imported.testCaseId, { FAULT_WRONG_BALANCE: true }, 'COR-005');

      const calls = detail?.apiCalls ?? [];
      const failedCalls = calls.filter(call => call.isFailed || (call.statusCode ?? 0) >= 400);

      return {
        pass: testRun?.status === 'failed'
          && failedCalls.length === 0
          && analysis?.summary === 'The API answered correctly and the page showed something else.'
          && analysis.isLikelyApplicationDefect === true,
        detail: analysis === null
          ? `run ${testRun?.status} with no analysis`
          : `${calls.length} API call(s), ${failedCalls.length} failed; `
            + `${analysis.category} at ${analysis.confidence}%: "${analysis.summary}"`,
        metrics: { calls: calls.length, failedCalls: failedCalls.length },
        evidence: { 'analysis.json': analysis, 'api-calls.json': calls }
      };
    }
  }, context);

  // ---- COR-006: a missing button is still a missing button ---------------
  await golden({
    id: 'COR-006',
    objective: "A signed-out page's own 401 never becomes the explanation for a removed control",
    preconditions: ['FAULT_LOGIN_BUTTON_REMOVED is enabled'],
    input: 'A journey that clicks the sign-in control, which is not rendered',
    expected: 'A locatorChange diagnosis; the 401 is reported as context, not as the cause '
      + '— the guard BUG-0015 added, now also at the correlated level',
    evidence: ['analysis.json'],
    severity: 'critical',
    run: async () => {
      const imported = await importJourney(tenant, {
        projectId: project.id,
        applicationId: application.id,
        journey: journey({
          name: 'Correlation — the sign-in control is gone',
          startUrl: `${BANK}/login`,
          steps: [
            // The journey signs in for itself, so a fault that removes the sign-in control
            // fails a step rather than blocking the run before any step executes.
            step.navigate(`${BANK}/login`, 'Open the sign-in page'),
            step.fill('username', CREDENTIALS.username, `${BANK}/login`),
            step.click('login-submit', `${BANK}/login`)
          ]
        })
      });

      const { analysis, run: testRun } = await diagnose(
        imported.testCaseId, { FAULT_LOGIN_BUTTON_REMOVED: true }, 'COR-006');

      return {
        pass: testRun?.status !== 'passed'
          && analysis?.category === 'locatorChange'
          && !(analysis.suggestedAction ?? '').includes('permissions'),
        detail: analysis === null
          ? `run ${testRun?.status} with no analysis`
          : `${analysis.category} at ${analysis.confidence}%: "${analysis.summary}"`,
        evidence: { 'analysis.json': analysis }
      };
    }
  }, context);

  // ---- COR-007: re-analysis of an old failure gains the correlation ------
  await golden({
    id: 'COR-007',
    objective: 'Re-analysing a stored failure rebuilds the correlation from the evidence',
    preconditions: ['a failure recorded by an earlier scenario'],
    input: 'Re-analyse the failure from COR-003 and compare the two verdicts',
    expected: 'The same correlated verdict, produced again from what was stored rather than '
      + 'carried forward',
    evidence: ['reanalysis.json'],
    severity: 'high',
    run: async () => {
      const apiTest = await requireApiTest(tenant, {
        projectId: project.id,
        applicationId: application.id,
        suiteName: 'Correlation — API',
        name: 'Read the accounts over the API',
        steps: [{
          description: 'Read the accounts with no credentials',
          request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' } },
          assertions: [{ type: 'httpStatusEquals', expected: '200' }]
        }]
      });

      const first = await diagnose(apiTest.testCaseId, {}, 'COR-007');
      const failureId = first.detail?.failure?.id;
      if (!failureId) {
        return { pass: false, detail: `no failure was recorded (run ${first.run?.status})` };
      }

      const reanalysed = await request(`/api/v1/failures/${failureId}/reanalyse`, {
        token: tenant.token, method: 'POST'
      });

      const before = first.analysis;
      const after = reanalysed.json;

      return {
        // The correlation has to survive the round trip through storage, or a re-analysis
        // silently loses the best evidence the platform has.
        pass: reanalysed.ok
          && after?.category === before?.category
          && after?.confidence === before?.confidence,
        detail: reanalysed.ok
          ? `first: ${before?.category} at ${before?.confidence}%; `
            + `re-analysed: ${after?.category} at ${after?.confidence}%`
          : `re-analysis was refused: ${reanalysed.status} ${reanalysed.text.slice(0, 200)}`,
        evidence: { 'reanalysis.json': { before, after } }
      };
    }
  }, context);
}
