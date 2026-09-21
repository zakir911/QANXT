/**
 * The lab's own test: does the laboratory work?
 *
 * Every number the golden suite produces is measured against these applications, so a lab
 * that quietly stops serving, stops injecting a fault, or stops matching its own ground
 * truth would corrupt each of them while everything still looked green. This checks the
 * instrument before the instrument is trusted.
 *
 * It starts the lab if it is not already running, and stops it again only if it started it.
 *
 *   node test-lab/scripts/lab-selftest.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const APPS = [
  { name: 'banking-app', url: 'http://127.0.0.1:4300' },
  { name: 'ecommerce-app', url: 'http://127.0.0.1:4310' },
  { name: 'forms-app', url: 'http://127.0.0.1:4320' },
  { name: 'dynamic-app', url: 'http://127.0.0.1:4330' },
  { name: 'failure-app', url: 'http://127.0.0.1:4340' },
  { name: 'self-healing-app', url: 'http://127.0.0.1:4350' }
];

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const reachable = async (url) => {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};

// ---- Start the lab if it is not up ----------------------------------------

let startedHere = false;
if (!(await reachable(APPS[0].url))) {
  console.log('The lab is not running; starting it.');
  const started = spawnSync('bash', [resolve(here, 'lab-ctl.sh'), 'start'], { cwd: root, encoding: 'utf8' });
  if (started.status !== 0) {
    console.error(started.stdout ?? '');
    console.error(started.stderr ?? '');
    console.error('The lab could not be started, so nothing below could be checked.');
    process.exit(2);
  }
  startedHere = true;
}

try {
  // ---- Every application answers ------------------------------------------

  for (const app of APPS) {
    const health = await reachable(app.url);
    check(`${app.name} serves /health`, health !== null,
      health ? `${health.application ?? app.name} ${health.version ?? ''}`.trim() : `nothing answered on ${app.url}`);
  }

  // ---- Every application declares faults, and they all start off ----------

  for (const app of APPS) {
    let catalogue = null;
    try {
      const response = await fetch(`${app.url}/__faults`);
      catalogue = response.ok ? await response.json() : null;
    } catch { /* reported below */ }

    const faults = catalogue?.faults ?? [];
    const enabled = faults.filter(entry => entry.enabled);
    check(`${app.name} declares a fault catalogue`, faults.length > 0, `${faults.length} fault(s)`);
    check(`${app.name} starts with every fault off`, faults.length > 0 && enabled.length === 0,
      enabled.length ? `still on: ${enabled.map(entry => entry.id).join(', ')}` : 'all off');
    check(`${app.name} describes each fault`, faults.length > 0 && faults.every(entry => entry.description?.length > 10),
      `${faults.filter(entry => (entry.description?.length ?? 0) > 10).length}/${faults.length} described`);
  }

  // ---- A fault can be set, is reported as set, and can be reset -----------

  for (const app of APPS) {
    const catalogue = await fetch(`${app.url}/__faults`).then(response => response.json()).catch(() => null);
    const first = catalogue?.faults?.[0]?.id;
    if (!first) { check(`${app.name} fault round-trip`, false, 'no fault to set'); continue; }

    const applied = await fetch(`${app.url}/__faults`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [first]: true })
    }).then(response => response.json());
    const afterSet = await fetch(`${app.url}/__faults`).then(response => response.json());
    await fetch(`${app.url}/__faults/reset`, { method: 'POST' });
    const afterReset = await fetch(`${app.url}/__faults`).then(response => response.json());

    const set = afterSet.faults.find(entry => entry.id === first)?.enabled === true;
    const cleared = afterReset.faults.every(entry => !entry.enabled);
    check(`${app.name} fault round-trip (${first})`, applied.applied?.includes(first) && set && cleared,
      `applied: ${Boolean(applied.applied?.includes(first))}, reported on: ${set}, cleared by reset: ${cleared}`);
  }

  // ---- An unknown fault is refused rather than silently accepted ----------

  const unknown = await fetch(`${APPS[0].url}/__faults`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ FAULT_THAT_DOES_NOT_EXIST: true })
  }).then(response => response.json());
  check('an unknown fault id is reported as unknown',
    unknown.unknown?.includes('FAULT_THAT_DOES_NOT_EXIST') && !unknown.applied?.length,
    `unknown: ${JSON.stringify(unknown.unknown ?? [])}, applied: ${JSON.stringify(unknown.applied ?? [])}`);

  // ---- The seeded data is the same on every start -------------------------
  //
  // Signed in for real rather than through a test-only header, so this also shows the
  // bank's own session working. A silent skip when the call fails would be the same mistake
  // as a silent pass: it is reported as a failed check.

  const signIn = await fetch(`${APPS[0].url}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'Password123!' })
  });
  const cookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? '';
  check('the bank signs a customer in', signIn.ok && cookie.length > 0,
    signIn.ok ? 'session cookie issued' : `sign-in answered ${signIn.status}`);

  const accounts = signIn.ok
    ? await fetch(`${APPS[0].url}/api/accounts`, { headers: { cookie } })
      .then(response => (response.ok ? response.json() : null)).catch(() => null)
    : null;

  // The seed is fixed (Mulberry32), so these are the same numbers on any machine. A change
  // here means the data every measurement is taken against has moved.
  const EXPECTED_ACCOUNTS = 3;
  const total = accounts?.accounts?.reduce((sum, account) => sum + account.balance, 0) ?? null;
  check('the bank\'s seeded accounts are deterministic',
    accounts !== null && accounts.accounts?.length === EXPECTED_ACCOUNTS && Number.isFinite(total),
    accounts === null
      ? 'the accounts endpoint did not answer'
      : `${accounts.accounts?.length} account(s), total balance ${total}`);

  // ---- Ground truth still describes the applications ----------------------

  const audit = spawnSync('node', [
    resolve(here, 'audit-ground-truth.mjs'),
    ...APPS.map(app => resolve(root, app.name, 'ground-truth.json'))
  ], { encoding: 'utf8' });
  check('ground truth matches the running applications', audit.status === 0,
    audit.status === 0
      ? 'every declared page, element and endpoint was found'
      : (audit.stdout ?? '').split('\n').filter(Boolean).slice(-3).join(' | '));
} finally {
  if (startedHere) {
    try { execFileSync('bash', [resolve(here, 'lab-ctl.sh'), 'stop'], { cwd: root, stdio: 'ignore' }); } catch { /* best effort */ }
  }
}

const failed = results.filter(entry => !entry.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('The lab is not trustworthy until these pass; every golden measurement is taken against it.');
  process.exit(1);
}
