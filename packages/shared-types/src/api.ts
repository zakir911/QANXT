import type { ApiAuthMode } from './enums.js';

/**
 * How an HTTP request is described so that it can be executed identically every time.
 *
 * This is the API-testing analogue of `LocatorDescriptor`: a declarative record, validated
 * before anything is sent, rather than a snippet of code. The reasons are the same ones
 * that kept the browser engine honest — a request that is data can be stored, diffed,
 * replayed, reported on and audited, and an AI-authored request can be validated against a
 * closed shape instead of being trusted.
 *
 * Nothing here holds a secret. Credentials travel as `${secret:name}` references and are
 * resolved at dispatch, exactly as step values are.
 */
export interface ApiRequestDescriptor {
  method: HttpMethod;
  /** Absolute, or relative to the environment's API base URL. */
  path: string;
  /** Appended to the path. Values may be `${secret:...}` / `${data:...}` references. */
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Raw body. JSON is the common case, but a string keeps form and text payloads possible. */
  body?: string;
  /** Defaults to application/json when a body is present. */
  contentType?: string;
  auth?: ApiAuthDescriptor;
  timeoutMs?: number;
  /**
   * When false, a non-2xx response is not in itself a step failure — only the assertions
   * decide. Negative tests need this: asserting a 401 must not also fail on the 401.
   */
  failOnErrorStatus?: boolean;
  /**
   * Captures values out of the response for later steps: `{ accountId: 'data[0].id' }`
   * binds `${data:accountId}`. This is what lets an API test chain calls.
   */
  capture?: Record<string, string>;
}

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Methods that change state. Used to refuse them where a policy forbids writes. */
export const MUTATING_METHODS: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export interface ApiAuthDescriptor {
  mode: ApiAuthMode;
  /** `${secret:...}` reference or literal, depending on mode. */
  token?: string;
  username?: string;
  password?: string;
  /** Header or query parameter name for the API-key modes. */
  keyName?: string;
  keyValue?: string;
  /** OAuth2 client credentials. */
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
}

/** What an executed request actually did. Stored as evidence, with secrets masked. */
export interface ApiResponseRecord {
  requestMethod: string;
  /** Masked: query values that came from secrets are replaced before this is written. */
  requestUrl: string;
  requestHeaders: Record<string, string>;
  requestBodyExcerpt?: string;
  statusCode: number;
  statusText: string;
  responseHeaders: Record<string, string>;
  responseBodyExcerpt?: string;
  responseSizeBytes: number;
  durationMs: number;
  /** Set when the request never produced a response at all (DNS, refused, timeout). */
  transportError?: string;
}

/**
 * Reads a value out of a parsed JSON body using a deliberately small path grammar:
 * dotted names and numeric indexes, e.g. `data.accounts[0].balance`.
 *
 * Small on purpose. A full JSONPath implementation would let a generated test express
 * filters and wildcards whose behaviour nobody reviewing the test could predict, and the
 * failure message could no longer say plainly which value was wrong.
 */
export function readJsonPath(body: unknown, path: string): { found: boolean; value: unknown } {
  if (path === '' || path === '$') return { found: true, value: body };

  const segments = path
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(segment => segment.length > 0);

  let cursor: unknown = body;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return { found: false, value: undefined };
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return { found: false, value: undefined };
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== 'object') return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return { found: false, value: undefined };
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { found: true, value: cursor };
}

/** Renders a JSON value for a failure message without printing a whole document. */
export function describeJsonValue(value: unknown, maxLength = 120): string {
  if (value === undefined) return '(absent)';
  if (value === null) return 'null';
  const rendered = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return rendered.length > maxLength ? `${rendered.slice(0, maxLength)}…` : rendered;
}

/**
 * Parses the `responseStatusIn` expectation: a comma-separated list of codes, ranges
 * (`200-204`) and families (`2xx`).
 */
export function statusMatches(expected: string, status: number): boolean {
  return expected.split(',').map(part => part.trim()).filter(Boolean).some(part => {
    const family = /^([1-5])xx$/i.exec(part);
    if (family) return Math.floor(status / 100) === Number(family[1]);

    const range = /^(\d{3})\s*-\s*(\d{3})$/.exec(part);
    if (range) return status >= Number(range[1]) && status <= Number(range[2]);

    return Number(part) === status;
  });
}
