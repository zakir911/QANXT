/**
 * Telling a failure that retrying can fix from one it cannot.
 *
 * At-least-once delivery is the right default: a crashed browser, a timeout, a network blip
 * all deserve another attempt on another worker. But some failures are settled on the first
 * try and will be settled the same way on the thousandth. A browser binary that is not
 * installed is the case that proved it: the job was released, reclaimed, and failed again
 * about every visibility window, burning a worker slot forever on work that could not pass,
 * while the run it belonged to reported Running throughout.
 *
 * Retrying those is not caution, it is a hot loop. They are failed once, with the reason,
 * and the operator is told what to do about it.
 */

/** Thrown by a handler that knows another attempt cannot succeed. */
export class PermanentJobFailure extends Error {
  override readonly name = 'PermanentJobFailure';

  constructor(message: string, readonly remedy?: string, readonly underlying?: unknown) {
    super(remedy ? `${message} ${remedy}` : message);
  }
}

/** A failure the handler could not classify, carrying what it was told to say about it. */
export interface FailureVerdict {
  permanent: boolean;
  /** What to tell the user. Already includes the remedy when there is one. */
  reason: string;
}

interface Signature {
  /** Matched against the error message, case-insensitively. */
  test: RegExp;
  remedy: string;
}

/**
 * Failures that no retry can change. Each entry has to name a remedy: a permanent verdict
 * with no way out is a dead end, and if we cannot say what to do about it we should be
 * retrying instead and letting the budget catch it.
 */
const PERMANENT: readonly Signature[] = [
  {
    // Playwright, when the browser was never downloaded. The exact text it prints is
    // "Executable doesn't exist at <path>", with its own install banner underneath.
    test: /executable doesn'?t exist at|please run the following command to download new browsers/i,
    remedy:
      'The browser Playwright needs is not installed on this worker. Install it with '
      + '"./node_modules/.bin/playwright install chromium" from apps/browser-worker, then '
      + 'restart the worker.'
  },
  {
    // A browser that is installed but cannot start for a reason restarting will not fix,
    // most often missing shared libraries on a slim Linux image.
    test: /error while loading shared libraries|host system is missing dependencies/i,
    remedy:
      'The browser is installed but cannot start because system libraries are missing. '
      + 'Install them with "sudo ./node_modules/.bin/playwright install-deps chromium".'
  },
  {
    // The control plane refused the job itself: a run that no longer exists, or a token
    // that will not become valid by waiting.
    test: /\b(401|403|404)\b.*(discovery|execution|security|worker)|was not found\./i,
    remedy:
      'The control plane refused this job. The run may have been deleted, or this worker\'s '
      + 'token may be wrong or expired. Check WORKER_TOKEN and that the run still exists.'
  }
];

/**
 * Classifies a thrown value. A `PermanentJobFailure` says so itself; anything else is
 * matched against the known signatures and is retryable by default.
 *
 * Retryable by default on purpose: a new failure mode we have not seen should get the
 * benefit of the doubt from the retry budget, not be thrown away on a guess.
 */
export function classifyFailure(error: unknown): FailureVerdict {
  if (error instanceof PermanentJobFailure) {
    return { permanent: true, reason: error.message };
  }

  const message = error instanceof Error ? error.message : String(error);

  for (const signature of PERMANENT) {
    if (signature.test.test(message)) {
      return { permanent: true, reason: `${firstLine(message)} ${signature.remedy}` };
    }
  }

  return { permanent: false, reason: firstLine(message) };
}

/**
 * Playwright errors arrive with a banner and a stack attached. The first line is the fact;
 * the rest is noise in a message a user reads on a run.
 */
function firstLine(message: string): string {
  const line = message.split('\n').map(part => part.trim()).find(part => part.length > 0);
  return line ?? 'The worker reported no reason.';
}
