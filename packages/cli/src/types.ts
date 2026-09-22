/**
 * The shapes the CLI reads from the control plane, and the report model it renders from.
 *
 * The report model is deliberately separate from the API responses: a report has to survive
 * an API field being renamed, and keeping the renderers pure functions of a plain model is
 * what makes them testable without a running platform.
 */

export interface RunSummary {
  id: string;
  projectId: string;
  name: string;
  status: string;
  trigger: string;
  browser: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs: number;
  totalCount: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  blockedCount: number;
  healedCount: number;
  flakyCount: number;
  qualityGatePassed?: boolean | null;
  ciBuildId?: string | null;
  ciBranch?: string | null;
  ciProvider?: string | null;
  ciCommitSha?: string | null;
  applicationBuildRef?: string | null;
  environmentId?: string | null;
  environmentKey?: string | null;
  environmentName?: string | null;
  contractCheckedAt?: string | null;
  contractBreakingChangeCount?: number;
  contractPotentiallyBreakingChangeCount?: number;
}

export interface ExecutionSummary {
  id: string;
  testCaseId: string;
  reference: string;
  name: string;
  suite?: string | null;
  status: string;
  startedAt?: string;
  completedAt?: string;
  durationMs: number;
  attempt: number;
  stepsTotal: number;
  stepsPassed: number;
  stepsFailed: number;
  stepsHealed: number;
  consoleErrorCount: number;
  networkErrorCount: number;
  errorMessage?: string | null;
  browser: string;
  browserVersion?: string | null;
  correlationId?: string | null;
  priority: string;
  kind?: string;
  /** What the platform concluded about this failure. Absent on a passing execution. */
  failureCategory?: string | null;
  failureConfidence?: number | null;
  failureSummary?: string | null;
}

export interface QualityGateRuleResult {
  ruleId: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  actualValue: number;
  passed: boolean;
  isBlocking: boolean;
  explanation: string;
  /** What a failure of this rule does. Absent on a platform older than gate actions. */
  action?: 'fail' | 'review' | 'warn' | null;
  /** False when this run could not measure the rule's metric at all. */
  measured?: boolean;
}

export type QualityGateOutcome = 'pass' | 'review' | 'fail';

export interface QualityGateResult {
  /** True for PASS and for REVIEW. A pipeline that must stop on REVIEW reads `outcome`. */
  passed: boolean;
  /** Absent on a platform older than three-outcome gates; treat as pass/fail then. */
  outcome?: QualityGateOutcome | null;
  reviewReasons?: string[] | null;
  metrics?: Record<string, number> | null;
  rules: QualityGateRuleResult[];
  summary: string;
}

/** Everything a report needs, gathered once so the three renderers agree with each other. */
export interface RunReport {
  run: RunSummary;
  executions: ExecutionSummary[];
  qualityGate: QualityGateResult;
  project?: { id: string; name: string; key: string } | undefined;
  consoleUrl?: string | undefined;
  generatedAt: string;
}
