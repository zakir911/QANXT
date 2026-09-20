/**
 * What the CLI's exit status means.
 *
 * A pipeline needs to tell "the application is broken" apart from "the tooling could not
 * run", because the two go to different people. Anything non-zero fails a build by default,
 * so the distinctions cost nothing and save a misdirected investigation.
 */
export const ExitCode = {
  /** The run finished and the quality gate passed. */
  Success: 0,
  /** Tests failed, or the quality gate blocked. The application or its tests are the story. */
  QualityGateFailed: 1,
  /** The command was used wrongly: a missing argument, an unknown flag. */
  UsageError: 2,
  /** Not signed in, the session expired, or the account lacks the permission. */
  AuthenticationError: 3,
  /** The platform was reachable but refused, or could not be reached at all. */
  PlatformError: 4,
  /** The run did not reach a verdict within the time allowed. */
  Timeout: 5
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** An error that carries the exit status it should produce. */
export class CliError extends Error {
  constructor(message: string, readonly code: ExitCodeValue, readonly hint?: string) {
    super(message);
    this.name = 'CliError';
  }
}

export const usage = (message: string, hint?: string): CliError =>
  new CliError(message, ExitCode.UsageError, hint);
