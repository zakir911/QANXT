import { ApiClient } from '../api.js';
import { flag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, note } from '../output.js';
import { gatherReport, writeReports } from '../report-gather.js';

export const REPORT_FLAGS = ['junit', 'json', 'html', 'report-dir'] as const;

export const REPORT_HELP = `
${bold('aira report')} — write the reports for a run that already finished

  aira report <run-id> --report-dir ./reports

  --junit <path>         Write JUnit XML
  --json <path>          Write the machine-readable report
  --html <path>          Write the human-readable report
  --report-dir <dir>     Write all three into a directory

Useful when a run was started with --no-wait, or when a pipeline stage that only
publishes artifacts is separate from the one that ran the tests.

Exit status mirrors the run's quality gate: 0 passed, 1 failed.
`;

export async function reportCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, REPORT_FLAGS);

  const runId = args.positionals[0];
  if (!runId) throw usage('A run id is required.', 'Usage: aira report <run-id> --report-dir ./reports');

  const context = await resolveContext({ apiUrl: flag(args, 'api-url'), token: flag(args, 'token') });
  const api = new ApiClient(context.apiUrl, context.token);

  const report = await gatherReport(api, runId, context.consoleUrl);

  const dir = flag(args, 'report-dir');
  const targets = {
    junit: flag(args, 'junit') ?? (dir ? `${dir}/junit.xml` : undefined),
    json: flag(args, 'json') ?? (dir ? `${dir}/report.json` : undefined),
    html: flag(args, 'html') ?? (dir ? `${dir}/report.html` : undefined)
  };

  if (!targets.junit && !targets.json && !targets.html) {
    throw usage('No report was requested.', 'Pass --report-dir, or one of --junit, --json, --html.');
  }

  const written = await writeReports(report, targets);
  note(`Wrote ${written.length} report(s) for ${report.run.name}.`);

  return report.qualityGate.passed ? ExitCode.Success : ExitCode.QualityGateFailed;
}
