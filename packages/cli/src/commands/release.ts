import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ApiClient } from '../api.js';
import { boolFlag, flag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, dim, green, note, out, red, yellow } from '../output.js';
import { renderComparison, type RunComparison, type ReleaseQualityReport } from '../reports/comparison.js';

export const RELEASE_FLAGS = [
  'project', 'run', 'previous', 'build', 'out', 'markdown', 'json', 'fail-on-new-failures'
] as const;

export const RELEASE_HELP = `
${bold('qanxt release')} — what changed, rather than what is broken

  ${bold('qanxt release compare --run <id>')}
      This run against the one before it: what newly fails, what was fixed,
      what was already failing, what ran that did not run before.

  ${bold('qanxt release compare --run <id> --previous <id>')}
      Against a run you choose.

  ${bold('qanxt release quality --build v2.4.1')}
      Every run that tested one application build, and what it says about
      shipping it — including tests that both passed and failed within it.

  --project <id>            Project to work in (or QANXT_PROJECT_ID)
  --run <id>                The run to compare
  --previous <id>           Compare against this one instead of the last
  --build <ref>             For "quality": the build, as passed to --app-build
  --markdown <path>         Write the report as a pull request comment
  --out <path>              Write the machine-readable report
  --json                    Print the machine-readable report
  --fail-on-new-failures    Exit 1 when a test that used to pass now fails

${bold('Why this is a separate question')}

  A single run answers "is it broken now". A release decision needs "what
  changed". Twelve failing tests are not a reason to stop a release if the same
  twelve failed last week and somebody already knows why; one test that used to
  pass is.

  --fail-on-new-failures is the one worth putting in a pipeline. It ignores
  failures you already knew about and stops only on a regression.

Exit status
  0 PASS                        3 CONFIGURATION_ERROR
  1 TEST_FAILURE                5 INFRASTRUCTURE_ERROR
`;

export async function releaseCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, RELEASE_FLAGS);

  const action = args.positionals[0] ?? 'compare';
  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token'),
    projectId: flag(args, 'project')
  });
  const api = new ApiClient(context.apiUrl, context.token);

  switch (action) {
    case 'compare': return compare(api, args);
    case 'quality': return quality(api, args, context.projectId);
    default:
      throw usage(`Unknown action "${action}".`, 'Use compare or quality.');
  }
}

async function compare(api: ApiClient, args: ParsedArgs): Promise<number> {
  const runId = flag(args, 'run');
  if (!runId) throw usage('A run is required.', 'Pass --run <id>.');

  const previous = flag(args, 'previous');
  const comparison = await api.get<RunComparison>(
    `/api/v1/release/compare?run=${runId}${previous ? `&previous=${previous}` : ''}`);

  await emit(args, comparison, () => renderComparison(comparison));

  if (!boolFlag(args, 'json')) printComparison(comparison);

  // The one reason to put this in a pipeline: stop on a regression, not on a failure
  // somebody already knows about.
  if (boolFlag(args, 'fail-on-new-failures') && comparison.counts.newlyFailing > 0) {
    note(red(`\n${comparison.counts.newlyFailing} test(s) that used to pass now fail.`));
    return ExitCode.TestFailure;
  }
  return ExitCode.Success;
}

async function quality(api: ApiClient, args: ParsedArgs, projectId?: string): Promise<number> {
  if (!projectId) throw usage('A project is required.', 'Pass --project <id>, or set QANXT_PROJECT_ID.');

  const build = flag(args, 'build');
  if (!build) {
    throw usage('A build is required.',
      'Pass --build <ref> — the value a pipeline passed to "qanxt run --app-build".');
  }

  const report = await api.get<ReleaseQualityReport>(
    `/api/v1/release/quality?projectId=${projectId}&build=${encodeURIComponent(build)}`);

  await emit(args, report, () => renderRelease(report));

  if (boolFlag(args, 'json')) return ExitCode.Success;

  out(bold(`Build ${report.buildRef}`));
  out('');
  out(report.summary);
  out('');
  out(`${report.runCount} run(s) · ${report.testsCovered} test(s) covered · `
    + `${report.passRatePercent}% pass rate in the most recent run`);

  if (report.outstandingFailures.length > 0) {
    out('');
    out(red(`Failing now (${report.outstandingFailures.length})`));
    for (const test of report.outstandingFailures) out(`  ${test.reference} ${test.name}`);
  }

  if (report.unstable.length > 0) {
    out('');
    out(yellow(`Both passed and failed within this build (${report.unstable.length})`));
    for (const test of report.unstable) out(`  ${test.reference} ${test.name}`);
    out(dim('  Which result you get depends on which run you look at.'));
  }

  if (report.comparison) printComparison(report.comparison);

  if (boolFlag(args, 'fail-on-new-failures')
      && (report.comparison?.counts.newlyFailing ?? 0) > 0) {
    return ExitCode.TestFailure;
  }
  return ExitCode.Success;
}

function printComparison(comparison: RunComparison): void {
  out('');
  out(bold('Against ') + comparison.previous.name + dim(` ${comparison.previous.id}`));
  out(comparison.summary);

  const show = (label: string, movement: string, colour: (text: string) => string) => {
    const tests = comparison.tests.filter(test => test.movement === movement);
    if (tests.length === 0) return;
    out('');
    out(colour(`${label} (${tests.length})`));
    for (const test of tests.slice(0, 30)) {
      const diagnosis = test.failureCategory ? dim(` — ${test.failureCategory}`) : '';
      out(`  ${test.reference} ${test.name}${diagnosis}`);
    }
    if (tests.length > 30) out(dim(`  …and ${tests.length - 30} more.`));
  };

  // Newly failing first: it is the list a release decision is made from.
  show('Newly failing', 'newlyFailing', red);
  show('Fixed', 'fixed', green);
  show('Still failing', 'stillFailing', yellow);
  show('Ran that did not run before', 'added', dim);
  show('Ran before, not this time', 'removed', yellow);
}

function renderRelease(report: ReleaseQualityReport): string {
  const lines = [
    `### Build \`${report.buildRef}\``,
    '',
    report.summary,
    '',
    `**${report.passRatePercent}% pass rate** · ${report.runCount} run(s) · `
      + `${report.testsCovered} test(s) covered`,
    ''
  ];

  if (report.outstandingFailures.length > 0) {
    lines.push(`#### Failing now`, '');
    for (const test of report.outstandingFailures) {
      lines.push(`- **${test.reference}** ${test.name}`);
    }
    lines.push('');
  }

  if (report.unstable.length > 0) {
    lines.push(`#### Both passed and failed within this build`, '');
    lines.push('Which result you get depends on which run you look at.', '');
    for (const test of report.unstable) lines.push(`- **${test.reference}** ${test.name}`);
    lines.push('');
  }

  if (report.breakingContractChanges > 0) {
    lines.push(`#### API contract`, '',
      `${report.breakingContractChanges} breaking and `
      + `${report.potentiallyBreakingContractChanges} potentially breaking change(s). `
      + 'Callers of those endpoints may already be broken.', '');
  }

  if (report.comparison) lines.push(renderComparison(report.comparison));
  return lines.join('\n');
}

/** Writes whatever was asked for, and says where. */
async function emit(args: ParsedArgs, document: unknown, markdown: () => string): Promise<void> {
  if (boolFlag(args, 'json')) out(JSON.stringify(document, null, 2));

  const jsonPath = flag(args, 'out');
  if (jsonPath) {
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`);
    note(dim(`Wrote ${jsonPath}`));
  }

  const markdownPath = flag(args, 'markdown');
  if (markdownPath) {
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, `${markdown()}\n`);
    note(dim(`Wrote ${markdownPath}`));
  }
}
