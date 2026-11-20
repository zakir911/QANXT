/**
 * Builds a measurement result straight from the database.
 *
 * ## Why this exists
 *
 * Starting a run is a synchronous request that inserts one execution row per test. For the
 * 5,887 tests this lab generates it holds the connection open for over five minutes, and
 * Node's fetch closes a request whose headers have not arrived in 300 seconds — regardless
 * of the AbortSignal the caller set. Measured twice: the run was created at 02:57:28 and
 * the driver reported `TypeError: fetch failed` at 03:02:30, five minutes and two seconds
 * later, with its own timeout set to ten minutes. Raising that timeout cannot help, which
 * is why raising it last time did not.
 *
 * The run itself is unharmed — the control plane carries on executing — but the driver
 * exits without the run id and every later stage is lost. Three hours of execution then
 * produce no report.
 *
 * So measurement is decoupled from that request. Given the application, this reads what the
 * run actually did out of the control plane's own tables and writes the result file the
 * analysis scripts read. The underlying API shape wants fixing too — a run should return its
 * id at once and enqueue behind it — but a measurement should not depend on that.
 *
 * Note the stage name. The driver writes `stages.run`; `analyse-detection.mjs` reads
 * `stages.execution` and silently sees no failures if it is not there, reporting a clean
 * run for one that failed hundreds of times. Both are written here.
 *
 *   node collect-run-result.mjs --app <applicationId> [--run <runId>] [--out <file>]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const APP = arg('app');
const OUT = arg('out', 'form-engine-result.json');
if (!APP) {
  console.error('Usage: node collect-run-result.mjs --app <applicationId> [--run <runId>] [--out <file>]');
  process.exit(2);
}

const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const dbUrl = /^DATABASE_URL=(.*)$/m.exec(env)?.[1] ?? '';
const part = (key) => new RegExp(`${key}=([^;"']*)`, 'i').exec(dbUrl)?.[1] ?? '';

const SEP = '\u0001';
const query = (sql) => execFileSync('psql', [
  '-h', part('Host') || 'localhost', '-p', part('Port') || '5432',
  '-U', part('Username') || 'qanxt', '-d', part('Database') || 'qanxt',
  '-tAF', SEP, '-c', sql
], { env: { ...process.env, PGPASSWORD: part('Password') }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  .replace(/\n$/, '').split('\n').filter(Boolean).map(row => row.split(SEP));

const one = (sql) => query(sql)[0] ?? [];

/** The run to report on: the one named, else the newest for this application. */
const RUN = arg('run') ?? one(`
  SELECT r.id FROM test_runs r
  WHERE EXISTS (SELECT 1 FROM test_executions e JOIN test_cases tc ON tc.id = e.test_case_id
                WHERE e.test_run_id = r.id AND tc.application_id = '${APP}')
  ORDER BY r.created_at DESC LIMIT 1`)[0];

if (!RUN) {
  console.error(`No run found for application ${APP}.`);
  process.exit(1);
}

const line = (text = '') => console.log(text);
/**
 * The runs this measurement is made of.
 *
 * Normally one. Run 3afa52d1 was cut short by a full disk, which left 992 tests with no
 * verdict at all, and they were re-run as 40334771 rather than repeating all 6,354. A
 * measurement spread over two runs is still one measurement, so every query below covers
 * the set — reporting either half alone would be a partial picture presented as a whole.
 */
const RUNS = (arg('runs') ?? RUN).split(',').map(id => id.trim()).filter(Boolean);
const RUN_SET = RUNS.map(id => `'${id}'`).join(',');

line(`\nCollecting ${RUNS.length > 1 ? `${RUNS.length} runs (${RUNS.join(', ')})` : `run ${RUN}`} for application ${APP}\n`);

// ---- execution verdicts -----------------------------------------------------
// ExecutionStatus: Passed=10 Failed=11 Skipped=12 Blocked=13 Healed=14 Flaky=15
// TimedOut=16 Cancelled=17 Error=18; anything under 10 has not finished.
/**
 * One verdict per test, not one row per attempt.
 *
 * A test re-run in a later run has two execution rows: the first run's, and the one that
 * actually says what the application did. Counting both reported 7,346 executions for a
 * suite of 6,354 and carried 992 phantom "blocked" results beside the real verdicts for
 * the same tests — a suite looking 16% larger and considerably worse than it is. The most
 * recent attempt per test case is the verdict; the earlier ones are history.
 */
const LATEST_PER_CASE = `
  SELECT DISTINCT ON (e.test_case_id) e.*
  FROM test_executions e
  WHERE e.test_run_id IN (${RUN_SET})
  ORDER BY e.test_case_id, e.created_at DESC, e.id DESC`;

const verdicts = Object.fromEntries(query(`
  SELECT e.status::text, count(*)::text FROM (${LATEST_PER_CASE}) e GROUP BY e.status`));
const count = (status) => Number(verdicts[String(status)] ?? 0);

const execution = {
  runId: RUN,
  runIds: RUNS,
  total: Object.values(verdicts).reduce((sum, n) => sum + Number(n), 0),
  passed: count(10) + count(14),
  failed: count(11) + count(16) + count(18),
  blocked: count(13),
  skipped: count(12),
  cancelled: count(17),
  stillPending: count(0) + count(1) + count(2),
  byStatus: verdicts
};

// ---- the failures themselves ------------------------------------------------
// The route is read from the database, not hoped for in the prose.
//
// A form test is named after its form — "Adjust MF-1333: carries an anti-forgery token" —
// so the screen it ran on appears nowhere in its text. The detector could only place a
// failure by finding the screen's path inside the message, which meant every finding on a
// form was invisible to it. FP_D29 was detected by that exact test and scored "possible"
// against unrelated evidence, because the one fact needed to join them was sitting in a
// column nobody selected. 1,076 of 1,138 failures have a route; it travels with them now.
const failures = query(`
  SELECT e.test_case_id::text,
         coalesce(tc.name, ''),
         replace(replace(coalesce(left(e.error_message, 400), ''), chr(10), ' '), chr(13), ' '),
         coalesce(tc.category::text, ''),
         coalesce(tc.technique, ''),
         coalesce(tc.field_key, ''),
         coalesce(af.route, '')
  FROM test_executions e JOIN test_cases tc ON tc.id = e.test_case_id
  LEFT JOIN application_forms af ON af.id = tc.application_form_id
  WHERE e.test_run_id IN (${RUN_SET}) AND e.status IN (11, 16, 18)
    AND e.id IN (SELECT id FROM (${LATEST_PER_CASE}) latest)`)
  .map(([testCaseId, name, message, category, technique, fieldKey, route]) =>
    ({ testCaseId, name, message, category, technique, fieldKey, route, title: name, url: '', evidence: '' }));

// ---- the structural findings, which are a third stream of evidence --------
//
// The form engine reports heuristics read from a form's structure separately from test
// failures: a control with no label, a placeholder standing in for one, a missing
// autocomplete. They sit in their own table and nothing downstream read them, so the
// engine's own detection of FP_D21 — "Quantity to add or remove has no label tied to it;
// its placeholder is not a label", recorded twice — was invisible to every report.
//
// axe finds nothing on that page, because the accessible-name computation accepts a
// placeholder. So this stream is not a duplicate of the accessibility check; it is the
// only thing in the product that catches one of the commonest real accessibility defects.
const structural = query(`
  SELECT coalesce(af.route, ''),
         coalesce(ff.code, ''),
         coalesce(ff.severity::text, ''),
         replace(replace(coalesce(left(ff.message, 400), ''), chr(10), ' '), chr(13), ' '),
         coalesce(ff.field_key, '')
  FROM form_findings ff
  JOIN application_forms af ON af.id = ff.application_form_id
  WHERE af.application_id = '${APP}'`)
  .map(([route, code, severity, message, fieldKey]) =>
    ({ route, code, severity, message, fieldKey }));

execution.structuralFindings = structural;
line(`  ${structural.length} structural finding(s) read from the form engine's heuristics`);

execution.failures = failures;
line(`  ${execution.total} execution(s): ${execution.passed} passed, ${execution.failed} failed, `
  + `${execution.blocked} blocked, ${execution.skipped} skipped`
  + (execution.stillPending ? `, ${execution.stillPending} NOT YET RUN` : ''));
line(`  ${failures.length} failure record(s) collected`);

// ---- what the engine correlated --------------------------------------------
const defects = query(`
  SELECT id::text, coalesce(title, ''), severity::text, coalesce(category::text, ''),
         coalesce(signature, ''), occurrence_count::text
  FROM defects WHERE application_id = '${APP}'`)
  .map(([id, title, severity, category, signature, occurrences]) =>
    ({ id, title, severity: Number(severity), category, signature, occurrences: Number(occurrences) }));
line(`  ${defects.length} defect(s) correlated by the engine`);

// ---- the crawl, for reachability -------------------------------------------
const discoveryRow = one(`
  SELECT id::text, status::text, pages_discovered::text, elements_discovered::text
  FROM discovery_runs WHERE application_id = '${APP}' ORDER BY created_at DESC LIMIT 1`);
const paths = query(`
  SELECT DISTINCT coalesce(route, normalized_url) FROM application_pages WHERE application_id = '${APP}'`)
  .map(([route]) => route);

const STATUS = { 0: 'queued', 1: 'running', 2: 'completed', 3: 'failed', 4: 'cancelled', 5: 'partiallyCompleted' };
const discovery = {
  status: STATUS[discoveryRow[1]] ?? discoveryRow[1],
  pagesDiscovered: Number(discoveryRow[2] ?? 0),
  elementsDiscovered: Number(discoveryRow[3] ?? 0),
  discoveredPaths: paths
};
line(`  discovery ${discovery.status}, ${discovery.pagesDiscovered} page(s), ${paths.length} distinct path(s)`);

// ---- generation -------------------------------------------------------------
const generated = one(`
  SELECT count(*)::text, count(DISTINCT name)::text FROM test_cases WHERE application_id = '${APP}'`);
const generation = { totalCases: Number(generated[0] ?? 0), duplication: { distinct: Number(generated[1] ?? 0) } };
line(`  generation ${generation.totalCases} case(s), ${generation.duplication.distinct} distinct name(s)`);

// ---- which oracles actually ran ---------------------------------------------
// The point of the exercise: a new oracle that was generated but never executed has not
// been measured, and saying otherwise is the failure this whole lab exists to prevent.
const oracleRuns = query(`
  SELECT s.action::text,
         count(*) FILTER (WHERE e.status IN (10, 14))::text,
         count(*) FILTER (WHERE e.status IN (11, 16, 18))::text
  FROM test_steps s
  JOIN test_cases tc ON tc.id = s.test_case_id
  JOIN (${LATEST_PER_CASE}) e ON e.test_case_id = tc.id
  WHERE tc.application_id = '${APP}' AND s.action >= 50
  GROUP BY s.action ORDER BY s.action`)
  .map(([action, passed, failed]) =>
    ({ action: Number(action), passed: Number(passed), failed: Number(failed) }));

const VERB = { 50: 'assertFormRejected', 51: 'assertFormAccepted', 52: 'assertFieldInvalid',
  53: 'assertFieldValid', 54: 'assertErrorAssociated', 55: 'assertFocused', 56: 'assertNoServerError',
  57: 'assertRequests', 58: 'assertLoadTimeUnder', 59: 'assertNoMarkupInjection', 60: 'assertPresent',
  61: 'assertValueLength', 62: 'assertNoHorizontalScroll', 63: 'assertServerEnforces',
  64: 'assertNotColourOnly',
  // Added with the calculation, authorization and state oracles. Their absence was not a
  // cosmetic gap: `VERB[row.action] ?? row.action` fell back to the numeric id, numbers
  // have no padEnd, and the collector threw at the first row carrying a new verb — after
  // printing a partial table and before writing the result file. The run looked collected
  // and the detection analysis then read the *previous* run's file, which is a stale
  // number presented as a fresh one.
  65: 'assertTotalsAddUp', 66: 'assertDisplayedCountMatches',
  67: 'assertPercentageLineConsistent', 68: 'assertHiddenMeansForbidden',
  69: 'assertStateForbidsAction' };
// These count tests that CARRY the verb, not verdicts of the verb itself: a test with
// both assertFormRejected and assertServerEnforces appears under each, and a failure may
// have happened at an earlier step. Attribution to a particular oracle comes from the
// failure message, below, which is the only place the acting oracle identifies itself.
line('\n  Tests carrying each oracle (not per-oracle verdicts — see attribution below):');
for (const row of oracleRuns) {
  line(`    ${String(VERB[row.action] ?? `action ${row.action}`).padEnd(26)} ${String(row.passed).padStart(5)} passed  `
    + `${String(row.failed).padStart(4)} failed`);
}

// ---- which oracle actually raised each failure ------------------------------
// The only honest attribution available: each oracle's message is distinctive, and there
// is no step-level result table to read instead.
const SIGNATURES = {
  'assertServerEnforces: the server accepted what the browser refused':
    '%enforced in the browser and not on the server%',
  'assertServerEnforces: the server answered 5xx instead of refusing':
    '%rather than refusing the submission%',
  'assertPercentageLineConsistent: a percentage line derives from a figure below it':
    '%derive from a figure above it%',
  'assertTotalsAddUp: a total does not equal its lines':
    '%does not equal the lines it totals%',
  'assertDisplayedCountMatches: a stated count does not match the rows':
    '%states a count it does not show%',
  'assertHiddenMeansForbidden: a withheld control is not refused by the server':
    '%enforced in the page and nowhere else%',
  'assertStateForbidsAction: a terminal state does not stop the transition':
    '%enforced by which controls the page draws%',
  'assertServerEnforces: could not read the form (tooling)':
    '%Could not read the form off the page%',
  'assertServerEnforces: could not reach the endpoint (tooling)':
    '%Could not reach%enforces the rule%',
  'assertNotColourOnly: information carried by colour alone':
    '%Information is carried by colour alone%',
  'assertNoHorizontalScroll: overflows a small screen': '%scrolled sideways%',
  'assertNoMarkupInjection: input came back as live markup': '%markup%',
  'assertErrorAssociated: error not tied to its field': '%not tied to%',
  // Not an application defect: the engine invalidating its own test data. The designer
  // captured an option value at discovery time and an earlier test in the same run
  // removed it — the invoice selects list unpaid invoices and the suite pays some of
  // them. Visible at all only because a failing select now names the options the control
  // actually has; these were opaque "locator.selectOption: Timeout" failures before.
  'stale test data: an option an earlier test in this run removed': '%that option is not offered%',
  'select step: the select has no selectable options': '%no selectable options%',
  'locator: matched more than one element': '%matched % elements%'
};
const attribution = {};
for (const [label, pattern] of Object.entries(SIGNATURES)) {
  const n = Number(one(`SELECT count(*) FROM test_executions e
    WHERE e.test_run_id IN (${RUN_SET}) AND e.status IN (11,16,18)
      AND e.id IN (SELECT id FROM (${LATEST_PER_CASE}) latest)
      AND e.error_message LIKE '${pattern}'`)[0] ?? 0);
  if (n > 0) attribution[label] = n;
}
line('\n  Failures attributed by the raising oracle\'s own message:');
for (const [label, n] of Object.entries(attribution).sort((a, b) => b[1] - a[1])) {
  line(`    ${String(n).padStart(5)}  ${label}`);
}
const unattributed = failures.length - Object.values(attribution).reduce((a, n) => a + n, 0);
line(`    ${String(unattributed).padStart(5)}  (not matched by any known signature)`);

const result = {
  collectedAt: new Date().toISOString(),
  collectedFrom: 'the control plane database, because the run-start request outlived the client',
  applicationId: APP,
  stages: {
    application: { id: APP },
    discovery,
    generation,
    execution,
    // The driver's own stage name, so either reader finds the failures.
    run: execution,
    defects: { total: defects.length, list: defects },
    security: { findings: 0, list: [] },
    oracles: oracleRuns.map(row => ({ verb: VERB[row.action] ?? String(row.action), ...row })),
    attribution: { ...attribution, unmatched: unattributed }
  }
};

const outPath = isAbsolute(OUT)
  ? OUT
  : resolve(new URL('.', import.meta.url).pathname, OUT);
await writeFile(outPath, JSON.stringify(result, null, 2) + '\n');
line(`\nWrote ${outPath}\n`);
if (execution.stillPending > 0) {
  line(`WARNING: ${execution.stillPending} execution(s) have not run yet. This is a partial`);
  line('         picture and must not be reported as the run\'s result.\n');
  process.exit(3);
}
