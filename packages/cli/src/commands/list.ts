import { ApiClient } from '../api.js';
import { boolFlag, flag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode } from '../exit-codes.js';
import { bold, dim, note, out } from '../output.js';

export const LIST_FLAGS = ['project', 'json'] as const;

export const LIST_HELP = `
${bold('qanxt projects')} — the projects this account can see
${bold('qanxt apps')} — the applications in a project
${bold('qanxt environments')} — a project's environments
${bold('qanxt suites')} — the test suites in a project, and what each holds
${bold('qanxt tests')} — the test cases in a project, with their references

  --project <id>         Project to list within (or QANXT_PROJECT_ID)
  --json                 Emit the list on stdout as JSON

These exist so a pipeline can resolve a name to an id without a browser: the ids that
"qanxt run --project" and "--suite" take are not guessable, and a pipeline should not have
them pasted in by hand.
`;

interface ProjectRow { id: string; name: string; key: string }
interface AppRow { id: string; name: string; baseUrl: string }
interface SuiteRow { id: string; name: string; caseCount?: number; enabledCaseCount?: number }
interface TestRow { id: string; reference: string; name: string; suiteName?: string; isEnabled?: boolean }

interface EnvironmentRow {
  id: string; name: string; key: string; kind: string; baseUrl: string;
  isProduction: boolean; productionTestingAuthorized: boolean; isEnabled: boolean;
}

/** Prints rows as an aligned table, or as JSON when a machine is reading. */
async function listing<T extends Record<string, unknown>>(
  args: ParsedArgs, path: string, columns: ReadonlyArray<[string, (row: T) => string]>,
  empty: string
): Promise<number> {
  rejectUnknownFlags(args, LIST_FLAGS);

  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token'),
    projectId: flag(args, 'project')
  });
  const api = new ApiClient(context.apiUrl, context.token);
  const rows = await api.get<T[]>(path.replace('{projectId}', context.projectId ?? ''));

  if (boolFlag(args, 'json')) { out(JSON.stringify(rows, null, 2)); return ExitCode.Success; }

  if (rows.length === 0) { note(dim(empty)); return ExitCode.Success; }

  const widths = columns.map(([header, read]) =>
    Math.max(header.length, ...rows.map(row => read(row).length)));

  note(bold(columns.map(([header], index) => header.padEnd(widths[index]!)).join('  ')));
  for (const row of rows) {
    out(columns.map(([, read], index) => read(row).padEnd(widths[index]!)).join('  ').trimEnd());
  }
  return ExitCode.Success;
}

export const projectsCommand = (args: ParsedArgs): Promise<number> =>
  listing<ProjectRow & Record<string, unknown>>(args, '/api/v1/projects', [
    ['KEY', row => row.key],
    ['NAME', row => row.name],
    ['ID', row => row.id]
  ], 'No projects yet. Create one in the console, or with POST /api/v1/projects.');

export const appsCommand = (args: ParsedArgs): Promise<number> =>
  listing<AppRow & Record<string, unknown>>(args, '/api/v1/applications?projectId={projectId}', [
    ['NAME', row => row.name],
    ['BASE URL', row => row.baseUrl],
    ['ID', row => row.id]
  ], 'No applications in this project yet.');

export const environmentsCommand = (args: ParsedArgs): Promise<number> =>
  listing<EnvironmentRow & Record<string, unknown>>(args, '/api/v1/environments?projectId={projectId}', [
    ['KEY', row => row.key],
    ['KIND', row => row.kind],
    ['BASE URL', row => row.baseUrl],
    // Production shows its authorization state, because "configured" and "allowed to be
    // tested" are different things and only one of them is safe.
    ['TESTING', row => row.isProduction
      ? (row.productionTestingAuthorized ? 'authorized' : 'REFUSED (production)')
      : (row.isEnabled ? 'allowed' : 'disabled')],
    ['ID', row => row.id]
  ], 'No environments configured for this project yet.');

/**
 * The two listings that make "qanxt run" usable from a pipeline.
 *
 * run takes --suite or --test and nothing listed either, so the only way to find an id was
 * to open the console and copy a UUID — which is exactly what the help above says a pipeline
 * should not have to do. The console's "Run all" had no command-line equivalent at all.
 */
export const suitesCommand = (args: ParsedArgs): Promise<number> =>
  listing<SuiteRow & Record<string, unknown>>(args, '/api/v1/test-suites?projectId={projectId}', [
    ['NAME', row => row.name],
    // Enabled against total, because only the enabled ones will run and a suite of 30 with
    // 2 enabled is not a suite of 30.
    ['TESTS', row => `${row.enabledCaseCount ?? 0}/${row.caseCount ?? 0}`],
    ['ID', row => row.id]
  ], 'No test suites in this project yet. Generate some, or import a recorded journey.');

export const testsCommand = (args: ParsedArgs): Promise<number> =>
  listing<TestRow & Record<string, unknown>>(args, '/api/v1/testcases?projectId={projectId}', [
    ['REF', row => row.reference],
    ['NAME', row => row.name],
    ['SUITE', row => row.suiteName ?? ''],
    // Whether it would actually run, because a disabled test in the list is otherwise
    // indistinguishable from one that will execute.
    ['ENABLED', row => row.isEnabled === false ? 'no' : 'yes'],
    ['ID', row => row.id]
  ], 'No test cases in this project yet.');
