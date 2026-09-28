import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionJob, ExecutionStepPlan } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { TestExecutor } from '../src/execution/executor.js';
import { Logger } from '../src/util/logger.js';
import { startDemoBank, type DemoBank } from './helpers/demo-bank.js';

const logger = new Logger('error', {}, () => {});

let bank: DemoBank;
let pool: BrowserPool;
let artifactRoot: string;
let executor: TestExecutor;

beforeAll(async () => {
  bank = await startDemoBank(4312);
  artifactRoot = await mkdtemp(join(tmpdir(), 'qanxt-exec-'));
  pool = new BrowserPool(true, logger);
  executor = new TestExecutor(pool, logger);
}, 120_000);

afterAll(async () => {
  await pool?.close();
  await bank?.stop();
  if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
});

/** A realistic customer journey: sign in, open an account, filter, download a statement. */
function statementJourney(): ExecutionStepPlan[] {
  return [
    {
      testStepId: 'step-1', order: 1, continueOnFailure: false,
      action: { action: 'assertVisible', description: 'The dashboard shows a total balance',
        target: { strategy: 'testId', value: 'total-balance' } },
      assertions: []
    },
    {
      testStepId: 'step-2', order: 2, continueOnFailure: false,
      action: { action: 'click', description: 'Open the accounts list',
        target: { strategy: 'role', value: 'link', name: 'Accounts' } },
      assertions: [{
        assertionId: 'a-1', type: 'urlContains', expected: '/accounts',
        negate: false, isSoft: false, description: 'The accounts page opens'
      }]
    },
    {
      testStepId: 'step-3', order: 3, continueOnFailure: false,
      action: { action: 'click', description: 'Open the everyday current account',
        target: { strategy: 'testId', value: 'open-account-acc-1001' } },
      assertions: [{
        assertionId: 'a-2', type: 'visible',
        target: { strategy: 'testId', value: 'transactions-table' },
        negate: false, isSoft: false, description: 'The transactions table is shown'
      }]
    },
    {
      testStepId: 'step-4', order: 4, continueOnFailure: false,
      action: { action: 'fill', description: 'Filter from 1 June 2026',
        target: { strategy: 'testId', value: 'filter-from' }, value: '2026-06-01' },
      assertions: []
    },
    {
      testStepId: 'step-5', order: 5, continueOnFailure: false,
      action: { action: 'click', description: 'Apply the filter',
        target: { strategy: 'testId', value: 'apply-filter' } },
      assertions: [{
        assertionId: 'a-3', type: 'visible',
        target: { strategy: 'testId', value: 'transactions-table' },
        negate: false, isSoft: false, description: 'Filtered transactions are listed'
      }]
    }
  ];
}

function job(overrides: Partial<ExecutionJob> = {}): ExecutionJob {
  return {
    jobId: 'job-1',
    executionId: `exec-${Math.random().toString(36).slice(2, 10)}`,
    organizationId: 'org-1',
    projectId: 'project-1',
    testRunId: 'run-1',
    testCaseId: 'case-1',
    testCaseName: 'Customer downloads an account statement',
    testCaseVersion: 1,
    attempt: 1,
    browser: 'chromium',
    headless: true,
    baseUrl: `${bank.baseUrl}/dashboard`,
    auth: {
      strategy: 'formLogin',
      loginUrl: `${bank.baseUrl}/login`,
      username: 'alice',
      password: '${secret:bank_password}',
      successUrlContains: '/dashboard'
    },
    steps: statementJourney(),
    data: {},
    secrets: { bank_password: 'Password123!' },
    capture: { video: false, trace: false, har: false, screenshotOnEveryAction: false, domSnapshotOnFailure: true },
    healing: { policy: 'auto', confidenceThreshold: 80 },
    allowScriptExecution: false,
    allowedHosts: ['127.0.0.1'],
    allowPrivateNetworks: true,
    defaultTimeoutMs: 8_000,
    callbackToken: 'token',
    callbackBaseUrl: 'http://localhost:5080',
    correlationId: 'corr-1',
    ...overrides
  };
}

describe('deterministic execution against the demo banking application', () => {
  test('a valid journey passes and every step is recorded', async () => {
    await bank.reset();
    const auth = { ...job().auth, password: 'Password123!' };
    const report = await executor.execute(job({ auth }), { workerId: 'worker-test', artifactRoot });

    expect(report.status, report.errorMessage).toBe('passed');
    expect(report.stepsPassed).toBe(5);
    expect(report.stepsFailed).toBe(0);
    expect(report.browserVersion).toMatch(/^\d+\./);
    expect(report.durationMs).toBeGreaterThan(0);
  }, 120_000);

  test('secret references resolve without the secret reaching the record', async () => {
    await bank.reset();
    const report = await executor.execute(job(), { workerId: 'worker-test', artifactRoot });

    expect(report.status, report.errorMessage).toBe('passed');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('Password123!');
  }, 120_000);

  test('a genuine application defect is reported as a failure, not hidden', async () => {
    await bank.reset();
    await bank.setScenario({ breakTransactionsApi: true });

    // A wrong balance assertion stands in for a genuine product defect: the platform must
    // report it as a failure with evidence, never smooth it over.
    const failing = statementJourney();
    failing.push({
      testStepId: 'step-6', order: 6, continueOnFailure: false,
      action: {
        action: 'assertText', description: 'The balance is the expected amount',
        target: { strategy: 'testId', value: 'account-balance' },
        expected: '£99,999.99'
      },
      assertions: []
    });

    const report = await executor.execute(
      job({ steps: failing, auth: { ...job().auth, password: 'Password123!' } }),
      { workerId: 'worker-test', artifactRoot });

    expect(report.status).toBe('failed');
    expect(report.stepsFailed).toBe(1);
    expect(report.errorMessage).toContain('£99,999.99');

    const failureScreenshot = report.artifacts.find(a => a.name.includes('failure'));
    expect(failureScreenshot, 'a failure must always produce evidence').toBeDefined();
    expect(report.artifacts.some(a => a.kind === 'domSnapshot')).toBe(true);
    await bank.reset();
  }, 120_000);

  test('a failed login is reported as blocked rather than as a test failure', async () => {
    await bank.reset();
    const report = await executor.execute(
      job({ auth: { ...job().auth, password: 'WrongPassword!' }, secrets: {} }),
      { workerId: 'worker-test', artifactRoot });

    expect(report.status).toBe('blocked');
    expect(report.errorMessage).toContain('Preconditions were not met');
    expect(report.stepsPassed).toBe(0);
  }, 120_000);

  test('evidence is collected: console and network events are captured', async () => {
    await bank.reset();
    const report = await executor.execute(
      job({ auth: { ...job().auth, password: 'Password123!' } }),
      { workerId: 'worker-test', artifactRoot });

    expect(report.networkEvents.length).toBeGreaterThan(0);
    const documentRequest = report.networkEvents.find(e => e.resourceType === 'document');
    expect(documentRequest).toBeDefined();
    expect(documentRequest!.statusCode).toBeGreaterThanOrEqual(200);
    // Headers must arrive masked, not raw.
    const withCookie = report.networkEvents.find(e => e.requestHeaders?.['cookie'] !== undefined);
    if (withCookie) expect(withCookie.requestHeaders!['cookie']).toBe('***REDACTED***');
  }, 120_000);
});

describe('self-healing when the application changes', () => {
  test('heals a renamed control, verifies the outcome and records the proposal', async () => {
    await bank.reset();
    // The login button is renamed "Sign in" -> "Log in" and its test id changes, which is
    // exactly the change that breaks a stored locator in the field.
    await bank.setScenario({ renameLoginButton: true });

    const healingJob = job({
      auth: {
        strategy: 'formLogin',
        loginUrl: `${bank.baseUrl}/login`,
        username: 'alice',
        password: 'Password123!',
        successUrlContains: '/dashboard'
      },
      steps: [
        {
          testStepId: 'step-login', order: 1, continueOnFailure: false,
          action: {
            action: 'click', description: 'Submit the sign-in form',
            // The locator that used to work, now broken by the rename.
            target: { strategy: 'testId', value: 'login-submit' }
          },
          fingerprint: {
            tagName: 'button', ariaRole: 'button', accessibleName: 'Sign in',
            testId: 'login-submit', type: 'submit',
            domPath: 'html/body/main/div/div/form/div/button',
            bounding: { x: 40, y: 430, width: 84, height: 41 }
          },
          assertions: [{
            assertionId: 'a-dash', type: 'urlContains', expected: '/dashboard',
            negate: false, isSoft: false, description: 'The dashboard opens after signing in'
          }]
        }
      ]
    });

    // Drive the login form manually so the healed click is the step under test.
    const report = await executor.execute({
      ...healingJob,
      baseUrl: `${bank.baseUrl}/login`,
      auth: { strategy: 'none' },
      steps: [
        {
          testStepId: 'step-nav', order: 1, continueOnFailure: false,
          action: { action: 'navigate', description: 'Open the sign-in page', url: `${bank.baseUrl}/login` },
          assertions: []
        },
        {
          testStepId: 'step-user', order: 2, continueOnFailure: false,
          action: { action: 'fill', description: 'Enter the username',
            target: { strategy: 'testId', value: 'username' }, value: 'alice' },
          assertions: []
        },
        {
          testStepId: 'step-pass', order: 3, continueOnFailure: false,
          action: { action: 'fill', description: 'Enter the password',
            target: { strategy: 'testId', value: 'password' }, value: '${secret:bank_password}' },
          assertions: []
        },
        ...healingJob.steps
      ]
    }, { workerId: 'worker-test', artifactRoot });

    expect(report.status, report.errorMessage).toBe('healed');
    expect(report.stepsHealed).toBe(1);
    expect(report.healingEvents).toHaveLength(1);

    const event = report.healingEvents[0]!;
    expect(event.originalLocator).toEqual({ strategy: 'testId', value: 'login-submit' });
    expect(event.confidence).toBeGreaterThanOrEqual(80);
    expect(event.applied).toBe(true);
    // The contract: a heal counts only if the action then achieved its intent.
    expect(event.outcomeVerified).toBe(true);
    expect(event.reason).toContain('no longer matched');
    expect(Object.keys(event.breakdown).length).toBeGreaterThan(0);

    expect(event.healedLocator.strategy).toBe('testId');
    expect(event.healedLocator.value).toBe('login-submit-v2');

    await bank.reset();
  }, 120_000);

  test('does not heal when the policy forbids it', async () => {
    await bank.reset();
    await bank.setScenario({ renameLoginButton: true });

    const report = await executor.execute(job({
      baseUrl: `${bank.baseUrl}/login`,
      auth: { strategy: 'none' },
      healing: { policy: 'never', confidenceThreshold: 80 },
      steps: [
        {
          testStepId: 'step-nav', order: 1, continueOnFailure: false,
          action: { action: 'navigate', description: 'Open the sign-in page', url: `${bank.baseUrl}/login` },
          assertions: []
        },
        {
          testStepId: 'step-click', order: 2, continueOnFailure: false,
          action: { action: 'click', description: 'Submit the sign-in form',
            target: { strategy: 'testId', value: 'login-submit' } },
          assertions: []
        }
      ]
    }), { workerId: 'worker-test', artifactRoot });

    expect(report.status).toBe('failed');
    expect(report.healingEvents).toHaveLength(0);
    await bank.reset();
  }, 120_000);

  test('records a proposal without applying it when the policy is suggest', async () => {
    await bank.reset();
    await bank.setScenario({ renameLoginButton: true });

    const report = await executor.execute(job({
      baseUrl: `${bank.baseUrl}/login`,
      auth: { strategy: 'none' },
      healing: { policy: 'suggest', confidenceThreshold: 60 },
      steps: [
        {
          testStepId: 'step-nav', order: 1, continueOnFailure: false,
          action: { action: 'navigate', description: 'Open the sign-in page', url: `${bank.baseUrl}/login` },
          assertions: []
        },
        {
          testStepId: 'step-click', order: 2, continueOnFailure: false,
          action: { action: 'click', description: 'Submit the sign-in form',
            target: { strategy: 'testId', value: 'login-submit' } },
          fingerprint: { tagName: 'button', ariaRole: 'button', accessibleName: 'Sign in', testId: 'login-submit' },
          assertions: []
        }
      ]
    }), { workerId: 'worker-test', artifactRoot });

    // The step still fails — suggest means propose, never silently repair.
    expect(report.status).toBe('failed');
    expect(report.healingEvents).toHaveLength(1);
    expect(report.healingEvents[0]!.applied).toBe(false);
    expect(report.healingEvents[0]!.outcomeVerified).toBe(false);
    await bank.reset();
  }, 120_000);
});
