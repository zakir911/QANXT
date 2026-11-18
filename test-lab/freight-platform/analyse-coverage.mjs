/**
 * Which planted defects had a test pointed at them, and what that test did.
 *
 * ## Why this is separate from detection
 *
 * The detection analysis answers "did the platform report this defect?". When the answer is
 * no, it reports "missed" — and "missed" covers two very different situations that a team
 * needs to tell apart:
 *
 *   - no test ever visited the screen, so nothing could have found it; and
 *   - a test ran against the screen, passed, and the defect sat there untouched.
 *
 * The first is a coverage gap and is fixed by generating more. The second is an oracle gap:
 * the suite looked at the defect and called it fine, which is the harder and more serious
 * failure, and the one a coverage percentage hides.
 *
 * Reads the run straight from the database because the pipeline result file records names
 * only for failures, and a screen is covered by the tests that passed on it too.
 *
 *   node analyse-coverage.mjs --run <testRunId>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const runId = arg('run');
if (!runId) {
  console.error('usage: node analyse-coverage.mjs --run <testRunId>');
  process.exit(2);
}

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

/** One row per line, columns separated by a pipe. */
async function query(sql) {
  const { stdout } = await run('psql',
    ['-h', 'localhost', '-p', '5432', '-U', 'qanxt', '-d', 'qanxt', '-At', '-F', '|', '-c', sql],
    { env: process.env, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\n').filter(Boolean).map(line => line.split('|'));
}

const groundTruth = JSON.parse(
  await readFile(new URL('./ground-truth.json', import.meta.url), 'utf8'));

// Every (path, status) a test in this run actually pointed at. A case can carry several
// steps on several URLs; each one counts as that path having been visited.
const rows = await query(`
  select distinct s.url, e.status
  from test_executions e
  join test_steps s on s.test_case_id = e.test_case_id
  where e.test_run_id = '${runId}' and s.url is not null and s.url <> ''`);

const visited = new Map(); // path -> Set of statuses
for (const [url, status] of rows) {
  let path;
  try { path = new URL(url).pathname; } catch { continue; }
  if (!visited.has(path)) visited.set(path, new Set());
  visited.get(path).add(String(status).toLowerCase());
}

const matches = (pattern, path) => {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+');
  return new RegExp(`^${source}$`).test(path);
};

const verdicts = groundTruth.defects.list.map(defect => {
  const screen = defect.screen.split('?')[0];
  const hits = [...visited.entries()].filter(([path]) => path === screen || matches(screen, path));
  const statuses = new Set(hits.flatMap(([, set]) => [...set]));

  return {
    id: defect.id, severity: defect.severity, category: defect.category, screen,
    testsPointedAtTheScreen: hits.length > 0,
    anyTestFailedThere: statuses.has('failed'),
    anyTestPassedThere: statuses.has('passed'),
    // The distinction this file exists for.
    gap: hits.length === 0 ? 'no-test-visited-the-screen'
       : statuses.has('failed') ? 'a-test-failed-there'
       : 'a-test-passed-over-it'
  };
});

const counts = verdicts.reduce((acc, v) => { acc[v.gap] = (acc[v.gap] ?? 0) + 1; return acc; }, {});

const line = (t = '') => console.log(t);
line();
line('═'.repeat(76));
line('COVERAGE — did a test point at each planted defect, and what did it do?');
line('═'.repeat(76));
line(`\n  Run ${runId}`);
line(`  ${visited.size} distinct path(s) carried at least one test step\n`);
for (const [gap, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  line(`  ${String(count).padStart(3)}  ${gap}`);
}
line('\n  Read it this way:');
line('    no-test-visited-the-screen  a coverage gap. Generate more and it closes.');
line('    a-test-passed-over-it       an oracle gap. The suite looked at the defect and');
line('                                called the screen fine. This is the one a coverage');
line('                                percentage hides, and the one that matters.');
line('    a-test-failed-there         something failed on that screen. Whether it failed');
line('                                FOR this defect is the detection analysis\u2019 question,');
line('                                not this one.');

line('\n  By defect:');
for (const v of verdicts) {
  line(`    ${v.id.padEnd(34)} ${v.severity.padEnd(8)} ${v.gap}`);
}

await writeFile(new URL('./coverage-analysis.json', import.meta.url),
  JSON.stringify({ analysedAt: new Date().toISOString(), runId,
    pathsWithTestSteps: visited.size, counts, verdicts }, null, 2) + '\n');
line('\n  Written to coverage-analysis.json\n');
