import type { AccessibilityResult } from './accessibility.js';
import type { VisualComparison } from './visual.js';
import type { BrowserAction } from './actions.js';
import type {
  AuthenticationStrategy, BrowserName, ExecutionStatus, HealingPolicy, TestCaseKind
} from './enums.js';
import type { ElementFingerprint, LocatorDescriptor } from './locator.js';

/** Queue names, mirrored from the control plane so producers and consumers agree. */
export const QUEUE_NAMES = {
  discovery: 'qanxt:discovery',
  execution: 'qanxt:execution',
  agent: 'qanxt:agent',
  security: 'qanxt:security'
} as const;

/** How the worker authenticates into the application under test. */
export interface AuthConfig {
  strategy: AuthenticationStrategy;
  loginUrl?: string;
  /** Declarative description of the login form; never contains the credentials. */
  usernameLocator?: LocatorDescriptor;
  passwordLocator?: LocatorDescriptor;
  submitLocator?: LocatorDescriptor;
  /** A locator whose appearance means the login worked. */
  successLocator?: LocatorDescriptor;
  successUrlContains?: string;
  /** Resolved at dispatch time from encrypted storage; never persisted by the worker. */
  username?: string;
  password?: string;
  bearerToken?: string;
  storageStateJson?: string;
}

/** The crawl boundary. The worker refuses to leave it, whatever the page contains. */
export interface CrawlBudget {
  allowedHosts: string[];
  excludedPathPrefixes: string[];
  maxDepth: number;
  maxPages: number;
  maxActions: number;
  /**
   * How many pages sharing one route shape (e.g. /accounts/*) may be visited. This is
   * what stops a crawl from walking a thousand list items: URL normalization cannot tell
   * an opaque identifier from a route name, but repetition of a shape is unambiguous.
   */
  maxInstancesPerRouteShape: number;
  timeoutSeconds: number;
  allowPrivateNetworks: boolean;
  respectRobotsTxt: boolean;
  /**
   * Routes or absolute URLs to explore besides the base URL, already resolved and
   * de-duplicated by the control plane.
   *
   * The answer to an application the crawler cannot reach by following links: the owner
   * names the routes. Each one is still checked against the allowlist, the exclusions and
   * robots.txt before it is opened.
   */
  seedUrls: string[];
  /** Whether to read /sitemap.xml for routes nothing links to. */
  useSitemap: boolean;
  /**
   * How the crawler finds pages that no anchor links to.
   *
   * `links` follows `a[href]` only. That is all discovery ever did, and on a modern admin
   * application whose navigation is buttons calling a client-side router it finds the
   * landing page and nothing else: there is no href to follow.
   *
   * `navigation` additionally clicks controls that are navigation-shaped — inside a `nav`,
   * or carrying role `link`, `menuitem` or `tab` — and enqueues wherever the URL moves to.
   *
   * `interactive` clicks every enabled control that is not shaped like a state change.
   * It finds the most and takes the longest.
   *
   * None of these modes clicks something that looks like it changes data. That is governed
   * separately by {@link allowStateChangingClicks}, because "explore more" and "press the
   * delete button on somebody's production system" are different decisions.
   */
  interactionMode: CrawlInteractionMode;
  /**
   * Whether the crawler may click controls that look like they change state: a form's
   * submit button, anything inside a form, anything whose label reads like delete, remove,
   * pay, send, confirm or save.
   *
   * Off unless somebody turns it on for an application, and it is meant for a throwaway
   * environment. The crawler cannot know what a button does before pressing it, so this is
   * the one decision it must not make on anybody's behalf.
   */
  allowStateChangingClicks: boolean;
}

export type CrawlInteractionMode = 'links' | 'navigation' | 'interactive';

export interface DiscoveryJob {
  jobId: string;
  discoveryRunId: string;
  organizationId: string;
  projectId: string;
  applicationId: string;
  baseUrl: string;
  browser: BrowserName;
  headless: boolean;
  auth: AuthConfig;
  budget: CrawlBudget;
  /** Job-scoped token the worker uses to post results back. */
  callbackToken: string;
  callbackBaseUrl: string;
  correlationId: string;
}

/**
 * The scope, carried into the job rather than looked up by the worker.
 *
 * A worker that fetched the scope itself could be pointed at a different one by whoever
 * enqueued the job; a worker that receives it can only do what the control plane already
 * decided somebody had authorized. The job is the authorization, and it is signed for by the
 * account that started the scan.
 */
export interface SecurityScopePayload {
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

/** One thing to point checks at, from the discovered attack surface. */
export interface SecurityTarget {
  kind: 'page' | 'endpoint';
  identifier: string;
  httpMethod?: string;
  requiresAuthentication: boolean;
  parameters: string[];
  checks: string[];
}

/** A synthetic identity the scan may sign in as. Never a real account. */
export interface SecurityIdentity {
  label: string;
  username: string;
  password: string;
  role?: string;
  resourceId?: string;
}

export interface SecurityScanJob {
  jobId: string;
  securityScanId: string;
  organizationId: string;
  projectId: string;
  applicationId: string;
  environmentId?: string | null;
  baseUrl: string;
  /** passive | standard | deep | regression. Bounds what the scan will attempt. */
  profile: string;
  scope: SecurityScopePayload;
  /** What to point checks at, and which checks each target implies. */
  targets: SecurityTarget[];
  /** The checks this run should execute. Narrower than the targets imply when a change
   *  selected a subset; the full implied set travels as checksConfigured so the gate can
   *  still read coverage honestly. */
  checksToRun: string[];
  checksConfigured: string[];
  identities: SecurityIdentity[];
  /** Whether this caller may issue destructive requests. Both this and the scope must allow. */
  callerMayRunDestructiveScans: boolean;
  isProductionEnvironment: boolean;
  productionTestingAuthorized: boolean;
  callbackToken: string;
  callbackBaseUrl: string;
  correlationId: string;
}

export interface ExecutionStepPlan {
  testStepId: string;
  order: number;
  action: BrowserAction;
  /** What the target looked like when the step was authored; used only when healing. */
  fingerprint?: ElementFingerprint;
  /** Assertions evaluated after the action succeeds. */
  assertions: PlannedAssertion[];
  continueOnFailure: boolean;
}

export interface PlannedAssertion {
  assertionId: string;
  type: string;
  target?: LocatorDescriptor;
  expected?: string;
  attribute?: string;
  negate: boolean;
  isSoft: boolean;
  description: string;
}

export interface ExecutionJob {
  jobId: string;
  executionId: string;
  organizationId: string;
  projectId: string;
  testRunId: string;
  testCaseId: string;
  testCaseName: string;
  testCaseVersion: number;
  /** 'api' cases need no page; a browser is still opened when the plan mixes the two. */
  testCaseKind?: TestCaseKind;
  attempt: number;
  browser: BrowserName;
  headless: boolean;
  baseUrl: string;
  /** Where relative API paths resolve. Falls back to baseUrl when the API shares the origin. */
  apiBaseUrl?: string;
  auth: AuthConfig;
  steps: ExecutionStepPlan[];
  /** Values for `${data:...}` references, already resolved and, where sensitive, masked in logs. */
  data: Record<string, string>;
  /** Values for `${secret:...}` references. Registered with the masker on arrival. */
  secrets: Record<string, string>;
  capture: CaptureSettings;
  healing: HealingSettings;
  allowScriptExecution: boolean;
  /** False in an environment that refuses writes: POST/PUT/PATCH/DELETE are then refused. */
  allowMutatingApiRequests?: boolean;
  allowedHosts: string[];
  allowPrivateNetworks: boolean;
  defaultTimeoutMs: number;
  callbackToken: string;
  callbackBaseUrl: string;
  correlationId: string;
}

export interface CaptureSettings {
  video: boolean;
  trace: boolean;
  har: boolean;
  screenshotOnEveryAction: boolean;
  domSnapshotOnFailure: boolean;
}

export interface HealingSettings {
  policy: HealingPolicy;
  /** 0-100. Candidates below this are never used, whatever the policy. */
  confidenceThreshold: number;
}

/** Streamed back to the control plane as each action completes. */
export interface ActionResultReport {
  order: number;
  testStepId?: string;
  action: string;
  description: string;
  status: ExecutionStatus;
  startedAt: string;
  durationMs: number;
  url?: string;
  locatorUsed?: LocatorDescriptor;
  locatorAlternatives?: RankedLocator[];
  maskedValue?: string;
  wasHealed: boolean;
  healingConfidence?: number;
  errorMessage?: string;
  screenshotKeys?: { before?: string; after?: string };
  /**
   * What an accessibility check found, when this step was one.
   *
   * Travels with the action rather than as a separate message so that a finding and the
   * step it came from cannot disagree about whether the step passed. Reported whether or
   * not the step failed on it: a failure that says "7 violations" and keeps the list is
   * half a report.
   */
  accessibility?: AccessibilityResult;
  /** What a visual check compared, when this step was one. */
  visual?: VisualComparison;
}

export interface RankedLocator {
  descriptor: LocatorDescriptor;
  score: number;
  rank: number;
  breakdown: Record<string, number>;
  stability: number;
}

export interface ExecutionCompletionReport {
  executionId: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  browserVersion: string;
  workerId: string;
  stepsTotal: number;
  stepsPassed: number;
  stepsFailed: number;
  stepsHealed: number;
  consoleErrorCount: number;
  networkErrorCount: number;
  errorMessage?: string;
  errorStack?: string;
  artifacts: ArtifactReport[];
  consoleEvents: ConsoleEventReport[];
  networkEvents: NetworkEventReport[];
  healingEvents: HealingEventReport[];
}

export interface ArtifactReport {
  kind: string;
  name: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  isMasked: boolean;
  actionOrder?: number;
  metadata?: Record<string, unknown>;
}

export interface ConsoleEventReport {
  level: string;
  message: string;
  stackTrace?: string;
  url?: string;
  occurredAt: string;
  actionOrder?: number;
}

export interface NetworkEventReport {
  method: string;
  url: string;
  resourceType?: string;
  statusCode?: number;
  durationMs: number;
  requestSizeBytes: number;
  responseSizeBytes: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBodyExcerpt?: string;
  responseBodyExcerpt?: string;
  isFailed: boolean;
  failureText?: string;
  occurredAt: string;
  actionOrder?: number;
}

export interface HealingEventReport {
  testStepId: string;
  originalLocator: LocatorDescriptor;
  healedLocator: LocatorDescriptor;
  reason: string;
  confidence: number;
  breakdown: Record<string, number>;
  outcomeVerified: boolean;
  applied: boolean;
  occurredAt: string;
}
