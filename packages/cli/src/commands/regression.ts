import { execFile } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { RunTrigger } from '@aira/shared-types';
import { ApiClient } from '../api.js';
import { boolFlag, flag, flagAll, intFlag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, dim, green, note, out, red, yellow } from '../output.js';
import { gatherReport, writeReports } from '../report-gather.js';
import type { RunSummary } from '../types.js';
import { ciContext, printSummary, reportTargets, verdictExitCode, waitForRun } from './run.js';

const run = promisify(execFile);

export const REGRESSION_FLAGS = [
  'project', 'app', 'since', 'changed', 'changed-file', 'mode', 'max', 'min-score',
  'include-tag', 'exclude-tag', 'name', 'timeout', 'poll', 'parallelism', 'retries',
  'junit', 'json', 'html', 'markdown', 'report-dir', 'selection-out', 'explain', 'dry-run',
  'ci-provider', 'ci-build', 'ci-commit', 'ci-branch', 'app-build'
] as const;

export const REGRESSION_HELP = `
${bold('aira regression')} — run the tests a change needs, and say why

  ${bold('aira regression run --since origin/main')}
      Works out what changed, selects the tests that change reaches, runs them
      and waits for the verdict.

  ${bold('aira regression select --since HEAD~1 --explain')}
      The selection only: what would run, what would not, and the reasoning for
      each. Nothing is executed.

  ${bold('aira regression impact --since origin/main')}
      What the changed files were found to affect, and which of those mappings a
      rule declared rather than AIRA inferring.

  --project <id>         Project to work in (or AIRA_PROJECT_ID)
  --app <id>             Restrict to one application
  --since <ref>          Compare against this git ref to find changed files
  --changed <path>       A changed path; repeat for several (instead of --since)
  --changed-file <path>  Read changed paths from a file, one per line
  --mode <mode>          impacted (default) | smoke | full
  --max <n>              Run at most n tests, highest-scoring first
  --min-score <n>        Leave out tests scoring below this (default 40)
  --include-tag <tag>    Only consider tests with this tag; repeat for several
  --exclude-tag <tag>    Never consider tests with this tag
  --explain              Print every test's score, its components and its reasons
  --dry-run              For "run": select and report, but execute nothing
  --selection-out <path> Write the selection as JSON, for the pipeline's artifacts

  --name <text>          Name the run
  --timeout <seconds>    Give up waiting (default 1800)
  --junit/--json/--html/--report-dir   As "aira run"

${bold('What the score means')}

  impact     40   whether the change reaches this test at all
  risk       20   what it costs to be wrong about this area
  history    20   recent failures and instability — a test that has been failing
                  is worth running again
  staleness  10   how long since it last ran
  always     10   the tests this project runs whatever changed

  Nothing here is learned or tuned. A selector whose weights drift on its own
  cannot be reproduced, and a release decision that cannot be reproduced is not
  a decision.

${bold('When it cannot tell')}

  A change AIRA cannot map to anything runs the whole suite, loudly. Returning
  no tests would read as a pass, and a narrowed run that skipped the test which
  would have caught the defect is the failure this command exists to avoid.

Exit status is the same contract as "aira run": 0 PASS, 1 TEST_FAILURE,
2 QUALITY_GATE_FAILURE, 7 HUMAN_REVIEW_REQUIRED, 3 CONFIGURATION_ERROR.
`;

interface ScoreComponent { name: string; points: number; maximum: number; reason: string }

interface ScoredTest {
  testCaseId: string;
  reference: string;
  name: string;
  kind: string;
  priority: string;
  risk: string;
  score: number;
  components: ScoreComponent[];
  reasons: string[];
  isImpacted: boolean;
}

interface PathImpact {
  path: string;
  kind: string;
  value: string;
  isDeclared: boolean;
  reason: string;
}

interface ChangeImpactResult {
  changedPathCount: number;
  matchedPathCount: number;
  unmatchedPaths: string[];
  affectedRoutes: string[];
  affectedApiPaths: string[];
  affectedTags: string[];
  affectedTestReferences: string[];
  affectsEverything: boolean;
  impacts: PathImpact[];
  notes: string[];
}

interface RegressionSelection {
  mode: string;
  requestedMode: string;
  totalCandidates: number;
  selectedCount: number;
  minScore: number;
  impact: ChangeImpactResult | null;
  selected: ScoredTest[];
  excluded: ScoredTest[];
  fellBackToFull: boolean;
  notes: string[];
}

export async function regressionCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, REGRESSION_FLAGS);

  const sub = args.positionals[0] ?? 'run';
  if (sub !== 'run' && sub !== 'select' && sub !== 'impact') {
    throw usage(`"aira regression ${sub}" is not a subcommand.`, 'Use "run", "select" or "impact".');
  }

  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token'),
    projectId: flag(args, 'project')
  });
  const api = new ApiClient(context.apiUrl, context.token);

  if (!context.projectId) {
    throw usage('A project is required.', 'Pass --project <id>, or set AIRA_PROJECT_ID.');
  }

  const changedPaths = await resolveChangedPaths(args);

  if (sub === 'impact') return showImpact(api, context.projectId, changedPaths, args);

  const selection = await api.post<RegressionSelection>('/api/v1/regression/select', {
    projectId: context.projectId,
    applicationId: flag(args, 'app'),
    changedPaths,
    mode: modeFlag(args),
    maxTests: intFlag(args, 'max'),
    minScore: intFlag(args, 'min-score'),
    includeTags: flagAll(args, 'include-tag'),
    excludeTags: flagAll(args, 'exclude-tag'),
    commitSha: flag(args, 'ci-commit'),
    branch: flag(args, 'ci-branch')
  });

  printSelection(selection, args);
  await writeSelection(selection, args);

  if (sub === 'select' || boolFlag(args, 'dry-run')) return ExitCode.Success;

  return executeSelection(api, context, selection, args);
}

/**
 * Works out which files changed.
 *
 * `--since` runs git, because a pipeline already has the repository and asking it is more
 * reliable than asking a person to paste a list. The explicit forms exist for the pipelines
 * that compute the list some other way, and for the ones where AIRA runs somewhere the
 * repository is not.
 */
async function resolveChangedPaths(args: ParsedArgs): Promise<string[]> {
  const explicit = flagAll(args, 'changed');
  const file = flag(args, 'changed-file');
  const since = flag(args, 'since');

  if (explicit.length > 0) return explicit;

  if (file) {
    const { readFile } = await import('node:fs/promises');
    try {
      const contents = await readFile(file, 'utf8');
      return contents.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    } catch (error) {
      throw usage(`Could not read ${file}.`, String(error));
    }
  }

  if (!since) return [];

  try {
    const { stdout } = await run('git', ['diff', '--name-only', `${since}...HEAD`], {
      maxBuffer: 16 * 1024 * 1024
    });
    const paths = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    if (paths.length === 0) {
      // Not an error, and not silence either: a pipeline that narrows on an empty diff
      // should see why it then ran everything.
      note(dim(`No files differ from ${since}.`));
    }
    return paths;
  } catch (error) {
    throw usage(
      `Could not work out what changed since ${since}.`,
      `${String(error)}. Pass --changed <path> or --changed-file <path> instead, or check `
      + 'that the pipeline checked out enough history (a shallow clone has none).');
  }
}

function modeFlag(args: ParsedArgs): string {
  const mode = flag(args, 'mode') ?? 'impacted';
  if (!['impacted', 'smoke', 'full'].includes(mode)) {
    throw usage(`--mode expects impacted, smoke or full, got "${mode}".`);
  }
  return mode;
}

async function showImpact(
  api: ApiClient, projectId: string, changedPaths: string[], args: ParsedArgs
): Promise<number> {
  const impact = await api.post<ChangeImpactResult>('/api/v1/regression/impact', {
    projectId,
    applicationId: flag(args, 'app'),
    changedPaths,
    commitSha: flag(args, 'ci-commit'),
    branch: flag(args, 'ci-branch')
  });

  if (boolFlag(args, 'json')) { out(JSON.stringify(impact, null, 2)); return ExitCode.Success; }

  note(`${bold(String(impact.changedPathCount))} changed path(s), `
    + `${impact.matchedPathCount} mapped to something the application does.`);
  note('');

  if (impact.affectsEverything) {
    note(yellow('  A rule marks this change as affecting everything.'));
  }

  for (const [label, values] of [
    ['Routes', impact.affectedRoutes],
    ['Endpoints', impact.affectedApiPaths],
    ['Tags', impact.affectedTags],
    ['Tests', impact.affectedTestReferences]
  ] as const) {
    if (values.length > 0) note(`  ${bold(label)}: ${values.join(', ')}`);
  }

  const inferred = impact.impacts.filter(entry => !entry.isDeclared);
  if (inferred.length > 0) {
    note('');
    note(yellow(`  ${inferred.length} mapping(s) were inferred rather than declared:`));
    for (const entry of inferred.slice(0, 10)) note(`    ${dim(entry.reason)}`);
  }

  if (impact.unmatchedPaths.length > 0) {
    note('');
    note(yellow(`  ${impact.unmatchedPaths.length} path(s) matched nothing:`));
    for (const path of impact.unmatchedPaths.slice(0, 20)) note(`    ${dim(path)}`);
  }

  note('');
  for (const advisory of impact.notes) note(`  ${dim(advisory)}`);
  return ExitCode.Success;
}

function printSelection(selection: RegressionSelection, args: ParsedArgs): void {
  if (boolFlag(args, 'json')) { out(JSON.stringify(selection, null, 2)); return; }

  if (selection.fellBackToFull) {
    // Loud on purpose. This is the case where a narrowed run would have been a guess.
    note(yellow(`  The whole suite was selected: ${selection.notes[0] ?? 'the change could not be mapped.'}`));
    note('');
  }

  for (const test of selection.selected) {
    const mark = test.isImpacted ? green('→') : dim('·');
    note(`  ${mark} ${bold(test.reference)} ${test.name} ${dim(`${test.score}`)}`);
    if (boolFlag(args, 'explain')) {
      for (const component of test.components) {
        const shown = component.points > 0 ? `${component.points}/${component.maximum}` : dim('—');
        note(`        ${component.name.padEnd(10)} ${String(shown).padStart(8)}  ${dim(component.reason)}`);
      }
    } else {
      for (const reason of test.reasons.slice(0, 2)) note(`        ${dim(reason)}`);
    }
  }

  if (boolFlag(args, 'explain') && selection.excluded.length > 0) {
    note('');
    note(dim(`  Not selected (${selection.excluded.length}):`));
    for (const test of selection.excluded.slice(0, 40)) {
      note(`    ${dim(`${test.reference} ${test.name} — ${test.score}, below ${selection.minScore}`)}`);
    }
  }

  note('');
  note(`  ${bold(String(selection.selectedCount))} of ${selection.totalCandidates} test(s) selected `
    + `(mode ${selection.mode}${selection.mode === selection.requestedMode ? '' : `, requested ${selection.requestedMode}`}).`);
  for (const advisory of selection.notes) note(`  ${dim(advisory)}`);
}

/** Writes the selection where a pipeline can keep it as an artifact. */
async function writeSelection(selection: RegressionSelection, args: ParsedArgs): Promise<void> {
  const target = flag(args, 'selection-out')
    ?? (flag(args, 'report-dir') ? `${flag(args, 'report-dir')}/regression-selection.json` : undefined);
  if (!target) return;

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(selection, null, 2), 'utf8');
  note(dim(`  Selection written to ${target}`));
}

async function executeSelection(
  api: ApiClient,
  context: { projectId?: string; consoleUrl?: string },
  selection: RegressionSelection,
  args: ParsedArgs
): Promise<number> {
  const testCaseIds = selection.selected.map(test => test.testCaseId);
  if (testCaseIds.length === 0) {
    // The service refuses to return an empty selection, so this should be unreachable —
    // and if it ever is reached, "no tests" must not be reported as success.
    note(red('The selection contained no tests, so nothing was run.'));
    return ExitCode.ConfigurationError;
  }

  note('');
  const started = await api.post<RunSummary>('/api/v1/testruns', {
    projectId: context.projectId,
    testCaseIds,
    name: flag(args, 'name') ?? `Regression (${selection.mode})`,
    parallelism: intFlag(args, 'parallelism'),
    maxRetries: intFlag(args, 'retries'),
    trigger: 'cicd' satisfies RunTrigger,
    ci: ciContext(args)
  });

  note(`${bold('Run queued')} ${started.name} ${dim(started.id)}`);

  const finished = await waitForRun(api, started.id, {
    timeoutMs: (intFlag(args, 'timeout') ?? 1800) * 1000,
    pollMs: (intFlag(args, 'poll') ?? 3) * 1000
  });

  const report = await gatherReport(api, finished.id, context.consoleUrl);
  const targets = reportTargets(args);
  if (targets.junit || targets.json || targets.html || targets.markdown) {
    note('');
    await writeReports(report, targets);
  }

  printSummary(report.run, report);

  if (!['passed', 'failed', 'completed'].includes(finished.status)) {
    note(red(`\nThe run ended as "${finished.status}" rather than producing a verdict.`));
    return ExitCode.InfrastructureError;
  }

  return verdictExitCode(report);
}
