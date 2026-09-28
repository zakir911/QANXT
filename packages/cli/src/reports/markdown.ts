import type { RunReport } from '../types.js';
import { qualification, verdictOf } from '../verdict.js';

/**
 * A run, as a pull request comment.
 *
 * Written to be read on a phone by someone who did not start the build. That constraint
 * decides the shape: the verdict first, the failures next with their diagnosis, and
 * everything else collapsed. A comment that opens with a table of twenty passing tests
 * makes the reader scroll past the only thing they needed.
 *
 * Nothing here is posted by QA NXT. The CLI writes the file and the pipeline posts it with
 * whatever it already uses — `gh pr comment`, an Azure DevOps task, a GitLab note. An
 * integration that needed its own credentials to comment on a pull request would be a
 * second thing to grant, rotate and audit, for no capability the pipeline does not have.
 */
export function renderMarkdown(report: RunReport): string {
  const { run, executions, qualityGate } = report;
  const outcome = qualityGate.outcome ?? (qualityGate.passed ? 'pass' : 'fail');

  const failed = executions.filter(e => verdictOf(e.status) === 'failed');
  const healed = executions.filter(e => e.status === 'healed');
  const flaky = executions.filter(e => e.status === 'flaky');
  const blocked = executions.filter(e => e.status === 'blocked');

  const lines: string[] = [];

  lines.push(`### ${headline(outcome, failed.length)}`);
  lines.push('');
  lines.push(
    `**${run.passedCount} passed · ${run.failedCount} failed · ${run.blockedCount} blocked**`
    + ` · ${run.healedCount} healed · ${run.flakyCount} flaky · ${duration(run.durationMs)}`);
  lines.push('');

  if (failed.length > 0) {
    lines.push(`#### What failed`);
    lines.push('');
    for (const execution of failed.slice(0, 20)) {
      lines.push(`- **${execution.reference}** ${execution.name}`);
      if (execution.errorMessage) {
        lines.push(`  \`\`\``);
        lines.push(`  ${firstLine(execution.errorMessage)}`);
        lines.push(`  \`\`\``);
      }
      if (execution.failureCategory) {
        const confidence = execution.failureConfidence !== undefined
          ? ` (${execution.failureConfidence}%)`
          : '';
        lines.push(`  ${humanise(execution.failureCategory)}${confidence}`);
      }
    }
    if (failed.length > 20) lines.push(`- …and ${failed.length - 20} more.`);
    lines.push('');
  }

  // The gate's own words. A team that disagrees with a block should be arguing with the
  // rule, and they cannot do that unless the rule is quoted.
  lines.push(`#### Quality gate`);
  lines.push('');
  lines.push(qualityGate.summary);
  lines.push('');

  const unsatisfied = qualityGate.rules.filter(rule => !rule.passed);
  if (unsatisfied.length > 0) {
    lines.push('| Rule | Measured | Required | Action |');
    lines.push('| --- | --- | --- | --- |');
    for (const rule of unsatisfied) {
      lines.push(`| ${rule.name} | ${format(rule.actualValue)} | `
        + `${describeOperator(rule.operator)} ${format(rule.threshold)} | `
        + `${rule.measured === false ? 'not measured' : rule.action ?? (rule.isBlocking ? 'fail' : 'warn')} |`);
    }
    lines.push('');
  }

  // A review verdict already surfaces its reasons below; a blocking one did not, so the
  // sentence the team wrote to explain the rule — the most useful line on the comment —
  // was dropped exactly when the build was stopped. Quoted here, and de-duplicated against
  // the review reasons so a rule that appears in both is not printed twice.
  const reviewReasons = qualityGate.reviewReasons ?? [];
  const blockingReasons = unsatisfied
    .filter(rule => (rule.action ?? (rule.isBlocking ? 'fail' : 'warn')) === 'fail')
    .map(rule => rule.explanation)
    .filter(explanation => explanation && !reviewReasons.includes(explanation));

  for (const reason of [...blockingReasons, ...reviewReasons]) {
    lines.push(`> ${reason}`);
    lines.push('');
  }

  if (healed.length > 0 || flaky.length > 0 || blocked.length > 0) {
    lines.push('<details><summary>Healed, flaky and blocked</summary>');
    lines.push('');
    for (const execution of [...healed, ...flaky, ...blocked]) {
      lines.push(`- **${execution.reference}** ${execution.name} — `
        + `${qualification(execution.status) ?? execution.status}`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  const passed = executions.filter(e => verdictOf(e.status) === 'passed');
  if (passed.length > 0) {
    lines.push(`<details><summary>${passed.length} passing test(s)</summary>`);
    lines.push('');
    for (const execution of passed) {
      lines.push(`- ${execution.reference} ${execution.name} ${duration(execution.durationMs)}`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  if (report.consoleUrl) {
    lines.push(`[Open this run in ${report.project?.name ?? 'QA NXT'}](${report.consoleUrl}/runs/${run.id})`);
    lines.push('');
  }

  const where = run.environmentName ?? run.environmentKey;
  lines.push(`<sub>${run.name} · run \`${run.id}\``
    + `${where ? ` · ${where}` : ''}`
    + `${run.ciCommitSha ? ` · \`${run.ciCommitSha.slice(0, 8)}\`` : ''}`
    + ` · generated ${report.generatedAt}</sub>`);

  return lines.join('\n');
}

function headline(outcome: string, failedCount: number): string {
  if (failedCount > 0) return `❌ ${failedCount} test(s) failed`;
  if (outcome === 'fail') return '❌ The quality gate blocked this run';
  if (outcome === 'review') return '⚠️ This run needs a person to look at it';
  return '✅ All tests passed';
}

function humanise(category: string): string {
  const spaced = category.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function describeOperator(operator: string): string {
  switch (operator) {
    case 'lessThan': return '<';
    case 'lessThanOrEqual': return '≤';
    case 'greaterThan': return '>';
    case 'greaterThanOrEqual': return '≥';
    case 'equal': return '=';
    case 'notEqual': return '≠';
    default: return operator;
  }
}

const format = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

const firstLine = (message: string): string => message.split('\n')[0] ?? message;

function duration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
