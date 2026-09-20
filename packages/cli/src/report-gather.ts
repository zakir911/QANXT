import type { ApiClient } from './api.js';
import type { ExecutionSummary, QualityGateResult, RunReport, RunSummary } from './types.js';
import { renderHtml } from './reports/html.js';
import { renderJson } from './reports/json.js';
import { renderJUnit } from './reports/junit.js';
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

  return { run, executions, qualityGate, project, consoleUrl, generatedAt: new Date().toISOString() };
}

export interface ReportTargets {
  junit?: string | undefined;
  json?: string | undefined;
  html?: string | undefined;
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

  return written;
}
