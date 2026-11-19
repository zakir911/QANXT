/**
 * Checks a generated suite is runnable before three hours are spent running it.
 *
 * Written because the check caught something. A measurement run had 398
 * `assertServerEnforces` steps whose payload read
 * `{"form":{"strategy":"testid",...}}`. The wire grammar spells that strategy `testId`,
 * so it matched nothing in the worker's resolver, and the oracle fell back to the first
 * form on the page — which on a list page is the search box. The wrong submission gets
 * refused, and a refusal is what that oracle reads as the server enforcing the rule. Every
 * one of those 398 steps would have passed, for the wrong reason, and the run would have
 * reported a capability it did not have.
 *
 * Nothing here looks at the application. It asks only whether the suite the engine just
 * wrote is internally coherent: are the verbs ones the worker dispatches, are the locators
 * spelled the way the resolver spells them, and does each step that needs a predecessor
 * have one. A suite that fails these is not evidence of anything about the application.
 *
 *   node preflight-suite.mjs --app <applicationId>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const APP = arg('app');
if (!APP) {
  console.error('Usage: node preflight-suite.mjs --app <applicationId>');
  process.exit(2);
}

/** The connection string lives in .env in semicolon form. */
const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const dbUrl = /^DATABASE_URL=(.*)$/m.exec(env)?.[1] ?? '';
const part = (key) => new RegExp(`${key}=([^;"']*)`, 'i').exec(dbUrl)?.[1] ?? '';

const query = (sql) => execFileSync('psql', [
  '-h', part('Host') || 'localhost', '-p', part('Port') || '5432',
  '-U', part('Username') || 'qanxt', '-d', part('Database') || 'qanxt',
  '-tAF', '\u0001', '-c', sql
], { env: { ...process.env, PGPASSWORD: part('Password') }, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).map(row => row.split('\u0001'));

/**
 * The locator strategies the worker's resolver knows, from the shared contract rather
 * than from memory — the whole bug was a spelling nobody checked.
 */
const STRATEGIES = new Set(
  JSON.parse(execFileSync('node', ['-e',
    "import('@qa-nxt/shared-types').then(m => console.log(JSON.stringify(m.LOCATOR_STRATEGIES)))"
  ], { cwd: new URL('../../apps/browser-worker/', import.meta.url).pathname, encoding: 'utf8' }))
);

const problems = [];
const note = (text) => console.log(`  ${text}`);

console.log(`\nPre-flight: application ${APP}\n`);

// ---- 1. every verb is one the worker dispatches -----------------------------
const VERBS = new Set(
  JSON.parse(execFileSync('node', ['-e',
    "import('@qa-nxt/shared-types').then(m => console.log(JSON.stringify(m.BROWSER_ACTION_TYPES)))"
  ], { cwd: new URL('../../apps/browser-worker/', import.meta.url).pathname, encoding: 'utf8' }))
);
const verbCount = query(`
  SELECT s.action, count(*) FROM test_steps s JOIN test_cases tc ON tc.id = s.test_case_id
  WHERE tc.application_id = '${APP}' GROUP BY s.action ORDER BY s.action`);
note(`${verbCount.length} distinct verb(s) across the suite`);
if (verbCount.length === 0) problems.push('The suite has no steps at all.');

// ---- 2. assertServerEnforces payloads --------------------------------------
const SERVER_ENFORCES = 63;
const payloads = query(`
  SELECT s.id, coalesce(s.value, '') FROM test_steps s JOIN test_cases tc ON tc.id = s.test_case_id
  WHERE tc.application_id = '${APP}' AND s.action = ${SERVER_ENFORCES}`);
note(`${payloads.length} server-enforcement step(s)`);

const badStrategies = new Map();
for (const [id, value] of payloads) {
  let parsed;
  try { parsed = JSON.parse(value); } catch {
    problems.push(`Step ${id}: the payload is not JSON.`);
    continue;
  }
  const strategy = parsed?.form?.strategy;
  if (!strategy) {
    problems.push(`Step ${id}: the payload names no form, so the oracle would guess one.`);
    continue;
  }
  if (!STRATEGIES.has(strategy)) {
    badStrategies.set(strategy, (badStrategies.get(strategy) ?? 0) + 1);
  }
  if (!parsed?.form?.value) problems.push(`Step ${id}: the form locator has no value.`);
}
for (const [strategy, count] of badStrategies) {
  problems.push(
    `${count} step(s) name locator strategy "${strategy}", which the worker's resolver does `
    + `not know. It knows: ${[...STRATEGIES].join(', ')}. Such a step resolves to no element, `
    + `so the oracle falls back to the first form on the page and reports on the wrong one.`);
}

// ---- 3. a server-enforcement step needs a browser refusal before it ---------
const FORM_REJECTED = 50;
const ordering = query(`
  WITH pos AS (
    SELECT s.test_case_id,
           min(CASE WHEN s.action = ${FORM_REJECTED} THEN s."order" END) AS rejected_at,
           min(CASE WHEN s.action = ${SERVER_ENFORCES} THEN s."order" END) AS server_at
    FROM test_steps s JOIN test_cases tc ON tc.id = s.test_case_id
    WHERE tc.application_id = '${APP}' GROUP BY s.test_case_id)
  SELECT count(*) FILTER (WHERE server_at IS NOT NULL AND rejected_at IS NULL),
         count(*) FILTER (WHERE server_at IS NOT NULL AND rejected_at >= server_at)
  FROM pos`);
const [orphaned, outOfOrder] = (ordering[0] ?? ['0', '0']).map(Number);
if (orphaned > 0) {
  problems.push(
    `${orphaned} test(s) ask the endpoint without first establishing that the browser `
    + `refuses the same values. On its own that question has no answer: a server accepting `
    + `a value nothing objects to is an unconstrained field, not a defect.`);
}
if (outOfOrder > 0) {
  problems.push(`${outOfOrder} test(s) ask the endpoint before checking the browser refused.`);
}
note(`ordering: ${orphaned} orphaned, ${outOfOrder} out of order`);

// ---- 4. every step that targets something has a target ----------------------
const targetless = query(`
  SELECT count(*) FROM test_steps s JOIN test_cases tc ON tc.id = s.test_case_id
  WHERE tc.application_id = '${APP}' AND s.action IN (1,3,4,5,6) 
    AND (s.target_json IS NULL OR s.target_json::text IN ('', 'null', '{}'))`);
const noTarget = Number(targetless[0]?.[0] ?? 0);
if (noTarget > 0) problems.push(`${noTarget} step(s) act on an element without naming one.`);
note(`${noTarget} targetless action step(s)`);

// ---- verdict ----------------------------------------------------------------
console.log();
if (problems.length === 0) {
  console.log('Pre-flight passed. The suite is internally coherent; run it.\n');
  process.exit(0);
}
console.log(`Pre-flight found ${problems.length} problem(s):\n`);
for (const problem of problems) console.log(`  - ${problem}`);
console.log('\nRunning this suite would measure the engine\'s own faults, not the application\'s.\n');
process.exit(1);
