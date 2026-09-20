import type { RunReport } from '../types.js';
import { explain, qualification, verdictOf } from '../verdict.js';

/**
 * The machine-readable report.
 *
 * Unlike the JUnit file, this is meant to be consumed by something that wants the whole
 * truth: which passes were qualified, why each gate rule decided what it decided, and what
 * the run actually measured. It carries its own schema version so a pipeline that parses it
 * can fail loudly rather than silently misread a later shape.
 */

export const REPORT_SCHEMA_VERSION = 1;

export function buildJsonReport(report: RunReport): unknown {
  const { run, executions, qualityGate } = report;

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: report.generatedAt,
    project: report.project ?? null,
    run: {
      id: run.id,
      name: run.name,
      status: run.status,
      trigger: run.trigger,
      browser: run.browser,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      durationMs: run.durationMs,
      ci: run.ciBuildId || run.ciBranch
        ? { buildId: run.ciBuildId ?? null, branch: run.ciBranch ?? null }
        : null,
      url: report.consoleUrl ? `${report.consoleUrl.replace(/\/+$/, '')}/runs/${run.id}` : null
    },
    totals: {
      total: run.totalCount,
      passed: run.passedCount,
      failed: run.failedCount,
      skipped: run.skippedCount,
      blocked: run.blockedCount,
      healed: run.healedCount,
      flaky: run.flakyCount
    },
    qualityGate: {
      passed: qualityGate.passed,
      summary: qualityGate.summary,
      rules: qualityGate.rules.map(rule => ({
        name: rule.name,
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        actual: rule.actualValue,
        passed: rule.passed,
        blocking: rule.isBlocking,
        explanation: rule.explanation
      }))
    },
    tests: executions.map(execution => ({
      id: execution.id,
      reference: execution.reference,
      name: execution.name,
      suite: execution.suite ?? null,
      priority: execution.priority,
      status: execution.status,
      verdict: verdictOf(execution.status),
      // Present only when the pass is qualified, so its absence means an unqualified result.
      qualification: qualification(execution.status) ?? null,
      durationMs: execution.durationMs,
      attempt: execution.attempt,
      steps: {
        total: execution.stepsTotal,
        passed: execution.stepsPassed,
        failed: execution.stepsFailed,
        healed: execution.stepsHealed
      },
      consoleErrors: execution.consoleErrorCount,
      networkErrors: execution.networkErrorCount,
      message: verdictOf(execution.status) === 'passed'
        ? null
        : explain(execution.status, execution.errorMessage),
      browser: execution.browser,
      browserVersion: execution.browserVersion ?? null,
      correlationId: execution.correlationId ?? null,
      url: report.consoleUrl
        ? `${report.consoleUrl.replace(/\/+$/, '')}/executions/${execution.id}`
        : null
    }))
  };
}

export function renderJson(report: RunReport): string {
  return `${JSON.stringify(buildJsonReport(report), null, 2)}\n`;
}
