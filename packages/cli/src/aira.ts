#!/usr/bin/env node
import { parseArgs, boolFlag } from './args.js';
import { CliError, ExitCode } from './exit-codes.js';
import { bold, dim, red, setQuiet, note, out } from './output.js';
import { DISCOVER_HELP, discoverCommand } from './commands/discover.js';
import { LOGIN_HELP, loginCommand } from './commands/login.js';
import { REPORT_HELP, reportCommand } from './commands/report.js';
import { RUN_HELP, runCommand } from './commands/run.js';
import { STATUS_HELP, statusCommand } from './commands/status.js';

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
  aira discover             Crawl an application and refresh its knowledge graph
  aira run                  Start a test run, wait for it, write reports
  aira status [run-id]      What a run did, or what the recent runs did
  aira report <run-id>      Write reports for a run that already finished

  --api-url <url>           The control plane (or AIRA_API_URL)
  --token <token>           A session token (or AIRA_TOKEN)
  --quiet                   Suppress progress; results still go to stdout
  -h, --help                Show help for a command
  -v, --version             Print the version

Exit status: 0 success · 1 quality gate failed · 2 bad usage
             3 not authorized · 4 platform error · 5 timed out

In a pipeline, set AIRA_API_URL and AIRA_TOKEN and skip "aira login".
`;

const COMMAND_HELP: Record<string, string> = {
  login: LOGIN_HELP,
  discover: DISCOVER_HELP,
  run: RUN_HELP,
  status: STATUS_HELP,
  report: REPORT_HELP
};

const COMMANDS: Record<string, (args: ReturnType<typeof parseArgs>) => Promise<number>> = {
  login: loginCommand,
  discover: discoverCommand,
  run: runCommand,
  status: statusCommand,
  report: reportCommand
};

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  setQuiet(boolFlag(args, 'quiet'));

  if (boolFlag(args, 'version') && !args.command) { out(VERSION); return ExitCode.Success; }

  if (!args.command) { note(HELP); return boolFlag(args, 'help') ? ExitCode.Success : ExitCode.UsageError; }

  const command = COMMANDS[args.command];
  if (!command) {
    note(red(`Unknown command "${args.command}".`));
    note(HELP);
    return ExitCode.UsageError;
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
    // Not a test failure. Something in the tooling broke, and the message must say so
    // clearly rather than leaving a team looking for a defect that is not there.
    process.stderr.write(`${red('error')} The command did not complete.\n`);
    process.stderr.write(`${dim(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`);
    process.exitCode = ExitCode.PlatformError;
  }
}
