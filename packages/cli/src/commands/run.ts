import { BROWSER_TYPES, type BrowserType, type RunTrigger } from '@aira/shared-types';
import { ApiClient } from '../api.js';
import { boolFlag, flag, flagAll, intFlag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { CliError, ExitCode, type ExitCodeValue, usage } from '../exit-codes.js';
import { bold, dim, duration, green, note, out, red, yellow } from '../output.js';
import { gatherReport, writeReports } from '../report-gather.js';
import type { RunReport, RunSummary } from '../types.js';
import { qualification, verdictOf } from '../verdict.js';

export const RUN_FLAGS = [
  'project', 'environment', 'suite', 'test', 'browser', 'headed', 'parallelism', 'retries', 'name',
  'timeout', 'poll', 'no-wait', 'junit', 'json', 'html', 'markdown', 'report-dir',
  'ci-provider', 'ci-build', 'ci-commit', 'ci-branch', 'app-build'
] as const;

export const RUN_HELP = `
${bold('aira run')} — start a test run and wait for its verdict

  --project <id>         Project to run in (or AIRA_PROJECT_ID)
  --environment <id>     Environment to run against (or AIRA_ENVIRONMENT_ID)
  --suite <id>           Run a whole suite
  --test <id>            Run one test; repeat for several
  --browser <name>       chromium | firefox | webkit
  --headed               Run with a visible browser
  --parallelism <n>      Executions in flight at once
  --retries <n>          Retries for a failing execution
  --name <text>          Name the run
  --timeout <seconds>    Give up waiting (default 1800)
  --poll <seconds>       How often to check progress (default 3)
  --no-wait              Queue the run and exit without waiting

  --junit <path>         Write JUnit XML
  --json <path>          Write the machine-readable report
  --html <path>          Write the human-readable report
  --markdown <path>      Write a summary a pipeline can post on a pull request
  --report-dir <dir>     Write all four into a directory, in the CI artifact layout

  --ci-provider <name>   Record where this run came from
  --ci-build <id>        Build identifier
  --ci-commit <sha>      Commit under test
  --ci-branch <name>     Branch under test
  --app-build <ref>      The application build being tested

Exit status
  0 PASS                        5 INFRASTRUCTURE_ERROR
  1 TEST_FAILURE                6 SECURITY_POLICY_VIOLATION
  2 QUALITY_GATE_FAILURE        7 HUMAN_REVIEW_REQUIRED
  3 CONFIGURATION_ERROR         8 AIRA_INTERNAL_ERROR
  4 AUTHENTICATION_ERROR
`;

const TERMINAL = new Set(['passed', 'failed', 'cancelled', 'error', 'blocked', 'completed', 'timedOut']);

export async function runCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, RUN_FLAGS);

  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token'),
    projectId: flag(args, 'project')
  });
  const api = new ApiClient(context.apiUrl, context.token);

  if (!context.projectId) {
    throw usage('A project is required.', 'Pass --project <id>, or set AIRA_PROJECT_ID.');
  }

  const testCaseIds = flagAll(args, 'test');
  const suiteId = flag(args, 'suite');
  if (testCaseIds.length === 0 && !suiteId) {
    throw usage('Nothing to run.', 'Pass --suite <id>, or one or more --test <id>.');
  }

  const started = await api.post<RunSummary>('/api/v1/testruns', {
    projectId: context.projectId,
    testSuiteId: suiteId,
    testCaseIds: testCaseIds.length > 0 ? testCaseIds : undefined,
    // The environment carries the base URL, the allowed domains, the rate limit and the
    // production guard. Omitting it does not mean "no environment" — it means the run
    // silently falls back to the application's own URL and none of those controls apply,
    // which is why it is worth passing even when a project has only one.
    environmentId: environmentFlag(args),
    browser: browserFlag(args),
    headless: boolFlag(args, 'headed') ? false : undefined,
    parallelism: intFlag(args, 'parallelism'),
    maxRetries: intFlag(args, 'retries'),
    name: flag(args, 'name'),
    // 'cicd' is the platform's own name for this trigger; the shared union is what keeps
    // the two sides from drifting apart again.
    trigger: 'cicd' satisfies RunTrigger,
    ci: ciContext(args)
  });

  note(`${bold('Run queued')} ${started.name} ${dim(started.id)}`);

  if (boolFlag(args, 'no-wait')) {
    out(started.id);
    return ExitCode.Success;
  }

  const run = await waitForRun(api, started.id, {
    timeoutMs: (intFlag(args, 'timeout') ?? 1800) * 1000,
    pollMs: (intFlag(args, 'poll') ?? 3) * 1000
  });

  const report = await gatherReport(api, run.id, context.consoleUrl);
  const targets = reportTargets(args);
  if (targets.junit || targets.json || targets.html || targets.markdown) {
    note('');
    await writeReports(report, targets);
  }

  printSummary(report.run, report);

  // A run that never reached a verdict is not a pass, whatever the gate says about it.
  if (!['passed', 'failed', 'completed'].includes(run.status)) {
    note(red(`\nThe run ended as "${run.status}" rather than producing a verdict.`));
    return ExitCode.InfrastructureError;
  }

  return verdictExitCode(report);
}

/**
 * Turns a finished run into the status a pipeline branches on.
 *
 * The order matters. A failed test is reported as a test failure even when a gate also
 * blocked, because "six tests failed" is what someone needs to read first; a gate failure
 * is reserved for a run whose tests were within tolerance and which a rule stopped anyway.
 * REVIEW is its own code so a pipeline can choose to proceed on it.
 */
export function verdictExitCode(report: RunReport): ExitCodeValue {
  const gate = report.qualityGate;
  // Older platforms answer without an outcome; a boolean is all there is to go on.
  const outcome = gate.outcome ?? (gate.passed ? 'pass' : 'fail');

  const failed = report.executions.filter(execution =>
    ['failed', 'error', 'timedOut'].includes(execution.status)).length;

  if (failed > 0) return ExitCode.TestFailure;
  if (outcome === 'fail') return ExitCode.QualityGateFailure;
  if (outcome === 'review') return ExitCode.HumanReviewRequired;
  return ExitCode.Success;
}

/** Validated here rather than at the API, so a typo fails immediately and says what is valid. */
function browserFlag(args: ParsedArgs): BrowserType | undefined {
  const value = flag(args, 'browser');
  if (value === undefined) return undefined;
  if (!(BROWSER_TYPES as readonly string[]).includes(value)) {
    throw usage(`--browser expects one of ${BROWSER_TYPES.join(', ')}, got "${value}".`);
  }
  return value as BrowserType;
}

/**
 * Which environment to run against.
 *
 * Also read from the environment variable, because a pipeline usually sets it once for the
 * whole job rather than repeating it on every command. Validated as a UUID here so a typo
 * fails before a run is started rather than as a 404 halfway through.
 */
export function environmentFlag(args: ParsedArgs): string | undefined {
  const value = flag(args, 'environment') ?? process.env.AIRA_ENVIRONMENT_ID;
  if (value === undefined || value.trim() === '') return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())) {
    throw usage(`--environment expects an environment id, got "${value}".`,
      'List them with "aira environments".');
  }
  return value.trim();
}

export function ciContext(args: ParsedArgs): unknown {
  // The common CI variables are read automatically, so a pipeline usually passes nothing.
  const provider = flag(args, 'ci-provider')
    ?? (process.env.GITHUB_ACTIONS ? 'github' : undefined)
    ?? (process.env.TF_BUILD ? 'azure-devops' : undefined)
    ?? (process.env.GITLAB_CI ? 'gitlab' : undefined);

  const buildId = flag(args, 'ci-build') ?? process.env.GITHUB_RUN_ID ?? process.env.BUILD_BUILDID;
  const commitSha = flag(args, 'ci-commit') ?? process.env.GITHUB_SHA ?? process.env.BUILD_SOURCEVERSION;
  const branch = flag(args, 'ci-branch')
    ?? process.env.GITHUB_REF_NAME
    ?? process.env.BUILD_SOURCEBRANCHNAME;
  const applicationBuildRef = flag(args, 'app-build');

  if (!provider && !buildId && !commitSha && !branch && !applicationBuildRef) return undefined;
  return { provider, buildId, commitSha, branch, applicationBuildRef };
}

/**
 * Where the reports go.
 *
 * `--report-dir` produces the CI artifact layout: fixed names, so a pipeline can publish
 * the directory without knowing what is in it, and so the next pipeline that reads it does
 * not have to be told either.
 *
 *   junit.xml      the test result format every CI system already understands
 *   report.json    the whole run, for anything that wants to read it
 *   report.html    the run as a person reads it
 *   summary.md     a pull request comment
 */
export function reportTargets(args: ParsedArgs): {
  junit?: string; json?: string; html?: string; markdown?: string;
} {
  const dir = flag(args, 'report-dir');
  return {
    junit: flag(args, 'junit') ?? (dir ? `${dir}/junit.xml` : undefined),
    json: flag(args, 'json') ?? (dir ? `${dir}/report.json` : undefined),
    html: flag(args, 'html') ?? (dir ? `${dir}/report.html` : undefined),
    markdown: flag(args, 'markdown') ?? (dir ? `${dir}/summary.md` : undefined)
  };
}

export async function waitForRun(
  api: ApiClient,
  runId: string,
  options: { timeoutMs: number; pollMs: number }
): Promise<RunSummary> {
  const deadline = Date.now() + options.timeoutMs;
  let lastLine = '';

  for (;;) {
    const run = await api.get<RunSummary>(`/api/v1/testruns/${runId}`);

    const finished = run.passedCount + run.failedCount + run.skippedCount + run.blockedCount;
    const line = `  ${run.status} — ${finished}/${run.totalCount} finished`;
    if (line !== lastLine) { note(dim(line)); lastLine = line; }

    if (TERMINAL.has(run.status)) return run;

    if (Date.now() > deadline) {
      // The run is still going; saying so matters, because cancelling it is a choice the
      // person running the pipeline should make deliberately.
      throw new CliError(
        `The run did not finish within ${Math.round(options.timeoutMs / 1000)}s (last status: ${run.status}).`,
        ExitCode.InfrastructureError,
        `It is still running. Follow it with "aira status ${runId}", or stop it with "aira cancel ${runId}".`);
    }

    await new Promise(resolve => setTimeout(resolve, options.pollMs));
  }
}

export function printSummary(run: RunSummary, report: Awaited<ReturnType<typeof gatherReport>>): void {
  note('');
  for (const execution of report.executions) {
    const verdict = verdictOf(execution.status);
    const mark = verdict === 'passed' ? green('✓') : verdict === 'skipped' ? dim('–') : red('✗');
    const qualifier = qualification(execution.status) ? yellow(` (${execution.status})`) : '';
    note(`  ${mark} ${execution.reference} ${execution.name}${qualifier} ${dim(duration(execution.durationMs))}`);
    if (verdict !== 'passed' && execution.errorMessage) {
      note(`      ${dim(execution.errorMessage.split('\n')[0] ?? '')}`);
    }
  }

  note('');
  note(`  ${run.passedCount} passed · ${run.failedCount} failed · ${run.blockedCount} blocked `
    + `· ${run.healedCount} healed · ${run.flakyCount} flaky · ${duration(run.durationMs)}`);

  const gate = report.qualityGate;
  note('');
  note(gate.passed ? green(`  Quality gate passed. ${gate.summary}`) : red(`  Quality gate failed. ${gate.summary}`));
  for (const rule of gate.rules.filter(r => !r.passed)) {
    note(`    ${rule.isBlocking ? red('blocking') : yellow('warning')} ${rule.name}: ${rule.explanation}`);
  }
}
