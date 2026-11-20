import { isIP } from 'node:net';

/**
 * The worker's copy of the SSRF guard. The control plane checks URLs when a job is
 * created, but the crawler discovers new links at runtime and follows redirects, so the
 * decision has to be enforced here too, immediately before each navigation.
 *
 * Mirrors `QaNxt.Application.Security.TargetUrlGuard`; `test/url-guard.test.ts` asserts
 * the same cases as the C# suite.
 */

export interface UrlGuardOptions {
  allowedHosts: string[];
  excludedPathPrefixes: string[];
  allowPrivateNetworks: boolean;
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', 'instance-data']);

export interface GuardResult {
  allowed: boolean;
  reason: string;
}

export function isUrlAllowed(rawUrl: string, options: UrlGuardOptions): GuardResult {
  if (!rawUrl || rawUrl.trim() === '') return deny('the URL is empty');

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return deny('the URL is not absolute');
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return deny(`scheme '${url.protocol.replace(':', '')}' is not permitted (http and https only)`);
  }
  if (url.username || url.password) return deny('credentials embedded in a URL are not permitted');

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return deny('the host is a cloud metadata endpoint');

  if (options.allowedHosts.length > 0 && !matchesAllowlist(host, options.allowedHosts)) {
    return deny(`host '${host}' is not in the application's allowed domains`);
  }

  for (const excluded of options.excludedPathPrefixes) {
    const prefix = excluded?.trim();
    if (!prefix) continue;
    if (url.pathname.toLowerCase().startsWith(prefix.toLowerCase())) {
      return deny(`path '${url.pathname}' is excluded by configuration`);
    }
  }

  if (!options.allowPrivateNetworks) {
    const privateReason = privateOrReservedReason(host);
    if (privateReason) return deny(privateReason);
  }

  return { allowed: true, reason: '' };
}

/** Allowlist entries are an exact host or a leading-dot suffix that matches subdomains. */
export function matchesAllowlist(host: string, allowed: string[]): boolean {
  for (const raw of allowed) {
    const entry = raw?.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('.')) {
      if (host.endsWith(entry)) return true;
      if (host === entry.slice(1)) return true;
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

export function privateOrReservedReason(host: string): string | null {
  if (host === 'localhost') return 'localhost targets are disabled by configuration';

  const candidate = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const family = isIP(candidate);
  if (family === 0) return null;         // a DNS name; resolution is checked at connect time

  if (family === 4) {
    const parts = candidate.split('.').map(Number) as [number, number, number, number];
    const [a, b] = parts;
    if (a === 127) return 'loopback addresses are disabled by configuration';
    if (a === 10) return '10.0.0.0/8 is a private network';
    if (a === 172 && b >= 16 && b <= 31) return '172.16.0.0/12 is a private network';
    if (a === 192 && b === 168) return '192.168.0.0/16 is a private network';
    if (a === 169 && b === 254) return '169.254.0.0/16 is link-local (cloud metadata)';
    if (a === 100 && b >= 64 && b <= 127) return '100.64.0.0/10 is carrier-grade NAT space';
    if (a === 0) return '0.0.0.0/8 is reserved';
    if (a >= 224) return 'multicast and reserved space is not a valid target';
    return null;
  }

  const lower = candidate.toLowerCase();
  if (lower === '::1') return 'loopback addresses are disabled by configuration';
  if (lower.startsWith('fe80')) return 'IPv6 link-local addresses are not valid targets';
  if (/^f[cd]/.test(lower)) return 'IPv6 unique-local addresses are not valid targets';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return privateOrReservedReason(mapped[1]);
  return null;
}

/**
 * Collapses URLs that represent the same page so the crawler does not loop forever on
 * /accounts/1, /accounts/2, … Identical to the server's normalization, because both
 * sides use it as the identity of a page node.
 */
export function normalizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  const segments = url.pathname.split('/').filter(Boolean).map(normalizeSegment);
  let path = '/' + segments.join('/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  let query = '';
  if (url.search) {
    const keys = [...new Set(
      url.search.replace(/^\?/, '').split('&').filter(Boolean).map(pair => pair.split('=')[0] ?? '')
    )].filter(Boolean).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (keys.length > 0) query = '?' + keys.map(key => `${key}={v}`).join('&');
  }

  const port = url.port && url.port !== defaultPort(url.protocol) ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}${query}`;
}

/**
 * The key that says whether this exact page has already been visited.
 *
 * `normalizeUrl` answers a different question — what route shape is this — and collapses
 * `/view.asp?id=1`, `?id=2` and `?id=3` to one string, which is right for a shape and
 * wrong for a visit. The crawler used it for both, so the second and third records of
 * every route were skipped as already seen.
 *
 * The cost was not the page count. A page-level data check runs on the pages discovery
 * recorded, so "every total equals the sum of its lines" ran against permit 1 — whose
 * fees add up — and passed, while the mismatch planted in permit 2 was never opened. One
 * record per route is one record per route however many the application holds, and that is
 * how a data-integrity suite reports green on an application full of broken arithmetic.
 *
 * Identifiers are kept here, both in the path and in the query. Only what is incidental is
 * normalised: host case, a default port, a trailing slash, and the order of query
 * parameters, so `?b=2&a=1` and `?a=1&b=2` are one page rather than two.
 *
 * How many instances of a route get crawled stays bounded by the route-shape cap, which is
 * what that cap is for.
 */
export function visitKey(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  // `javascript:void(0)` and `mailto:` parse, with no host. They are not pages, and
  // rebuilding them as `javascript://void(0)` would make a href that goes nowhere look
  // like a URL that could be compared with one.
  if (url.hostname === '') return rawUrl;

  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const pairs = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
  const query = pairs.length === 0 ? ''
    : '?' + pairs.map(([key, value]) => `${key}=${value}`).join('&');

  const port = url.port && url.port !== defaultPort(url.protocol) ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}${query}`;
}

function normalizeSegment(segment: string): string {
  if (segment.length === 0) return segment;
  if (/^\d+$/.test(segment)) return '{id}';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return '{guid}';
  if (segment.length >= 24 && /^[A-Za-z0-9_-]+$/.test(segment)
    && /\d/.test(segment) && /[A-Za-z]/.test(segment)) return '{token}';
  return segment.toLowerCase();
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

function deny(reason: string): GuardResult {
  return { allowed: false, reason };
}
