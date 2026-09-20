import type { ExecutionSummary, RunReport } from '../types.js';
import { explain, qualification, verdictOf } from '../verdict.js';

/**
 * Renders a run as JUnit XML, the format every CI system can already read.
 *
 * Two things matter more than they look. First, escaping: a test name or a browser error
 * message can contain quotes, ampersands and control characters, and a report that breaks
 * the parser is worse than no report — the pipeline reports a tooling error instead of the
 * test result. Second, the verdict mapping in ../verdict.ts is applied here without
 * exception, so a healed or flaky pass always arrives carrying its qualification.
 */

/** XML 1.0 forbids most control characters outright; they cannot be escaped, only removed. */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function escapeXml(value: string): string {
  return value
    .replace(FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const seconds = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(3);

/** JUnit's classname is what most CI UIs group by, so it carries the suite. */
function classNameOf(execution: ExecutionSummary, report: RunReport): string {
  const project = report.project?.key ?? report.project?.name;
  const suite = execution.suite?.trim();
  return [project, suite].filter(Boolean).join('.') || 'aira';
}

export function renderJUnit(report: RunReport): string {
  const { run, executions } = report;

  const counted = executions.map(e => ({ execution: e, verdict: verdictOf(e.status) }));
  const failures = counted.filter(c => c.verdict === 'failed').length;
  const errors = counted.filter(c => c.verdict === 'error').length;
  const skipped = counted.filter(c => c.verdict === 'skipped').length;

  // Grouped by classname so a CI UI shows suites rather than one flat list.
  const groups = new Map<string, typeof counted>();
  for (const entry of counted) {
    const key = classNameOf(entry.execution, report);
    const existing = groups.get(key);
    if (existing) existing.push(entry);
    else groups.set(key, [entry]);
  }

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  // The root time is the run's wall clock, while each suite's is the sum of its executions.
  // With parallel execution the suites can therefore add up to more than the root, which is
  // not a contradiction: the run really did take the shorter time. Reporting the sum here
  // instead would overstate how long the pipeline waited.
  lines.push(
    `<testsuites name="${escapeXml(run.name)}" tests="${executions.length}" `
    + `failures="${failures}" errors="${errors}" skipped="${skipped}" `
    + `time="${seconds(run.durationMs)}">`);

  for (const [className, entries] of groups) {
    const groupFailures = entries.filter(e => e.verdict === 'failed').length;
    const groupErrors = entries.filter(e => e.verdict === 'error').length;
    const groupSkipped = entries.filter(e => e.verdict === 'skipped').length;
    const groupTime = entries.reduce((total, e) => total + e.execution.durationMs, 0);

    lines.push(
      `  <testsuite name="${escapeXml(className)}" tests="${entries.length}" `
      + `failures="${groupFailures}" errors="${groupErrors}" skipped="${groupSkipped}" `
      + `time="${seconds(groupTime)}"`
      + (run.startedAt ? ` timestamp="${escapeXml(run.startedAt)}"` : '')
      + '>');

    for (const { execution, verdict } of entries) {
      const name = `${execution.reference} ${execution.name}`.trim();
      lines.push(
        `    <testcase name="${escapeXml(name)}" classname="${escapeXml(className)}" `
        + `time="${seconds(execution.durationMs)}">`);

      const detail = escapeXml(explain(execution.status, execution.errorMessage));

      if (verdict === 'failed') {
        lines.push(`      <failure message="${escapeXml(summarise(execution))}" `
          + `type="${escapeXml(execution.status)}">${detail}</failure>`);
      } else if (verdict === 'error') {
        lines.push(`      <error message="${escapeXml(summarise(execution))}" `
          + `type="${escapeXml(execution.status)}">${detail}</error>`);
      } else if (verdict === 'skipped') {
        lines.push(`      <skipped message="${escapeXml(summarise(execution))}"/>`);
      }

      const note = qualification(execution.status);
      const output = [
        note,
        `Steps: ${execution.stepsPassed}/${execution.stepsTotal} passed`
        + (execution.stepsHealed > 0 ? `, ${execution.stepsHealed} healed` : ''),
        execution.consoleErrorCount > 0 ? `Console errors: ${execution.consoleErrorCount}` : undefined,
        execution.networkErrorCount > 0 ? `Network errors: ${execution.networkErrorCount}` : undefined,
        report.consoleUrl
          ? `Evidence: ${report.consoleUrl.replace(/\/+$/, '')}/executions/${execution.id}`
          : undefined
      ].filter((line): line is string => Boolean(line));

      if (output.length > 0) {
        lines.push(`      <system-out>${escapeXml(output.join('\n'))}</system-out>`);
      }

      lines.push('    </testcase>');
    }

    lines.push('  </testsuite>');
  }

  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

function summarise(execution: ExecutionSummary): string {
  const first = execution.errorMessage?.split('\n')[0]?.trim();
  if (first) return first.length > 200 ? `${first.slice(0, 197)}...` : first;
  return `${execution.reference} ${execution.status}`;
}
