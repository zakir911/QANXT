/**
 * How the platform's execution statuses map onto the four verdicts a CI system understands.
 *
 * This mapping is the one place where the platform's honesty rules meet a format that only
 * has "pass", "fail", "error" and "skipped" to say things with, so each choice is recorded
 * rather than left to whoever reads the XML:
 *
 *   healed   → passed, with a note. The journey completed, so failing the build would be
 *              wrong; hiding that a locator was rewritten would also be wrong, so every
 *              report says so in the test's output.
 *   flaky    → passed, with a note. Same reasoning. The platform only ever labels a *pass*
 *              flaky, so this can never turn a failure into a green build.
 *   blocked  → error, never passed. The test could not run — a missing credential, an
 *              unreachable environment. Reporting that as a pass would claim coverage that
 *              does not exist, and reporting it as a failure would send someone hunting for
 *              a defect in the application.
 *   timedOut → failed. The test ran and did not finish in its budget; that is a result.
 *   cancelled→ skipped. A person stopped it; it is not evidence of anything.
 *   pending / queued / running → error. A finished run should not contain these, so seeing
 *              one means the run was reported incomplete, and a report must not quietly
 *              drop a test it cannot account for.
 */

export type Verdict = 'passed' | 'failed' | 'error' | 'skipped';

const VERDICTS: Record<string, Verdict> = {
  passed: 'passed',
  healed: 'passed',
  flaky: 'passed',
  failed: 'failed',
  timedOut: 'failed',
  error: 'error',
  blocked: 'error',
  skipped: 'skipped',
  cancelled: 'skipped'
};

export function verdictOf(status: string): Verdict {
  return VERDICTS[status] ?? 'error';
}

/** The note a passing-but-qualified verdict must carry, so a green is never a silent green. */
export function qualification(status: string): string | undefined {
  switch (status) {
    case 'healed':
      return 'This test passed only after a locator was healed. Review the healing proposal '
        + 'before trusting the result: the application may have changed in a way that matters.';
    case 'flaky':
      return 'This test passed, but the platform has seen it change verdict repeatedly on '
        + 'unchanged code. Treat the result as weak evidence.';
    default:
      return undefined;
  }
}

/** Why a non-passing verdict is what it is, for a reader who only has the report. */
export function explain(status: string, errorMessage?: string | null): string {
  const detail = errorMessage?.trim();
  switch (status) {
    case 'blocked':
      return detail
        ? `The test could not be run: ${detail}`
        : 'The test could not be run. This is not a failure of the application — the run was '
          + 'blocked before the test could reach it.';
    case 'timedOut':
      return detail ? `The test ran out of time: ${detail}` : 'The test ran out of time.';
    case 'cancelled':
      return 'The run was cancelled before this test finished.';
    case 'skipped':
      return detail ?? 'The test was not run.';
    case 'pending':
    case 'queued':
    case 'running':
      return `The run was reported as finished while this test was still "${status}". `
        + 'The result is unknown, not a pass.';
    default:
      return detail ?? 'The test failed without a recorded message.';
  }
}
