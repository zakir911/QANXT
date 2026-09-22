import { CliError, ExitCode } from './exit-codes.js';

/**
 * The CLI's view of the control plane.
 *
 * Every failure is turned into a CliError carrying the exit status it deserves, because the
 * difference between "your credentials expired" and "the platform is down" decides who gets
 * paged. The token is sent in the Authorization header and never placed in a URL, where it
 * would end up in access logs and CI console output.
 */
export class ApiClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async get<T>(path: string): Promise<T> {
    return this.send<T>('GET', path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('POST', path, body);
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      throw new CliError(
        `Could not reach the platform at ${this.baseUrl}.`,
        ExitCode.InfrastructureError,
        `${String(error)}. Check AIRA_API_URL and that the API is running.`);
    }

    const text = await response.text();

    if (response.status === 401) {
      throw new CliError('The platform rejected the session.', ExitCode.AuthenticationError,
        'The token has expired or was revoked. Run "aira login" again, or refresh AIRA_TOKEN.');
    }
    if (response.status === 403) {
      throw new CliError('The account is not permitted to do that.', ExitCode.AuthenticationError,
        'Ask an organization administrator for the required role.');
    }
    if (response.status === 400 || response.status === 404 || response.status === 409 || response.status === 422) {
      // The request was wrong, not the platform. Reporting this as an infrastructure
      // error would send a pipeline's failure to whoever runs the platform instead of to
      // whoever wrote the configuration that caused it.
      throw new CliError(
        describeProblem(text),
        ExitCode.ConfigurationError,
        undefined,
        problemDetails(text));
    }
    if (!response.ok) {
      throw new CliError(
        `${method} ${path} failed (${response.status}).`,
        ExitCode.InfrastructureError,
        describeProblem(text));
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError(`The platform returned a response that is not JSON.`,
        ExitCode.InfrastructureError, text.slice(0, 200));
    }
  }
}

/** Unwraps the API's problem document into one readable line. */
function describeProblem(text: string): string {
  if (!text) return 'The platform returned no detail.';
  try {
    const problem = JSON.parse(text) as { title?: string; detail?: string; correlationId?: string };
    const message = problem.detail ?? problem.title;
    if (!message) return text.slice(0, 300);
    return problem.correlationId ? `${message} (correlation ${problem.correlationId})` : message;
  } catch {
    return text.slice(0, 300);
  }
}

/** The per-field problems a validation failure carries, when it carries any. */
function problemDetails(text: string): Record<string, string[]> | undefined {
  try {
    const problem = JSON.parse(text) as { errors?: Record<string, string[]> };
    return problem.errors && Object.keys(problem.errors).length > 0 ? problem.errors : undefined;
  } catch {
    return undefined;
  }
}

/** Signing in is the one call made without a session, so it does not go through ApiClient. */
export async function login(apiUrl: string, body: {
  organizationSlug?: string; email: string; password: string;
}): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new CliError(`Could not reach the platform at ${apiUrl}.`, ExitCode.InfrastructureError, String(error));
  }

  const text = await response.text();
  if (response.status === 401) {
    throw new CliError('Those credentials were not accepted.', ExitCode.AuthenticationError,
      'Check the email, password and organization.');
  }
  if (!response.ok) {
    throw new CliError(`Sign-in failed (${response.status}).`, ExitCode.InfrastructureError, describeProblem(text));
  }
  return JSON.parse(text) as { accessToken: string; refreshToken?: string; expiresAt?: string };
}
