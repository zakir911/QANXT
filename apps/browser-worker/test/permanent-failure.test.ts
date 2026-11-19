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

/**
 * The second failure that forced a change here, verbatim from run accddf2b. Every
 * execution's callback token was minted at run start with a two-hour life; two hours in,
 * 1,116 executions were still queued and every one of their callbacks was refused.
 *
 * A signature existed for exactly this. It read
 *   /\b(401|403|404)\b.*(discovery|execution|security|worker)/i
 * and required the status code to come before the word. The real message is a URL and
 * then a number, and the URL says "executions", so it never matched once. The jobs were
 * released and reclaimed until their budget ran out, and those retries answered 1,110
 * further 429s out of the control plane they were retrying against.
 */
const EXPIRED_TOKEN =
  '/api/v1/worker/executions/3e080446-b528-43bc-8306-7cbf63148ea0/started failed with 401';

/** What `ControlPlaneClient.ensureOk` throws. Rebuilt here so this file stays the queue's. */
function controlPlaneError(message: string, status: number) {
  const error = new Error(message) as Error & { status: number; retryable: boolean };
  error.name = 'ControlPlaneError';
  error.status = status;
  error.retryable = status >= 500 || status === 408 || status === 429;
  return error;
}

describe('classifying a refusal the control plane has already settled', () => {
  it('calls an expired callback token permanent, which the old regex never did', () => {
    const verdict = classifyFailure(controlPlaneError(EXPIRED_TOKEN, 401));

    expect(verdict.permanent).toBe(true);
    expect(verdict.reason).toContain('expired');
    // The operator needs the failing call, not only the diagnosis.
    expect(verdict.reason).toContain('/started failed with 401');
  });

  it('does not depend on where the status code falls in the message', () => {
    // The whole defect: the path comes first and contains the word the regex anchored on.
    const codeLast = classifyFailure(controlPlaneError(EXPIRED_TOKEN, 401));
    const codeFirst = classifyFailure(controlPlaneError(
      '401 refused: /api/v1/worker/executions/3e080446/started', 401));

    expect(codeLast.permanent).toBe(true);
    expect(codeFirst.permanent).toBe(true);
  });

  it('calls a scope refusal permanent', () => {
    const verdict = classifyFailure(controlPlaneError(
      '/api/v1/worker/executions/3e080446/complete failed with 403', 403));

    expect(verdict.permanent).toBe(true);
    expect(verdict.reason).toContain('one job and one scope');
  });

  it('calls a missing run permanent', () => {
    const verdict = classifyFailure(controlPlaneError(
      '/api/v1/worker/executions/3e080446/started failed with 404', 404));

    expect(verdict.permanent).toBe(true);
    expect(verdict.reason).toContain('no longer exists');
  });

  it('covers a refusal no signature was ever written for', () => {
    // The old list named three statuses. Honouring the client's own verdict covers every
    // refusal it can report, including ones nobody has met yet.
    const verdict = classifyFailure(controlPlaneError(
      '/api/v1/worker/executions/3e080446/complete failed with 422', 422));

    expect(verdict.permanent).toBe(true);
  });

  it('still retries a rate limit, which is the one 4xx that clears by waiting', () => {
    const verdict = classifyFailure(controlPlaneError(
      '/api/v1/worker/executions/3e080446/started failed with 429', 429));

    expect(verdict.permanent).toBe(false);
  });

  it('still retries a server error', () => {
    const verdict = classifyFailure(controlPlaneError(
      '/api/v1/worker/executions/3e080446/started failed with 503', 503));

    expect(verdict.permanent).toBe(false);
  });

  it('does not mistake an ordinary error carrying a status-like field for a refusal', () => {
    // `retryable: false` is the signal, not the presence of a number called status.
    const notOurs = new Error('page.goto: net::ERR_ABORTED') as Error & { status: number };
    notOurs.status = 404;

    expect(classifyFailure(notOurs).permanent).toBe(false);
  });
});
