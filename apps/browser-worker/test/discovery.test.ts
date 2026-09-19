import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import type { DiscoveryCompletionReport } from '@aira/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { Crawler } from '../src/discovery/crawler.js';
import { Logger } from '../src/util/logger.js';
import { startDemoBank, type DemoBank } from './helpers/demo-bank.js';

/**
 * Discovery is exercised against the real Demo Bank in a real Chromium: the point of the
 * engine is that it works on an actual application, so this suite drives one.
 */
describe('discovery against the demo banking application', () => {
  let bank: DemoBank;
  let pool: BrowserPool;
  let context: BrowserContext;
  let artifactDir: string;
  let report: DiscoveryCompletionReport;

  const logger = new Logger('error', {}, () => {});

  beforeAll(async () => {
    bank = await startDemoBank(4311);
    artifactDir = await mkdtemp(join(tmpdir(), 'aira-discovery-'));
    pool = new BrowserPool(true, logger);
    context = await pool.createContext('chromium', {
      defaultTimeoutMs: 10_000,
      navigationTimeoutMs: 20_000
    });

    const crawler = new Crawler(context, {
      baseUrl: `${bank.baseUrl}/dashboard`,
      artifactDir,
      navigationTimeoutMs: 20_000,
      auth: {
        strategy: 'formLogin',
        loginUrl: `${bank.baseUrl}/login`,
        username: 'alice',
        password: 'Password123!',
        successUrlContains: '/dashboard'
      },
      budget: {
        allowedHosts: ['127.0.0.1'],
        excludedPathPrefixes: ['/logout', '/__control'],
        maxDepth: 2,
        maxPages: 12,
        maxActions: 120,
        maxInstancesPerRouteShape: 2,
        timeoutSeconds: 120,
        allowPrivateNetworks: true,
        respectRobotsTxt: false
      }
    }, logger);

    report = await crawler.run('run-under-test', 'worker-test');
  }, 180_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close();
    await bank?.stop();
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
  });

  test('completes and maps multiple real pages', () => {
    expect(['completed', 'partiallyCompleted']).toContain(report.status);
    expect(report.errorMessage).toBeUndefined();
    expect(report.pages.length).toBeGreaterThanOrEqual(4);
  });

  test('authenticates and reaches pages behind the login', () => {
    const routes = report.pages.map(p => p.route);
    expect(routes).toContain('/dashboard');
    expect(routes).toContain('/accounts');
    expect(routes).toContain('/payments');
    expect(routes).toContain('/profile');
  });

  test('classifies pages from what it observed', () => {
    const dashboard = report.pages.find(p => p.route === '/dashboard');
    expect(dashboard?.kind).toBe('dashboard');
    const payments = report.pages.find(p => p.route === '/payments');
    expect(payments?.kind).toBe('form');
  });

  test('extracts elements with the semantic signals healing depends on', () => {
    const payments = report.pages.find(p => p.route === '/payments');
    expect(payments).toBeDefined();

    const amount = payments!.elements.find(e => e.testId === 'payment-amount');
    expect(amount, 'the amount input should have been found by its test id').toBeDefined();
    expect(amount!.kind).toBe('textInput');
    expect(amount!.label).toContain('Amount');
    expect(amount!.placeholder).toBe('0.00');
    expect(amount!.domPath).toContain('form');
    expect(amount!.preferredLocator.strategy).toBe('testId');
    expect(amount!.stabilityScore).toBeGreaterThanOrEqual(90);

    const submit = payments!.elements.find(e => e.testId === 'payment-submit');
    expect(submit!.ariaRole).toBe('button');
    expect(submit!.accessibleName).toBe('Send payment');
    expect(submit!.preferredLocator.fallbacks?.length).toBeGreaterThan(0);
  });

  test('records the transitions that form the knowledge graph', () => {
    expect(report.transitions.length).toBeGreaterThan(0);
    const intoAccounts = report.transitions.find(t => t.toNormalizedUrl.endsWith('/accounts'));
    expect(intoAccounts).toBeDefined();
    expect(intoAccounts!.fromNormalizedUrl).not.toBe(intoAccounts!.toNormalizedUrl);
  });

  test('captures evidence for every page it mapped', () => {
    for (const page of report.pages) {
      expect(page.screenshotKey, `screenshot for ${page.route}`).toBeDefined();
      expect(page.domKey, `DOM for ${page.route}`).toBeDefined();
    }
  });

  test('caps repeated route shapes so a long list cannot drive the crawl', () => {
    // Alice has three accounts. With the budget set to two instances per shape, the
    // crawler must stop after the second /accounts/<id> page rather than walking them all.
    const detailPages = report.pages.filter(p => /^\/accounts\/[^/]+$/.test(p.route));
    expect(detailPages.length).toBe(2);
    expect(report.progressLog).toContain('already mapped 2 pages matching /accounts/*');
  });

  test('normalizes urls so the same page is never mapped twice', () => {
    const normalized = report.pages.map(p => p.normalizedUrl);
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  test('refuses to leave the allowed host or enter excluded paths', () => {
    for (const page of report.pages) {
      expect(new URL(page.url).hostname).toBe('127.0.0.1');
      expect(page.route.startsWith('/logout')).toBe(false);
    }
  });

  test('masks customer data captured from the signed-in application', () => {
    const profile = report.pages.find(p => p.route === '/profile');
    expect(profile).toBeDefined();
    // The profile form holds alice@demo-bank.test; it must not survive capture intact.
    expect(profile!.visibleTextExcerpt).not.toContain('alice@demo-bank.test');
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain('alice@demo-bank.test');
  });
});
