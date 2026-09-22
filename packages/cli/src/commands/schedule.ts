import { ApiClient } from '../api.js';
import { boolFlag, flag, intFlag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, dim, green, note, out, red, yellow } from '../output.js';
import { environmentFlag } from './run.js';

export const SCHEDULE_FLAGS = [
  'project', 'environment', 'name', 'cron', 'timezone', 'suite', 'tags', 'browser',
  'count', 'json'
] as const;

export const SCHEDULE_HELP = `
${bold('aira schedule')} — regression that happens without anybody asking

  ${bold('aira schedule list')}
      Every schedule in the project, when each last ran and when each runs next.

  ${bold('aira schedule add --name "Nightly" --cron "0 2 * * *" --timezone Europe/London')}
      Creates one. Add --tags smoke or --suite <id> to narrow what it runs.

  ${bold('aira schedule preview <id>')}
      The next few times it will fire. Worth doing before waiting a night to
      find out the expression meant something else.

  ${bold('aira schedule enable <id>')} / ${bold('aira schedule disable <id>')}
      Turns one on or off. Enabling clears a failure count.

  ${bold('aira schedule remove <id>')}
      Deletes it.

  --project <id>         Project to work in (or AIRA_PROJECT_ID)
  --name <text>          What this schedule is for
  --cron <expression>    Five fields: minute hour day-of-month month day-of-week
  --timezone <name>      IANA name, e.g. Europe/London. Defaults to UTC
  --suite <id>           Restrict to one suite
  --tags <a,b>           Restrict to tests carrying any of these tags
  --environment <id>     Environment to run against (or AIRA_ENVIRONMENT_ID)
  --browser <name>       chromium | firefox | webkit
  --count <n>            For "preview": how many occurrences (default 5)
  --json                 Machine-readable output

${bold('Writing a cron expression')}

  0 2 * * *          every day at 02:00
  */15 * * * *       every fifteen minutes
  0 2 * * mon-fri    weekdays at 02:00
  0 */4 * * *        every four hours

  A time zone is worth setting. "0 2 * * *" in UTC drifts an hour into the
  working day every summer for anyone who is not on UTC; named, it stays at
  02:00 local on both sides of a daylight-saving change.

  Restricting both the day-of-month and day-of-week fields matches ${bold('either')},
  which is crontab's rule and catches people out: "0 0 13 * fri" is the 13th of
  every month and every Friday, not Friday the 13th.
`;

interface ScheduleSummary {
  id: string;
  projectId: string;
  name: string;
  cronExpression: string;
  timeZone: string;
  testSuiteId?: string | null;
  includeTags?: string | null;
  environmentId?: string | null;
  browser: string;
  isEnabled: boolean;
  disabledReason?: string | null;
  lastRunAt?: string | null;
  lastRunId?: string | null;
  nextRunAt?: string | null;
  consecutiveFailureCount: number;
}

export async function scheduleCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, SCHEDULE_FLAGS);

  const action = args.positionals[0] ?? 'list';
  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token'),
    projectId: flag(args, 'project')
  });
  const api = new ApiClient(context.apiUrl, context.token);

  switch (action) {
    case 'list': return list(api, args, context.projectId);
    case 'add': return add(api, args, context.projectId);
    case 'preview': return preview(api, args);
    case 'enable': return setEnabled(api, args, true);
    case 'disable': return setEnabled(api, args, false);
    case 'remove': return remove(api, args);
    default:
      throw usage(`Unknown action "${action}".`,
        'Use list, add, preview, enable, disable or remove.');
  }
}

async function list(api: ApiClient, args: ParsedArgs, projectId?: string): Promise<number> {
  if (!projectId) throw usage('A project is required.', 'Pass --project <id>, or set AIRA_PROJECT_ID.');

  const schedules = await api.get<ScheduleSummary[]>(`/api/v1/schedules?projectId=${projectId}`);

  if (boolFlag(args, 'json')) { out(JSON.stringify(schedules, null, 2)); return ExitCode.Success; }

  if (schedules.length === 0) {
    note(dim('No schedules. Add one with "aira schedule add --name … --cron …".'));
    return ExitCode.Success;
  }

  for (const schedule of schedules) {
    const state = schedule.isEnabled ? green('on') : red('off');
    out(`${state} ${bold(schedule.name)} ${dim(schedule.id)}`);
    out(`    ${schedule.cronExpression} (${schedule.timeZone})`
      + `${schedule.includeTags ? ` · tags ${schedule.includeTags}` : ''}`
      + `${schedule.testSuiteId ? ` · one suite` : ''}`);

    if (schedule.isEnabled) {
      out(dim(`    next ${schedule.nextRunAt ?? 'never'}`
        + `${schedule.lastRunAt ? ` · last ${schedule.lastRunAt}` : ' · has not run yet'}`));
    }

    // A schedule the platform turned off is the case worth being loud about: it is not
    // running, and nobody asked for that.
    if (!schedule.isEnabled && schedule.disabledReason) {
      out(yellow(`    ${schedule.disabledReason}`));
    }
    if (schedule.isEnabled && schedule.consecutiveFailureCount > 0) {
      out(yellow(`    ${schedule.consecutiveFailureCount} failure(s) in a row so far`));
    }
  }

  return ExitCode.Success;
}

async function add(api: ApiClient, args: ParsedArgs, projectId?: string): Promise<number> {
  if (!projectId) throw usage('A project is required.', 'Pass --project <id>, or set AIRA_PROJECT_ID.');

  const name = flag(args, 'name');
  const cron = flag(args, 'cron');
  if (!name) throw usage('A name is required.', 'Pass --name "Nightly regression".');
  if (!cron) throw usage('A cron expression is required.', 'Pass --cron "0 2 * * *".');

  const created = await api.post<ScheduleSummary>('/api/v1/schedules', {
    projectId,
    name,
    cronExpression: cron,
    timeZone: flag(args, 'timezone'),
    testSuiteId: flag(args, 'suite'),
    includeTags: flag(args, 'tags'),
    // environmentFlag, not a second reading of the variable: it treats an exported-but-
    // empty value as absent, which is the normal state of a variable a pipeline declares
    // and does not set, and validates the shape of a non-empty one. (BUG-0030.)
    environmentId: environmentFlag(args),
    browser: flag(args, 'browser')
  });

  if (boolFlag(args, 'json')) { out(JSON.stringify(created, null, 2)); return ExitCode.Success; }

  note(`${green('Created')} ${bold(created.name)} ${dim(created.id)}`);
  note(`${created.cronExpression} (${created.timeZone})`);
  note(dim(`First run ${created.nextRunAt}`));
  return ExitCode.Success;
}

async function preview(api: ApiClient, args: ParsedArgs): Promise<number> {
  const id = requireId(args, 'preview');
  const count = intFlag(args, 'count') ?? 5;
  const occurrences = await api.get<string[]>(`/api/v1/schedules/${id}/preview?count=${count}`);

  if (boolFlag(args, 'json')) { out(JSON.stringify(occurrences, null, 2)); return ExitCode.Success; }

  if (occurrences.length === 0) {
    note(red('This schedule has no further occurrences.'));
    return ExitCode.Success;
  }
  for (const occurrence of occurrences) out(occurrence);
  return ExitCode.Success;
}

async function setEnabled(api: ApiClient, args: ParsedArgs, isEnabled: boolean): Promise<number> {
  const id = requireId(args, isEnabled ? 'enable' : 'disable');
  const updated = await api.patch<ScheduleSummary>(`/api/v1/schedules/${id}`, { isEnabled });

  if (boolFlag(args, 'json')) { out(JSON.stringify(updated, null, 2)); return ExitCode.Success; }

  note(isEnabled
    ? `${green('Enabled')} ${bold(updated.name)} — next run ${updated.nextRunAt}`
    : `${yellow('Disabled')} ${bold(updated.name)}`);
  return ExitCode.Success;
}

async function remove(api: ApiClient, args: ParsedArgs): Promise<number> {
  const id = requireId(args, 'remove');
  await api.delete(`/api/v1/schedules/${id}`);
  note(`${green('Removed')} ${dim(id)}`);
  return ExitCode.Success;
}

function requireId(args: ParsedArgs, action: string): string {
  const id = args.positionals[1];
  if (!id) throw usage(`"${action}" needs a schedule id.`, 'List them with "aira schedule list".');
  return id;
}
