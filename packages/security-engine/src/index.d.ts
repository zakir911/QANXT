/**
 * Types for the security engine.
 *
 * Hand-written rather than generated, because the engine is plain ESM that the golden suites
 * run directly with `node` and a build step between the suites and the code they verify would
 * be one more thing that can differ from what ships.
 *
 * These describe the surface the worker uses. They are deliberately not exhaustive: a check's
 * finding carries more than this, and the fields below are the ones a caller reads.
 */

export type SecurityRisk = 0 | 1 | 2 | 3;
export type SecurityProfileName = 'passive' | 'standard' | 'deep' | 'regression' | 'custom';
export type SeverityName = 'Informational' | 'Low' | 'Medium' | 'High' | 'Critical';
export type ConfidenceName = 'Low' | 'Medium' | 'High';

export const SECURITY_RISK: {
  PASSIVE: 0; ACTIVE: 1; STATE_CHANGING: 2; DESTRUCTIVE: 3;
};

export const SECURITY_PROFILE: Record<
  'PASSIVE' | 'STANDARD' | 'DEEP' | 'REGRESSION' | 'CUSTOM', SecurityProfileName>;

export const DENIAL: Record<string, string>;

/** What an application has authorized. Every default refuses. */
export interface SecurityScope {
  enabled: boolean;
  authorizationNote: string | null;
  allowedDomains: string[];
  allowedApiDomains: string[];
  allowedPaths: string[];
  blockedPaths: string[];
  environmentId: string | null;
  maxRequestsPerSecond: number;
  maxConcurrentRequests: number;
  maxScanDurationMinutes: number;
  allowActiveTesting: boolean;
  allowDestructiveTesting: boolean;
  allowProduction: boolean;
}

export interface ScopeDecision {
  allowed: boolean;
  reason: string;
  explanation: string;
  checksPassed: string[];
}

export function evaluateScope(
  scope: SecurityScope | null,
  request: {
    url: string; method?: string; risk?: SecurityRisk;
    profile?: SecurityProfileName; environmentId?: string | null; isApiRequest?: boolean;
  },
  context?: Record<string, unknown>
): ScopeDecision;

export function labScope(overrides?: Partial<SecurityScope>): SecurityScope;
export function pathMatches(path: string, pattern: string): boolean;
export function matchesAllowlist(host: string, allowed: string[]): boolean;

/** One request/response the scan issued, or the refusal that stopped it. */
/**
 * One request/response the scan performed, as it is stored on the scanner.
 *
 * Deliberately without `allowed` and `decision`: those belong to the *outcome* of asking for
 * the request, not to the record of having made it. The scanner stores this shape, evidence is
 * written from this shape, and a refusal never becomes one of these at all.
 */
export interface SecurityExchange {
  method?: string;
  url?: string;
  as?: string;
  note?: string;
  testId?: string;
  status?: number;
  transportError?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  responseText?: string;
  durationMs?: number;
  headers?: Headers;
}

/**
 * What asking for a request answers with: the decision, and the exchange if it happened.
 *
 * A refusal carries no exchange, which is why the two are different types. A caller that
 * reads `status` off a refusal is reading a field that was never there, and the compiler
 * should say so.
 */
export type RequestOutcome =
  | ({ allowed: true; decision: ScopeDecision } & SecurityExchange)
  | { allowed: false; decision: ScopeDecision };

export const MAX_SCORE: number;

/** The severity bands, weakest first, and the confidence levels alongside them. */
export const SEVERITY_BANDS: readonly SeverityName[];
export const CONFIDENCE_LEVELS: readonly ConfidenceName[];

export class SeverityFactors {
  constructor(
    exploitability: string, impact: string, privilegeRequired: string,
    affectedData: string, exposure: string, requiresUnusualConditions?: boolean);
  readonly score: number;
  readonly severity: SeverityName;
  explain(): string;
  toJSON(): Record<string, unknown>;
}

export function confidenceFrom(signals: {
  reproduced?: boolean; corroborated?: boolean; unambiguous?: boolean;
}): ConfidenceName;

/** What a check reports. A finding always carries the exchanges that establish it. */
export interface SecurityFinding {
  category: string;
  title: string;
  /**
   * The canonical name of the check that produced it — `passive.headers`, not the engine's
   * own internal test id. No check in this engine sets it: the caller that dispatched the
   * check is the only thing that knows which of the platform's names it was running under,
   * and it stamps it on the way out.
   */
  testId?: string;
  endpoint?: string;
  httpMethod?: string;
  parameter?: string;
  observedAsRole?: string;
  description: string;
  impact: string;
  remediation: string;
  cwe?: string;
  cweConfidence?: string;
  owaspApiCategory?: string;
  owaspWebCategory?: string;
  severityFactors: SeverityFactors;
  confidence: ConfidenceName;
  exchanges: SecurityExchange[];
  /**
   * How to see it again, where the check can say it better than a list of exchanges can.
   *
   * Most findings are reproduced by replaying their requests, and the default derived from
   * the exchanges says that well. A few are not: a DOM sink reproduces by opening a URL in a
   * browser, and its exchange list shows a GET returning 200, which is true and tells the
   * reader nothing.
   */
  reproductionSteps?: string;
  coverageNote?: string;
  payloadUsed?: string;
  payloadNote?: string;
  redactLiterals?: string[];
}

/**
 * What a check returns.
 *
 * Five outcomes, and the distinctions matter: a refused probe, an inconclusive comparison, a
 * clean result and an untestable area are four different answers, and only one of them means
 * the application is fine in that respect.
 */
export interface CheckResult {
  findings: SecurityFinding[];
  skipped?: boolean;
  decision?: ScopeDecision;
  inconclusive?: boolean;
  notTestable?: boolean;
  reason?: string;
  ok?: boolean;
  detail?: string;
  /** A single summary of what was seen, where one object says it. */
  observed?: Record<string, unknown>;
  /**
   * What the check looked at, one entry per thing, including the ones that were fine.
   * A coverage report needs to say what was checked rather than only what failed.
   */
  observations?: Record<string, unknown>[];
}

export interface ScannerSummary {
  profile: SecurityProfileName;
  requestsIssued: number;
  requestsBlocked: number;
  elapsedMinutes: number;
  blocked: Array<{
    url: string; method: string; risk: SecurityRisk;
    testId?: string; reason: string; explanation: string; occurredAt: string;
  }>;
}

/**
 * The only way to issue a security request.
 *
 * The scope guard runs inside `request`. A check cannot bypass it, and that is deliberate:
 * a control a caller can decline to call is documentation.
 */
export class SecurityScanner {
  constructor(options: {
    scope: SecurityScope;
    profile?: SecurityProfileName;
    context?: Record<string, unknown>;
    clock?: () => number;
  });
  readonly exchanges: SecurityExchange[];
  readonly requestsIssued: number;
  readonly requestsBlocked: number;
  request(options: {
    url: string; method?: string; risk?: SecurityRisk;
    headers?: Record<string, string>; body?: unknown;
    testId?: string; as?: string; note?: string;
  }): Promise<RequestOutcome>;
  /**
   * Asks the guard about one piece of work without performing it, and paces the scan.
   * For anything the engine cannot do itself — a page driven in a real browser, above all —
   * so that work goes through the same control rather than a second copy of it.
   */
  authorize(options: {
    url: string; method?: string; risk?: SecurityRisk; testId?: string;
  }): Promise<{ allowed: boolean; decision: ScopeDecision }>;
  /** Records work the caller performed under a decision `authorize` already granted. */
  record(exchange: SecurityExchange): SecurityExchange;
  signIn(baseUrl: string, username: string, password?: string):
    Promise<{ cookie: string | null; body: unknown; csrf: string | null } | null>;
  summary(): ScannerSummary;
}

export const REDACTED: string;
export function redactText(value: string, literals?: string[]): string;
export function redactHeaders(headers: Record<string, string>, literals?: string[]): Record<string, string>;
export function redactBody(body: unknown, literals?: string[]): unknown;
export function writeFindingEvidence(options: {
  root: string; findingId: string; finding: SecurityFinding;
  exchanges: SecurityExchange[]; literals?: string[]; extras?: Record<string, unknown>;
}): { dir: string; digest: string; files: string[] };

export const OUTCOME: { PASS: 0; REVIEW: 1; FAIL: 2 };
export const OUTCOME_NAME: readonly ['PASS', 'REVIEW', 'FAIL'];
export const SEVERITY_ORDER: Record<SeverityName, number>;
export const CONFIDENCE_ORDER: Record<ConfidenceName, number>;
export const DEFAULT_POLICY: {
  failOnNewAtOrAbove: SeverityName;
  failOnExistingAtOrAbove: SeverityName;
  failOnRegression: boolean;
  reviewLowConfidenceInsteadOfFailing: boolean;
  minimumCheckCoverage: number;
};

export interface GateCoverage {
  scanRan: boolean;
  profile: SecurityProfileName | string;
  requestsIssued: number;
  requestsBlocked: number;
  checksConfigured: string[];
  checksExecuted: string[];
  untestedAreas?: string[];
}

export interface GateResult {
  outcome: 0 | 1 | 2;
  outcomeName: 'PASS' | 'REVIEW' | 'FAIL';
  blocked: boolean;
  rules: Array<{ name: string; passed: boolean; measured: boolean; explanation: string }>;
  reasons: string[];
  summary: string;
  counts?: Record<string, number>;
}

export function evaluateSecurityGate(
  coverage: GateCoverage,
  findings?: Array<Record<string, unknown>>,
  policy?: Partial<typeof DEFAULT_POLICY>
): GateResult;

export const TRIAGE_STATUSES: Set<string>;
export function fingerprint(finding: Record<string, unknown>): string;
export function compareToBaseline(
  current: Array<Record<string, unknown>>,
  baseline?: Array<Record<string, unknown>>,
  executed?: string[] | null
): {
  findings: Array<Record<string, unknown>>;
  disappeared: Array<Record<string, unknown>>;
  summary: Record<string, number>;
};
export function triage(
  finding: Record<string, unknown>,
  decision: { status: string; justification?: string; decidedBy?: string; at?: string }
): Record<string, unknown>;
export function suppressionApplies(
  suppression: { fingerprint: string }, finding: Record<string, unknown>): boolean;

// ---- Check families -------------------------------------------------------
//
// Each is a namespace of functions taking (scanner, options) and returning a CheckResult.
// Typed loosely on purpose: the options differ per check, and inventing a union here would
// be a second description of them that could disagree with the first.

type Check = (scanner: SecurityScanner, options: Record<string, unknown>) => Promise<CheckResult>;

export namespace authz {
  const checkBola: Check;
  const checkVerticalEscalation: Check;
  const checkReadOnlyWrite: Check;
  const checkMissingAuthorization: Check;
  const checkTokenVerification: Check;
}
export namespace auth {
  const checkUserEnumeration: Check;
  const checkAccountLockout: Check;
  const checkSessionInvalidation: Check;
  const checkSessionLifetime: Check;
  const checkResetTokenReuse: Check;
}
export namespace api {
  const checkMassAssignment: Check;
  const checkInputValidation: Check;
  const checkUnsafeMethods: Check;
  const checkRateLimit: Check;
  const checkExcessiveData: Check;
}
export namespace xss {
  const checkReflectedXss: Check;
  const checkStoredXss: Check;
  const checkDomXss: Check;
}
export namespace injection {
  const checkSqlInjection: Check;
  const checkNoSqlInjection: Check;
  const checkCommandInjection: Check;
  const checkTemplateInjection: Check;
}
export namespace request {
  const checkCsrfToken: Check;
  const checkOriginValidation: Check;
  const checkUploadRestrictions: Check;
  const checkOpenRedirect: Check;
  const checkSsrf: Check;
}
export namespace passive {
  const checkSecurityHeaders: (scanner: SecurityScanner, url: string, testId?: string) => Promise<CheckResult>;
  const checkCookies: (scanner: SecurityScanner, url: string, testId?: string) => Promise<CheckResult>;
  const checkCors: (scanner: SecurityScanner, url: string, testId?: string) => Promise<CheckResult>;
  const checkSensitiveData: (
    scanner: SecurityScanner, url: string, testId?: string,
    options?: { headers?: Record<string, string> }) => Promise<CheckResult>;
  const checkMisconfiguration: (scanner: SecurityScanner, baseUrl: string, testId?: string) => Promise<CheckResult>;
}
