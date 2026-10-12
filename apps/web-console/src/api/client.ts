/**
 * The console's only way of talking to the control plane.
 *
 * Access tokens are short-lived and rotate; a request that fails on an expired token
 * refreshes once and retries, so a user working through a long session is never bounced
 * to the sign-in page for a reason the console could have handled itself.
 */

const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '')
  ?? 'http://localhost:5080';

export interface ApiErrorBody {
  code: string;
  title: string;
  status: number;
  correlationId?: string;
  errors?: Record<string, string[]>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly correlationId?: string,
    readonly fieldErrors?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The message a user should see: field errors first, since they are actionable. */
  get displayMessage(): string {
    if (this.fieldErrors) {
      const first = Object.values(this.fieldErrors)[0]?.[0];
      if (first) return first;
    }
    return this.message;
  }
}

const STORAGE_KEY = 'qanxt.session';

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  user: {
    userId: string;
    organizationId: string;
    email: string;
    displayName: string;
    roles: string[];
    permissions: string[];
  };
}

export function readSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function writeSession(session: StoredSession | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). The session then lives
    // only in memory for this tab, which still works.
  }
}

let refreshInFlight: Promise<StoredSession | null> | null = null;

async function refreshSession(): Promise<StoredSession | null> {
  const current = readSession();
  if (!current?.refreshToken) return null;

  // One refresh at a time: several 401s arriving together must not each rotate the token,
  // which would invalidate the others and log the user out.
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken })
      });
      if (!response.ok) {
        writeSession(null);
        return null;
      }
      const session = (await response.json()) as StoredSession;
      writeSession(session);
      return session;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Set false for endpoints that must not trigger a refresh loop (the auth endpoints). */
  authenticated?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, authenticated = true } = options;

  const send = async (token?: string): Promise<Response> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;

    return fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });
  };

  let session = authenticated ? readSession() : null;
  let response = await send(session?.accessToken);

  if (response.status === 401 && authenticated && session?.refreshToken) {
    session = await refreshSession();
    if (session) response = await send(session.accessToken);
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Sends a file as multipart form data — evidence for a verification task, a sheet of manual
 * tests. The same refresh-once rule as apiRequest, so an expired token is not a lost upload.
 */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const send = (token?: string) => fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: form
  });

  let session = readSession();
  let response = await send(session?.accessToken);
  if (response.status === 401 && session?.refreshToken) {
    session = await refreshSession();
    if (session) response = await send(session.accessToken);
  }
  if (!response.ok) throw await toApiError(response);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Downloads a file the API only serves to a signed-in caller — a run's bug report. The
 * bytes are fetched with the Authorization header and handed to the browser as a blob, so
 * the token never appears in a URL. The file name is the one the API sends.
 */
export async function apiDownload(path: string, fallbackName: string): Promise<string> {
  const send = (token?: string) => fetch(`${API_URL}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });

  let session = readSession();
  let response = await send(session?.accessToken);
  if (response.status === 401 && session?.refreshToken) {
    session = await refreshSession();
    if (session) response = await send(session.accessToken);
  }
  if (!response.ok) throw await toApiError(response);

  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : plain ?? fallbackName;

  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: the click has already handed the blob to the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return name;
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // Not every failure returns JSON — a gateway timeout, for instance.
  }

  return new ApiError(
    body?.title ?? `The request failed with status ${response.status}.`,
    response.status,
    body?.code ?? 'request_failed',
    body?.correlationId,
    body?.errors
  );
}

export function apiBaseUrl(): string {
  return API_URL;
}
