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
