import { ApiClient } from '../api.js';
import { boolFlag, flag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode } from '../exit-codes.js';
import { bold, dim, note, out } from '../output.js';

export const LIST_FLAGS = ['project', 'json'] as const;

export const LIST_HELP = `
${bold('aira projects')} — the projects this account can see
${bold('aira apps')} — the applications in a project
${bold('aira environments')} — a project's environments

  --project <id>         Project to list within (or AIRA_PROJECT_ID)
  --json                 Emit the list on stdout as JSON

These exist so a pipeline can resolve a name to an id without a browser: the ids that
"aira run --project" and "--suite" take are not guessable, and a pipeline should not have
them pasted in by hand.
`;

interface ProjectRow { id: string; name: string; key: string }
interface AppRow { id: string; name: string; baseUrl: string }
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
