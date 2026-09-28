import { readFile, writeFile } from 'node:fs/promises';
import { ApiClient } from '../api.js';
import { boolFlag, flag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, dim, green, note, out, yellow } from '../output.js';

export const TEST_DATA_FLAGS = [
  'project', 'environment', 'file', 'out', 'name', 'json'
] as const;

export const TEST_DATA_HELP = `
${bold('qanxt test-data')} — the named data a test case uses

  ${bold('qanxt test-data list')}
      Every data set in the project, with its fields.

  ${bold('qanxt test-data show <id>')}
      One data set.

  ${bold('qanxt test-data preview <id>')}
      What a run would actually use, without starting one. Sensitive fields
      are masked.

  ${bold('qanxt test-data import --file data.json')}
      Creates a data set from a file. See the shape below.

  ${bold('qanxt test-data export <id> --out data.json')}
      Writes one out, so it can live beside the tests in version control.

  ${bold('qanxt test-data remove <id>')}
      Deletes it. Refused while a test case still uses it.

  ${bold('qanxt test-data types')}
      The generator types a field may ask for.

  --project <id>         Project to work in (or QANXT_PROJECT_ID)
  --environment <id>     Tie this data set to one environment
  --file <path>          For "import": the data set to read
  --out <path>           For "export": where to write it
  --name <text>          For "import": override the name in the file
  --json                 Machine-readable output

${bold('The file')}

  {
    "name": "Checkout customer",
    "description": "One customer, the same every run",
    "fields": [
      { "key": "customerEmail", "kind": "seededRandom",
        "generatorJson": "{\\"type\\":\\"email\\"}", "seed": 42 },
      { "key": "orderReference", "kind": "static", "value": "QANXT-TEST-001" },
      { "key": "password", "kind": "secretReference", "value": "\${secret:app_password}" }
    ]
  }

${bold('Kinds')}

  static           a literal value
  generated        a value from the generator, different every run
  seededRandom     a value from the generator, the same every run — needs a seed
  secretReference  names a secret in the environment's storage; never holds one

${bold('Why a seed')}

  A seeded field produces the same value on every run, so a failure can be
  reproduced. Without one, a test that fails on a boundary value passes when you
  re-run it and the investigation ends in "could not reproduce".

${bold('Credentials')}

  A field whose name looks like a credential — password, apiKey, clientSecret,
  pin — must be a secretReference. A data set is readable by anyone who can read
  the project and is exported in plain text by this command, so a literal
  password in one is a password in a repository.
`;

type Kind = 'static' | 'generated' | 'random' | 'seededRandom' | 'secretReference' | 'environmentSpecific';

interface Field {
  id?: string;
  key: string;
  kind: Kind;
  value?: string | null;
  generatorJson?: string | null;
  seed?: number | null;
  isSensitive?: boolean;
}

interface DataSet {
  id: string;
  projectId: string;
  name: string;
  description: string;
  environmentId?: string | null;
  fields: Field[];
}

export async function testDataCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, TEST_DATA_FLAGS);

  const action = args.positionals[0] ?? 'list';
  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token'),
    projectId: flag(args, 'project')
  });
  const api = new ApiClient(context.apiUrl, context.token);

  switch (action) {
    case 'list': return list(api, args, context.projectId);
    case 'show': return show(api, args);
    case 'preview': return preview(api, args);
    case 'import': return importSet(api, args, context.projectId);
    case 'export': return exportSet(api, args);
    case 'remove': return remove(api, args);
    case 'types': return types(api, args);
    default:
      throw usage(`Unknown action "${action}".`,
        'Use list, show, preview, import, export, remove or types.');
  }
}

async function list(api: ApiClient, args: ParsedArgs, projectId?: string): Promise<number> {
  if (!projectId) throw usage('A project is required.', 'Pass --project <id>, or set QANXT_PROJECT_ID.');

  const sets = await api.get<DataSet[]>(`/api/v1/test-data?projectId=${projectId}`);
  if (boolFlag(args, 'json')) { out(JSON.stringify(sets, null, 2)); return ExitCode.Success; }

  if (sets.length === 0) {
    note(dim('No data sets. Create one with "qanxt test-data import --file data.json".'));
    return ExitCode.Success;
  }

  for (const set of sets) {
    out(`${bold(set.name)} ${dim(set.id)}`);
    if (set.description) out(dim(`    ${set.description}`));
    for (const field of set.fields) out(`    ${describe(field)}`);
  }
  return ExitCode.Success;
}

async function show(api: ApiClient, args: ParsedArgs): Promise<number> {
  const set = await api.get<DataSet>(`/api/v1/test-data/${requireId(args, 'show')}`);
  if (boolFlag(args, 'json')) { out(JSON.stringify(set, null, 2)); return ExitCode.Success; }

  out(`${bold(set.name)} ${dim(set.id)}`);
  if (set.description) out(dim(set.description));
  for (const field of set.fields) out(`  ${describe(field)}`);
  return ExitCode.Success;
}

async function preview(api: ApiClient, args: ParsedArgs): Promise<number> {
  const resolved = await api.get<{ key: string; kind: Kind; value: string; isSensitive: boolean }[]>(
    `/api/v1/test-data/${requireId(args, 'preview')}/preview`);

  if (boolFlag(args, 'json')) { out(JSON.stringify(resolved, null, 2)); return ExitCode.Success; }

  for (const field of resolved) {
    out(`${field.key.padEnd(24)} ${field.isSensitive ? yellow(field.value) : field.value}`);
  }
  note('');
  note(dim('A seeded field shows the value every run will use. Sensitive fields are masked.'));
  return ExitCode.Success;
}

async function importSet(api: ApiClient, args: ParsedArgs, projectId?: string): Promise<number> {
  if (!projectId) throw usage('A project is required.', 'Pass --project <id>, or set QANXT_PROJECT_ID.');

  const path = flag(args, 'file');
  if (!path) throw usage('A file is required.', 'Pass --file data.json.');

  let parsed: { name?: string; description?: string; fields?: Field[] };
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw usage(`${path} could not be read as JSON.`, String(error));
  }

  const created = await api.post<DataSet>('/api/v1/test-data', {
    projectId,
    name: flag(args, 'name') ?? parsed.name,
    description: parsed.description,
    environmentId: flag(args, 'environment') || undefined,
    fields: parsed.fields
  });

  if (boolFlag(args, 'json')) { out(JSON.stringify(created, null, 2)); return ExitCode.Success; }

  note(`${green('Created')} ${bold(created.name)} ${dim(created.id)}`);
  note(dim(`${created.fields.length} field(s). Preview them with "qanxt test-data preview ${created.id}".`));
  return ExitCode.Success;
}

async function exportSet(api: ApiClient, args: ParsedArgs): Promise<number> {
  const set = await api.get<DataSet>(`/api/v1/test-data/${requireId(args, 'export')}`);

  // The id and the project are left out: an exported file is meant to be imported into
  // another project, and carrying the original's identifiers only invites confusion.
  const document = {
    name: set.name,
    description: set.description,
    fields: set.fields.map(({ id, isSensitive, ...field }) => field)
  };

  const path = flag(args, 'out');
  if (!path) { out(JSON.stringify(document, null, 2)); return ExitCode.Success; }

  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
  note(`${green('Wrote')} ${path}`);

  // Said every time, because the file is about to be committed somewhere.
  const references = set.fields.filter(field => field.kind === 'secretReference').length;
  note(dim(references > 0
    ? `${references} field(s) reference a secret by name. No secret values are in this file.`
    : 'No secrets are in this file.'));
  return ExitCode.Success;
}

async function remove(api: ApiClient, args: ParsedArgs): Promise<number> {
  const id = requireId(args, 'remove');
  await api.delete(`/api/v1/test-data/${id}`);
  note(`${green('Removed')} ${dim(id)}`);
  return ExitCode.Success;
}

async function types(api: ApiClient, args: ParsedArgs): Promise<number> {
  const available = await api.get<string[]>('/api/v1/test-data/generator-types');
  if (boolFlag(args, 'json')) { out(JSON.stringify(available, null, 2)); return ExitCode.Success; }
  for (const type of available) out(type);
  return ExitCode.Success;
}

function describe(field: Field): string {
  const kind = dim(`[${field.kind}]`);
  if (field.kind === 'secretReference') return `${field.key.padEnd(24)} ${kind} ${yellow(field.value ?? '')}`;
  if (field.seed !== null && field.seed !== undefined) {
    return `${field.key.padEnd(24)} ${kind} ${dim(`seed ${field.seed}`)}`;
  }
  return `${field.key.padEnd(24)} ${kind} ${field.value ?? dim('generated')}`;
}

function requireId(args: ParsedArgs, action: string): string {
  const id = args.positionals[1];
  if (!id) throw usage(`"${action}" needs a data set id.`, 'List them with "qanxt test-data list".');
  return id;
}
