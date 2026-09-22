import type { BrowserAction } from './actions.js';
import type {
  AuthenticationStrategy, BrowserName, ExecutionStatus, HealingPolicy, TestCaseKind
} from './enums.js';
import type { ElementFingerprint, LocatorDescriptor } from './locator.js';

/** Queue names, mirrored from the control plane so producers and consumers agree. */
export const QUEUE_NAMES = {
  discovery: 'aira:discovery',
  execution: 'aira:execution',
  agent: 'aira:agent'
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
}

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
