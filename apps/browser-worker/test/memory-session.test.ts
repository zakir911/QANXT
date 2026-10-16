import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import type { DiscoveryCompletionReport, ExecutionJob } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { Crawler } from '../src/discovery/crawler.js';
import { TestExecutor } from '../src/execution/executor.js';
import { Logger } from '../src/util/logger.js';
import { startMemoryBank, type MemoryBank } from './helpers/memory-bank.js';

/**
 * An application whose sign-in lives only in the page and allows one session per user:
 * the kind that mapped nineteen signed-out shells and refused 108 of 122 tests.
 */
const logger = new Logger('error', {}, () => {});
let bank: MemoryBank;
let pool: BrowserPool;
let artifactRoot: string;

const auth = () => ({
  strategy: 'formLogin' as const,
  loginUrl: `${bank.baseUrl}/app/login`,
  username: 'tester',
  password: 'secret',
  successUrlContains: '/app/dashboard'
});

beforeAll(async () => {
  bank = await startMemoryBank();
  pool = new BrowserPool(true, logger);
  artifactRoot = await mkdtemp(join(tmpdir(), 'qanxt-memory-'));
}, 60_000);

afterAll(async () => {
  await pool?.close();
  await bank?.stop();
  if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
});

describe('an application whose session lives in the page and allows one at a time', () => {
  let report: DiscoveryCompletionReport;

  beforeAll(async () => {
    const context: BrowserContext = await pool.createContext('chromium', { defaultTimeoutMs: 8_000, navigationTimeoutMs: 15_000 });
    try {
      // The base URL is the login page, as it was for the banking application.
      const crawler = new Crawler(context, {
        baseUrl: `${bank.baseUrl}/app/login`,
        artifactDir: artifactRoot,
        navigationTimeoutMs: 15_000,
        auth: auth(),
        budget: {
          allowedHosts: ['127.0.0.1'], excludedPathPrefixes: ['/logout'], maxDepth: 3, maxPages: 20, maxActions: 300,
          maxInstancesPerRouteShape: 3, timeoutSeconds: 180, allowPrivateNetworks: true, respectRobotsTxt: false
        }
      }, logger);
      report = await crawler.run('memory-run', 'worker-test');
    } finally {
      await context.close().catch(() => undefined);
    }
  }, 240_000);

  test('discovery maps the signed-in pages, not signed-out shells', () => {
    const routes = report.pages.map(p => p.route);
    expect(report.errorMessage).toBeUndefined();
    expect(routes).toEqual(expect.arrayContaining(['/app/dashboard', '/app/accounts', '/app/transfer', '/app/beneficiaries', '/app/profile']));
    expect(report.progressLog).toMatch(/signs out on a page load/);
  });

  test('discovery finds every form and field behind the sign-in', () => {
    const fieldsOf = (route: string) => report.pages.find(p => p.route === route)?.forms?.flatMap(f => f.fields.map(x => x.name)) ?? [];
    expect(fieldsOf('/app/transfer')).toEqual(expect.arrayContaining(['from', 'to', 'amount', 'remarks']));
    expect(fieldsOf('/app/beneficiaries')).toEqual(expect.arrayContaining(['name', 'account', 'ifsc']));
    expect(fieldsOf('/app/profile')).toEqual(expect.arrayContaining(['email', 'mobile']));
  });

  test('discovery signs out at the end, so the next job can sign in', () => {
    expect(bank.openSessions()).toBe(0);
  });

  test('tests started together all run: the second sign-in is refused, waits, and goes in after', async () => {
    const executor = new TestExecutor(pool, logger);
    const job = (n: number): ExecutionJob => ({
      jobId: `job-${n}`, executionId: `exec-mem-${n}-${Math.random().toString(36).slice(2, 8)}`, organizationId: 'org', projectId: 'project',
      testRunId: 'run', testCaseId: `case-${n}`, testCaseName: `Transfer form ${n}`, testCaseVersion: 1, attempt: 1,
      browser: 'chromium', headless: true, baseUrl: `${bank.baseUrl}/app/login`, auth: auth(),
      steps: [
        { testStepId: 's1', order: 1, continueOnFailure: false, assertions: [],
          action: { action: 'navigate', description: 'Open Fund transfer', url: `${bank.baseUrl}/app/transfer` } },
        { testStepId: 's2', order: 2, continueOnFailure: false, assertions: [],
          action: { action: 'fill', description: 'Enter an amount', target: { strategy: 'label', value: 'Amount' }, value: '250' } },
        { testStepId: 's3', order: 3, continueOnFailure: false, assertions: [],
          action: { action: 'assertVisible', description: 'The Transfer button is there', target: { strategy: 'role', value: 'button', name: 'Transfer' } } }
      ],
      data: {}, secrets: {},
      capture: { video: false, trace: false, har: false, screenshotOnEveryAction: false, domSnapshotOnFailure: false },
      healing: { policy: 'off', confidenceThreshold: 80 }, allowScriptExecution: false, allowedHosts: ['127.0.0.1'],
      allowPrivateNetworks: true, defaultTimeoutMs: 8_000, callbackToken: 't', callbackBaseUrl: 'http://localhost:5080', correlationId: 'c'
    } as ExecutionJob);

    const reports = await Promise.all([1, 2, 3].map(n => executor.execute(job(n), { workerId: 'worker-test', artifactRoot })));
    for (const r of reports) expect(r.status, r.errorMessage).toBe('passed');
    // The waiting really happened: the bank refused a second session at least once.
    expect(bank.refusals()).toBeGreaterThan(0);
    expect(bank.openSessions()).toBe(0);
  }, 240_000);
});
