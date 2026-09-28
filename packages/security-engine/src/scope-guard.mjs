/**
 * The scope guard, in JavaScript.
 *
 * A deliberate second implementation of `SecurityScopeGuard`, and worth being uneasy about:
 * two implementations of a control can drift, and a drifted control is worse than one
 * control because everybody believes the wrong half.
 *
 * It exists because the golden suites drive the engine from Node, and routing every probe
 * through the platform API to reach the C# guard would mean the suites could not test the
 * guard's own refusals without the platform being the thing under test. The mitigation is
 * that both sides are tested against the same ordered ladder, and the golden suite asserts
 * the order explicitly — so a change to one that is not made to the other fails a test
 * rather than silently widening what the engine will do.
 */
export const SECURITY_RISK = { PASSIVE: 0, ACTIVE: 1, STATE_CHANGING: 2, DESTRUCTIVE: 3 };
export const SECURITY_PROFILE = {
  PASSIVE: 'passive', STANDARD: 'standard', DEEP: 'deep',
  REGRESSION: 'regression', CUSTOM: 'custom'
};

export const DENIAL = {
  NONE: 'none',
  SCOPE_MISSING: 'scopeMissing',
  SCOPE_DISABLED: 'scopeDisabled',
  DOMAIN_NOT_ALLOWED: 'domainNotAllowed',
  PATH_NOT_ALLOWED: 'pathNotAllowed',
  PATH_BLOCKED: 'pathBlocked',
  METHOD_NOT_ALLOWED: 'methodNotAllowed',
  ACTIVE_NOT_ALLOWED: 'activeTestingNotAllowed',
  DESTRUCTIVE_NOT_ALLOWED: 'destructiveTestingNotAllowed',
  PRODUCTION_NOT_AUTHORIZED: 'productionNotAuthorized',
  RATE_LIMIT: 'rateLimitExceeded',
  CONCURRENCY_LIMIT: 'concurrencyLimitExceeded',
  DURATION_EXCEEDED: 'scanDurationExceeded',
  PERMISSION_DENIED: 'permissionDenied',
  PROFILE_DOES_NOT_PERMIT: 'profileDoesNotPermit'
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DESTRUCTIVE = new Set(['DELETE']);

/** Never a legitimate target, whatever a scope says. Mirrors the platform's TargetUrlGuard. */
const ALWAYS_FORBIDDEN = [
  /^169\.254\./, /^metadata\.google\.internal$/i, /^metadata\.goog$/i, /^instance-data$/i
];

export function pathMatches(path, pattern) {
  pattern = String(pattern ?? '').trim();
  if (!pattern) return false;
  if (pattern === '*' || pattern === '/*') return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    return path.toLowerCase() === prefix.toLowerCase()
      || path.toLowerCase().startsWith(prefix.toLowerCase() + '/');
  }
  if (pattern.endsWith('*')) return path.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());
  return path.toLowerCase() === pattern.toLowerCase()
    || path.toLowerCase().startsWith(pattern.replace(/\/$/, '').toLowerCase() + '/');
}

export function matchesAllowlist(host, allowed) {
  for (const raw of allowed ?? []) {
    const entry = String(raw ?? '').trim();
    if (!entry) continue;
    if (entry.startsWith('.')) {
      if (host.toLowerCase().endsWith(entry.toLowerCase())) return true;
      if (host.toLowerCase() === entry.slice(1).toLowerCase()) return true;
    } else if (host.toLowerCase() === entry.toLowerCase()) return true;
  }
  return false;
}

const profilePermits = (profile, risk) => {
  switch (profile) {
    case SECURITY_PROFILE.PASSIVE: return risk === SECURITY_RISK.PASSIVE;
    case SECURITY_PROFILE.STANDARD: return risk <= SECURITY_RISK.STATE_CHANGING;
    case SECURITY_PROFILE.DEEP: return true;
    case SECURITY_PROFILE.REGRESSION: return risk <= SECURITY_RISK.STATE_CHANGING;
    case SECURITY_PROFILE.CUSTOM: return true;
    default: return false;
  }
};

const deny = (reason, explanation, passed) => ({ allowed: false, reason, explanation, checksPassed: passed });

/** The same ordered ladder as the C# guard. Deny by default at every rung. */
export function evaluateScope(scope, request, context = {}) {
  const passed = [];

  if (!scope) return deny(DENIAL.SCOPE_MISSING,
    'This application has no security scope. Nobody has authorized security testing against it, and the absence of a restriction is not permission.', passed);
  if (!scope.enabled) return deny(DENIAL.SCOPE_DISABLED, 'The security scope exists but is not enabled.', passed);
  if (!scope.authorizationNote) return deny(DENIAL.SCOPE_MISSING,
    'The security scope carries no written authorization.', passed);
  passed.push('authorization');

  let uri;
  try { uri = new URL(request.url); } catch {
    return deny(DENIAL.DOMAIN_NOT_ALLOWED, 'The URL is not absolute.', passed);
  }
  if (!['http:', 'https:'].includes(uri.protocol)) {
    return deny(DENIAL.DOMAIN_NOT_ALLOWED, `Scheme '${uri.protocol}' is not permitted.`, passed);
  }
  if (ALWAYS_FORBIDDEN.some(p => p.test(uri.hostname))) {
    return deny(DENIAL.DOMAIN_NOT_ALLOWED,
      `'${uri.hostname}' is never a legitimate target, whatever the scope allows.`, passed);
  }
  passed.push('target-policy');

  const domains = request.isApiRequest && (scope.allowedApiDomains ?? []).length > 0
    ? scope.allowedApiDomains : scope.allowedDomains;
  if (!domains || domains.length === 0) {
    return deny(DENIAL.DOMAIN_NOT_ALLOWED, 'The scope names no allowed domains. An empty allowlist permits nothing.', passed);
  }
  if (!matchesAllowlist(uri.hostname, domains)) {
    return deny(DENIAL.DOMAIN_NOT_ALLOWED, `Host '${uri.hostname}' is not in the scope's allowed domains.`, passed);
  }
  passed.push('domain');

  for (const blocked of scope.blockedPaths ?? []) {
    if (pathMatches(uri.pathname, blocked)) {
      return deny(DENIAL.PATH_BLOCKED, `Path '${uri.pathname}' is blocked (pattern '${blocked}').`, passed);
    }
  }
  if ((scope.allowedPaths ?? []).length > 0
      && !scope.allowedPaths.some(p => pathMatches(uri.pathname, p))) {
    return deny(DENIAL.PATH_NOT_ALLOWED, `Path '${uri.pathname}' is not in the scope's allowed paths.`, passed);
  }
  passed.push('path');

  const method = String(request.method ?? '').trim();
  if (!method) return deny(DENIAL.METHOD_NOT_ALLOWED, 'The request names no HTTP method.', passed);

  // The declared risk can be raised by the verb, never lowered.
  let risk = request.risk ?? SECURITY_RISK.PASSIVE;
  if (DESTRUCTIVE.has(method.toUpperCase())) risk = Math.max(risk, SECURITY_RISK.DESTRUCTIVE);
  else if (MUTATING.has(method.toUpperCase())) risk = Math.max(risk, SECURITY_RISK.STATE_CHANGING);
  passed.push('method');

  if (!profilePermits(request.profile, risk)) {
    return deny(DENIAL.PROFILE_DOES_NOT_PERMIT, `The ${request.profile} profile does not run this risk level.`, passed);
  }
  if (risk >= SECURITY_RISK.ACTIVE && !scope.allowActiveTesting) {
    return deny(DENIAL.ACTIVE_NOT_ALLOWED, 'The scope does not permit active testing.', passed);
  }
  if (risk >= SECURITY_RISK.DESTRUCTIVE && !scope.allowDestructiveTesting) {
    return deny(DENIAL.DESTRUCTIVE_NOT_ALLOWED, `A ${method} request is destructive and the scope does not permit it.`, passed);
  }
  if (risk >= SECURITY_RISK.ACTIVE && context.callerMayRunActiveScans === false) {
    return deny(DENIAL.PERMISSION_DENIED, 'This account may run passive scans but not active ones.', passed);
  }
  if (risk >= SECURITY_RISK.DESTRUCTIVE && context.callerMayRunDestructiveScans === false) {
    return deny(DENIAL.PERMISSION_DENIED, 'This account may not run destructive security tests.', passed);
  }
  passed.push('risk');

  if (scope.environmentId && request.environmentId && scope.environmentId !== request.environmentId) {
    return deny(DENIAL.PRODUCTION_NOT_AUTHORIZED, 'This scan names a different environment from the one the scope authorizes.', passed);
  }
  if (context.isProductionEnvironment) {
    if (!scope.allowProduction) {
      return deny(DENIAL.PRODUCTION_NOT_AUTHORIZED, 'Production, and the scope does not authorize testing it.', passed);
    }
    if (!context.productionTestingAuthorized) {
      return deny(DENIAL.PRODUCTION_NOT_AUTHORIZED, 'Production, and the environment itself has not been authorized.', passed);
    }
    if (risk >= SECURITY_RISK.STATE_CHANGING) {
      return deny(DENIAL.PRODUCTION_NOT_AUTHORIZED, 'State-changing security tests are never run against production.', passed);
    }
  }
  passed.push('environment');

  if (scope.maxRequestsPerSecond > 0 && (context.requestsInLastSecond ?? 0) >= scope.maxRequestsPerSecond) {
    return deny(DENIAL.RATE_LIMIT, `At the limit of ${scope.maxRequestsPerSecond} request(s) per second.`, passed);
  }
  if (scope.maxConcurrentRequests > 0 && (context.requestsInFlight ?? 0) >= scope.maxConcurrentRequests) {
    return deny(DENIAL.CONCURRENCY_LIMIT, `At the limit of ${scope.maxConcurrentRequests} concurrent request(s).`, passed);
  }
  if (scope.maxScanDurationMinutes > 0 && (context.scanElapsedMinutes ?? 0) >= scope.maxScanDurationMinutes) {
    return deny(DENIAL.DURATION_EXCEEDED, `At the limit of ${scope.maxScanDurationMinutes} minute(s).`, passed);
  }
  passed.push('rate');

  return { allowed: true, reason: DENIAL.NONE, explanation: 'Within scope.', checksPassed: passed };
}

/**
 * A scope for the local security lab. Narrow on purpose: it names the hosts it needs.
 *
 * It takes overrides as its only argument. It briefly took an unused `ports` argument
 * first, which meant `labScope({ allowDestructiveTesting: true })` silently returned the
 * default scope and the caller got a refusal it could not account for. A parameter that
 * quietly swallows the one thing a caller is trying to say is worse than no parameter.
 */
export function labScope(overrides = {}) {
  return {
    enabled: true,
    allowedDomains: ['127.0.0.1', 'localhost'],
    allowedApiDomains: [],
    allowedPaths: [],
    blockedPaths: [],
    environmentId: null,
    maxRequestsPerSecond: 20,
    maxConcurrentRequests: 4,
    maxScanDurationMinutes: 10,
    allowActiveTesting: true,
    allowDestructiveTesting: false,
    allowProduction: false,
    authorizationNote: 'QA NXT security lab: local, synthetic, authorized for automated verification.',
    ...overrides
  };
}
