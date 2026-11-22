import { describe, expect, test } from 'vitest';
import { BrowserPool, hasDisplay } from '../src/browser/browser-pool.js';
import { Logger } from '../src/util/logger.js';

function pool(workerHeadless: boolean, screen: boolean) {
  const lines: string[] = [];
  const logger = new Logger('debug', {}, line => lines.push(line));
  return { pool: new BrowserPool(workerHeadless, logger, () => screen), lines };
}

describe('watching a run in a browser window', () => {
  test('a run that asks to be watched opens a window on a worker with a screen', () => {
    expect(pool(true, true).pool.resolveHeadless(true)).toBe(false);
  });

  test('a run that does not ask stays headless', () => {
    expect(pool(true, true).pool.resolveHeadless(false)).toBe(true);
    expect(pool(true, true).pool.resolveHeadless(undefined)).toBe(true);
  });

  test('WORKER_HEADLESS=false still shows every job, as before', () => {
    expect(pool(false, true).pool.resolveHeadless(false)).toBe(false);
  });

  test('without a screen the run goes ahead headless and says so once', () => {
    const { pool: p, lines } = pool(true, false);
    expect(p.resolveHeadless(true)).toBe(true);
    expect(p.resolveHeadless(true)).toBe(true);
    expect(lines.filter(l => l.includes('has no screen'))).toHaveLength(1);
  });
});

describe('hasDisplay', () => {
  test('macOS and Windows have a desktop', () => {
    expect(hasDisplay('darwin', {})).toBe(true);
    expect(hasDisplay('win32', {})).toBe(true);
  });

  test('Linux has one only under X11 or Wayland', () => {
    expect(hasDisplay('linux', {})).toBe(false);
    expect(hasDisplay('linux', { DISPLAY: ':0' })).toBe(true);
    expect(hasDisplay('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
  });
});

/**
 * Releasing Playwright's trace scratch.
 *
 * A trace's screenshots and DOM snapshots go into a directory that belongs to the browser
 * process and is shared by all of its contexts. It is removed when the browser closes, not
 * when a context does, and a trace that is discarded rather than saved still leaves its
 * blobs there. Measured on this project's own lab: a 6,372-test run left 45 such
 * directories totalling 13GB, one of them 11GB, on top of the 13GB the run meant to keep.
 * The disk filled and every browser-backed test after that failed with
 * ERR_INSUFFICIENT_RESOURCES — including, while this was being diagnosed, the suite that
 * tests the oracles.
 *
 * Driven against real browsers, because the claim is that a browser process goes away and
 * nothing short of one would show that.
 */
describe('a browser does not serve a whole run', () => {
  const logger = new Logger('debug', {}, () => {});

  test('a fresh browser replaces one that has served its allowance', async () => {
    const p = new BrowserPool(true, logger, () => false, 2);
    try {
      const first = await p.acquire('chromium');
      // Two contexts is the allowance; the third request must not come from this browser.
      const a = await p.createContext('chromium', { defaultTimeoutMs: 1000, navigationTimeoutMs: 5000 });
      const b = await p.createContext('chromium', { defaultTimeoutMs: 1000, navigationTimeoutMs: 5000 });
      const second = await p.acquire('chromium');

      expect(second).not.toBe(first);
      // The old one is still alive, because contexts are still open on it: closing it here
      // would close them underneath the tests using them.
      expect(first.isConnected()).toBe(true);

      await a.close();
      await b.close();
      // And once they are gone it closes itself, which is what frees the scratch.
      const freed = await Promise.race([
        new Promise<boolean>(resolve => first.on('disconnected', () => resolve(true))),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 15_000))
      ]);
      expect(freed).toBe(true);
      expect(first.isConnected()).toBe(false);
      expect(second.isConnected()).toBe(true);
    } finally {
      await p.close().catch(() => undefined);
    }
  }, 90_000);

  test('a browser inside its allowance is reused, so the launch cost is not paid per test', async () => {
    const p = new BrowserPool(true, logger, () => false, 50);
    try {
      const first = await p.acquire('chromium');
      const context = await p.createContext('chromium', { defaultTimeoutMs: 1000, navigationTimeoutMs: 5000 });
      expect(await p.acquire('chromium')).toBe(first);
      await context.close();
    } finally {
      await p.close().catch(() => undefined);
    }
  }, 90_000);

  test('closing the pool closes a retired browser too', async () => {
    // A retired browser waiting on a context leaked by a crashed test must not outlive
    // the pool, still holding its scratch.
    const p = new BrowserPool(true, logger, () => false, 1);
    const first = await p.acquire('chromium');
    const leaked = await p.createContext('chromium', { defaultTimeoutMs: 1000, navigationTimeoutMs: 5000 });
    await p.acquire('chromium');
    expect(first.isConnected()).toBe(true);

    await p.close();

    expect(first.isConnected()).toBe(false);
    void leaked;
  }, 90_000);
});
