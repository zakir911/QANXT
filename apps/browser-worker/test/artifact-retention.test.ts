import { describe, expect, it } from 'vitest';
import { shouldRetainHeavyArtifacts } from '../src/execution/executor.js';

/**
 * Which executions keep a trace and a video.
 *
 * This exists because a 6,354-test run wrote 7.3GB of them. The disk filled, postgres died
 * twice, and 992 tests ended with no verdict at all — not because any test was slow or
 * broken, but because the worker kept a trace and a video for every execution that passed
 * and nobody ever opens those. A product that cannot finish a real suite is not a product.
 */
describe('keeping a trace and a video', () => {
  const settings = (over = {}) => ({ retainHeavyArtifactsOnPass: undefined, ...over });

  it('keeps them for every verdict somebody will investigate', () => {
    for (const status of ['failed', 'healed', 'timedOut', 'error', 'blocked', 'flaky']) {
      expect(shouldRetainHeavyArtifacts(status, settings())).toBe(true);
    }
  });

  it('does not keep them for a pass', () => {
    expect(shouldRetainHeavyArtifacts('passed', settings())).toBe(false);
  });

  it('does not keep them for work that never ran', () => {
    // There is nothing in the trace of a test that was skipped or cancelled.
    expect(shouldRetainHeavyArtifacts('skipped', settings())).toBe(false);
    expect(shouldRetainHeavyArtifacts('cancelled', settings())).toBe(false);
  });

  it('keeps them for a pass when somebody has asked for that', () => {
    // For debugging a test that passes when it should not.
    expect(shouldRetainHeavyArtifacts('passed', settings({ retainHeavyArtifactsOnPass: true })))
      .toBe(true);
  });

  it('treats a missing setting as off rather than on', () => {
    // The default decides whether the product can run a real suite, so it is not left to
    // whether a caller remembered to send the field.
    expect(shouldRetainHeavyArtifacts('passed', {})).toBe(false);
    expect(shouldRetainHeavyArtifacts('passed', settings({ retainHeavyArtifactsOnPass: false })))
      .toBe(false);
  });

  it('keeps a failure even when retention on pass is off', () => {
    expect(shouldRetainHeavyArtifacts('failed', settings({ retainHeavyArtifactsOnPass: false })))
      .toBe(true);
  });
});
