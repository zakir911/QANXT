import { describe, expect, it } from 'vitest';
import { classifyFailure, PermanentJobFailure } from '../src/queue/permanent-failure.js';

/**
 * The failure that forced this to exist, verbatim from a user's worker log on macOS. It
 * failed in 126ms, was released, was reclaimed by the same consumer a visibility window
 * later, and failed again — indefinitely, on a job that could never pass, while the run it
 * belonged to reported Running throughout.
 */
const MISSING_BROWSER = `browserType.launch: Executable doesn't exist at /Users/someone/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell
╔═════════════════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.                    ║
║ Please run the following command to download new browsers:              ║
║                                                                         ║
║     npx playwright install                                              ║
╚═════════════════════════════════════════════════════════════════════════╝`;

describe('classifying a job failure', () => {
  it('calls a missing browser binary permanent and says how to install it', () => {
    const verdict = classifyFailure(new Error(MISSING_BROWSER));

    expect(verdict.permanent).toBe(true);
    expect(verdict.reason).toContain('playwright install chromium');
    // The first line is the fact; the banner and stack are noise on a run a user reads.
    expect(verdict.reason).not.toContain('╔');
    expect(verdict.reason).not.toContain('npx playwright install\n');
  });

  it('calls missing system libraries permanent and names install-deps', () => {
    const verdict = classifyFailure(new Error(
      'browserType.launch: Host system is missing dependencies to run browsers.'));

    expect(verdict.permanent).toBe(true);
    expect(verdict.reason).toContain('install-deps');
  });

  it('treats a timeout as retryable, because another attempt genuinely can pass', () => {
    const verdict = classifyFailure(new Error('page.goto: Timeout 30000ms exceeded.'));

    expect(verdict.permanent).toBe(false);
    expect(verdict.reason).toContain('Timeout 30000ms exceeded');
  });

  it('treats a connection reset as retryable', () => {
    const verdict = classifyFailure(new Error('read ECONNRESET'));
    expect(verdict.permanent).toBe(false);
  });

  it('treats an unrecognised failure as retryable rather than guessing', () => {
    // Deliberate: a failure mode nobody has classified should get the benefit of the retry
    // budget, not be discarded on a guess. The budget still bounds it.
    const verdict = classifyFailure(new Error('something nobody has seen before'));

    expect(verdict.permanent).toBe(false);
    expect(verdict.reason).toBe('something nobody has seen before');
  });

  it('honours a handler that declares the failure permanent itself', () => {
    const verdict = classifyFailure(
      new PermanentJobFailure('The job names an application that no longer exists.',
        'Delete the schedule that queued it.'));

    expect(verdict.permanent).toBe(true);
    expect(verdict.reason).toContain('no longer exists');
    expect(verdict.reason).toContain('Delete the schedule');
  });

  it('handles a thrown non-Error without crashing', () => {
    const verdict = classifyFailure('a bare string');
    expect(verdict.permanent).toBe(false);
    expect(verdict.reason).toBe('a bare string');
  });

  it('says something useful when the failure carries no message at all', () => {
    const verdict = classifyFailure(new Error(''));
    expect(verdict.reason).toBe('The worker reported no reason.');
  });
});
