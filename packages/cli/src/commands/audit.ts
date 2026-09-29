import { ApiClient } from '../api.js';
import { boolFlag, flag, intFlag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, dim, humanize, note, out, red } from '../output.js';

export const AUDIT_FLAGS = [
  'project', 'action', 'entity-type', 'entity-id', 'correlation', 'user',
  'failed', 'since', 'until', 'limit', 'offset', 'json'
] as const;

export const AUDIT_HELP = `
${bold('qanxt audit')} — who did what, and whether it worked

  ${bold('qanxt audit list')}
      The most recent records for your organization, newest first.

  ${bold('qanxt audit list --failed')}
      Only the actions that did not succeed. This is the query a security
      review actually runs: a run of failed sign-ins is the thing you want
      to find, and it is invisible in a list that shows successes too.

  ${bold('qanxt audit list --action scheduleFired --limit 100')}
      One kind of action. "qanxt audit actions" lists the names.

  ${bold('qanxt audit trace <correlation-id>')}
      Everything one request did. The correlation id is on the response
      header of every API call, in the problem body of every failure the
      CLI prints, and on every log line the API and the worker write.

  ${bold('qanxt audit actions')}
      The action names this build can record.

  --project <id>          Restrict to one project
  --action <name>         One action, e.g. qualityGateChanged
  --entity-type <name>    e.g. Schedule, Project, Integration
  --entity-id <id>        One thing's whole history
  --correlation <id>      Same as "trace", as a filter
  --user <email>          Everything one person did (exact match)
  --failed                Only actions that did not succeed
  --since <timestamp>     ISO-8601, e.g. 2026-09-01T00:00:00Z
  --until <timestamp>     ISO-8601
  --limit <n>             Up to 200 per page (default 50)
  --offset <n>            Skip this many
  --json                  Machine-readable output

${bold('What the trail does and does not cover')}

  It records security- and governance-relevant actions: sign-ins and failed
  sign-ins, role changes, integration and secret configuration, quality gate
  changes, healing approvals and rejections, run starts, and every schedule
  change, firing and automatic disabling.

  It is not a log. It says who asked for something and whether it succeeded,
  not what the application did — that is evidence — and not what the platform
  was thinking, which is the log. Reading ${bold('audit:read')} is a separate
  permission from reading results, because the trail names people.

  Nothing can change it. There is no write path here, and the database role
  the platform runs as holds INSERT and SELECT on the table only.
`;

interface AuditEntry {
  id: string;
  projectId?: string | null;
  userEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  changesJson?: string | null;
  correlationId?: string | null;
  succeeded: boolean;
  occurredAt: string;
}

interface AuditPage { entries: AuditEntry[]; total: number; limit: number; offset: number; }

export async function auditCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, AUDIT_FLAGS);

  const action = args.positionals[0] ?? 'list';
  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token'),
    projectId: flag(args, 'project')
  });
  const api = new ApiClient(context.apiUrl, context.token);

  switch (action) {
    case 'list': return list(api, args, context.projectId);
    case 'trace': return trace(api, args);
    case 'actions': return actions(api, args);
    default:
      throw usage(`Unknown action "${action}".`, 'Use list, trace or actions.');
  }
}

async function list(api: ApiClient, args: ParsedArgs, projectId?: string): Promise<number> {
  const query = new URLSearchParams();
  const add = (key: string, value: string | undefined) => { if (value) query.set(key, value); };

  add('action', flag(args, 'action'));
  add('entityType', flag(args, 'entity-type'));
  add('entityId', flag(args, 'entity-id'));
  add('correlationId', flag(args, 'correlation'));
  add('userEmail', flag(args, 'user'));
  add('from', flag(args, 'since'));
  add('to', flag(args, 'until'));
  // --project is a filter here, not a requirement: most audited actions are
  // organization-level and carry no project at all, so demanding one would hide them.
  add('projectId', flag(args, 'project') ?? projectId);
  if (boolFlag(args, 'failed')) query.set('succeeded', 'false');
  query.set('limit', String(intFlag(args, 'limit') ?? 50));
  query.set('offset', String(intFlag(args, 'offset') ?? 0));

  const page = await api.get<AuditPage>(`/api/v1/audit?${query.toString()}`);
  return render(page, args);
}

async function trace(api: ApiClient, args: ParsedArgs): Promise<number> {
  const correlationId = args.positionals[1] ?? flag(args, 'correlation');
  if (!correlationId) {
    throw usage('A correlation id is required.',
      'qanxt audit trace <correlation-id>. It is on the x-correlation-id response header, '
      + 'and in the "(correlation …)" the CLI prints with a platform error.');
  }
  const page = await api.get<AuditPage>(
    `/api/v1/audit/correlation/${encodeURIComponent(correlationId)}`);

  if (!boolFlag(args, 'json') && page.entries.length === 0) {
    // Not an error: plenty of requests are not audited, and a correlation id that
    // produced no audit record is a real answer to the question asked.
    note(dim(`No audit record carries correlation ${correlationId}.`));
    note(dim('Not every request is audited — only security- and governance-relevant actions are.'));
    return ExitCode.Success;
  }
  return render(page, args);
}

async function actions(api: ApiClient, args: ParsedArgs): Promise<number> {
  const names = await api.get<Array<{ name: string; value: number }>>('/api/v1/audit/actions');
  if (boolFlag(args, 'json')) { out(JSON.stringify(names, null, 2)); return ExitCode.Success; }
  for (const entry of names) out(`${dim(String(entry.value).padStart(3))}  ${entry.name}`);
  return ExitCode.Success;
}

function render(page: AuditPage, args: ParsedArgs): number {
  if (boolFlag(args, 'json')) { out(JSON.stringify(page, null, 2)); return ExitCode.Success; }

  if (page.entries.length === 0) {
    note(dim('No audit records match.'));
    return ExitCode.Success;
  }

  for (const entry of page.entries) {
    // A failed action is the one worth finding, so it is marked rather than left to be
    // spotted in a column.
    const mark = entry.succeeded ? ' ' : red('!');
    out(`${mark} ${dim(entry.occurredAt)} ${bold(humanize(entry.action))} ${dim(entry.entityType)}`);
    out(`    ${entry.summary}`);
    const trail = [
      entry.userEmail ?? 'no user in context',
      entry.correlationId ? `correlation ${entry.correlationId}` : null
    ].filter(Boolean).join(' · ');
    out(dim(`    ${trail}`));
  }

  // Say what is not being shown. A page that cannot say how much it is hiding invites
  // the reader to assume it is showing everything.
  const shown = page.offset + page.entries.length;
  if (shown < page.total) {
    note(dim(`${page.entries.length} of ${page.total} — `
      + `next page: --offset ${shown}`));
  } else {
    note(dim(`${page.total} record(s).`));
  }
  return ExitCode.Success;
}
