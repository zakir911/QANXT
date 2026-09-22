import { request as playwrightRequest, type APIRequestContext, type Page } from 'playwright';
import type {
  ApiAuthDescriptor, ApiRequestDescriptor, ApiResponseRecord, HttpMethod, PlannedAssertion
} from '@aira/shared-types';
import {
  MUTATING_METHODS, RESPONSE_ASSERTION_TYPES, describeJsonValue, readJsonPath, statusMatches
} from '@aira/shared-types';
import { isUrlAllowed } from '../security/url-guard.js';
import type { SecretMasker } from '../security/masker.js';
import { ActionError, type ActionContext, type AssertionOutcome } from './action-runner.js';

/**
 * Executes the `apiRequest` verb.
 *
 * An API test is a test case like any other, so this file is deliberately the same shape as
 * `action-runner.ts`: it takes an already-validated declarative description, performs
 * exactly what it says, records what happened, and decides nothing. The verdict comes from
 * assertions; the evidence is the request and the response.
 *
 * Three things here are load-bearing rather than incidental:
 *
 *  - Every URL goes through the same allowlist guard the browser does. A discovered
 *    endpoint is not a licence to call it: the boundary is checked at the moment of the
 *    call, so a templated path or a captured value cannot smuggle a request outside it.
 *  - Credentials and captured values are masked before anything is written. What reaches
 *    evidence is the exchange, not the secret that authorised it.
 *  - A non-2xx response is not automatically a failure. Asserting that an unauthenticated
 *    call returns 401 is a test that must be able to pass.
 */

/** Everything the runner needs beyond the action context the browser steps use. */
export interface ApiRequestContextOptions {
  /** Where relative paths resolve. */
  apiBaseUrl: string;
  /** False in an environment that refuses writes; POST/PUT/PATCH/DELETE are then refused. */
  allowMutatingRequests: boolean;
  masker: SecretMasker;
  /** The page whose session an `inheritSession` request reuses. */
  page?: Page;
}

export interface ApiRequestOutcome {
  record: ApiResponseRecord;
  /** The parsed body when the response was JSON; undefined otherwise. */
  parsedBody?: unknown;
  bodyText?: string;
  /** Values pulled out by the descriptor's `capture` map, for `${data:...}` in later steps. */
  captured: Record<string, string>;
}

const MAX_BODY_EXCERPT = 8000;

export async function performApiRequest(
  descriptor: ApiRequestDescriptor,
  context: ActionContext,
  options: ApiRequestContextOptions
): Promise<ApiRequestOutcome> {
  const method = (descriptor.method ?? 'GET').toUpperCase() as HttpMethod;

  if (MUTATING_METHODS.includes(method) && !options.allowMutatingRequests) {
    // Refused rather than attempted. An environment that forbids writes forbids them at the
    // moment of the call, not by hoping no test contains one.
    throw new ActionError(
      `A ${method} request is not permitted against this environment. `
      + 'Destructive API requests are disabled for it.', false);
  }

  const url = resolveUrl(descriptor, context, options.apiBaseUrl);
  const guard = isUrlAllowed(url, {
    allowedHosts: context.allowedHosts,
    excludedPathPrefixes: [],
    allowPrivateNetworks: context.allowPrivateNetworks
  });
  if (!guard.allowed) {
    throw new ActionError(`The request to ${options.masker.maskText(url)} was refused: ${guard.reason}`, false);
  }

  const auth = resolveAuth(descriptor.auth, context);
  const headers = buildHeaders(descriptor, context, auth);
  const body = context.resolveTemplate(descriptor.body);
  const timeout = descriptor.timeoutMs ?? context.defaultTimeoutMs;

  const { api, dispose } = await acquireContext(auth, url, context, options);

  const startedAt = Date.now();
  let record: ApiResponseRecord;
  let bodyText: string | undefined;
  let parsedBody: unknown;

  try {
    if (auth?.mode === 'oAuth2ClientCredentials' && auth.token === undefined) {
      throw new ActionError('The OAuth2 token exchange produced no access token.', false);
    }

    const response = await api.fetch(url, {
      method,
      headers,
      data: body,
      timeout,
      // Redirects are followed, as a browser would; failures are reported rather than thrown
      // so that a 500 can be asserted on.
      failOnStatusCode: false
    });

    const durationMs = Date.now() - startedAt;
    const responseHeaders = response.headers();
    const contentType = responseHeaders['content-type'] ?? '';

    try {
      bodyText = await response.text();
    } catch {
      // A body that cannot be read is still an exchange worth recording.
    }

    if (bodyText !== undefined && contentType.includes('json')) {
      try { parsedBody = JSON.parse(bodyText); } catch { parsedBody = undefined; }
    }

    record = {
      requestMethod: method,
      requestUrl: options.masker.maskText(url),
      requestHeaders: options.masker.maskHeaders(headers),
      requestBodyExcerpt: body ? options.masker.maskJson(body).slice(0, MAX_BODY_EXCERPT) : undefined,
      statusCode: response.status(),
      statusText: response.statusText(),
      responseHeaders: options.masker.maskHeaders(responseHeaders),
      responseBodyExcerpt: bodyText === undefined
        ? undefined
        : options.masker.maskJson(bodyText).slice(0, MAX_BODY_EXCERPT),
      responseSizeBytes: bodyText === undefined ? 0 : Buffer.byteLength(bodyText),
      durationMs
    };
  } catch (error) {
    if (error instanceof ActionError) { await dispose(); throw error; }

    // No response at all: DNS, connection refused, TLS, timeout. Recorded as an exchange
    // with a transport error so the evidence shows the attempt rather than a silent gap.
    const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
    record = {
      requestMethod: method,
      requestUrl: options.masker.maskText(url),
      requestHeaders: options.masker.maskHeaders(headers),
      requestBodyExcerpt: body ? options.masker.maskJson(body).slice(0, MAX_BODY_EXCERPT) : undefined,
      statusCode: 0,
      statusText: '',
      responseHeaders: {},
      responseSizeBytes: 0,
      durationMs: Date.now() - startedAt,
      transportError: options.masker.maskText(message)
    };
    await dispose();
    const outcome: ApiRequestOutcome = { record, captured: {} };
    throw new ApiTransportError(
      `${method} ${record.requestUrl} did not complete: ${record.transportError}`, outcome);
  }

  await dispose();

  const captured = captureValues(descriptor.capture, parsedBody, bodyText);

  // failOnErrorStatus defaults to true: a test that says nothing about the status still
  // means "this call should work". A negative test sets it false and asserts the code.
  if (descriptor.failOnErrorStatus !== false && record.statusCode >= 400) {
    throw new ApiStatusError(
      `${method} ${record.requestUrl} returned ${record.statusCode} ${record.statusText}.`,
      { record, parsedBody, bodyText, captured });
  }

  return { record, parsedBody, bodyText, captured };
}

/** Thrown when the request produced no response. Carries the exchange for evidence. */
export class ApiTransportError extends ActionError {
  constructor(message: string, readonly outcome: ApiRequestOutcome) {
    super(message, false);
    this.name = 'ApiTransportError';
  }
}

/** Thrown when a response arrived but its status was an error the test did not expect. */
export class ApiStatusError extends ActionError {
  constructor(message: string, readonly outcome: ApiRequestOutcome) {
    super(message, false);
    this.name = 'ApiStatusError';
  }
}

/** True when this assertion is evaluated against a response rather than a page. */
export function isResponseAssertion(type: string): boolean {
  return (RESPONSE_ASSERTION_TYPES as readonly string[]).includes(type);
}

/**
 * Evaluates one assertion against a recorded exchange.
 *
 * Every failure message names the expectation and what was actually there. An assertion
 * whose type this function does not recognise fails loudly: silently treating an unknown
 * assertion as satisfied is how a suite comes to contain tests that cannot fail.
 */
export function evaluateResponseAssertion(
  assertion: PlannedAssertion,
  outcome: ApiRequestOutcome,
  context: ActionContext
): AssertionOutcome {
  const expected = context.resolveValue(assertion.expected) ?? assertion.expected ?? '';
  const { record, parsedBody, bodyText } = outcome;

  const failure = ((): string | null => {
    if (record.transportError) {
      return `The request did not complete (${record.transportError}), so this assertion could not be evaluated.`;
    }

    switch (assertion.type) {
      case 'httpStatusEquals':
        return String(record.statusCode) === expected.trim()
          ? null
          : `Expected status ${expected} but the response was ${record.statusCode} ${record.statusText}.`;

      case 'responseStatusIn':
        return statusMatches(expected, record.statusCode)
          ? null
          : `Expected a status in "${expected}" but the response was ${record.statusCode} ${record.statusText}.`;

      case 'responseTimeUnderMs': {
        const limit = Number(expected);
        if (!Number.isFinite(limit) || limit <= 0) {
          return `"${expected}" is not a millisecond limit.`;
        }
        return record.durationMs < limit
          ? null
          : `Expected the response within ${limit}ms but it took ${record.durationMs}ms.`;
      }

      case 'responseBodyContains':
        if (bodyText === undefined) return 'The response had no readable body.';
        return bodyText.includes(expected)
          ? null
          : `Expected the body to contain "${expected}". It did not (${bodyText.length} bytes read).`;

      case 'responseJsonPathExists': {
        if (parsedBody === undefined) return jsonUnavailable(record);
        const path = assertion.attribute ?? expected;
        const found = readJsonPath(parsedBody, path);
        return found.found && found.value !== null
          ? null
          : `Expected a value at "${path}" but it was ${found.found ? 'null' : 'absent'}.`;
      }

      case 'responseJsonPathEquals': {
        if (parsedBody === undefined) return jsonUnavailable(record);
        // The path lives in attributeName and the expectation in expectedValue, matching
        // how attributeEquals already splits "which thing" from "what value".
        const path = assertion.attribute ?? '';
        if (path === '') return 'This assertion needs a JSON path; none was stored.';
        const found = readJsonPath(parsedBody, path);
        if (!found.found) return `Expected "${path}" to be ${expected} but the field was absent.`;
        return jsonEquals(found.value, expected)
          ? null
          : `Expected "${path}" to be ${expected} but it was ${describeJsonValue(found.value)}.`;
      }

      case 'responseJsonPathMatches': {
        if (parsedBody === undefined) return jsonUnavailable(record);
        const path = assertion.attribute ?? '';
        if (path === '') return 'This assertion needs a JSON path; none was stored.';
        const found = readJsonPath(parsedBody, path);
        if (!found.found) return `Expected "${path}" to match /${expected}/ but the field was absent.`;
        const rendered = typeof found.value === 'string' ? found.value : JSON.stringify(found.value) ?? '';
        let pattern: RegExp;
        try { pattern = new RegExp(expected); } catch { return `"${expected}" is not a valid regular expression.`; }
        return pattern.test(rendered)
          ? null
          : `Expected "${path}" to match /${expected}/ but it was ${describeJsonValue(found.value)}.`;
      }

      case 'responseHeaderEquals': {
        const name = (assertion.attribute ?? '').toLowerCase();
        if (name === '') return 'This assertion needs a header name; none was stored.';
        const actual = record.responseHeaders[name];
        return actual === expected
          ? null
          : `Expected header "${name}" to be "${expected}" but it was ${actual === undefined ? '(absent)' : `"${actual}"`}.`;
      }

      case 'responseSchemaMatches':
        // Contract comparison is a separate concern with its own classification of what a
        // difference means, and it runs in the control plane where the baseline lives.
        // Saying so is honest; answering "passed" here would not be.
        return 'Schema comparison is performed by the contract check, not by the executor.';

      default:
        return `This assertion type cannot be evaluated against a response: ${assertion.type}`;
    }
  })();

  if (failure === null) {
    // A negated assertion that held is a failure, and the message has to say which way
    // round it was; otherwise a passing negation reads as a bug in the report.
    return assertion.negate
      ? { failure: `Expected NOT: ${assertion.description || assertion.type}, but it held.`, isLocatorFailure: false }
      : { failure: null, isLocatorFailure: false };
  }
  return { failure: assertion.negate ? null : failure, isLocatorFailure: false };
}

function jsonUnavailable(record: ApiResponseRecord): string {
  const contentType = record.responseHeaders['content-type'] ?? '(none)';
  return `The response body could not be read as JSON (content-type ${contentType}).`;
}

/** Compares a JSON value with the stored expectation, which is always text. */
function jsonEquals(value: unknown, expected: string): boolean {
  if (value === null) return expected === 'null';
  if (typeof value === 'string') return value === expected;
  if (typeof value === 'number') return Number(expected) === value;
  if (typeof value === 'boolean') return String(value) === expected.toLowerCase();
  // Objects and arrays compare on their canonical text, so a test can assert an empty
  // array ("[]") without needing a separate assertion type for it.
  return JSON.stringify(value) === expected.replace(/\s+/g, '');
}

function captureValues(
  capture: Record<string, string> | undefined, parsedBody: unknown, bodyText: string | undefined
): Record<string, string> {
  const captured: Record<string, string> = {};
  if (!capture) return captured;

  for (const [name, path] of Object.entries(capture)) {
    if (parsedBody === undefined) continue;
    const found = readJsonPath(parsedBody, path);
    if (!found.found || found.value === null || found.value === undefined) continue;
    captured[name] = typeof found.value === 'string' ? found.value : JSON.stringify(found.value);
  }
  void bodyText;
  return captured;
}

function resolveUrl(descriptor: ApiRequestDescriptor, context: ActionContext, apiBaseUrl: string): string {
  const path = context.resolveTemplate(descriptor.path) ?? descriptor.path ?? '';
  let url: URL;
  try {
    url = new URL(path, apiBaseUrl || context.baseUrl);
  } catch {
    throw new ActionError(`"${path}" is not a usable request path.`, false);
  }

  for (const [name, rawValue] of Object.entries(descriptor.query ?? {})) {
    const value = context.resolveTemplate(rawValue) ?? rawValue;
    url.searchParams.set(name, value);
  }

  const auth = descriptor.auth;
  if (auth?.mode === 'apiKeyQuery' && auth.keyName) {
    url.searchParams.set(auth.keyName, context.resolveValue(auth.keyValue) ?? '');
  }
  return url.toString();
}

interface ResolvedAuth extends ApiAuthDescriptor {
  token?: string;
}

function resolveAuth(auth: ApiAuthDescriptor | undefined, context: ActionContext): ResolvedAuth | undefined {
  if (!auth) return undefined;
  return {
    ...auth,
    token: context.resolveValue(auth.token),
    username: context.resolveValue(auth.username),
    password: context.resolveValue(auth.password),
    keyValue: context.resolveValue(auth.keyValue),
    clientId: context.resolveValue(auth.clientId),
    clientSecret: context.resolveValue(auth.clientSecret)
  };
}

function buildHeaders(
  descriptor: ApiRequestDescriptor, context: ActionContext, auth: ResolvedAuth | undefined
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(descriptor.headers ?? {})) {
    headers[name] = context.resolveTemplate(rawValue) ?? rawValue;
  }

  if (descriptor.body !== undefined && !hasHeader(headers, 'content-type')) {
    headers['content-type'] = descriptor.contentType ?? 'application/json';
  }
  if (!hasHeader(headers, 'accept')) headers['accept'] = 'application/json, text/plain, */*';

  switch (auth?.mode) {
    case 'bearer':
      if (auth.token) headers['authorization'] = `Bearer ${auth.token}`;
      break;
    case 'basic':
      if (auth.username !== undefined) {
        const encoded = Buffer.from(`${auth.username}:${auth.password ?? ''}`).toString('base64');
        headers['authorization'] = `Basic ${encoded}`;
      }
      break;
    case 'apiKeyHeader':
      if (auth.keyName) headers[auth.keyName] = auth.keyValue ?? '';
      break;
    case 'oAuth2ClientCredentials':
      if (auth.token) headers['authorization'] = `Bearer ${auth.token}`;
      break;
    default:
      break;
  }
  return headers;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === name);
}

/**
 * Chooses the request context each auth mode requires.
 *
 * `inheritSession` reuses the page's context so the request carries the cookies a UI login
 * established — that is what makes "sign in, then call the API as that user" expressible.
 * Every other mode gets an isolated context, because a test that says it sends no
 * credentials must actually send none: inheriting cookies would make an asserted 401
 * quietly impossible.
 */
async function acquireContext(
  auth: ResolvedAuth | undefined,
  url: string,
  context: ActionContext,
  options: ApiRequestContextOptions
): Promise<{ api: APIRequestContext; dispose: () => Promise<void> }> {
  const mode = auth?.mode ?? 'inheritSession';

  if (mode === 'inheritSession') {
    if (!options.page) {
      throw new ActionError(
        'This request reuses the browser session, but the test has no page open.',
        false);
    }
    return { api: options.page.request, dispose: async () => undefined };
  }

  if (mode === 'oAuth2ClientCredentials' && auth) {
    auth.token = await exchangeClientCredentials(auth, context, options);
  }

  const api = await playwrightRequest.newContext({
    baseURL: new URL(url).origin,
    ignoreHTTPSErrors: false
  });
  return { api, dispose: () => api.dispose() };
}

/**
 * Exchanges client credentials for an access token.
 *
 * The token endpoint is checked against the same allowlist as everything else. An identity
 * provider on another host is a legitimate thing to need, and adding it to the project's
 * allowed hosts is a deliberate, recorded decision — which is the point.
 */
async function exchangeClientCredentials(
  auth: ResolvedAuth, context: ActionContext, options: ApiRequestContextOptions
): Promise<string> {
  if (!auth.tokenUrl) throw new ActionError('OAuth2 authentication needs a token URL.', false);

  const guard = isUrlAllowed(auth.tokenUrl, {
    allowedHosts: context.allowedHosts,
    excludedPathPrefixes: [],
    allowPrivateNetworks: context.allowPrivateNetworks
  });
  if (!guard.allowed) {
    throw new ActionError(
      `The token endpoint ${options.masker.maskText(auth.tokenUrl)} is outside this project's `
      + `allowed hosts: ${guard.reason}`, false);
  }

  const api = await playwrightRequest.newContext();
  try {
    const form: Record<string, string> = {
      grant_type: 'client_credentials',
      client_id: auth.clientId ?? '',
      client_secret: auth.clientSecret ?? ''
    };
    if (auth.scope) form.scope = auth.scope;

    const response = await api.post(auth.tokenUrl, {
      form,
      timeout: context.defaultTimeoutMs,
      failOnStatusCode: false
    });

    if (response.status() !== 200) {
      // The body is not echoed: a token endpoint's error body can contain the client
      // secret it was sent.
      throw new ActionError(
        `The token endpoint returned ${response.status()} ${response.statusText()}.`, false);
    }

    const payload = await response.json().catch(() => undefined) as { access_token?: string } | undefined;
    const token = payload?.access_token;
    if (!token) throw new ActionError('The token endpoint returned no access_token.', false);

    // Registered so it can never appear in evidence, exactly as a step secret is.
    options.masker.withLiteral(token);
    return token;
  } finally {
    await api.dispose();
  }
}
