/**
 * API testing, against the lab bank's real HTTP API.
 *
 * Every test here drives the product the way a team would: author an API test through the
 * platform's own endpoint, run it through the same engine that runs UI tests, and read the
 * evidence the run produced. Nothing is stubbed and nothing is asserted from source code.
 *
 * Several of these tests are about what the platform *refuses*. That is deliberate. The
 * reason API testing is worth having is that it can fail honestly, and the ways a test can
 * be written so that it cannot fail — no assertions, an assertion the executor cannot
 * evaluate, a request outside the authorization boundary, a credential inlined where it
 * will end up in a report — are exactly the ways an API suite quietly becomes decoration.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { golden, suite, ROOT } from '../harness.mjs';
import {
  API, LAB, createApiTest, createEnvironment, createGateRule, createProject, execute,
  lab, networkLog, newTenant, qualityGate, registerApplication, requireApiTest, request,
  startRun, testCase, waitForRun
} from '../platform.mjs';

const BANK = LAB.banking;
const CREDENTIALS = { username: 'alice', password: 'Password123!' };

/** The two-step sign-in-then-read sequence most of these tests are built from. */
function signInThenRead({ capture = true } = {}) {
  return [
    {
      description: 'Sign in through the API',
      request: {
        method: 'POST',
        path: '/api/session',
        body: JSON.stringify({ username: CREDENTIALS.username, password: '${secret:app_password}' }),
        contentType: 'application/json',
        auth: { mode: 'none' }
      },
      assertions: [
        { type: 'httpStatusEquals', expected: '200' },
        { type: 'responseJsonPathEquals', subject: 'user.username', expected: 'alice' }
      ]
    },
    {
      description: 'Read the accounts that session can see',
      request: {
        method: 'GET',
        path: '/api/accounts',
        auth: { mode: 'none' },
        ...(capture ? { capture: { accountId: 'accounts[0].id' } } : {})
      },
      assertions: [
        { type: 'httpStatusEquals', expected: '200' },
        { type: 'responseJsonPathExists', subject: 'accounts[0].balance' },
        { type: 'responseJsonPathMatches', subject: 'accounts[0].id', expected: '^acc-\\d+$' },
        { type: 'responseTimeUnderMs', expected: '5000' }
      ]
    }
  ];
}

/**
 * Runs the CLI as a pipeline would, and reports its exit status rather than throwing.
 *
 * Both streams are captured. The CLI writes results to stdout and progress to stderr on
 * purpose, so that `--json` output stays machine-readable — a test that read only stdout
 * would see an empty transcript for every command whose output is meant for a person.
 */
function cli(args, { token, projectId } = {}) {
  const binary = resolve(ROOT, 'packages/cli/dist/qanxt.js');
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    env: {
      ...process.env,
      QANXT_API_URL: API,
      QANXT_TOKEN: token ?? '',
      QANXT_PROJECT_ID: projectId ?? '',
      NO_COLOR: '1'
    }
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    code: result.status ?? -1,
    stdout,
    stderr,
    /** What a person watching the pipeline would see, in order. */
    output: `${stdout}${stderr}`
  };
}

export default async function run() {
  suite('API testing');
  await lab.reset(BANK);

  const tenant = await newTenant('ApiTesting');
  const project = await createProject(tenant, 'Golden API testing');
  const application = await registerApplication(tenant, project.id, {
    name: 'Lab Bank API', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
  });
  const environment = await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
  });
  const context = { tenant, project, application, environment, applicationVersion: '1.0.0' };

  // ---- API-001: an API test is stored as an ordinary test case ------------
  await golden({
    id: 'API-001',
    objective: 'An API test is authored through the platform and stored as a test case',
    preconditions: ['the lab bank is running', 'the project has an application and a QA environment'],
    input: 'A two-request API test: sign in, then read the accounts it can see',
    expected: 'A stored test case of kind "api" whose steps carry the request and whose '
      + 'assertions are all response assertions',
    evidence: ['created.json', 'stored-test-case.json'],
    severity: 'critical',
    run: async () => {
      const created = await requireApiTest(tenant, {
        projectId: project.id,
        applicationId: application.id,
        suiteName: 'API — accounts',
        name: 'A signed-in customer can read their accounts over the API',
        objective: 'The accounts endpoint answers for an authenticated session',
        priority: 'high',
        steps: signInThenRead()
      });

      const stored = await testCase(tenant, created.testCaseId);

      const kindIsApi = stored?.kind === 'api';
      const stepsCarryRequests = (stored?.steps ?? []).length === 2
        && stored.steps.every(step => step.action === 'apiRequest' && step.apiRequest?.path);
      const assertionCount = (stored?.steps ?? [])
        .reduce((total, step) => total + (step.assertions?.length ?? 0), 0);
      const everyAssertionIsAResponseAssertion = (stored?.steps ?? []).every(step =>
        (step.assertions ?? []).every(assertion =>
          assertion.type === 'httpStatusEquals' || String(assertion.type).startsWith('response')));

      return {
        pass: kindIsApi && stepsCarryRequests && assertionCount === 6 && everyAssertionIsAResponseAssertion,
        detail: `stored as ${stored?.reference} kind=${stored?.kind} with `
          + `${stored?.steps?.length ?? 0} request(s) and ${assertionCount} assertion(s)`,
        metrics: { assertions: assertionCount, steps: stored?.steps?.length ?? 0 },
        evidence: { 'created.json': created, 'stored-test-case.json': stored }
      };
    }
  }, context);

  // ---- API-002: it executes, and passes on a working API ------------------
  const passing = await requireApiTest(tenant, {
    projectId: project.id,
    applicationId: application.id,
    suiteName: 'API — accounts',
    name: 'Accounts endpoint answers for a signed-in session',
    priority: 'high',
    steps: signInThenRead()
  });

  await golden({
    id: 'API-002',
    objective: 'An API test executes in the ordinary run pipeline and passes when the API works',
    preconditions: ['the lab bank has no faults enabled'],
    input: `Run of ${passing.reference}`,
    expected: 'A passed execution whose steps are the two HTTP requests',
    evidence: ['run.json', 'execution.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      const { run: testRun, executions, detail } = await execute(tenant, {
        projectId: project.id, testCaseId: passing.testCaseId, name: 'API-002', timeoutMs: 180_000
      });

      const execution = executions[0];
      return {
        pass: testRun?.status === 'passed' && execution?.status === 'passed' && detail?.actions?.length === 2,
        detail: testRun === null
          ? 'the run did not reach a verdict'
          : `run ${testRun.status}, execution ${execution?.status}, `
            + `${detail?.actions?.length ?? 0} action(s), ${execution?.durationMs}ms`,
        metrics: { durationMs: execution?.durationMs ?? null },
        evidence: { 'run.json': testRun, 'execution.json': detail }
      };
    }
  }, context);

  // ---- API-003: the exchange is evidence ---------------------------------
  await golden({
    id: 'API-003',
    objective: 'The request and the response are recorded as evidence, tagged with the step that made them',
    preconditions: ['API-002 executed'],
    input: `A fresh run of ${passing.reference}`,
    expected: 'Network events of type apiTest carrying method, URL, status, duration and '
      + 'the response body, each attributed to its step',
    evidence: ['network.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      const { executions } = await execute(tenant, {
        projectId: project.id, testCaseId: passing.testCaseId, name: 'API-003', timeoutMs: 180_000
      });

      const events = await networkLog(tenant, executions[0]?.id);
      const exchanges = events.filter(event => event.resourceType === 'apiTest');

      const bothRecorded = exchanges.length === 2;
      const attributed = exchanges.every(event => typeof event.actionOrder === 'number');
      const carryStatus = exchanges.every(event => event.statusCode === 200);
      const carryBody = exchanges.some(event => (event.responseBodyExcerpt ?? '').includes('acc-'));
      const timed = exchanges.every(event => event.durationMs >= 0);

      return {
        pass: bothRecorded && attributed && carryStatus && carryBody && timed,
        detail: `${exchanges.length} exchange(s) recorded: `
          + exchanges.map(e => `step ${e.actionOrder} ${e.method} ${new URL(e.url).pathname} → ${e.statusCode} in ${e.durationMs}ms`).join('; '),
        metrics: { exchanges: exchanges.length },
        evidence: { 'network.json': exchanges }
      };
    }
  }, context);

  // ---- API-004: a negative test passes on a 401 --------------------------
  await golden({
    id: 'API-004',
    objective: 'A test that expects an unauthenticated call to be refused passes on the refusal',
    preconditions: ['the lab bank refuses /api/accounts without a session'],
    input: 'An API test asserting 401 and the error body, with error statuses tolerated',
    expected: 'A passed execution: the 401 is the expected result, not the failure',
    evidence: ['execution.json', 'network.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      const negative = await requireApiTest(tenant, {
        projectId: project.id,
        applicationId: application.id,
        suiteName: 'API — security',
        name: 'The accounts endpoint refuses an unauthenticated caller',
        priority: 'critical',
        tags: 'security',
        steps: [{
          description: 'Read the accounts with no credentials at all',
          request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' }, failOnErrorStatus: false },
          assertions: [
            { type: 'httpStatusEquals', expected: '401' },
            { type: 'responseJsonPathEquals', subject: 'error', expected: 'unauthenticated' }
          ]
        }]
      });

      const { run: testRun, executions, detail } = await execute(tenant, {
        projectId: project.id, testCaseId: negative.testCaseId, name: 'API-004', timeoutMs: 180_000
      });
      const events = await networkLog(tenant, executions[0]?.id);
      const exchange = events.find(event => event.resourceType === 'apiTest');

      return {
        pass: testRun?.status === 'passed' && exchange?.statusCode === 401,
        detail: `run ${testRun?.status}; the call returned ${exchange?.statusCode}`,
        evidence: { 'execution.json': detail, 'network.json': events }
      };
    }
  }, context);

  // ---- API-005: a real fault fails the test ------------------------------
  await golden({
    id: 'API-005',
    objective: 'A switched-on server fault fails the API test, with the response as evidence',
    preconditions: ['FAULT_API_500 is enabled on the lab bank'],
    input: `A run of ${passing.reference} while the sign-in endpoint returns 500`,
    expected: 'A failed execution whose message names the 500 and whose evidence carries '
      + "the application's own error body",
    evidence: ['execution.json', 'network.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      await lab.set(BANK, { FAULT_API_500: true });
      try {
        const { run: testRun, executions, detail } = await execute(tenant, {
          projectId: project.id, testCaseId: passing.testCaseId, name: 'API-005', timeoutMs: 180_000
        });
        const events = await networkLog(tenant, executions[0]?.id);
        const exchange = events.find(event => event.resourceType === 'apiTest');
        const message = executions[0]?.errorMessage ?? detail?.errorMessage ?? '';

        return {
          pass: testRun?.status === 'failed'
            && message.includes('500')
            && (exchange?.responseBodyExcerpt ?? '').includes('authentication service is unavailable'),
          detail: `run ${testRun?.status}; message "${message.slice(0, 160)}"; `
            + `evidence body "${(exchange?.responseBodyExcerpt ?? '').slice(0, 120)}"`,
          evidence: { 'execution.json': detail, 'network.json': events }
        };
      } finally {
        await lab.reset(BANK);
      }
    }
  }, context);

  // ---- API-006: a test that cannot fail is refused -----------------------
  await golden({
    id: 'API-006',
    objective: 'The platform refuses an API test that asserts nothing',
    preconditions: ['none'],
    input: 'An API test with one request and no assertions, tolerating error statuses',
    expected: 'A 400 naming the problem: no result could make the test fail',
    evidence: ['refusal.json'],
    severity: 'high',
    run: async () => {
      const response = await createApiTest(tenant, {
        projectId: project.id,
        applicationId: application.id,
        name: 'A test that cannot fail',
        steps: [{
          description: 'Read the accounts and ignore the answer',
          request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' }, failOnErrorStatus: false },
          assertions: []
        }]
      });

      const problems = Object.values(response.json?.errors ?? {}).flat();
      return {
        pass: response.status === 400 && problems.some(problem => problem.includes('no assertions')),
        detail: `status ${response.status}; ${problems.length} problem(s): ${problems.join(' | ').slice(0, 300)}`,
        evidence: { 'refusal.json': response.json ?? response.text }
      };
    }
  }, context);

  // ---- API-007: a page assertion on an API test is refused ---------------
  await golden({
    id: 'API-007',
    objective: 'The platform refuses a page assertion attached to an API request',
    preconditions: ['none'],
    input: 'An API test whose assertion is "the element is visible"',
    expected: 'A 400 explaining that a page assertion cannot be evaluated against a response',
    evidence: ['refusal.json'],
    severity: 'high',
    run: async () => {
      const response = await createApiTest(tenant, {
        projectId: project.id,
        applicationId: application.id,
        name: 'An API test asserting about a page',
        steps: [{
          description: 'Read the accounts',
          request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' }, failOnErrorStatus: false },
          assertions: [{ type: 'visible', subject: 'accounts-table' }]
        }]
      });

      const problems = Object.values(response.json?.errors ?? {}).flat();
      return {
        pass: response.status === 400
          && problems.some(problem => problem.includes('page assertion')),
        detail: `status ${response.status}; ${problems.join(' | ').slice(0, 300)}`,
        evidence: { 'refusal.json': response.json ?? response.text }
      };
    }
  }, context);

  // ---- API-008: the authorization boundary holds at authoring time -------
  await golden({
    id: 'API-008',
    objective: 'The platform refuses an API test pointed at a host outside the application boundary',
    preconditions: ["the application's allowed domains are the lab bank's host only"],
    input: 'An API test whose request path is an absolute URL on another host',
    expected: 'A 400 naming the allowlist',
    evidence: ['refusal.json'],
    severity: 'critical',
    run: async () => {
      const response = await createApiTest(tenant, {
        projectId: project.id,
        applicationId: application.id,
        name: 'An API test aimed somewhere else',
        steps: [{
          description: 'Call a third party',
          request: { method: 'GET', path: 'https://api.stripe.com/v1/charges', auth: { mode: 'none' } },
          assertions: [{ type: 'httpStatusEquals', expected: '200' }]
        }]
      });

      const problems = Object.values(response.json?.errors ?? {}).flat();
      return {
        pass: response.status === 400 && problems.some(problem => problem.includes('not allowed')),
        detail: `status ${response.status}; ${problems.join(' | ').slice(0, 300)}`,
        evidence: { 'refusal.json': response.json ?? response.text }
      };
    }
  }, context);

  // ---- API-009: a credential written into a test is refused --------------
  await golden({
    id: 'API-009',
    objective: 'The platform refuses an API test that inlines a credential instead of referencing one',
    preconditions: ['none'],
    input: 'Three API tests: a literal bearer header, a literal bearer token, and a '
      + 'correctly referenced secret',
    expected: 'The two literals refused, the reference accepted',
    evidence: ['refusals.json'],
    severity: 'critical',
    run: async () => {
      const base = { projectId: project.id, applicationId: application.id };
      const assertion = [{ type: 'httpStatusEquals', expected: '200' }];

      const literalHeader = await createApiTest(tenant, {
        ...base, name: 'Literal authorization header',
        steps: [{
          description: 'Call with a pasted token',
          request: {
            method: 'GET', path: '/api/accounts',
            headers: { authorization: 'Bearer sk_live_51H8zQ2eZvKYlo2C' },
            auth: { mode: 'none' }
          },
          assertions: assertion
        }]
      });

      const literalToken = await createApiTest(tenant, {
        ...base, name: 'Literal bearer token',
        steps: [{
          description: 'Call with a pasted token',
          request: {
            method: 'GET', path: '/api/accounts',
            auth: { mode: 'bearer', token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc' }
          },
          assertions: assertion
        }]
      });

      const referenced = await createApiTest(tenant, {
        ...base, name: 'Referenced bearer token',
        steps: [{
          description: 'Call with a referenced token',
          request: {
            method: 'GET', path: '/api/accounts',
            auth: { mode: 'bearer', token: '${secret:api_token}' },
            failOnErrorStatus: false
          },
          assertions: [{ type: 'responseStatusIn', expected: '200,401' }]
        }]
      });

      const refusals = {
        literalHeader: { status: literalHeader.status, errors: literalHeader.json?.errors ?? null },
        literalToken: { status: literalToken.status, errors: literalToken.json?.errors ?? null },
        referenced: { status: referenced.status }
      };

      return {
        pass: literalHeader.status === 400 && literalToken.status === 400 && referenced.status === 200,
        detail: `literal header ${literalHeader.status}, literal token ${literalToken.status}, `
          + `reference ${referenced.status}`,
        evidence: { 'refusals.json': refusals }
      };
    }
  }, context);

  // ---- API-010: the gate counts API failures separately ------------------
  await golden({
    id: 'API-010',
    objective: 'The quality gate measures API failures as their own metric, and a rule over it fires',
    preconditions: ['a rule "no failing API tests" on the project', 'FAULT_API_500 enabled'],
    input: `A run of ${passing.reference} against a broken API`,
    expected: 'The gate reports ApiFailedCount = 1 and fails on the rule that covers it',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      await createGateRule(tenant, project.id, {
        name: 'No failing API tests',
        metric: 'apiFailedCount',
        operator: 'equal',
        threshold: 0,
        action: 'fail',
        message: 'An API endpoint this release depends on is broken.'
      });

      await lab.reset(BANK);
      await lab.set(BANK, { FAULT_API_500: true });
      try {
        const { run: testRun } = await execute(tenant, {
          projectId: project.id, testCaseId: passing.testCaseId, name: 'API-010', timeoutMs: 180_000
        });
        const gate = await qualityGate(tenant, testRun.id);
        const rule = (gate?.rules ?? []).find(candidate => candidate.metric === 'apiFailedCount');

        return {
          pass: gate?.metrics?.ApiFailedCount === 1
            && rule?.passed === false
            && gate?.outcome === 'fail'
            && String(rule?.explanation ?? '').includes('this release depends on'),
          detail: `ApiFailedCount=${gate?.metrics?.ApiFailedCount}, outcome ${gate?.outcome}, `
            + `rule "${rule?.name}" passed=${rule?.passed}`,
          metrics: { apiFailedCount: gate?.metrics?.ApiFailedCount ?? null },
          evidence: { 'gate.json': gate }
        };
      } finally {
        await lab.reset(BANK);
      }
    }
  }, context);

  // ---- API-011: an unmeasurable metric never reads as a pass -------------
  await golden({
    id: 'API-011',
    objective: 'A gate rule over a metric the run could not measure is sent for review, never reported as satisfied',
    preconditions: ['a rule over contractBreakingChangeCount, which nothing measures yet'],
    input: `A passing run of ${passing.reference} with that rule enabled`,
    expected: 'The rule reports "not measured" and the outcome is REVIEW, not PASS',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      // The honest answer for a threshold nobody could evaluate. Comparing it against
      // zero would make a rule intended to stop a release into one that always passes,
      // which is the most expensive kind of green there is.
      const isolated = await createProject(tenant, 'Unmeasured metric');
      const isolatedApp = await registerApplication(tenant, isolated.id, {
        name: 'Lab Bank API (isolated)', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
      });
      await createGateRule(tenant, isolated.id, {
        name: 'No breaking contract changes',
        metric: 'contractBreakingChangeCount',
        operator: 'equal',
        threshold: 0,
        action: 'fail'
      });

      const test = await requireApiTest(tenant, {
        projectId: isolated.id,
        applicationId: isolatedApp.id,
        name: 'Accounts endpoint answers',
        steps: signInThenRead({ capture: false })
      });

      await lab.reset(BANK);
      const { run: testRun } = await execute(tenant, {
        projectId: isolated.id, testCaseId: test.testCaseId, name: 'API-011', timeoutMs: 180_000
      });
      const gate = await qualityGate(tenant, testRun.id);
      const rule = (gate?.rules ?? []).find(candidate => candidate.metric === 'contractBreakingChangeCount');

      return {
        pass: testRun?.status === 'passed'
          && rule?.passed === false
          && rule?.measured === false
          && gate?.outcome === 'review',
        detail: `run ${testRun?.status}; rule measured=${rule?.measured} passed=${rule?.passed}; `
          + `outcome ${gate?.outcome}`,
        evidence: { 'gate.json': gate }
      };
    }
  }, context);

  // ---- API-012: a secret reference never reaches the evidence ------------
  await golden({
    id: 'API-012',
    objective: "A referenced secret is sent but never appears in the run's stored evidence",
    preconditions: ['the application credentials are configured on the project'],
    input: `A run of ${passing.reference}, whose sign-in body references \${secret:app_password}`,
    expected: 'The run passes and the password appears nowhere in the execution record, '
      + 'the action list or the network log',
    evidence: ['searched.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      const { run: testRun, executions, detail } = await execute(tenant, {
        projectId: project.id, testCaseId: passing.testCaseId, name: 'API-012', timeoutMs: 180_000
      });
      const events = await networkLog(tenant, executions[0]?.id);

      const haystacks = {
        execution: JSON.stringify(detail ?? {}),
        executions: JSON.stringify(executions),
        network: JSON.stringify(events)
      };
      const leaks = Object.entries(haystacks)
        .filter(([, text]) => text.includes(CREDENTIALS.password))
        .map(([where]) => where);

      return {
        pass: testRun?.status === 'passed' && leaks.length === 0,
        detail: leaks.length === 0
          ? `run ${testRun?.status}; the password appears in none of ${Object.keys(haystacks).join(', ')}`
          : `the password leaked into: ${leaks.join(', ')}`,
        evidence: {
          'searched.json': {
            searched: Object.keys(haystacks),
            bytesSearched: Object.values(haystacks).reduce((total, text) => total + text.length, 0),
            leaks
          }
        }
      };
    }
  }, context);

  // ---- API-013: the CLI authors and runs API tests -----------------------
  await golden({
    id: 'API-013',
    objective: 'A pipeline can author and run API tests through the CLI, and branch on its exit status',
    preconditions: ['the CLI is built', 'the lab bank is running'],
    input: '"qanxt api-test add --file", then "qanxt api-test run" against a working API and '
      + 'again against a broken one',
    expected: 'add exits 0 and creates the tests; run exits 0 while the API works and 1 '
      + '(TEST_FAILURE) while it is broken',
    evidence: ['definition.json', 'cli-output.txt'],
    severity: 'critical',
    run: async () => {
      const cliProject = await createProject(tenant, 'CLI API tests');
      const cliApp = await registerApplication(tenant, cliProject.id, {
        name: 'Lab Bank API (CLI)', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
      });
      await createEnvironment(tenant, cliProject.id, {
        name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
      });

      const definition = {
        applicationId: cliApp.id,
        suiteName: 'API — from the pipeline',
        tests: [{
          name: 'Dashboard totals answer for a signed-in session',
          objective: 'The dashboard endpoint answers and reports a balance',
          priority: 'high',
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
              description: 'Read the dashboard',
              request: { method: 'GET', path: '/api/dashboard', auth: { mode: 'none' } },
              assertions: [
                { type: 'httpStatusEquals', expected: '200' },
                { type: 'responseJsonPathExists', subject: 'totalBalance' },
                { type: 'responseJsonPathExists', subject: 'accounts[0].name' }
              ]
            }
          ]
        }]
      };

      const directory = mkdtempSync(join(tmpdir(), 'qanxt-api-cli-'));
      const file = join(directory, 'api-tests.json');
      writeFileSync(file, JSON.stringify(definition, null, 2));

      const options = { token: tenant.token, projectId: cliProject.id };

      const added = cli(['api-test', 'add', '--file', file], options);
      const listed = cli(['api-test', 'list'], options);

      await lab.reset(BANK);
      const green = cli(['api-test', 'run', '--timeout', '240'], options);

      await lab.set(BANK, { FAULT_API_500: true });
      const red = cli(['api-test', 'run', '--timeout', '240'], options);
      await lab.reset(BANK);

      const transcript = [
        `$ qanxt api-test add --file api-tests.json   (exit ${added.code})`, added.output,
        `$ qanxt api-test list                        (exit ${listed.code})`, listed.output,
        `$ qanxt api-test run     [API healthy]       (exit ${green.code})`, green.output,
        `$ qanxt api-test run     [FAULT_API_500]     (exit ${red.code})`, red.output
      ].join('\n');

      return {
        pass: added.code === 0 && listed.code === 0 && green.code === 0 && red.code === 1,
        detail: `add exit ${added.code}, list exit ${listed.code}, `
          + `healthy run exit ${green.code} (expected 0), broken run exit ${red.code} (expected 1)`,
        metrics: { addExit: added.code, passExit: green.code, failExit: red.code },
        evidence: { 'definition.json': definition, 'cli-output.txt': transcript }
      };
    }
  }, context);

  // ---- API-014: a write is refused where the environment forbids one -----
  await golden({
    id: 'API-014',
    objective: 'A mutating API request is refused in an environment that does not permit destructive tests',
    preconditions: ['a production-marked environment with destructive tests disabled'],
    input: 'A POST test run against that environment',
    expected: 'The request is refused at the moment of the call and the step fails; '
      + 'nothing is sent to the application',
    evidence: ['execution.json', 'network.json'],
    severity: 'critical',
    run: async () => {
      const guarded = await createProject(tenant, 'Write-protected environment');
      const guardedApp = await registerApplication(tenant, guarded.id, {
        name: 'Lab Bank API (guarded)', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
      });
      const production = await createEnvironment(tenant, guarded.id, {
        name: 'Lab production', key: 'prod', kind: 'production', baseUrl: BANK, apiBaseUrl: BANK,
        isProduction: true
      });

      // Production testing has to be authorized deliberately, and that is a separate
      // switch from whether destructive operations are allowed.
      const authorized = await request(`/api/v1/environments/${production.id}/authorize-production`, {
        token: tenant.token, method: 'POST',
        body: { authorized: true, note: 'Golden verification of the destructive-write refusal.' }
      });
      if (!authorized.ok) {
        throw new Error(`could not authorize production testing: ${authorized.status} ${authorized.text.slice(0, 200)}`);
      }

      const mutating = await requireApiTest(tenant, {
        projectId: guarded.id,
        applicationId: guardedApp.id,
        name: 'Creating a beneficiary is refused in production',
        steps: [{
          description: 'Create a beneficiary',
          request: {
            method: 'POST', path: '/api/beneficiaries', contentType: 'application/json',
            body: JSON.stringify({ name: 'Golden Verification', sortCode: '04-00-72', accountNumber: '12345678' }),
            auth: { mode: 'none' }
          },
          assertions: [{ type: 'responseStatusIn', expected: '2xx' }]
        }]
      });

      await lab.reset(BANK);
      // The run is pinned to the production environment, which is what makes its policy
      // apply. Production testing is authorized, so the run itself is permitted; writes
      // are a separate switch, and that one is still off.
      const started = await startRun(tenant, {
        projectId: guarded.id, testCaseIds: [mutating.testCaseId], name: 'API-014',
        environmentId: production.id
      });
      const testRun = await waitForRun(tenant, started.id, 180_000);
      const executions = await request(`/api/v1/testruns/${started.id}/executions`, { token: tenant.token });
      const first = executions.json?.[0];
      const detail = first
        ? (await request(`/api/v1/executions/${first.id}`, { token: tenant.token })).json
        : null;
      const events = first ? await networkLog(tenant, first.id) : [];
      const message = first?.errorMessage ?? detail?.errorMessage ?? '';

      return {
        // The environment on this project is production and unauthorized for destructive
        // work, so the write must never leave the worker.
        pass: testRun?.status === 'failed'
          && message.toLowerCase().includes('not permitted')
          && events.filter(event => event.resourceType === 'apiTest').length === 0,
        detail: `run ${testRun?.status}; message "${message.slice(0, 200)}"; `
          + `${events.filter(e => e.resourceType === 'apiTest').length} request(s) recorded`,
        evidence: { 'execution.json': detail, 'network.json': events }
      };
    }
  }, context);
}
