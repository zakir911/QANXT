/**
 * Rebuilds the execution stage of pipeline-result.json from the database.
 *
 * ## Why this exists
 *
 * The pipeline driver waits a bounded time for the run to finish. When the wait runs out
 * the run does NOT stop — it carries on in the control plane, which is correct, and is the
 * same property that once left a 2189-case run executing after its driver was killed. What
 * the driver writes at that point is a partial execution stage, and a detection analysis
 * computed on it understates what the platform found.
 *
 * Rather than re-crawl and re-execute to get a complete file, this reads the finished run
 * back out of the database and rewrites the stage, so the detection and coverage analyses
 * run against the whole run. It refuses to write while the run is still going, because a
 * partial file that looks complete is worse than one that says it is partial.
 *
 *   node rebuild-execution-stage.mjs --run <testRunId>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const runId = arg('run');
if (!runId) { console.error('usage: node rebuild-execution-stage.mjs --run <testRunId>'); process.exit(2); }

/**
 * The database password comes from PGPASSWORD in the environment, set by whatever started
 * this script. It is deliberately not parsed out of .env here: a script that reads a
 * credential out of a file is a script that can print it, log it, or put it in an error
 * message, and none of that is needed to run a query. Export it before running:
 *
 *   set -a && . ./.env && set +a
 *   export PGPASSWORD=$(echo "$DATABASE_URL" | tr ';' '\n' | grep -i '^Password=' | cut -d= -f2-)
 */
if (!process.env.PGPASSWORD) {
  console.error('PGPASSWORD is not set. See the comment at the top of this file.');
  process.exit(2);
}

async function query(sql) {
  const { stdout } = await exec('psql',
    ['-h', 'localhost', '-p', '5432', '-U', 'qanxt', '-d', 'qanxt', '-At', '-F', '\u0001', '-c', sql],
    { env: process.env, maxBuffer: 128 * 1024 * 1024 });
  return stdout.split('\n').filter(Boolean).map(line => line.split('\u0001'));
}

/**
 * Status is stored as the enum's integer, so the mapping is spelled out in full against
 * QaNxt.Domain.Enums.ExecutionStatus rather than guessed at the two values of interest.
 * Pending is 0, not 1, and lumping TimedOut, Error and Healed under "blocked" would hide
 * three different outcomes behind one word.
 */
const STATUS = {
  0: 'pending', 1: 'queued', 2: 'running',
  10: 'passed', 11: 'failed', 12: 'skipped', 13: 'blocked', 14: 'healed', 15: 'flaky',
  16: 'timedOut', 17: 'cancelled', 18: 'error'
};
const NOT_FINISHED = ['pending', 'queued', 'running'];
const PASSED = 10, FAILED = 11;

const byStatus = {};
for (const [code, count] of await query(
  `select status, count(*) from test_executions where test_run_id = '${runId}' group by status`)) {
  byStatus[STATUS[Number(code)] ?? `unknown-${code}`] = Number(count);
}

const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
const passed = byStatus.passed ?? 0;
const failed = byStatus.failed ?? 0;
const pending = NOT_FINISHED.reduce((sum, key) => sum + (byStatus[key] ?? 0), 0);

console.log(`  run ${runId}: ${total} execution(s) — `
  + Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', '));

if (pending > 0) {
  console.error(`\n  Refusing to rewrite the result file: ${pending} execution(s) have not`);
  console.error('  finished. Run this again once they have.\n');
  process.exit(1);
}

const failures = await query(`
  select e.test_case_id, coalesce(c.name, ''), coalesce(e.error_message, '')
  from test_executions e
  left join test_cases c on c.id = e.test_case_id
  where e.test_run_id = '${runId}' and e.status = ${FAILED}`);

const file = new URL('./pipeline-result.json', import.meta.url);
const result = JSON.parse(await readFile(file, 'utf8'));

result.stages.execution = {
  ...(result.stages.execution ?? {}),
  runId,
  rebuiltFromDatabaseAt: new Date().toISOString(),
  rebuiltBecause: 'the driver stopped waiting before the run finished; the run itself '
    + 'continued in the control plane and these are its final figures',
  status: 'completed',
  total,
  passed,
  failed,
  blocked: byStatus.blocked ?? 0,
  skipped: byStatus.skipped ?? 0,
  // Every terminal status, so no outcome is folded into another.
  byStatus,
  failures: failures.map(([testCaseId, name, message]) => ({
    testCaseId, name: name || null, message: message.slice(0, 400), category: null
  }))
};

await writeFile(file, JSON.stringify(result, null, 2) + '\n');
console.log(`\n  Rewrote the execution stage: ${passed} passed, ${failed} failed, `
  + `${failures.length} failure message(s) carried through.\n`);
