#!/usr/bin/env node
import { parseArgs, boolFlag } from './args.js';
import { CliError, ExitCode } from './exit-codes.js';
import { bold, dim, red, setQuiet, note, out } from './output.js';
import { DISCOVER_HELP, discoverCommand } from './commands/discover.js';
import { LOGIN_HELP, loginCommand } from './commands/login.js';
import { REPORT_HELP, reportCommand } from './commands/report.js';
import { RUN_HELP, runCommand } from './commands/run.js';
import { STATUS_HELP, statusCommand } from './commands/status.js';
import { QUALITY_GATE_HELP, qualityGateCommand } from './commands/quality-gate.js';
import { API_TEST_HELP, apiTestCommand } from './commands/api-test.js';
import { CONTRACT_HELP, contractCommand } from './commands/contract.js';
import { REGRESSION_HELP, regressionCommand } from './commands/regression.js';
import { SCHEDULE_HELP, scheduleCommand } from './commands/schedule.js';
import { TEST_DATA_HELP, testDataCommand } from './commands/test-data.js';
import { RELEASE_HELP, releaseCommand } from './commands/release.js';
import { AUDIT_HELP, auditCommand } from './commands/audit.js';
import { SECURITY_HELP, securityCommand } from './commands/security.js';
import { appsCommand, environmentsCommand, LIST_HELP, projectsCommand } from './commands/list.js';

/**
 * The entry point.
 *
 * Every command returns an exit code rather than calling process.exit, so the codes are
 * testable and there is exactly one place that decides what a thrown error means for a
 * pipeline. An unexpected error is reported as a platform error, never as a test failure:
 * telling a team their application is broken because the CLI crashed would be a lie.
 */

const VERSION = '0.1.0';
const PRODUCT = process.env.PRODUCT_NAME ?? 'QA NXT';

const HELP = `
${bold(`${PRODUCT} command line`)} ${dim(`v${VERSION}`)}

  qanxt login                Store a session
  qanxt projects             List the projects this account can see
  qanxt apps                 List the applications in a project
  qanxt environments         List a project's environments
  qanxt discover             Crawl an application and refresh its knowledge graph
  qanxt api-test             Author, generate and run API tests
  qanxt contract             API contract baselines, and what has moved since
  qanxt regression           Run the tests a change needs, and say why
  qanxt schedule             Regression that happens without anybody asking
  qanxt test-data            The named data a test case uses
  qanxt release              What changed between runs, and whether to ship
  qanxt run                  Start a test run, wait for it, write reports
  qanxt status [run-id]      What a run did, or what the recent runs did
  qanxt quality-gate         Evaluate a finished run against its gate
  qanxt security             Security scopes, scans, findings and the gate
  qanxt audit                Who did what, and whether it worked
  qanxt report <run-id>      Write reports for a run that already finished

  --api-url <url>           The control plane (or QANXT_API_URL)
  --token <token>           A session token (or QANXT_TOKEN)
  --quiet                   Suppress progress; results still go to stdout
  -h, --help                Show help for a command
  -v, --version             Print the version

Exit status
  0 PASS                        5 INFRASTRUCTURE_ERROR
  1 TEST_FAILURE                6 SECURITY_POLICY_VIOLATION
  2 QUALITY_GATE_FAILURE        7 HUMAN_REVIEW_REQUIRED
  3 CONFIGURATION_ERROR         8 QANXT_INTERNAL_ERROR
  4 AUTHENTICATION_ERROR

In a pipeline, set QANXT_API_URL and QANXT_TOKEN and skip "qanxt login".
`;

const COMMAND_HELP: Record<string, string> = {
  login: LOGIN_HELP,
  discover: DISCOVER_HELP,
  'api-test': API_TEST_HELP,
  contract: CONTRACT_HELP,
  regression: REGRESSION_HELP,
  schedule: SCHEDULE_HELP,
  audit: AUDIT_HELP,
  security: SECURITY_HELP,
  'test-data': TEST_DATA_HELP,
  release: RELEASE_HELP,
  run: RUN_HELP,
  status: STATUS_HELP,
  'quality-gate': QUALITY_GATE_HELP,
  projects: LIST_HELP,
  apps: LIST_HELP,
  environments: LIST_HELP,
  report: REPORT_HELP
};

const COMMANDS: Record<string, (args: ReturnType<typeof parseArgs>) => Promise<number>> = {
  login: loginCommand,
  discover: discoverCommand,
  'api-test': apiTestCommand,
  contract: contractCommand,
  regression: regressionCommand,
  schedule: scheduleCommand,
  audit: auditCommand,
  security: securityCommand,
  'test-data': testDataCommand,
  release: releaseCommand,
  run: runCommand,
  status: statusCommand,
  'quality-gate': qualityGateCommand,
  projects: projectsCommand,
  apps: appsCommand,
  environments: environmentsCommand,
  report: reportCommand
};

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  setQuiet(boolFlag(args, 'quiet'));

  if (boolFlag(args, 'version') && !args.command) { out(VERSION); return ExitCode.Success; }

  if (!args.command) { note(HELP); return boolFlag(args, 'help') ? ExitCode.Success : ExitCode.ConfigurationError; }

  const command = COMMANDS[args.command];
  if (!command) {
    note(red(`Unknown command "${args.command}".`));
    note(HELP);
    return ExitCode.ConfigurationError;
  }

  if (boolFlag(args, 'help')) { note(COMMAND_HELP[args.command] ?? HELP); return ExitCode.Success; }

  return command(args);
}

/**
 * A closed downstream pipe is not a failure.
 *
 * `qanxt audit list | head` closes stdout once head has what it wants. Node then raises
 * EPIPE on the next write, and with no handler it surfaces as an unhandled 'error' event:
 * a stack trace, and exit 1. In this CLI exit 1 means TEST_FAILURE, so piping a command
 * into `head` told a pipeline that tests had failed. Anything writing more lines than its
 * reader consumes hit it; the audit listing just hits it most easily.
 *
 * Handled here rather than at each write site, because there is one correct answer and it
 * is the same everywhere: stop writing, and exit as if the output had been delivered.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(ExitCode.Success);
    throw error;
  });
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliError) {
    process.stderr.write(`${red('error')} ${error.message}\n`);
    if (error.hint) process.stderr.write(`${dim(error.hint)}\n`);
    process.exitCode = error.code;
  } else {
    // Not a test failure, and not the platform being unreachable either: something in the
    // tooling broke. Reporting it as infrastructure sent an unhandled exception to whoever
    // runs the deployment, who checks it, finds it healthy, and hands it back.
    process.stderr.write(`${red('error')} The command did not complete. This is a defect in QA NXT.\n`);
    process.stderr.write(`${dim(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`);
    process.exitCode = ExitCode.QaNxtInternalError;
  }
}
