/**
 * The golden-test harness.
 *
 * A golden test is a declaration plus a function. The declaration says what the test is
 * for, what has to be true before it runs, what it expects and what evidence it must
 * produce; the function does the work and returns a verdict. The harness enforces the part
 * that is easy to get wrong:
 *
 *   - a test that throws is a failure, never a skip;
 *   - a test that declares evidence and produces none is a failure, whatever it returned;
 *   - evidence is written under the test's own id and never overwrites an earlier run;
 *   - every artifact is hashed, and the hash is recorded next to the result.
 *
 * "The code ran and nothing threw" is not a pass. A pass means the action executed, the
 * expected behaviour was observed, the assertion held and the evidence exists.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';

export const ROOT = resolve(new URL('../..', import.meta.url).pathname);
export const VERIFICATION = resolve(ROOT, 'verification');
export const EVIDENCE_ROOT = resolve(VERIFICATION, 'evidence');

/** One identifier for the whole invocation, so a run's evidence stays together. */
export const RUN_ID = process.env.GOLDEN_RUN_ID
  ?? `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z`;

export const BUILD = (() => {
  try {
    return {
      commit: execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(),
      branch: execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(),
      dirty: execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim().length > 0
    };
  } catch {
    return { commit: 'unknown', branch: 'unknown', dirty: null };
  }
})();

const RESULTS = resolve(VERIFICATION, 'reports/golden-results.jsonl');

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export function evidenceDir(testId) {
  const path = resolve(EVIDENCE_ROOT, testId, RUN_ID);
  mkdirSync(path, { recursive: true });
  return path;
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function hashFile(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

/**
 * Writes one piece of evidence for a test and returns its path.
 *
 * Content may be a string, a Buffer or a value to serialise. Binary artifacts that already
 * exist elsewhere are copied in rather than referenced, so the evidence directory is
 * self-contained when it is archived.
 */
export function saveEvidence(testId, name, content) {
  const path = resolve(evidenceDir(testId), name);
  mkdirSync(dirname(path), { recursive: true });
  const data = Buffer.isBuffer(content) ? content
    : typeof content === 'string' ? content
      : JSON.stringify(content, null, 2);
  writeFileSync(path, data);
  return path;
}

// ---------------------------------------------------------------------------
// Running a test
// ---------------------------------------------------------------------------

const state = { suite: 'unknown', results: [], startedAt: null };

export function suite(name) {
  state.suite = name;
  console.log(`\n\u001b[1m── ${name} ──\u001b[0m`);
}

export function results() {
  return state.results;
}

/**
 * Executes one golden test.
 *
 * `test.run(context)` returns `{ pass, detail, metrics?, evidence? }`, where `evidence` is
 * a map of filename → content that the harness writes under the test's id. Declared
 * evidence that never appears fails the test even if it said it passed: a result with no
 * artifact cannot be checked by anyone else, which is the whole point of the exercise.
 */
export async function golden(test, context = {}) {
  const startedAt = new Date();
  const started = Date.now();
  let outcome;

  if (!test.id || !test.objective || !test.expected || !test.severity) {
    throw new Error(`Golden test ${test.id ?? '(no id)'} is missing a required declaration field.`);
  }
  if (!SEVERITIES.includes(test.severity)) {
    throw new Error(`Golden test ${test.id} has an unknown severity: ${test.severity}`);
  }

  try {
    const value = await test.run({ ...context, testId: test.id, save: (name, content) => saveEvidence(test.id, name, content) });
    outcome = {
      pass: Boolean(value?.pass),
      detail: value?.detail ?? '',
      metrics: value?.metrics ?? null,
      files: value?.evidence ?? {}
    };
  } catch (error) {
    outcome = {
      pass: false,
      detail: `threw: ${String(error?.stack ?? error).split('\n').slice(0, 2).join(' ').slice(0, 300)}`,
      metrics: null,
      files: {}
    };
  }

  const written = [];
  for (const [name, content] of Object.entries(outcome.files)) {
    if (content === undefined || content === null) continue;
    written.push(saveEvidence(test.id, name, content));
  }

  // Evidence the declaration promised. A missing artifact is a failed test, not a warning.
  const required = test.evidence ?? [];
  const produced = new Set(written.map(path => path.split('/').pop()));
  const missingEvidence = required.filter(name => !produced.has(name));

  const metadata = {
    testId: test.id,
    suite: state.suite,
    runId: RUN_ID,
    objective: test.objective,
    preconditions: test.preconditions ?? [],
    input: test.input ?? null,
    expected: test.expected,
    severity: test.severity,
    result: outcome.pass && missingEvidence.length === 0 ? 'PASS' : 'FAIL',
    detail: missingEvidence.length
      ? `${outcome.detail}${outcome.detail ? '; ' : ''}declared evidence never produced: ${missingEvidence.join(', ')}`
      : outcome.detail,
    metrics: outcome.metrics,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    build: BUILD,
    browser: context.browser ?? 'chromium',
    applicationVersion: context.applicationVersion ?? null,
    evidence: written.map(path => ({
      file: path.split('/').pop(),
      path: relative(VERIFICATION, path),
      bytes: existsSync(path) ? readFileSync(path).length : 0,
      sha256: hashFile(path)
    }))
  };

  saveEvidence(test.id, 'metadata.json', metadata);
  mkdirSync(dirname(RESULTS), { recursive: true });
  appendFileSync(RESULTS, `${JSON.stringify(metadata)}\n`);
  state.results.push(metadata);

  const mark = metadata.result === 'PASS' ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`${mark}  ${test.id.padEnd(18)} ${test.objective}${metadata.detail ? ` — ${metadata.detail}` : ''}`);
  if (metadata.result === 'FAIL' && test.severity === 'critical') process.exitCode = 1;
  return metadata;
}

/**
 * Declares a test that cannot be executed here, with the reason.
 *
 * Recorded as NOT VERIFIED rather than skipped quietly, because an unexecuted test that
 * leaves no trace is indistinguishable from one that never existed.
 */
export function notVerified(test, reason) {
  const record = {
    testId: test.id, suite: state.suite, runId: RUN_ID,
    objective: test.objective, expected: test.expected, severity: test.severity,
    result: 'NOT_VERIFIED', detail: reason,
    startedAt: new Date().toISOString(), durationMs: 0, build: BUILD, evidence: [], metrics: null
  };
  mkdirSync(dirname(RESULTS), { recursive: true });
  appendFileSync(RESULTS, `${JSON.stringify(record)}\n`);
  state.results.push(record);
  console.log(`\u001b[33mNOT VERIFIED\u001b[0m  ${test.id.padEnd(10)} ${test.objective} — ${reason}`);
  return record;
}

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export const uniqueId = () => randomUUID().slice(0, 8);
