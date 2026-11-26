import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, OUTCOME, evaluateSecurityGate } from '../src/gate.mjs';

/**
 * The gate that decides whether a build passes.
 *
 * It had 17.3% line coverage and no test file of its own — the lowest-covered file in the
 * engine, and the one whose answer a customer acts on. Everything else in this product
 * produces information; this turns it into a verdict, and a verdict that is wrong in the
 * permissive direction is a build shipped on a scan that proved nothing.
 *
 * The three outcomes mean different things and the difference is the point. PASS says it was
 * tested and found clean. REVIEW says a person has to look. FAIL stops the build. The one
 * mistake this file must never make is reporting PASS for a scan that did not really happen.
 */

/** Coverage that would pass on its own, so each test can take one thing away. */
const scanned = (overrides = {}) => ({
  scanRan: true,
  profile: 'standard',
  requestsIssued: 400,
  requestsBlocked: 0,
  checksConfigured: Array.from({ length: 10 }, (_, i) => `check-${i}`),
  checksExecuted: Array.from({ length: 10 }, (_, i) => `check-${i}`),
  untestedAreas: [],
  ...overrides
});

const finding = (overrides = {}) => ({
  id: Math.random().toString(36).slice(2),
  category: 'MissingCsrfToken',
  severity: 'High',
  confidence: 'High',
  status: 'Open',
  hasEvidence: true,
  isNew: true,
  isRegression: false,
  ...overrides
});

const ruleNamed = (result, fragment) =>
  result.rules.find(r => r.name.toLowerCase().includes(fragment.toLowerCase()));

// ---- the scan has to have happened ----------------------------------------------------

test('no scan is REVIEW, never PASS, and the summary says so in words', () => {
  // The mistake that matters most. "Not tested" and "tested and clean" are not the same
  // sentence, and a build that was never scanned must not read as a build that was.
  const result = evaluateSecurityGate({ scanRan: false }, []);

  assert.equal(result.outcome, OUTCOME.REVIEW);
  assert.equal(result.outcomeName, 'REVIEW');
  assert.equal(result.blocked, false);
  assert.match(result.summary, /NOT SCANNED/);
  assert.match(result.reasons.join(' '), /not the same as/);
});

test('missing coverage altogether is treated as no scan rather than a clean one', () => {
  for (const coverage of [null, undefined, {}]) {
    assert.equal(evaluateSecurityGate(coverage, []).outcome, OUTCOME.REVIEW);
  }
});

test('a clean scan with nothing found passes', () => {
  const result = evaluateSecurityGate(scanned(), []);

  assert.equal(result.outcome, OUTCOME.PASS);
  assert.equal(result.blocked, false);
  assert.equal(ruleNamed(result, 'a security scan ran').passed, true);
});

// ---- how much of it ran ---------------------------------------------------------------

test('a partial scan is REVIEW: a result from the part that ran describes only that part', () => {
  const result = evaluateSecurityGate(
    scanned({ checksExecuted: Array.from({ length: 5 }, (_, i) => `check-${i}`) }), []);

  assert.equal(result.outcome, OUTCOME.REVIEW);
  assert.equal(ruleNamed(result, 'enough of the configured checks').passed, false);
  assert.match(result.reasons.join(' '), /partial scan/);
});

test('the coverage threshold is honoured exactly, at the boundary', () => {
  const eight = Array.from({ length: 8 }, (_, i) => `check-${i}`);
  const seven = Array.from({ length: 7 }, (_, i) => `check-${i}`);

  assert.equal(evaluateSecurityGate(scanned({ checksExecuted: eight }), []).outcome, OUTCOME.PASS);
  assert.equal(evaluateSecurityGate(scanned({ checksExecuted: seven }), []).outcome, OUTCOME.REVIEW);
});

test('no checks configured is REVIEW, because a clean result means only that nothing was asked', () => {
  const result = evaluateSecurityGate(scanned({ checksConfigured: [], checksExecuted: [] }), []);

  assert.equal(result.outcome, OUTCOME.REVIEW);
  assert.match(result.reasons.join(' '), /nothing was asked/);
  // And the rule says it was not measured, rather than claiming a pass.
  assert.equal(ruleNamed(result, 'enough of the configured checks').measured, false);
});

test('a stricter coverage policy is applied', () => {
  const nine = Array.from({ length: 9 }, (_, i) => `check-${i}`);

  assert.equal(evaluateSecurityGate(scanned({ checksExecuted: nine }), []).outcome, OUTCOME.PASS);
  assert.equal(evaluateSecurityGate(scanned({ checksExecuted: nine }), [],
                                    { minimumCheckCoverage: 0.95 }).outcome, OUTCOME.REVIEW);
});

// ---- what the scope refused -----------------------------------------------------------

test('a scan mostly refused by its own scope is REVIEW', () => {
  const result = evaluateSecurityGate(scanned({ requestsIssued: 100, requestsBlocked: 100 }), []);

  assert.equal(result.outcome, OUTCOME.REVIEW);
  assert.match(result.reasons.join(' '), /refused by its own scope/);
});

test('a few refusals do not spoil a scan', () => {
  assert.equal(evaluateSecurityGate(
    scanned({ requestsIssued: 400, requestsBlocked: 20 }), []).outcome, OUTCOME.PASS);
});

// ---- suppression has to be accountable ------------------------------------------------

test('a finding dismissed with no reason FAILS, because that is switching the check off', () => {
  const result = evaluateSecurityGate(scanned(), [
    finding({ status: 'FalsePositive', justification: '', decidedBy: '' })
  ]);

  assert.equal(result.outcome, OUTCOME.FAIL);
  assert.equal(result.blocked, true);
  assert.match(result.reasons.join(' '), /indistinguishable from switching the check off/);
});

test('a reason without a name is still unaccountable', () => {
  const result = evaluateSecurityGate(scanned(), [
    finding({ status: 'Accepted', justification: 'Accepted for this release.', decidedBy: '  ' })
  ]);

  assert.equal(result.outcome, OUTCOME.FAIL);
});

test('a name without a reason is still unaccountable', () => {
  const result = evaluateSecurityGate(scanned(), [
    finding({ status: 'FalsePositive', justification: '   ', decidedBy: 'a.khan' })
  ]);

  assert.equal(result.outcome, OUTCOME.FAIL);
});

test('a properly justified suppression is set aside and does not fail the build', () => {
  const result = evaluateSecurityGate(scanned(), [
    finding({ severity: 'Critical', status: 'Accepted',
              justification: 'Compensating control at the gateway, reviewed 2026-11-20.',
              decidedBy: 'a.khan' })
  ]);

  assert.equal(result.outcome, OUTCOME.PASS);
  assert.equal(ruleNamed(result, 'written justification').passed, true);
});

// ---- a claim nobody can check ---------------------------------------------------------

test('a finding with no evidence is REVIEW: neither failed nor quietly dropped', () => {
  const result = evaluateSecurityGate(scanned(), [
    finding({ severity: 'Critical', hasEvidence: false })
  ]);

  assert.equal(result.outcome, OUTCOME.REVIEW);
  assert.equal(result.blocked, false);
  assert.match(result.reasons.join(' '), /nobody can check/);
});

test('an evidenceless finding is not also counted as a failing one', () => {
  // It would otherwise fail the build on severity while being reported as unverifiable.
  const result = evaluateSecurityGate(scanned(), [
    finding({ severity: 'Critical', hasEvidence: false, isNew: true })
  ]);

  assert.equal(result.outcome, OUTCOME.REVIEW);
});

// ---- new findings ---------------------------------------------------------------------

test('a new high finding fails the build', () => {
  const result = evaluateSecurityGate(scanned(), [finding({ severity: 'High' })]);

  assert.equal(result.outcome, OUTCOME.FAIL);
  assert.match(result.reasons.join(' '), /MissingCsrfToken/);
});

test('a new medium finding does not, on the default policy', () => {
  assert.equal(evaluateSecurityGate(scanned(), [finding({ severity: 'Medium' })]).outcome,
               OUTCOME.PASS);
});

test('the threshold is a policy, and a stricter one is obeyed', () => {
  const result = evaluateSecurityGate(scanned(), [finding({ severity: 'Medium' })],
                                      { failOnNewAtOrAbove: 'Medium' });

  assert.equal(result.outcome, OUTCOME.FAIL);
});

test('a new high finding on a single unreproduced indicator is REVIEW, not FAIL', () => {
  // A person should look rather than the build stopping on one weak signal.
  const result = evaluateSecurityGate(scanned(), [
    finding({ severity: 'Critical', confidence: 'Low' })
  ]);

  assert.equal(result.outcome, OUTCOME.REVIEW);
  assert.match(result.reasons.join(' '), /single unreproduced indicator/);
});

test('that leniency can be switched off, and then low confidence fails too', () => {
  const result = evaluateSecurityGate(scanned(), [
    finding({ severity: 'Critical', confidence: 'Low' })
  ], { reviewLowConfidenceInsteadOfFailing: false });

  assert.equal(result.outcome, OUTCOME.FAIL);
});

test('a resolved finding is not open and does not fail the build', () => {
  assert.equal(evaluateSecurityGate(scanned(), [
    finding({ severity: 'Critical', status: 'Resolved' })
  ]).outcome, OUTCOME.PASS);
});

// ---- findings that were already there -------------------------------------------------

test('a pre-existing critical fails: a finding does not become acceptable by being old', () => {
  const result = evaluateSecurityGate(scanned(), [
    finding({ severity: 'Critical', isNew: false })
  ]);

  assert.equal(result.outcome, OUTCOME.FAIL);
  assert.match(result.reasons.join(' '), /does not become acceptable by being old/);
});

test('a pre-existing high does not fail on the default policy, which is deliberate', () => {
  // New work is held to a higher standard than the backlog it inherited, so a team can adopt
  // the gate without the first run blocking everything.
  assert.equal(evaluateSecurityGate(scanned(), [
    finding({ severity: 'High', isNew: false })
  ]).outcome, OUTCOME.PASS);
});

test('the same finding fails when it is new and passes when it is not', () => {
  const asNew = evaluateSecurityGate(scanned(), [finding({ severity: 'High', isNew: true })]);
  const asOld = evaluateSecurityGate(scanned(), [finding({ severity: 'High', isNew: false })]);

  assert.equal(asNew.outcome, OUTCOME.FAIL);
  assert.equal(asOld.outcome, OUTCOME.PASS);
});

// ---- something that was fixed and came back -------------------------------------------

test('a regression fails, whatever its severity', () => {
  const result = evaluateSecurityGate(scanned(), [
    finding({ severity: 'Low', isRegression: true, isNew: false })
  ]);

  assert.equal(result.outcome, OUTCOME.FAIL);
});

test('regressions can be made non-blocking by policy', () => {
  const result = evaluateSecurityGate(scanned(), [
    finding({ severity: 'Low', isRegression: true, isNew: false })
  ], { failOnRegression: false });

  assert.equal(result.outcome, OUTCOME.PASS);
});

// ---- the worst answer wins ------------------------------------------------------------

test('a build with both a REVIEW reason and a FAIL reason fails', () => {
  const result = evaluateSecurityGate(
    scanned({ checksExecuted: ['check-0'] }),
    [finding({ severity: 'High' })]);

  assert.equal(result.outcome, OUTCOME.FAIL);
  // And both reasons are reported, so the reader sees everything wrong rather than the worst.
  assert.ok(result.reasons.length >= 2);
});

test('an outcome never improves as more rules are checked', () => {
  const result = evaluateSecurityGate(
    scanned({ requestsBlocked: 1000 }),
    [finding({ severity: 'Critical', isNew: false })]);

  assert.equal(result.outcome, OUTCOME.FAIL);
});

// ---- what the result carries ----------------------------------------------------------

test('every rule is reported whether it passed or not, so the gate can be audited', () => {
  const result = evaluateSecurityGate(scanned(), []);

  assert.ok(result.rules.length >= 6);
  assert.ok(result.rules.every(r => typeof r.name === 'string' && r.name !== ''));
  assert.ok(result.rules.every(r => typeof r.explanation === 'string' && r.explanation !== ''));
  assert.ok(result.rules.every(r => typeof r.passed === 'boolean'));
});

test('a pass carries no reasons, because a reason is something that went wrong', () => {
  assert.deepEqual(evaluateSecurityGate(scanned(), []).reasons, []);
});

test('blocked is set only on FAIL, so a REVIEW does not stop a build', () => {
  assert.equal(evaluateSecurityGate(scanned(), []).blocked, false);
  assert.equal(evaluateSecurityGate({ scanRan: false }, []).blocked, false);
  assert.equal(evaluateSecurityGate(scanned(), [finding({ severity: 'High' })]).blocked, true);
});

test('the summary names what ran and what was not tested', () => {
  const result = evaluateSecurityGate(
    scanned({ untestedAreas: ['request.csrf on /x: no body was discovered'] }), []);

  assert.match(result.summary, /10 of 10/);
  assert.ok(result.summary.length > 40);
});

test('the default policy is the one documented, so a caller can rely on it', () => {
  assert.deepEqual(DEFAULT_POLICY, {
    failOnNewAtOrAbove: 'High',
    failOnExistingAtOrAbove: 'Critical',
    failOnRegression: true,
    reviewLowConfidenceInsteadOfFailing: true,
    minimumCheckCoverage: 0.8
  });
});

test('a severity nobody recognises does not silently fail the build', () => {
  // An unknown severity sorts below everything, so it cannot cross a threshold by accident.
  assert.equal(evaluateSecurityGate(scanned(), [finding({ severity: 'Spicy' })]).outcome,
               OUTCOME.PASS);
});
