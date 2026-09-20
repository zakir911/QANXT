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
}

export interface QualityGateResult {
  passed: boolean;
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
