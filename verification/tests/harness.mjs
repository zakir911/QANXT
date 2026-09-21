/**
 * Verification harness.
 *
 * Records what was actually executed, when, and what evidence it produced. Nothing writes a
 * result here without having run something: every `check` takes a function whose return
 * value decides the verdict, and evidence paths are recorded only after the file exists on
 * disk with a hash taken from its bytes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';

export const ROOT = resolve(new URL('../..', import.meta.url).pathname);
export const EVIDENCE = resolve(ROOT, 'verification');

export const API = (process.env.AIRA_API_URL ?? 'http://127.0.0.1:5080').replace(/\/+$/, '');
export const CONSOLE_URL = (process.env.AIRA_CONSOLE_URL ?? 'http://127.0.0.1:5173').replace(/\/+$/, '');
export const BANK = (process.env.AIRA_DEMO_BANK_URL ?? 'http://localhost:4200').replace(/\/+$/, '');

/**
 * The ledger every check appends to. It is redirectable so that a deliberate negative
 * control — a suite run against a broken build, to prove the check can fail — records its
 * result somewhere other than the ledger that describes the product as it stands.
 */
const RESULTS = process.env.AIRA_VERIFY_RESULTS
  ? resolve(EVIDENCE, process.env.AIRA_VERIFY_RESULTS)
  : resolve(EVIDENCE, 'reports/results.jsonl');

export function evidencePath(...parts) {
  const path = resolve(EVIDENCE, ...parts);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** Hashing the bytes is what ties a report line to a specific file. */
export function hashFile(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function saveEvidence(relativePath, content) {
  const path = evidencePath(relativePath);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return path;
}

const suiteState = { suite: 'unknown', results: [] };

export function suite(name) {
  suiteState.suite = name;
  console.log(`\n=== ${name} ===`);
}

/**
 * Runs one check. `fn` returns { pass, detail, evidence[] } or throws.
 * A thrown error is a failure, never a skip: a check that could not run has not passed.
 */
export async function check(id, capability, fn) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let outcome;

  try {
    const result = await fn();
    outcome = {
      pass: Boolean(result?.pass),
      detail: result?.detail ?? '',
      evidence: result?.evidence ?? []
    };
  } catch (error) {
    outcome = {
      pass: false,
      detail: `threw: ${String(error).split('\n').slice(0, 2).join(' ')}`,
      evidence: []
    };
  }

  const record = {
    id,
    suite: suiteState.suite,
    capability,
    result: outcome.pass ? 'PASS' : 'FAIL',
    detail: outcome.detail,
    startedAt,
    durationMs: Date.now() - started,
    evidence: outcome.evidence
      .filter(path => existsSync(path))
      .map(path => ({ path: relative(EVIDENCE, path), sha256: hashFile(path) }))
  };

  suiteState.results.push(record);
  mkdirSync(dirname(RESULTS), { recursive: true });
  appendFileSync(RESULTS, `${JSON.stringify(record)}\n`);

  const mark = record.result === 'PASS' ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${id}  ${capability}${record.detail ? ` — ${record.detail}` : ''}`);
  if (record.result === 'FAIL') process.exitCode = 1;
  return record;
}

// ---- HTTP helpers ---------------------------------------------------------

/** Returns the full exchange, so a check can assert on status as well as body. */
export async function request(path, options = {}) {
  const { token, method = 'GET', body, headers = {}, raw = false } = options;
  const url = path.startsWith('http') ? path : `${API}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {})
    });
  } catch (error) {
    return { ok: false, status: 0, text: String(error), json: null, headers: new Headers() };
  }

  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json; the text is the evidence */ }
  return { ok: response.ok, status: response.status, text, json, headers: response.headers };
}

export async function login(email, password, organizationSlug) {
  const response = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password, organizationSlug: organizationSlug ?? null }
  });
  return response.json?.accessToken ?? null;
}

/** Registers a throwaway organization and returns its administrator's session. */
export async function newTenant(label = 'Verify') {
  const unique = Math.random().toString(36).slice(2, 12);
  const email = `${label.toLowerCase()}-${unique}@example.test`;
  const password = 'Str0ngPassphrase!2026';
  const response = await request('/api/v1/auth/register', {
    method: 'POST',
    body: { organizationName: `${label} ${unique}`, email, password, displayName: `${label} Admin` }
  });
  if (!response.ok) throw new Error(`could not register a tenant: ${response.status} ${response.text.slice(0, 200)}`);
  return {
    token: response.json.accessToken,
    refreshToken: response.json.refreshToken,
    userId: response.json.user.userId,
    organizationId: response.json.user.organizationId,
    email,
    password
  };
}

export const scenario = (patch) => fetch(`${BANK}/__control/scenario`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(patch)
});

/**
 * Turns every switch off, read from the target application rather than from a list kept
 * here. A hard-coded list silently stops covering a switch the moment one is added, and a
 * leftover switch contaminates the next test in a way that looks like a product defect.
 */
export async function resetScenario() {
  const current = await (await fetch(`${BANK}/health`)).json();
  const off = Object.fromEntries(Object.keys(current.scenario ?? {}).map(key => [key, false]));
  return scenario(off);
}

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Polls a run to a terminal verdict. Returns null on timeout rather than guessing. */
export async function waitForRun(token, runId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(['passed', 'failed', 'error', 'cancelled', 'blocked']);
  while (Date.now() < deadline) {
    const run = await request(`/api/v1/testruns/${runId}`, { token });
    if (run.json && terminal.has(run.json.status)) return run.json;
    await sleep(2000);
  }
  return null;
}
