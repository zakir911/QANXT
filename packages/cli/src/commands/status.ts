import { ApiClient } from '../api.js';
import { boolFlag, flag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, dim, duration, green, note, out, red, yellow } from '../output.js';
import { gatherReport } from '../report-gather.js';
import { buildJsonReport } from '../reports/json.js';
import type { RunSummary } from '../types.js';
import { verdictOf } from '../verdict.js';

export const STATUS_FLAGS = ['project', 'limit', 'json'] as const;

export const STATUS_HELP = `
${bold('aira status')} — what a run did, or what the recent runs did

  aira status <run-id>   One run, with its tests and its quality gate
  aira status            The recent runs in the project

  --project <id>         Project to list (or AIRA_PROJECT_ID)
  --limit <n>            How many runs to list (default 10)
  --json                 Emit the machine-readable report on stdout

Exit status mirrors the run: 0 if its quality gate passed, 1 if it did not.
`;

export async function statusCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, STATUS_FLAGS);

  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token'),
    projectId: flag(args, 'project')
  });
  const api = new ApiClient(context.apiUrl, context.token);
  const runId = args.positionals[0];

  if (!runId) return listRuns(api, args, context.projectId);

  const report = await gatherReport(api, runId, context.consoleUrl);

  if (boolFlag(args, 'json')) {
    out(JSON.stringify(buildJsonReport(report), null, 2));
    return report.qualityGate.passed ? ExitCode.Success : ExitCode.QualityGateFailure;
  }

  const { run } = report;
  note(`${bold(run.name)} ${dim(run.id)}`);
  note(`${run.status} · ${run.browser} · ${duration(run.durationMs)}`);
  note('');

  for (const execution of report.executions) {
    const verdict = verdictOf(execution.status);
    const mark = verdict === 'passed' ? green('✓') : verdict === 'skipped' ? dim('–') : red('✗');
    note(`  ${mark} ${execution.reference} ${execution.name} ${dim(execution.status)}`);
  }

  note('');
  note(report.qualityGate.passed
    ? green(`  Quality gate passed. ${report.qualityGate.summary}`)
    : red(`  Quality gate failed. ${report.qualityGate.summary}`));

  return report.qualityGate.passed ? ExitCode.Success : ExitCode.QualityGateFailure;
}

async function listRuns(api: ApiClient, args: ParsedArgs, projectId?: string): Promise<number> {
  if (!projectId) throw usage('A project is required to list runs.', 'Pass --project <id>.');

  const limit = flag(args, 'limit') ?? '10';
  const runs = await api.get<RunSummary[]>(`/api/v1/testruns?projectId=${projectId}&limit=${limit}`);

  if (boolFlag(args, 'json')) {
    out(JSON.stringify(runs, null, 2));
    return ExitCode.Success;
  }

  if (runs.length === 0) {
    note('No runs yet.');
    return ExitCode.Success;
  }

  for (const run of runs) {
    const gate = run.qualityGatePassed === null || run.qualityGatePassed === undefined
      ? dim('gate not evaluated')
      : run.qualityGatePassed ? green('gate passed') : red('gate failed');
    const verdict = run.failedCount > 0 ? red(`${run.failedCount} failed`) : green('all passed');
    const flaky = run.flakyCount > 0 ? yellow(` ${run.flakyCount} flaky`) : '';
    note(`  ${dim(run.id.slice(0, 8))} ${run.name} — ${run.status}, ${verdict}${flaky}, ${gate} `
      + dim(`${duration(run.durationMs)} ${run.createdAt}`));
  }

  return ExitCode.Success;
}
