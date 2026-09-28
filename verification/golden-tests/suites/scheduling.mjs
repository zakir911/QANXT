/**
 * Schedules: regression that happens without anybody asking.
 *
 * The entity had been in the database since the first migration and nothing ever read it —
 * no service, no controller, nothing that evaluated a cron expression. A console that lists
 * schedules which never fire is worse than one with no schedules at all, because it looks
 * armed.
 *
 * These execute the real thing: a schedule is created through the API, the runner in the
 * live platform picks it up on its own sweep, and the run it starts is waited for and read
 * back. Nothing here calls the runner directly or simulates a tick — if the background
 * service is not actually running, these fail, which is the point.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { golden, suite, ROOT } from '../harness.mjs';
import {
  API, LAB, createEnvironment, createProject, lab, newTenant, registerApplication,
  request, requireApiTest
} from '../platform.mjs';

const BANK = LAB.banking;
const CREDENTIALS = { username: 'alice', password: 'Password123!' };

/** The runner sweeps twice a minute, so anything waiting on a fire waits a little over that. */
const FIRE_TIMEOUT_MS = 90_000;

function cli(args, { token, projectId } = {}) {
  const result = spawnSync(process.execPath, [resolve(ROOT, 'packages/cli/dist/qanxt.js'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env, QANXT_API_URL: API, QANXT_TOKEN: token ?? '',
      QANXT_PROJECT_ID: projectId ?? '', QANXT_ENVIRONMENT_ID: '', NO_COLOR: '1'
    }
  });
  return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const createSchedule = (tenant, body) =>
  request('/api/v1/schedules', { token: tenant.token, method: 'POST', body });

const updateSchedule = (tenant, id, body) =>
  request(`/api/v1/schedules/${id}`, { token: tenant.token, method: 'PATCH', body });

const getSchedule = (tenant, id) =>
  request(`/api/v1/schedules/${id}`, { token: tenant.token });

/**
 * A cron expression matching every minute, so a schedule created now fires within the
 * runner's next sweep rather than at two in the morning.
 */
const EVERY_MINUTE = '* * * * *';

/** Waits until the schedule reports a run, or gives up. */
async function waitForFire(tenant, scheduleId, timeoutMs = FIRE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { json } = await getSchedule(tenant, scheduleId);
    if (json?.lastRunId) return json;
    await sleep(3000);
  }
  return null;
}

/** Waits for a run to reach a terminal state. */
async function waitForRun(tenant, runId, timeoutMs = 180_000) {
  const terminal = new Set(['passed', 'failed', 'cancelled', 'error', 'blocked', 'completed', 'timedOut']);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { json } = await request(`/api/v1/testruns/${runId}`, { token: tenant.token });
    if (json && terminal.has(json.status)) return json;
    await sleep(2000);
  }
  return null;
}

export default async function run() {
  suite('Scheduling');
  await lab.reset(BANK);

  const tenant = await newTenant('Scheduling');
  const project = await createProject(tenant, 'Golden scheduling');
  const application = await registerApplication(tenant, project.id, {
    name: 'Lab Bank scheduled', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
  });
  const qa = await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
  });
  const production = await createEnvironment(tenant, project.id, {
    name: 'Lab Production', key: 'prod', kind: 'production', baseUrl: BANK, apiBaseUrl: BANK
  });

  const context = { tenant, project, application, applicationVersion: '1.0.0' };
  const shared = { projectId: project.id, applicationId: application.id };

  const smoke = await requireApiTest(tenant, {
    ...shared, suiteName: 'Scheduled smoke', name: 'The application answers', tags: 'smoke',
    steps: [{
      description: 'Health check',
      request: { method: 'GET', path: '/health', auth: { mode: 'none' } },
      assertions: [{ type: 'httpStatusEquals', expected: '200' }]
    }]
  });

  // A second test, untagged, so a tag-restricted schedule has something to leave out.
  const nightly = await requireApiTest(tenant, {
    ...shared, suiteName: 'Scheduled nightly', name: 'The accounts endpoint needs a session',
    tags: 'accounts',
    steps: [{
      description: 'Read the accounts with no credentials',
      request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' }, failOnErrorStatus: false },
      assertions: [{ type: 'httpStatusEquals', expected: '401' }]
    }]
  });

  // ---- SCH-001: a schedule actually fires ---------------------------------
  await golden({
    id: 'SCH-001',
    objective: 'A schedule created through the API fires on its own and starts a real run',
    preconditions: ['the platform is running with the schedule runner enabled', 'the lab bank is up'],
    input: 'A schedule with the cron expression "* * * * *"',
    expected: 'Within a minute or two the platform starts a run of the scheduled tests with '
      + 'no further input, records it on the schedule, and the run reaches a verdict',
    evidence: ['schedule.json', 'run.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      const created = await createSchedule(tenant, {
        projectId: project.id,
        name: 'Every minute (SCH-001)',
        cronExpression: EVERY_MINUTE,
        timeZone: 'UTC',
        includeTags: 'smoke',
        environmentId: qa.id
      });

      if (!created.ok) {
        return { pass: false, detail: `the schedule was refused: ${created.status} ${created.text.slice(0, 200)}` };
      }

      const fired = await waitForFire(tenant, created.json.id);
      // Disabled straight away so it does not keep firing through the rest of the suite.
      await updateSchedule(tenant, created.json.id, { isEnabled: false });

      if (!fired) {
        return {
          pass: false,
          detail: `the schedule never fired within ${FIRE_TIMEOUT_MS / 1000}s`,
          evidence: { 'schedule.json': (await getSchedule(tenant, created.json.id)).json }
        };
      }

      const finished = await waitForRun(tenant, fired.lastRunId);

      return {
        pass: finished !== null
          && finished.trigger === 'scheduled'
          && finished.totalCount === 1
          && finished.passedCount === 1,
        detail: `fired at ${fired.lastRunAt}, run ${fired.lastRunId} `
          + `(${finished?.status}, trigger ${finished?.trigger}, `
          + `${finished?.passedCount}/${finished?.totalCount} passed); next run ${fired.nextRunAt}`,
        metrics: { testsRun: finished?.totalCount ?? 0 },
        evidence: { 'schedule.json': fired, 'run.json': finished }
      };
    }
  }, context);

  // ---- SCH-002: the tag restriction is honoured ---------------------------
  await golden({
    id: 'SCH-002',
    objective: 'A schedule restricted by tag runs only the tests carrying that tag',
    preconditions: ['two tests exist, one tagged smoke and one tagged accounts'],
    input: 'A schedule with includeTags "accounts"',
    expected: 'The run it starts contains the accounts test and not the smoke test — a '
      + 'nightly that quietly ran everything would cost hours and hide what it was for',
    evidence: ['executions.json'],
    severity: 'high',
    run: async () => {
      await lab.reset(BANK);
      const created = await createSchedule(tenant, {
        projectId: project.id,
        name: 'Accounts only (SCH-002)',
        cronExpression: EVERY_MINUTE,
        timeZone: 'UTC',
        includeTags: 'accounts',
        environmentId: qa.id
      });

      const fired = await waitForFire(tenant, created.json.id);
      await updateSchedule(tenant, created.json.id, { isEnabled: false });
      if (!fired) return { pass: false, detail: 'the schedule never fired' };

      await waitForRun(tenant, fired.lastRunId);
      const { json: executions } = await request(
        `/api/v1/testruns/${fired.lastRunId}/executions`, { token: tenant.token });

      const references = (executions ?? []).map(execution => execution.reference).sort();

      return {
        pass: references.length === 1 && references[0] === nightly.reference,
        detail: `ran ${references.length} test(s): ${references.join(', ')} `
          + `(expected only ${nightly.reference})`,
        evidence: { 'executions.json': executions }
      };
    }
  }, context);

  // ---- SCH-003: the next fire time moves forward --------------------------
  await golden({
    id: 'SCH-003',
    objective: 'Firing moves the schedule forward, so one occurrence starts exactly one run',
    preconditions: ['a schedule that has fired'],
    input: 'The schedule from SCH-001, read after it fired',
    expected: 'nextRunAt is strictly later than the occurrence that fired, and the schedule '
      + 'did not start a second run for the same occurrence',
    evidence: ['schedule.json', 'runs.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      const created = await createSchedule(tenant, {
        projectId: project.id,
        name: 'Advances (SCH-003)',
        cronExpression: EVERY_MINUTE,
        timeZone: 'UTC',
        includeTags: 'smoke',
        environmentId: qa.id
      });

      const firedAt = await waitForFire(tenant, created.json.id);
      await updateSchedule(tenant, created.json.id, { isEnabled: false });
      if (!firedAt) return { pass: false, detail: 'the schedule never fired' };

      // Every run this schedule produced. One occurrence must mean one run; the claim is
      // a compare-and-swap on nextRunAt, and if it were not, a second sweep inside the
      // same minute would start another.
      const { json: runs } = await request(
        `/api/v1/testruns?projectId=${project.id}&limit=200`, { token: tenant.token });
      const mine = (runs?.items ?? runs ?? [])
        .filter(candidate => candidate.name?.startsWith('Advances (SCH-003)'));

      const advanced = new Date(firedAt.nextRunAt).getTime() > new Date(firedAt.lastRunAt).getTime();

      return {
        pass: advanced && mine.length === 1,
        detail: `fired at ${firedAt.lastRunAt}, next ${firedAt.nextRunAt} `
          + `(advanced: ${advanced}); ${mine.length} run(s) started for this schedule`,
        metrics: { runs: mine.length },
        evidence: { 'schedule.json': firedAt, 'runs.json': mine }
      };
    }
  }, context);

  // ---- SCH-004: a bad cron expression is refused on the way in -----------
  await golden({
    id: 'SCH-004',
    objective: 'A cron expression that cannot work is refused when it is written, not at 3am',
    preconditions: ['none'],
    input: 'Schedules with a malformed expression, an out-of-range field, a six-field '
      + 'expression, an @daily shorthand, and one that parses but can never occur',
    expected: 'Each refused with a 400 naming what is wrong — a schedule accepted and never '
      + 'fired looks armed in the console and is not',
    evidence: ['refusals.json'],
    severity: 'high',
    run: async () => {
      const cases = [
        { cron: 'not a cron', because: 'malformed' },
        { cron: '99 * * * *', because: 'minute out of range' },
        { cron: '0 0 2 * * *', because: 'six fields' },
        { cron: '@daily', because: 'shorthand' },
        { cron: '0 0 30 2 *', because: 'parses, can never occur' },
        { cron: '0 0 * * *', because: 'valid — must be accepted', shouldSucceed: true }
      ];

      const refusals = [];
      for (const testCase of cases) {
        const response = await createSchedule(tenant, {
          projectId: project.id,
          name: `SCH-004 ${testCase.because}`,
          cronExpression: testCase.cron,
          timeZone: 'UTC',
          environmentId: qa.id
        });

        refusals.push({
          cron: testCase.cron,
          because: testCase.because,
          status: response.status,
          message: response.json?.title ?? response.text?.slice(0, 200)
        });

        // The valid one is created; turn it off so it does not fire for the rest of the run.
        if (response.ok && response.json?.id) {
          await updateSchedule(tenant, response.json.id, { isEnabled: false });
        }
      }

      const bad = refusals.filter(refusal => refusal.because !== 'valid — must be accepted');
      const good = refusals.find(refusal => refusal.because === 'valid — must be accepted');

      return {
        pass: bad.every(refusal => refusal.status === 400 && (refusal.message ?? '').length > 0)
          && good?.status === 201,
        detail: `${bad.filter(r => r.status === 400).length}/${bad.length} refused with 400; `
          + `the valid expression returned ${good?.status}`,
        evidence: { 'refusals.json': refusals }
      };
    }
  }, context);

  // ---- SCH-005: production is refused at the schedule, not at 3am --------
  await golden({
    id: 'SCH-005',
    objective: 'A schedule pointed at unauthorized production is refused when it is created',
    preconditions: ['a production environment that nobody has authorized for testing'],
    input: 'A schedule with that environment',
    expected: 'Refused with the security reason, at the moment somebody is looking at it — '
      + 'rather than failing silently every night once they are not',
    evidence: ['refusal.json'],
    severity: 'critical',
    run: async () => {
      const response = await createSchedule(tenant, {
        projectId: project.id,
        name: 'Against production (SCH-005)',
        cronExpression: '0 2 * * *',
        timeZone: 'UTC',
        environmentId: production.id
      });

      if (response.ok && response.json?.id) {
        await updateSchedule(tenant, response.json.id, { isEnabled: false });
      }

      return {
        pass: response.status === 403
          && response.json?.code === 'security_policy'
          && /has not been authorized/.test(response.json?.title ?? ''),
        detail: `${response.status} ${response.json?.code}: ${response.json?.title ?? response.text?.slice(0, 160)}`,
        evidence: { 'refusal.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  // ---- SCH-006: preview says when it will fire ---------------------------
  await golden({
    id: 'SCH-006',
    objective: 'Preview reports the real occurrences, in the schedule\'s own time zone',
    preconditions: ['a schedule in a zone that observes daylight saving'],
    input: 'A daily 02:30 Europe/London schedule, previewed',
    expected: 'Five ascending occurrences, each at 02:30 local — so a cron expression can be '
      + 'checked against what whoever typed it meant, before waiting a night to find out',
    evidence: ['preview.json'],
    severity: 'medium',
    run: async () => {
      const created = await createSchedule(tenant, {
        projectId: project.id,
        name: 'London nights (SCH-006)',
        cronExpression: '30 2 * * *',
        timeZone: 'Europe/London',
        environmentId: qa.id
      });
      await updateSchedule(tenant, created.json.id, { isEnabled: false });

      const { json: occurrences } = await request(
        `/api/v1/schedules/${created.json.id}/preview?count=5`, { token: tenant.token });

      const times = (occurrences ?? []).map(occurrence =>
        new Date(occurrence).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour12: false }));

      const ascending = (occurrences ?? []).every((occurrence, index) =>
        index === 0 || new Date(occurrence) > new Date(occurrences[index - 1]));

      return {
        pass: occurrences?.length === 5 && ascending && times.every(time => time === '02:30:00'),
        detail: `${occurrences?.length ?? 0} occurrence(s), local times ${[...new Set(times)].join(', ')}, `
          + `ascending: ${ascending}`,
        evidence: { 'preview.json': occurrences }
      };
    }
  }, context);

  // ---- SCH-007: the CLI surface --------------------------------------------
  await golden({
    id: 'SCH-007',
    objective: 'A schedule can be created, listed, previewed, disabled and removed from the CLI',
    preconditions: ['the CLI is built'],
    input: 'qanxt schedule add / list / preview / disable / remove',
    expected: 'Each command does what it says, and list shows the expression and the next '
      + 'run rather than only an id',
    evidence: ['cli.txt'],
    severity: 'high',
    run: async () => {
      const options = { token: tenant.token, projectId: project.id };
      const transcript = [];
      const record = (label, result) => {
        transcript.push(`$ qanxt schedule ${label}\n[exit ${result.code}]\n${result.output}`);
        return result;
      };

      const added = record('add', cli([
        'schedule', 'add', '--name', 'From the CLI (SCH-007)',
        '--cron', '0 3 * * mon-fri', '--timezone', 'UTC', '--json'
      ], options));

      let id = null;
      try { id = JSON.parse(added.output).id; } catch { /* reported below */ }
      if (!id) {
        return { pass: false, detail: `add did not return a schedule: ${added.output.slice(0, 200)}`,
          evidence: { 'cli.txt': transcript.join('\n\n') } };
      }

      // Disabled immediately: a weekday 03:00 schedule will not fire during a verification
      // run, but leaving live schedules behind in a shared database is not tidy.
      const listed = record('list', cli(['schedule', 'list'], options));
      const previewed = record('preview', cli(['schedule', 'preview', id, '--count', '3'], options));
      const disabled = record('disable', cli(['schedule', 'disable', id], options));
      const removed = record('remove', cli(['schedule', 'remove', id], options));
      const afterRemoval = record('list (after removal)', cli(['schedule', 'list'], options));

      return {
        pass: added.code === 0
          && listed.code === 0 && listed.output.includes('0 3 * * mon-fri')
          && previewed.code === 0 && previewed.output.trim().split('\n').length === 3
          && disabled.code === 0
          && removed.code === 0
          && !afterRemoval.output.includes(id),
        detail: `add ${added.code}, list ${listed.code}, preview ${previewed.code}, `
          + `disable ${disabled.code}, remove ${removed.code}; `
          + `gone from the list afterwards: ${!afterRemoval.output.includes(id)}`,
        evidence: { 'cli.txt': transcript.join('\n\n') }
      };
    }
  }, context);
}
