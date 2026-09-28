/**
 * The security gate, in JavaScript.
 *
 * Mirrors `SecurityGateEvaluator` in the Application layer, rule for rule and word for word
 * in the sentences that matter, so a decision made by the platform and one made by a golden
 * suite read the same. The C# side carries the unit tests; the golden suite drives this one
 * against a real scan of the lab, and a parity test asserts the two agree.
 *
 * The rules that matter are the ones about absence:
 *
 *   A scan that did not run is not a pass.
 *   A scan whose scope blocked most of its requests is not a pass.
 *   A suppressed finding with no written justification is not suppressed.
 *   A finding with no evidence is neither failed nor dismissed.
 *
 * And the summary never says the application is secure, because no scan can support that.
 */
export const OUTCOME = { PASS: 0, REVIEW: 1, FAIL: 2 };
export const OUTCOME_NAME = ['PASS', 'REVIEW', 'FAIL'];

export const SEVERITY_ORDER = { Informational: 0, Low: 1, Medium: 2, High: 3, Critical: 4 };
export const CONFIDENCE_ORDER = { Low: 0, Medium: 1, High: 2 };

export const DEFAULT_POLICY = {
  failOnNewAtOrAbove: 'High',
  failOnExistingAtOrAbove: 'Critical',
  failOnRegression: true,
  reviewLowConfidenceInsteadOfFailing: true,
  minimumCheckCoverage: 0.8
};

const atOrAbove = (severity, threshold) =>
  (SEVERITY_ORDER[severity] ?? -1) >= (SEVERITY_ORDER[threshold] ?? 99);

const percent = value => `${Math.round(value * 100)}%`;

const SUPPRESSED = new Set(['FalsePositive', 'Accepted']);

export function evaluateSecurityGate(coverage, findings = [], policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const rules = [];
  const reasons = [];
  let outcome = OUTCOME.PASS;

  const escalate = (to, reason) => { if (to > outcome) outcome = to; reasons.push(reason); };

  if (!coverage?.scanRan) {
    rules.push({ name: 'A security scan ran', passed: false, measured: false,
                 explanation: 'No security scan ran for this build.' });
    escalate(OUTCOME.REVIEW,
      'No security scan ran, so this build has not been security tested. That is not the same as '
      + 'having been tested and found clean, and the gate will not report it as a pass.');
    return {
      outcome, outcomeName: OUTCOME_NAME[outcome], blocked: false, rules, reasons,
      summary: 'NOT SCANNED. No security tests were executed for this build, so nothing is known about '
        + 'its security posture from QA NXT.'
    };
  }
  rules.push({ name: 'A security scan ran', passed: true, measured: true,
               explanation: `${coverage.requestsIssued} request(s) issued under the ${coverage.profile} profile.` });

  // ---- how much of it ran -------------------------------------------------
  const configured = coverage.checksConfigured?.length ?? 0;
  const executed = coverage.checksExecuted?.length ?? 0;
  const checkCoverage = configured === 0 ? 0 : executed / configured;
  const coverageOk = configured > 0 && checkCoverage >= p.minimumCheckCoverage;

  rules.push({
    name: 'Enough of the configured checks executed', passed: coverageOk, measured: configured > 0,
    explanation: configured === 0
      ? 'No checks were configured, so there was nothing to execute.'
      : `${executed} of ${configured} configured check(s) executed (${percent(checkCoverage)}; `
        + `the policy requires ${percent(p.minimumCheckCoverage)}).`
  });
  if (!coverageOk) {
    escalate(OUTCOME.REVIEW, configured === 0
      ? 'No security checks were configured, so a clean result means only that nothing was asked.'
      : `Only ${executed} of ${configured} configured check(s) executed. A result from a partial scan `
        + 'describes the part that ran and nothing else.');
  }

  // ---- what the scope stopped it reaching ----------------------------------
  const attempted = (coverage.requestsIssued ?? 0) + (coverage.requestsBlocked ?? 0);
  const blockedShare = attempted === 0 ? 0 : coverage.requestsBlocked / attempted;
  const reachedEnough = blockedShare <= 0.25;
  rules.push({
    name: 'The scan reached what it was aiming at', passed: reachedEnough, measured: attempted > 0,
    explanation: `${coverage.requestsBlocked} of ${attempted} request(s) were refused by the scope `
      + `(${percent(blockedShare)}).`
  });
  if (!reachedEnough) {
    escalate(OUTCOME.REVIEW,
      `${percent(blockedShare)} of the scan's requests were refused by its own scope. The findings `
      + 'describe the part of the application the scan was allowed to reach.');
  }

  // ---- suppressions that are not suppressions -------------------------------
  const unjustified = findings.filter(f =>
    SUPPRESSED.has(f.status) && (!f.justification?.trim() || !f.decidedBy?.trim()));

  rules.push({
    name: 'Every suppressed finding carries a written justification and a name',
    passed: unjustified.length === 0, measured: true,
    explanation: unjustified.length === 0
      ? 'No finding is suppressed without a reason.'
      : `${unjustified.length} finding(s) are marked false positive or accepted with no justification `
        + 'or no named decision-maker.'
  });
  if (unjustified.length > 0) {
    escalate(OUTCOME.FAIL,
      `${unjustified.length} finding(s) are suppressed with no written justification or no named `
      + 'decision-maker. They are counted as open, because an unexplained suppression is '
      + 'indistinguishable from switching the check off.');
  }

  const suppressedIds = new Set(findings
    .filter(f => SUPPRESSED.has(f.status) && !unjustified.includes(f))
    .map(f => f.id));

  // ---- findings with nothing behind them ------------------------------------
  const evidenceless = findings.filter(f => f.hasEvidence === false);
  rules.push({
    name: 'Every finding carries evidence', passed: evidenceless.length === 0, measured: true,
    explanation: evidenceless.length === 0
      ? 'Every finding carries at least one request/response exchange.'
      : `${evidenceless.length} finding(s) have no evidence.`
  });
  if (evidenceless.length > 0) {
    escalate(OUTCOME.REVIEW,
      `${evidenceless.length} finding(s) carry no evidence. They are neither failed nor dismissed: a `
      + 'claim nobody can check is not yet a finding, and dropping it silently is worse than saying so.');
  }

  const open = findings.filter(f =>
    !suppressedIds.has(f.id) && f.hasEvidence !== false && f.status !== 'Resolved');

  // ---- regressions -----------------------------------------------------------
  const regressions = open.filter(f => f.isRegression);
  rules.push({
    name: 'No previously resolved finding has reappeared',
    passed: regressions.length === 0, measured: true,
    explanation: regressions.length === 0 ? 'No regression.'
      : `${regressions.length} finding(s) previously resolved have been detected again: `
        + regressions.map(f => `${f.category} (${f.severity})`).join(', ')
  });
  if (regressions.length > 0 && p.failOnRegression) {
    escalate(OUTCOME.FAIL,
      `${regressions.length} security finding(s) that were fixed have come back. A regression fails at `
      + 'any severity: something that was repaired has been undone.');
  }

  // ---- new findings ------------------------------------------------------------
  const newBlocking = open.filter(f =>
    f.isNew && !f.isRegression && atOrAbove(f.severity, p.failOnNewAtOrAbove));
  const newLowConfidence = p.reviewLowConfidenceInsteadOfFailing
    ? newBlocking.filter(f => f.confidence === 'Low') : [];
  const newFailing = newBlocking.filter(f => !newLowConfidence.includes(f));

  rules.push({
    name: `No new finding at or above ${p.failOnNewAtOrAbove}`,
    passed: newFailing.length === 0, measured: true,
    explanation: newFailing.length === 0
      ? `No new finding at or above ${p.failOnNewAtOrAbove} with better than low confidence.`
      : newFailing.map(f => `${f.category} (${f.severity}, ${f.confidence})`).join(', ')
  });
  if (newFailing.length > 0) {
    escalate(OUTCOME.FAIL,
      `${newFailing.length} new finding(s) at or above ${p.failOnNewAtOrAbove}: `
      + `${newFailing.map(f => f.category).join(', ')}.`);
  }
  if (newLowConfidence.length > 0) {
    escalate(OUTCOME.REVIEW,
      `${newLowConfidence.length} new finding(s) at or above ${p.failOnNewAtOrAbove} rest on a single `
      + 'unreproduced indicator. A person should look rather than the build stopping.');
  }

  // ---- existing findings too severe to carry --------------------------------------
  const existingTooSevere = open.filter(f =>
    !f.isNew && !f.isRegression && atOrAbove(f.severity, p.failOnExistingAtOrAbove));
  rules.push({
    name: `No open finding at or above ${p.failOnExistingAtOrAbove}`,
    passed: existingTooSevere.length === 0, measured: true,
    explanation: existingTooSevere.length === 0
      ? `No pre-existing finding at or above ${p.failOnExistingAtOrAbove}.`
      : existingTooSevere.map(f => `${f.category} (${f.severity})`).join(', ')
  });
  if (existingTooSevere.length > 0) {
    escalate(OUTCOME.FAIL,
      `${existingTooSevere.length} open finding(s) at or above ${p.failOnExistingAtOrAbove} were already `
      + 'present. A finding does not become acceptable by being old.');
  }

  return {
    outcome, outcomeName: OUTCOME_NAME[outcome], blocked: outcome === OUTCOME.FAIL,
    rules, reasons,
    summary: summarise(outcome, coverage, open, findings),
    counts: {
      total: findings.length, open: open.length,
      suppressed: suppressedIds.size, regressions: regressions.length,
      newFailing: newFailing.length, evidenceless: evidenceless.length
    }
  };
}

function summarise(outcome, coverage, open, all) {
  const executed = `${coverage.checksExecuted?.length ?? 0} of ${coverage.checksConfigured?.length ?? 0} `
    + `configured check(s), ${coverage.requestsIssued} request(s) issued`;
  const untested = (coverage.untestedAreas ?? []).length === 0
    ? '' : ` Untested: ${coverage.untestedAreas.join('; ')}.`;

  const setAside = all.length - open.length;
  const setAsideNote = setAside === 0 ? ''
    : ` ${setAside} finding(s) were detected and then suppressed or resolved; they are listed with the `
      + 'reason and the person who decided.';

  if (open.length === 0) {
    return 'Within the configured scope and test coverage, no security findings were detected by the '
      + `executed QA NXT security tests (${executed}). This is not a statement that the application is `
      + `secure or that no vulnerabilities exist.${setAsideNote}${untested}`;
  }

  const bySeverity = Object.entries(
    open.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {}))
    .sort((a, b) => (SEVERITY_ORDER[b[0]] ?? 0) - (SEVERITY_ORDER[a[0]] ?? 0))
    .map(([severity, count]) => `${count} ${severity}`);

  const verb = ['PASSED', 'NEEDS REVIEW', 'BLOCKED'][outcome];
  return `${verb}. ${open.length} open finding(s) (${bySeverity.join(', ')}) from ${executed}.`
    + `${setAsideNote} Findings describe what these tests reached; areas they did not reach are `
    + `untested, not clean.${untested}`;
}
