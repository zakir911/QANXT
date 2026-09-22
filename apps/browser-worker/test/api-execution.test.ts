import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApiRequestDescriptor, ExecutionJob, ExecutionStepPlan, PlannedAssertion
} from '@aira/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { TestExecutor, needsPage } from '../src/execution/executor.js';
import { Logger } from '../src/util/logger.js';
import { startDemoBank, type DemoBank } from './helpers/demo-bank.js';

/**
 * API testing, executed against the real Demo Bank through the real executor.
 *
 * The claim this suite has to earn is that an API test is a test case like any other: it
 * runs in the same engine, produces the same evidence, and its verdict is whatever actually
 * happened. So nothing is stubbed. A 401 here is a 401 the application returned, a 500 is a
 * fault switched on in the application, and the masked header is the one that was sent.
 */

const logger = new Logger('warn');
let bank: DemoBank;
let pool: BrowserPool;
let executor: TestExecutor;
let artifactRoot: string;

beforeAll(async () => {
  bank = await startDemoBank(4322);
  artifactRoot = await mkdtemp(join(tmpdir(), 'aira-api-'));
  pool = new BrowserPool(true, logger);
  executor = new TestExecutor(pool, logger);
}, 120_000);

afterAll(async () => {
  await pool?.close();
  await bank?.stop();
  if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
});

let stepCounter = 0;

function apiStep(
  description: string,
  request: ApiRequestDescriptor,
  assertions: Array<Partial<PlannedAssertion> & { type: string }> = [],
  continueOnFailure = false
): ExecutionStepPlan {
  stepCounter++;
  return {
    testStepId: `step-${stepCounter}`,
    order: stepCounter,
    continueOnFailure,
    action: { action: 'apiRequest', description, apiRequest: request },
    assertions: assertions.map((assertion, index) => ({
      assertionId: `assert-${stepCounter}-${index}`,
      negate: false,
      isSoft: false,
      description: assertion.description ?? assertion.type,
      ...assertion
    })) as PlannedAssertion[]
  };
}

/** A browserless API job: no UI login, no session, nothing inherited. */
function apiJob(steps: ExecutionStepPlan[], overrides: Partial<ExecutionJob> = {}): ExecutionJob {
  return {
    jobId: 'job-api',
    executionId: `exec-${Math.random().toString(36).slice(2, 10)}`,
    organizationId: 'org-1',
    projectId: 'project-1',
    testRunId: 'run-1',
    testCaseId: 'case-api',
    testCaseName: 'API test',
    testCaseVersion: 1,
    testCaseKind: 'api',
    attempt: 1,
    browser: 'chromium',
    headless: true,
    baseUrl: bank.baseUrl,
    apiBaseUrl: bank.baseUrl,
    auth: { strategy: 'none' },
    steps,
    data: {},
    secrets: {},
    capture: { video: false, trace: false, har: false, screenshotOnEveryAction: false, domSnapshotOnFailure: true },
    healing: { policy: 'never', confidenceThreshold: 90 },
    allowScriptExecution: false,
    allowedHosts: ['127.0.0.1'],
    allowPrivateNetworks: true,
    defaultTimeoutMs: 8_000,
    callbackToken: 'token',
    callbackBaseUrl: 'http://localhost:5080',
    correlationId: 'corr-api',
    ...overrides
  };
}

/** A job that signs into the UI first, so an API request can inherit the session. */
function sessionJob(steps: ExecutionStepPlan[], overrides: Partial<ExecutionJob> = {}): ExecutionJob {
  return apiJob(steps, {
    testCaseKind: 'mixed',
    baseUrl: `${bank.baseUrl}/dashboard`,
    auth: {
      strategy: 'formLogin',
      loginUrl: `${bank.baseUrl}/login`,
      username: 'alice',
      password: 'Password123!',
      successUrlContains: '/dashboard'
    },
    ...overrides
  });
}

const run = (job: ExecutionJob) => executor.execute(job, { workerId: 'worker-api-test', artifactRoot });

describe('API tests execute in the same engine as UI tests', () => {
  test('an unauthenticated call is asserted, and no browser page is opened for it', async () => {
    await bank.reset();

    const job = apiJob([
      apiStep('Ask who is signed in, with no credentials', {
        method: 'GET',
        path: '/api/session',
        auth: { mode: 'none' },
        // The 401 is the expected result, so it must not also be the failure.
        failOnErrorStatus: false
      }, [
        { type: 'httpStatusEquals', expected: '401' },
        { type: 'responseJsonPathEquals', attribute: 'authenticated', expected: 'false' },
        { type: 'responseHeaderEquals', attribute: 'content-type', expected: 'application/json; charset=utf-8' }
      ])
    ]);

    expect(needsPage(job)).toBe(false);

    const report = await run(job);

    expect(report.status, report.errorMessage).toBe('passed');
    expect(report.stepsPassed).toBe(1);
    // Nothing was photographed because nothing was rendered.
    expect(report.artifacts.filter(a => a.kind === 'screenshot')).toHaveLength(0);
  }, 120_000);

  test('the request and the response are recorded as evidence', async () => {
    await bank.reset();

    const report = await run(apiJob([
      apiStep('List the payees without signing in', {
        method: 'GET', path: '/api/payees', auth: { mode: 'none' }, failOnErrorStatus: false
      }, [{ type: 'httpStatusEquals', expected: '401' }])
    ]));

    expect(report.status, report.errorMessage).toBe('passed');

    // The exchange appears in the same network log the browser's own calls go into,
    // tagged with the step that made it — which is what UI/API correlation reads.
    const exchange = report.networkEvents.find(event => event.resourceType === 'apiTest');
    expect(exchange).toBeDefined();
    expect(exchange!.method).toBe('GET');
    expect(exchange!.url).toContain('/api/payees');
    expect(exchange!.statusCode).toBe(401);
    expect(exchange!.actionOrder).toBe(report.stepsTotal > 0 ? exchange!.actionOrder : undefined);
    expect(exchange!.responseBodyExcerpt).toContain('Authentication required');

    // And as a file, so a failure can be read without the database.
    const files = await readdir(join(artifactRoot, report.executionId));
    const http = files.find(name => name.endsWith('.http.json'));
    expect(http, `no .http.json among ${files.join(', ')}`).toBeDefined();

    const written = JSON.parse(await readFile(join(artifactRoot, report.executionId, http!), 'utf8'));
    expect(written.statusCode).toBe(401);
    expect(written.requestMethod).toBe('GET');
  }, 120_000);

  test('an API request reuses the session a UI login established, and chains captured values', async () => {
    await bank.reset();

    const job = sessionJob([
      apiStep('List the signed-in customer\'s accounts', {
        method: 'GET', path: '/api/accounts', auth: { mode: 'inheritSession' },
        capture: { accountId: 'accounts[0].id' }
      }, [
        { type: 'httpStatusEquals', expected: '200' },
        { type: 'responseJsonPathExists', attribute: 'accounts[0].id' }
      ]),
      apiStep('Read that account\'s transactions', {
        method: 'GET', path: '/api/accounts/${data:accountId}/transactions',
        auth: { mode: 'inheritSession' }
      }, [
        { type: 'responseStatusIn', expected: '2xx' },
        { type: 'responseJsonPathExists', attribute: 'transactions[0].date' },
        { type: 'responseJsonPathMatches', attribute: 'accountId', expected: '^acc-' }
      ])
    ]);

    // This one does need a page: the session comes from signing in.
    expect(needsPage(job)).toBe(true);

    const report = await run(job);

    expect(report.status, report.errorMessage).toBe('passed');
    expect(report.stepsPassed).toBe(2);

    const second = report.networkEvents.filter(e => e.resourceType === 'apiTest').at(-1);
    // The captured id was substituted, so the second call went to a real account.
    expect(second!.url).toMatch(/\/api\/accounts\/acc-\d+\/transactions/);
  }, 120_000);

  test('the same call without the session fails, so inheritance is doing the work', async () => {
    await bank.reset();

    // Identical to the passing step above except for the auth mode. If 'none' still
    // carried the browser's cookies, this would pass, and the test above would prove
    // nothing about session reuse.
    const report = await run(sessionJob([
      apiStep('List accounts, deliberately sending no credentials', {
        method: 'GET', path: '/api/accounts', auth: { mode: 'none' }
      }, [{ type: 'httpStatusEquals', expected: '200' }])
    ]));

    expect(report.status).toBe('failed');
    expect(report.errorMessage).toContain('401');
  }, 120_000);

  test('an API-only test can sign in through the API and then read what that session sees', async () => {
    await bank.reset();

    // No browser at all: the cookie comes from the API call, and the next request has to
    // still hold it. This is why the isolated client lasts for the test rather than for
    // one request.
    const job = apiJob([
      apiStep('Sign in', {
        method: 'POST', path: '/login',
        contentType: 'application/x-www-form-urlencoded',
        body: 'username=alice&password=${secret:bank_password}',
        auth: { mode: 'none' }
      }, [{ type: 'responseStatusIn', expected: '2xx,3xx' }]),
      apiStep('Read the accounts that session can see', {
        method: 'GET', path: '/api/accounts', auth: { mode: 'none' },
        capture: { accountId: 'accounts[0].id' }
      }, [
        { type: 'httpStatusEquals', expected: '200' },
        { type: 'responseJsonPathExists', attribute: 'accounts[0].balance' }
      ])
    ], { secrets: { bank_password: 'Password123!' } });

    expect(needsPage(job)).toBe(false);

    const report = await run(job);

    expect(report.status, report.errorMessage).toBe('passed');
    expect(report.stepsPassed).toBe(2);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('Password123!');
  }, 120_000);

  test('a real server fault is reported as a failure with the response body', async () => {
    await bank.reset();
    await bank.setScenario({ breakTransactionsApi: true });

    const report = await run(sessionJob([
      apiStep('Read an account\'s transactions', {
        method: 'GET', path: '/api/accounts/acc-1001/transactions', auth: { mode: 'inheritSession' }
      }, [{ type: 'httpStatusEquals', expected: '200' }])
    ]));

    await bank.reset();

    expect(report.status).toBe('failed');
    expect(report.errorMessage).toContain('500');

    const exchange = report.networkEvents.find(e => e.resourceType === 'apiTest' && e.statusCode === 500);
    expect(exchange).toBeDefined();
    expect(exchange!.isFailed).toBe(true);
    // The evidence says what the application actually said, which is what makes the
    // failure diagnosable rather than merely red.
    expect(exchange!.responseBodyExcerpt).toContain('TRANSACTION_SERVICE_UNAVAILABLE');
  }, 120_000);

  test('an assertion that disagrees with the response fails, and says what was there', async () => {
    await bank.reset();

    const report = await run(sessionJob([
      apiStep('List accounts', {
        method: 'GET', path: '/api/accounts', auth: { mode: 'inheritSession' }
      }, [{
        type: 'responseJsonPathEquals', attribute: 'accounts[0].currency', expected: 'USD',
        description: 'The first account is in US dollars'
      }])
    ]));

    expect(report.status).toBe('failed');
    expect(report.errorMessage).toContain('USD');
    // The observed value, not only the expectation: a failure that does not say what was
    // found sends someone to a debugger.
    expect(report.errorMessage).toContain('GBP');
  }, 120_000);

  test('a response-time assertion reports the measured duration when it fails', async () => {
    await bank.reset();

    const report = await run(apiJob([
      apiStep('The session endpoint answers within a microsecond', {
        method: 'GET', path: '/api/session', auth: { mode: 'none' }, failOnErrorStatus: false
      }, [{ type: 'responseTimeUnderMs', expected: '1' }])
    ]));

    expect(report.status).toBe('failed');
    expect(report.errorMessage).toMatch(/Expected the response within 1ms but it took \d+ms/);
  }, 120_000);

  test('a write is refused where the environment does not permit one, before it is sent', async () => {
    await bank.reset();

    const report = await run(apiJob([
      apiStep('Create a payee', {
        method: 'POST', path: '/api/payees', auth: { mode: 'none' },
        body: JSON.stringify({ name: 'Someone' })
      }, [{ type: 'responseStatusIn', expected: '2xx' }])
    ], { allowMutatingApiRequests: false }));

    expect(report.status).toBe('failed');
    expect(report.errorMessage).toContain('not permitted');
    // Refused, not attempted: nothing left the worker.
    expect(report.networkEvents.filter(e => e.resourceType === 'apiTest')).toHaveLength(0);
  }, 120_000);

  test('a request outside the allowed hosts is refused', async () => {
    await bank.reset();

    const report = await run(apiJob([
      apiStep('Call somewhere else entirely', {
        method: 'GET', path: 'http://example.invalid/api/data', auth: { mode: 'none' }
      }, [{ type: 'responseStatusIn', expected: '2xx' }])
    ]));

    expect(report.status).toBe('failed');
    expect(report.errorMessage).toContain('refused');
    expect(report.networkEvents.filter(e => e.resourceType === 'apiTest')).toHaveLength(0);
  }, 120_000);

  test('a bearer token from a secret reference never reaches the evidence', async () => {
    await bank.reset();

    const report = await run(apiJob([
      apiStep('Call with a token the application will not accept', {
        method: 'GET', path: '/api/accounts',
        auth: { mode: 'bearer', token: '${secret:api_token}' },
        failOnErrorStatus: false
      }, [{ type: 'httpStatusEquals', expected: '401' }])
    ], { secrets: { api_token: 'tok_live_5f3d9c1b7a2e' } }));

    expect(report.status, report.errorMessage).toBe('passed');

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('tok_live_5f3d9c1b7a2e');

    // The header was sent — the point is that the record shows it was sent without
    // showing what it was.
    const exchange = report.networkEvents.find(e => e.resourceType === 'apiTest');
    const authorization = Object.entries(exchange!.requestHeaders ?? {})
      .find(([name]) => name.toLowerCase() === 'authorization');
    expect(authorization).toBeDefined();
    expect(authorization![1]).not.toContain('tok_live_5f3d9c1b7a2e');

    const files = await readdir(join(artifactRoot, report.executionId));
    for (const file of files) {
      const contents = await readFile(join(artifactRoot, report.executionId, file), 'utf8');
      expect(contents, file).not.toContain('tok_live_5f3d9c1b7a2e');
    }
  }, 120_000);

  test('a page assertion attached to an API step fails rather than passing silently', async () => {
    await bank.reset();

    // The control plane refuses to store this, but the executor must not be the only
    // thing standing between a mis-authored test and a green run.
    const report = await run(apiJob([
      apiStep('List the payees', {
        method: 'GET', path: '/api/payees', auth: { mode: 'none' }, failOnErrorStatus: false
      }, [{ type: 'visible', target: { strategy: 'testId', value: 'payees-table' } }])
    ]));

    expect(report.status).toBe('failed');
    expect(report.errorMessage).toContain('page assertion');
  }, 120_000);

  test('a request that cannot connect is recorded as an attempt, not as a silent gap', async () => {
    await bank.reset();

    // A port nothing is listening on, inside the allowed host, so the guard passes and
    // the connection is what fails.
    const report = await run(apiJob([
      apiStep('Call a port nothing is serving', {
        method: 'GET', path: 'http://127.0.0.1:4399/api/accounts', auth: { mode: 'none' },
        timeoutMs: 3000
      }, [{ type: 'responseStatusIn', expected: '2xx' }])
    ]));

    expect(report.status).toBe('failed');
    expect(report.errorMessage).toContain('did not complete');

    const exchange = report.networkEvents.find(e => e.resourceType === 'apiTest');
    expect(exchange).toBeDefined();
    expect(exchange!.isFailed).toBe(true);
    expect(exchange!.failureText).toBeTruthy();
  }, 120_000);

  test('an unknown assertion type fails loudly instead of being treated as satisfied', async () => {
    await bank.reset();

    const report = await run(apiJob([
      apiStep('List the payees', {
        method: 'GET', path: '/api/payees', auth: { mode: 'none' }, failOnErrorStatus: false
      }, [{ type: 'responseIsNiceEnough', expected: 'yes' }])
    ]));

    expect(report.status).toBe('failed');
  }, 120_000);
});

describe('needsPage', () => {
  test('is true for any test with a browser step', () => {
    const job = apiJob([
      apiStep('Call the API', { method: 'GET', path: '/api/payees', auth: { mode: 'none' } },
        [{ type: 'httpStatusEquals', expected: '401' }]),
      {
        testStepId: 'ui', order: 99, continueOnFailure: false, assertions: [],
        action: { action: 'click', description: 'Click something', target: { strategy: 'testId', value: 'x' } }
      }
    ]);
    expect(needsPage(job)).toBe(true);
  });

  test('is true when an API step means to reuse the session, stated or implied', () => {
    expect(needsPage(apiJob([apiStep('a', { method: 'GET', path: '/x', auth: { mode: 'inheritSession' } })]))).toBe(true);
    // No auth mode at all is treated as session reuse, because that is what the runner
    // defaults to. Guessing the cheaper answer here would break the test instead.
    expect(needsPage(apiJob([apiStep('b', { method: 'GET', path: '/x' })]))).toBe(true);
  });

  test('is false only when every step calls an API on its own credentials', () => {
    expect(needsPage(apiJob([
      apiStep('a', { method: 'GET', path: '/x', auth: { mode: 'none' } }),
      apiStep('b', { method: 'GET', path: '/y', auth: { mode: 'bearer', token: '${secret:t}' } })
    ]))).toBe(false);
  });

  test('is true for a test with no steps, rather than assuming', () => {
    expect(needsPage(apiJob([]))).toBe(true);
  });
});
