import type { RunReport } from '../types.js';
import { explain, qualification, verdictOf } from '../verdict.js';

/**
 * The human-readable report.
 *
 * A CI artifact is opened from a build page, often on a phone, often with no network beyond
 * the artifact itself — so this is one self-contained file with no external stylesheet,
 * font or script. The verdict is stated in words as well as colour, because a report whose
 * meaning depends on being able to distinguish red from green is not a report for everyone.
 */

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const duration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
};

const VERDICT_LABEL: Record<string, string> = {
  passed: 'Passed',
  failed: 'Failed',
  error: 'Could not run',
  skipped: 'Not run'
};

export function renderHtml(report: RunReport): string {
  const { run, executions, qualityGate } = report;
  const productName = process.env.PRODUCT_NAME ?? 'QA NXT';
  const gateState = qualityGate.passed ? 'pass' : 'fail';

  const rows = executions.map(execution => {
    const verdict = verdictOf(execution.status);
    const note = qualification(execution.status);
    const message = verdict === 'passed' ? undefined : explain(execution.status, execution.errorMessage);
    const link = report.consoleUrl
      ? `${report.consoleUrl.replace(/\/+$/, '')}/executions/${execution.id}`
      : undefined;

    return `
      <tr class="v-${verdict}">
        <td>
          <span class="badge b-${verdict}">${escapeHtml(VERDICT_LABEL[verdict] ?? verdict)}</span>
          ${execution.status !== verdict ? `<span class="sub">${escapeHtml(execution.status)}</span>` : ''}
        </td>
        <td>
          <div class="name"><code>${escapeHtml(execution.reference)}</code> ${escapeHtml(execution.name)}</div>
          ${execution.suite ? `<div class="sub">${escapeHtml(execution.suite)}</div>` : ''}
          ${note ? `<div class="note">${escapeHtml(note)}</div>` : ''}
          ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ''}
        </td>
        <td class="num">${execution.stepsPassed}/${execution.stepsTotal}${execution.stepsHealed > 0 ? ` <span class="sub">(${execution.stepsHealed} healed)</span>` : ''}</td>
        <td class="num">${escapeHtml(duration(execution.durationMs))}</td>
        <td>${link ? `<a href="${escapeHtml(link)}">Evidence</a>` : '<span class="sub">—</span>'}</td>
      </tr>`;
  }).join('');

  const gateRows = qualityGate.rules.map(rule => `
      <tr>
        <td><span class="badge b-${rule.passed ? 'passed' : rule.isBlocking ? 'failed' : 'warn'}">${
          rule.passed ? 'Met' : rule.isBlocking ? 'Blocking' : 'Warning'}</span></td>
        <td>${escapeHtml(rule.name)}<div class="sub">${escapeHtml(rule.explanation)}</div></td>
      </tr>`).join('');

  const tiles = [
    { label: 'Total', value: run.totalCount },
    { label: 'Passed', value: run.passedCount },
    { label: 'Failed', value: run.failedCount },
    { label: 'Blocked', value: run.blockedCount },
    { label: 'Healed', value: run.healedCount },
    { label: 'Flaky', value: run.flakyCount }
  ].map(tile => `<div class="tile"><div class="tv">${tile.value}</div><div class="tl">${tile.label}</div></div>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(run.name)} — ${escapeHtml(productName)}</title>
<style>
  :root {
    --bg: #ffffff; --panel: #f6f7f9; --line: #dfe3e8; --ink: #14181d; --muted: #5b6672;
    --pass: #1f7a3d; --fail: #b3261e; --warn: #8a5a00; --link: #0b5fff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14181d; --panel: #1c2128; --line: #2d343d; --ink: #e9edf2; --muted: #9aa5b1;
      --pass: #5cc98a; --fail: #ff8a80; --warn: #e0b060; --link: #79a8ff;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--ink);
         font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 32px 0 8px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  .gate { border: 1px solid var(--line); border-left: 4px solid var(--${gateState === 'pass' ? 'pass' : 'fail'});
          background: var(--panel); border-radius: 6px; padding: 12px 14px; margin-bottom: 20px; }
  .gate strong { color: var(--${gateState === 'pass' ? 'pass' : 'fail'}); }
  .tiles { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .tile { flex: 1 1 96px; background: var(--panel); border: 1px solid var(--line);
          border-radius: 6px; padding: 10px 12px; }
  .tv { font-size: 22px; font-weight: 600; }
  .tl { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .04em;
       color: var(--muted); border-bottom: 1px solid var(--line); padding: 8px 10px; font-weight: 600; }
  td { border-bottom: 1px solid var(--line); padding: 10px; vertical-align: top; }
  td.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .name code { background: var(--panel); border-radius: 3px; padding: 1px 5px; font-size: 12px; }
  .sub { color: var(--muted); font-size: 12px; }
  .note { color: var(--warn); font-size: 13px; margin-top: 4px; }
  .msg { font-size: 13px; margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px;
           border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
  .b-passed { color: var(--pass); } .b-failed { color: var(--fail); }
  .b-error  { color: var(--fail); } .b-skipped { color: var(--muted); }
  .b-warn   { color: var(--warn); }
  a { color: var(--link); }
  @media (max-width: 640px) { th.hide, td.hide { display: none; } }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(run.name)}</h1>
  <p class="meta">
    ${escapeHtml(productName)} ·
    ${escapeHtml(run.browser)} ·
    ${escapeHtml(duration(run.durationMs))} ·
    ${run.startedAt ? escapeHtml(new Date(run.startedAt).toUTCString()) : 'not started'}
    ${run.ciBranch ? ` · branch ${escapeHtml(run.ciBranch)}` : ''}
    ${run.ciBuildId ? ` · build ${escapeHtml(run.ciBuildId)}` : ''}
  </p>

  <div class="gate">
    <strong>Quality gate: ${qualityGate.passed ? 'passed' : 'failed'}.</strong>
    ${escapeHtml(qualityGate.summary)}
  </div>

  <div class="tiles">${tiles}</div>

  ${qualityGate.rules.length > 0 ? `
  <h2>Gate rules</h2>
  <table><tbody>${gateRows}</tbody></table>` : ''}

  <h2>Tests</h2>
  <table>
    <thead><tr>
      <th>Verdict</th><th>Test</th><th class="hide">Steps</th><th>Time</th><th class="hide">Links</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="sub">This run contains no executions.</td></tr>'}</tbody>
  </table>

  <p class="meta" style="margin-top:28px">
    Generated ${escapeHtml(new Date(report.generatedAt).toUTCString())}.
    ${report.consoleUrl ? `<a href="${escapeHtml(report.consoleUrl.replace(/\/+$/, ''))}/runs/${escapeHtml(run.id)}">Open this run in ${escapeHtml(productName)}</a>.` : ''}
  </p>
</main>
</body>
</html>
`;
}
