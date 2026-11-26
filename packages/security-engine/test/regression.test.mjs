import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRIAGE_STATUSES, compareToBaseline, fingerprint, suppressionApplies, triage
} from '../src/regression.mjs';

/**
 * Telling this scan apart from the last one.
 *
 * Three jobs, each with a way of being quietly wrong. Deciding two findings are the same
 * flaw, which if done too loosely hides a real one behind a suppression somebody granted
 * elsewhere. Deciding a flaw has come back. And refusing to let anybody set a finding aside
 * without saying why and signing their name — which is the difference between a security gate
 * and decoration.
 *
 * 35.2% line coverage, no test file.
 */

const finding = (overrides = {}) => ({
  application: 'app.test',
  category: 'MissingCsrfToken',
  endpoint: '/orders/new',
  parameter: null,
  observedAsRole: 'operations',
  severity: 'High',
  check: 'request.csrf',
  ...overrides
});

// ---- is this the same flaw as last time? ---------------------------------------------

test('the same flaw on the same address fingerprints the same, run after run', () => {
  assert.equal(fingerprint(finding()), fingerprint(finding()));
  // And it does not depend on anything that changes between runs.
  assert.equal(fingerprint(finding()),
               fingerprint(finding({ severity: 'Critical', confidence: 'Low', id: 'x' })));
});

test('each thing that makes it a different flaw changes the fingerprint', () => {
  const base = fingerprint(finding());

  assert.notEqual(base, fingerprint(finding({ application: 'other.test' })));
  assert.notEqual(base, fingerprint(finding({ category: 'MissingOriginValidation' })));
  assert.notEqual(base, fingerprint(finding({ endpoint: '/orders/edit' })));
  assert.notEqual(base, fingerprint(finding({ parameter: 'id' })));
  assert.notEqual(base, fingerprint(finding({ observedAsRole: 'viewer' })));
});

test('a finding missing everything still fingerprints rather than throwing', () => {
  assert.match(fingerprint({}), /^[0-9a-f]{16}$/);
});

// ---- new, carried forward, come back -------------------------------------------------

test('a finding the baseline never had is new', () => {
  const result = compareToBaseline([finding()], []);

  assert.equal(result.findings[0].isNew, true);
  assert.equal(result.findings[0].isRegression, false);
  assert.equal(result.summary.new, 1);
});

test('a new finding with no status of its own is Potential, not Confirmed', () => {
  assert.equal(compareToBaseline([finding()], []).findings[0].status, 'Potential');
});

test('a finding the baseline had resolved has come back, and says so', () => {
  const result = compareToBaseline([finding()], [finding({ status: 'Resolved' })]);

  const back = result.findings[0];
  assert.equal(back.isRegression, true);
  assert.equal(back.isNew, false);
  assert.equal(back.status, 'Regressed');
  assert.match(back.regressionNote, /recorded as resolved and has been detected again/);
  assert.equal(result.summary.regressed, 1);
});

test('a finding still open is carried forward, keeping the decision somebody made', () => {
  const result = compareToBaseline([finding()], [finding({
    status: 'Accepted',
    justification: 'Compensating control at the gateway, reviewed 2026-11-01.',
    decidedBy: 'a.khan'
  })]);

  const carried = result.findings[0];
  assert.equal(carried.isNew, false);
  assert.equal(carried.isRegression, false);
  assert.equal(carried.status, 'Accepted');
  assert.equal(carried.decidedBy, 'a.khan');
  assert.equal(result.summary.carriedForward, 1);
});

test('the decision carries forward but the severity does not', () => {
  // A flaw somebody accepted may have got worse since. The acceptance was of the flaw, not of
  // whatever it has become.
  const result = compareToBaseline(
    [finding({ severity: 'Critical' })],
    [finding({ severity: 'Low', status: 'Accepted', justification: 'x'.repeat(30), decidedBy: 'a' })]);

  assert.equal(result.findings[0].severity, 'Critical');
  assert.equal(result.findings[0].status, 'Accepted');
});

// ---- what the baseline had and this scan did not --------------------------------------

test('an absent finding is never resolved on absence alone', () => {
  const result = compareToBaseline([], [finding()], ['request.csrf']);

  const gone = result.disappeared[0];
  assert.equal(gone.outcome, 'notReproduced');
  assert.match(gone.note, /not a resolution on its own/);
  assert.equal(result.summary.notReproduced, 1);
});

test('when the check did not run, its absence is evidence of nothing and says so', () => {
  const result = compareToBaseline([], [finding()], ['passive.headers']);

  const gone = result.disappeared[0];
  assert.equal(gone.outcome, 'notObserved');
  assert.match(gone.note, /did not run in this scan, so its absence is not evidence/);
  assert.equal(result.summary.notObserved, 1);
});

test('when nobody recorded which checks ran, nothing is concluded either', () => {
  const result = compareToBaseline([], [finding()], null);

  assert.equal(result.disappeared[0].outcome, 'notObserved');
  assert.match(result.disappeared[0].note, /was not recorded/);
});

test('a finding present in both is not reported as disappeared', () => {
  const result = compareToBaseline([finding()], [finding()], ['request.csrf']);

  assert.deepEqual(result.disappeared, []);
});

test('the summary adds up to what was put in', () => {
  const result = compareToBaseline(
    [finding({ endpoint: '/a' }), finding({ endpoint: '/b' })],
    [finding({ endpoint: '/b' }), finding({ endpoint: '/c' })],
    ['request.csrf']);

  assert.equal(result.summary.current, 2);
  assert.equal(result.summary.baseline, 2);
  assert.equal(result.summary.new, 1);
  assert.equal(result.summary.carriedForward, 1);
  assert.equal(result.summary.notReproduced, 1);
});

test('an empty scan against an empty baseline is empty rather than an error', () => {
  const result = compareToBaseline([], []);

  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.disappeared, []);
  assert.equal(result.summary.new, 0);
});

test('every finding carries its fingerprint out, so a caller can key a decision on it', () => {
  const result = compareToBaseline([finding()], [finding({ status: 'Resolved' })], []);

  assert.match(result.findings[0].fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(result.findings[0].fingerprint, fingerprint(finding()));
});

// ---- setting a finding aside has to cost somebody their name --------------------------

test('a status nobody recognises is refused', () => {
  assert.throws(() => triage(finding(), { status: 'Probably Fine' }),
    /Unknown security finding status/);
});

test('a false positive with no reason is refused, and the refusal explains itself', () => {
  assert.throws(
    () => triage(finding(), { status: 'FalsePositive', decidedBy: 'a.khan' }),
    /indistinguishable from turning the check off/);
});

test('a false positive with no name is refused', () => {
  assert.throws(
    () => triage(finding(), {
      status: 'FalsePositive',
      justification: 'The endpoint is behind the gateway which enforces the token.'
    }),
    /no named decision-maker/);
});

test('a reason too short to be a reason is refused', () => {
  // "wontfix" is not a justification.
  assert.throws(
    () => triage(finding(), { status: 'FalsePositive', justification: 'not real', decidedBy: 'a.khan' }),
    /too short to be one/);
});

test('both suppressing statuses are held to the same standard', () => {
  for (const status of ['FalsePositive', 'Accepted']) {
    assert.throws(() => triage(finding(), { status, decidedBy: 'a.khan' }), /justification/, status);
  }
});

test('a status that does not suppress anything needs no justification', () => {
  // Confirming or asking for a second look costs nobody anything, so it is not gated.
  for (const status of ['Potential', 'Confirmed', 'NeedsReview', 'Resolved', 'Regressed']) {
    const out = triage(finding(), { status });
    assert.equal(out.status, status, status);
  }
});

test('a proper suppression is accepted and records who decided and when', () => {
  const out = triage(finding(), {
    status: 'Accepted',
    justification: 'Mitigated by the gateway rule added in change 4471; verified by hand.',
    decidedBy: 'a.khan',
    at: '2026-11-26T10:00:00.000Z'
  });

  assert.equal(out.status, 'Accepted');
  assert.equal(out.decidedBy, 'a.khan');
  assert.equal(out.triagedAt, '2026-11-26T10:00:00.000Z');
});

test('the decision is appended, so the trail shows what was thought before', () => {
  const first = triage(finding(), { status: 'Confirmed' });
  const second = triage(first, {
    status: 'FalsePositive',
    justification: 'The gateway strips this header before the application sees it.',
    decidedBy: 'r.vasquez'
  });

  assert.equal(second.triageHistory.length, 2);
  assert.equal(second.triageHistory[0].status, 'Confirmed');
  assert.equal(second.triageHistory[1].from, 'Confirmed');
  assert.equal(second.triageHistory[1].decidedBy, 'r.vasquez');
});

test('the first decision records what the finding was before anybody touched it', () => {
  assert.equal(triage(finding(), { status: 'Confirmed' }).triageHistory[0].from, 'Potential');
});

test('the finding is not mutated, so a caller cannot lose the original by accident', () => {
  const original = finding({ status: 'Potential' });
  triage(original, { status: 'Confirmed' });

  assert.equal(original.status, 'Potential');
  assert.equal(original.triageHistory, undefined);
});

test('the recognised statuses are the documented set', () => {
  assert.deepEqual([...TRIAGE_STATUSES].sort(),
    ['Accepted', 'Confirmed', 'FalsePositive', 'NeedsReview', 'Potential', 'Regressed', 'Resolved']);
});

// ---- a suppression covers one flaw, not a category ------------------------------------

test('a suppression applies to the flaw it was granted for', () => {
  const target = finding();

  assert.equal(suppressionApplies({ fingerprint: fingerprint(target) }, target), true);
});

test('and not to the same category somewhere else, which would hide a real one', () => {
  // Marking one endpoint's finding a false positive says something about that endpoint.
  // Applying it to every finding of that category would suppress the ones that are real.
  const suppression = { fingerprint: fingerprint(finding({ endpoint: '/orders/new' })) };

  assert.equal(suppressionApplies(suppression, finding({ endpoint: '/claims/settle' })), false);
});

test('nor to the same address seen as a different role', () => {
  const suppression = { fingerprint: fingerprint(finding({ observedAsRole: 'operations' })) };

  assert.equal(suppressionApplies(suppression, finding({ observedAsRole: 'viewer' })), false);
});
