/**
 * What the CLI's exit status means.
 *
 * A pipeline needs to tell "the application is broken" apart from "the tooling could not
 * run", because the two go to different people. Anything non-zero fails a build by default,
 * so the distinctions cost nothing and save a misdirected investigation.
 *
 * The codes are contract, not convenience: CI definitions in `infrastructure/ci` and
 * `.github/workflows` branch on them directly, and `docs/cli.md` documents every one. Adding
 * a code is additive; changing what an existing code means is a breaking change for every
 * pipeline already keying off it.
 */
export const ExitCode = {
  /** The run finished, the tests passed and the quality gate passed. */
  Success: 0,

  /**
   * Tests failed. The application or its tests are the story, and the quality gate is not
   * what stopped the build.
   *
   * Previously this code also covered a blocking quality gate. They are now distinct,
   * because "six tests failed" and "the pass rate was 94% against a threshold of 95" send a
   * reader to different places. A pipeline that treated 1 as "something about quality went
   * wrong" still behaves correctly, since both remain non-zero.
   */
  TestFailure: 1,

  /** Every test passed, or failed within tolerance, but a quality gate rule blocked. */
  QualityGateFailure: 2,

  /** The command, the configuration or the environment was wrong: a missing argument, an
   * unknown flag, a project that does not exist, an environment that is not configured. */
  ConfigurationError: 3,

  /** Not signed in, the session expired, or the account lacks the permission. */
  AuthenticationError: 4,

  /** The platform, the queue, the database or the application under test could not be
   * reached, or a worker died. Nothing is known about quality; do not read this as a pass. */
  InfrastructureError: 5,

  /**
   * A security policy refused the request: a target outside the allowed domains, a
   * production environment without explicit authorization, a destructive action a policy
   * forbids. The run did not happen, and that is the correct outcome.
   */
  SecurityPolicyViolation: 6,

  /**
   * The gate returned REVIEW rather than PASS or FAIL. A person has to look — typically
   * because tests self-healed, or a performance regression crossed a warning threshold.
   * Distinct from failure on purpose: a pipeline may choose to proceed on this and not on 1.
   */
  HumanReviewRequired: 7,

  /** QA NXT itself misbehaved: an unhandled error, a malformed response from its own API. A
   * bug in the tool, not a finding about the application. */
  QaNxtInternalError: 8
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** The name and one-line meaning of each code, for `--help` and for the docs to stay true. */
export const EXIT_CODE_TABLE: ReadonlyArray<{ code: ExitCodeValue; name: string; meaning: string }> = [
  { code: ExitCode.Success, name: 'PASS', meaning: 'Tests passed and the quality gate passed' },
  { code: ExitCode.TestFailure, name: 'TEST_FAILURE', meaning: 'One or more tests failed' },
  { code: ExitCode.QualityGateFailure, name: 'QUALITY_GATE_FAILURE', meaning: 'A quality gate rule blocked the run' },
  { code: ExitCode.ConfigurationError, name: 'CONFIGURATION_ERROR', meaning: 'Bad usage, or a project/environment that does not exist' },
  { code: ExitCode.AuthenticationError, name: 'AUTHENTICATION_ERROR', meaning: 'Not signed in, expired, or not permitted' },
  { code: ExitCode.InfrastructureError, name: 'INFRASTRUCTURE_ERROR', meaning: 'The platform, queue, worker or target could not be reached' },
  { code: ExitCode.SecurityPolicyViolation, name: 'SECURITY_POLICY_VIOLATION', meaning: 'A security policy refused the request' },
  { code: ExitCode.HumanReviewRequired, name: 'HUMAN_REVIEW_REQUIRED', meaning: 'The quality gate returned REVIEW' },
  { code: ExitCode.QaNxtInternalError, name: 'QANXT_INTERNAL_ERROR', meaning: 'QA NXT itself failed' }
];

/** An error that carries the exit status it should produce. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ExitCodeValue,
    readonly hint?: string,
    /** Field-level problems from a validation failure, so each can be printed on its own line. */
    readonly details?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const usage = (message: string, hint?: string): CliError =>
  new CliError(message, ExitCode.ConfigurationError, hint);
