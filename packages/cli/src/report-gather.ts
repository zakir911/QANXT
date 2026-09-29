import type { ApiClient } from './api.js';
import type { ExecutionSummary, PendingHeal, QualityGateResult, RunReport, RunSummary } from './types.js';
import { renderHtml } from './reports/html.js';
import { renderJson } from './reports/json.js';
import { renderJUnit } from './reports/junit.js';
import { renderMarkdown } from './reports/markdown.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { note } from './output.js';

/** Collects everything the three report formats need, in one place so they cannot disagree. */
export async function gatherReport(
  api: ApiClient,
  runId: string,
  consoleUrl?: string
): Promise<RunReport> {
  const run = await api.get<RunSummary>(`/api/v1/testruns/${runId}`);
  const executions = await api.get<ExecutionSummary[]>(`/api/v1/testruns/${runId}/executions`);
  const qualityGate = await api.get<QualityGateResult>(`/api/v1/testruns/${runId}/quality-gate`);

  let project: RunReport['project'];
  try {
    const projects = await api.get<Array<{ id: string; name: string; key: string }>>('/api/v1/projects');
    project = projects.find(p => p.id === run.projectId);
  } catch {
    // A report without the project's name is still a useful report.
  }

  // Repairs the platform has already worked out and is holding for approval. Narrowed to the
  // tests that ran here: a proposal against some other suite is not this run's news, and a
  // report that listed the whole project's backlog would be ignored.
  let pendingHeals: PendingHeal[] = [];
  try {
    const ran = new Set(executions.map(e => e.testCaseId));
    const proposals = await api.get<Array<{
      testCaseId: string; testCaseName: string; stepDescription: string;
      originalLocator: string; healedLocator: string; confidence: number;
    }>>(`/api/v1/healing?projectId=${run.projectId}&outcome=proposed&limit=100`);

    pendingHeals = proposals
      .filter(p => ran.has(p.testCaseId))
      .map(p => ({
        testCaseReference: executions.find(e => e.testCaseId === p.testCaseId)?.reference ?? '',
        testCaseName: p.testCaseName,
        stepDescription: p.stepDescription,
        originalLocator: p.originalLocator,
        healedLocator: p.healedLocator,
        confidence: p.confidence
      }));
  } catch {
    // Reporting the run matters more than reporting the proposals; an older platform that
    // does not serve this endpoint still produces a complete report of what ran.
  }

  return {
    run, executions, qualityGate, pendingHeals, project, consoleUrl,
    generatedAt: new Date().toISOString()
  };
}

export interface ReportTargets {
  junit?: string | undefined;
  json?: string | undefined;
  html?: string | undefined;
  /** A pull request comment: the verdict first, the failures next, the rest collapsed. */
  markdown?: string | undefined;
}

/** Writes whichever reports were asked for, creating directories as needed. */
export async function writeReports(report: RunReport, targets: ReportTargets): Promise<string[]> {
  const written: string[] = [];

  const write = async (path: string, content: string): Promise<void> => {
    const full = resolve(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    written.push(full);
    note(`  wrote ${full}`);
  };

  if (targets.junit) await write(targets.junit, renderJUnit(report));
  if (targets.json) await write(targets.json, renderJson(report));
  if (targets.html) await write(targets.html, renderHtml(report));
  if (targets.markdown) await write(targets.markdown, renderMarkdown(report));

  return written;
}
