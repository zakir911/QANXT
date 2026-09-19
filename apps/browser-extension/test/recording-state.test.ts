import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The service worker owns the recording, and every message it handles is a
 * read-modify-write over one stored object. MV3 delivers messages concurrently, so two
 * steps produced within the same millisecond — a username being filled and then a
 * password — used to race: both read the recording before either wrote it back, and the
 * later write dropped the earlier step. A recording that silently loses the password step
 * generates a test that cannot sign in, so the serialisation is asserted here rather than
 * left to the end-to-end check to notice.
 */

type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

let listener: Listener;
let store: Record<string, unknown>;

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

/** A storage stub that suspends on every read, the way the real one does. */
function installChromeStub(readDelayMs: number): void {
  store = {};
  const defer = <T>(value: T): Promise<T> =>
    new Promise(resolve => setTimeout(() => resolve(value), readDelayMs));

  (globalThis as Record<string, unknown>).chrome = {
    runtime: { onMessage: { addListener: (fn: Listener) => { listener = fn; } }, lastError: undefined },
    storage: {
      session: {
        // chrome.storage structured-clones in both directions, so a handler can never
        // reach the stored object by reference. Cloning here is what makes the race real.
        get: (key: string) => defer({ [key]: clone(store[key]) }),
        set: (values: Record<string, unknown>) => { Object.assign(store, clone(values)); return Promise.resolve(); }
      }
    },
    action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
    tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve() }
  };
}

/** Sends a message the way Chrome does, and resolves with the worker's response. */
function send(message: unknown): Promise<unknown> {
  return new Promise(resolve => listener(message, {}, resolve));
}

const fillStep = (testId: string, value: string) => ({
  kind: 'step',
  step: {
    action: 'fill',
    description: `Enter a value in ${testId}`,
    target: { strategy: 'testId', value: testId, exact: false, fallbacks: [] },
    value,
    url: 'http://localhost:4200/login',
    timestampMs: Date.now()
  }
});

beforeEach(async () => {
  installChromeStub(5);
  // The worker registers its listener on import; a fresh module gives a fresh listener.
  vi.resetModules();
  await import('../src/background');
  await send({ kind: 'clear' });
  store['aira.recording'] = {
    recording: true, paused: false, name: 'Journey', startUrl: 'http://localhost:4200/login',
    steps: [{ order: 1, action: 'navigate', description: 'Go to /login', url: 'http://localhost:4200/login', timestampMs: 0 }]
  };
});

describe('the recording survives concurrent steps', () => {
  test('keeps both steps when two arrive before either is stored', async () => {
    // Sent without awaiting the first: exactly what filling two fields in quick
    // succession produces.
    await Promise.all([
      send(fillStep('username', 'alice')),
      send(fillStep('password', '${secret:app_password}'))
    ]);

    const state = store['aira.recording'] as { steps: Array<{ order: number; value?: string }> };
    expect(state.steps).toHaveLength(3);
    expect(state.steps.map(s => s.order)).toEqual([1, 2, 3]);
    expect(state.steps.some(s => s.value === '${secret:app_password}')).toBe(true);
  });

  test('still collapses repeated edits to the same field into one step', async () => {
    await send(fillStep('username', 'ali'));
    await send(fillStep('username', 'alice'));

    const state = store['aira.recording'] as { steps: Array<{ value?: string }> };
    expect(state.steps).toHaveLength(2);
    expect(state.steps[1]?.value).toBe('alice');
  });
});
