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

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('PATCH', path, body);
  }

  async delete<T = void>(path: string): Promise<T> {
    return this.send<T>('DELETE', path);
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
      // Two different refusals arrive as 403, and they go to different people. "Your role
      // does not allow this" is resolved by granting a role. "A policy refuses this
      // regardless of your role" must not be, and a pipeline told only that it lacks
      // permission will try to resolve it by widening the service account — which is the
      // opposite of the correct response. The error code on the wire separates them.
      if (problemCode(text) === 'security_policy') {
        throw new CliError(describeProblem(text), ExitCode.SecurityPolicyViolation,
          'A security policy refused this run. It did not happen, and that is the correct '
          + 'outcome. Do not retry until you have read why — in particular, do not widen '
          + "the service account's permissions, which will not change this answer.");
      }
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
      // A 500 is AIRA failing, not AIRA being unreachable, and the two go to different
      // people: one is a defect to file, the other is a deployment to check. A gateway
      // error in front of AIRA stays infrastructure, because that is exactly what it is.
      const internal = response.status === 500;
      throw new CliError(
        `${method} ${path} failed (${response.status}).`,
        internal ? ExitCode.AiraInternalError : ExitCode.InfrastructureError,
        internal
          ? `${describeProblem(text)} This is a defect in AIRA. Report it with the `
            + 'correlation id above; the application under test is not implicated.'
          : describeProblem(text));
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // AIRA's own API produced this. Nothing about the application under test is known.
      throw new CliError(`The platform returned a response that is not JSON.`,
        ExitCode.AiraInternalError, text.slice(0, 200));
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

/** The machine-readable code the API puts on a problem document, when it parses. */
function problemCode(text: string): string | undefined {
  try {
    return (JSON.parse(text) as { code?: string }).code;
  } catch {
    return undefined;
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
