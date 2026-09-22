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
const PRODUCT = process.env.PRODUCT_NAME ?? 'AIRA';

const HELP = `
${bold(`${PRODUCT} command line`)} ${dim(`v${VERSION}`)}

  aira login                Store a session
  aira projects             List the projects this account can see
  aira apps                 List the applications in a project
  aira environments         List a project's environments
  aira discover             Crawl an application and refresh its knowledge graph
  aira api-test             Author, generate and run API tests
  aira contract             API contract baselines, and what has moved since
  aira regression           Run the tests a change needs, and say why
  aira schedule             Regression that happens without anybody asking
  aira test-data            The named data a test case uses
  aira release              What changed between runs, and whether to ship
  aira run                  Start a test run, wait for it, write reports
  aira status [run-id]      What a run did, or what the recent runs did
  aira quality-gate         Evaluate a finished run against its gate
  aira report <run-id>      Write reports for a run that already finished

  --api-url <url>           The control plane (or AIRA_API_URL)
  --token <token>           A session token (or AIRA_TOKEN)
  --quiet                   Suppress progress; results still go to stdout
  -h, --help                Show help for a command
  -v, --version             Print the version

Exit status
  0 PASS                        5 INFRASTRUCTURE_ERROR
  1 TEST_FAILURE                6 SECURITY_POLICY_VIOLATION
  2 QUALITY_GATE_FAILURE        7 HUMAN_REVIEW_REQUIRED
  3 CONFIGURATION_ERROR         8 AIRA_INTERNAL_ERROR
  4 AUTHENTICATION_ERROR

In a pipeline, set AIRA_API_URL and AIRA_TOKEN and skip "aira login".
`;

const COMMAND_HELP: Record<string, string> = {
  login: LOGIN_HELP,
  discover: DISCOVER_HELP,
  'api-test': API_TEST_HELP,
  contract: CONTRACT_HELP,
  regression: REGRESSION_HELP,
  schedule: SCHEDULE_HELP,
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
    process.stderr.write(`${red('error')} The command did not complete. This is a defect in AIRA.\n`);
    process.stderr.write(`${dim(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`);
    process.exitCode = ExitCode.AiraInternalError;
  }
}
