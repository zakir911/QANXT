/**
 * Security regression: comparing this scan against the last one.
 *
 * The question a team actually asks is not "what did the scanner find" but "what changed".
 * Answering it needs a stable identity for a finding, which is the hard part: the same flaw
 * reported twice must match, and two different flaws must not.
 *
 * The identity here is deliberately narrow — application, category, endpoint, parameter and
 * the role it was observed as. It does not include the severity (which the model can revise),
 * the title (which can be reworded), the payload (which can vary between runs) or any
 * response value. A fingerprint that included those would report a new finding every time
 * anything was rephrased, and a team that sees a wall of new findings every run stops reading.
 *
 * Nothing here can mark a finding fixed on its own. A finding that is absent from this scan
 * is `notObserved`, not `resolved`, and the difference matters: the check may have been
 * refused by scope, the endpoint may have been unreachable, or the scan may simply not have
 * run that check this time. Calling that "fixed" is how a security regression gets hidden,
 * which the brief forbids in as many words.
 */
import { createHash } from 'node:crypto';

/** A stable identity for a finding across runs. */
export function fingerprint(finding) {
  const parts = [
    finding.application ?? 'unknown',
    finding.category ?? 'unknown',
    finding.endpoint ?? '',
    finding.parameter ?? '',
    finding.observedAsRole ?? ''
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

/**
 * Compares a scan against a baseline.
 *
 * @param current   findings from this scan
 * @param baseline  findings from the previous scan, each carrying `status`
 * @param executed  the check names that actually ran this time — used to decide whether an
 *                  absent finding is evidence of anything
 */
export function compareToBaseline(current, baseline = [], executed = null) {
  const currentByPrint = new Map(current.map(f => [fingerprint(f), f]));
  const baselineByPrint = new Map(baseline.map(f => [fingerprint(f), f]));
  const ranThisTime = executed === null ? null : new Set(executed);

  const findings = [];

  for (const [print, finding] of currentByPrint) {
    const previous = baselineByPrint.get(print);

    if (!previous) {
      findings.push({ ...finding, fingerprint: print, isNew: true, isRegression: false, status: finding.status ?? 'Potential' });
      continue;
    }

    // Seen before, and the previous scan had it resolved: it has come back.
    if (previous.status === 'Resolved') {
      findings.push({
        ...finding, fingerprint: print, isNew: false, isRegression: true, status: 'Regressed',
        previousStatus: previous.status,
        regressionNote: 'This finding was recorded as resolved and has been detected again.'
      });
      continue;
    }

    // Seen before and still open. A suppression decision carries forward — but only the
    // decision, never the severity, because the flaw may have got worse since somebody
    // accepted it.
    findings.push({
      ...finding, fingerprint: print, isNew: false, isRegression: false,
      status: previous.status ?? finding.status ?? 'Potential',
      justification: previous.justification ?? null,
      decidedBy: previous.decidedBy ?? null,
      previousStatus: previous.status ?? null
    });
  }

  // What the baseline had and this scan did not report.
  const disappeared = [];
  for (const [print, previous] of baselineByPrint) {
    if (currentByPrint.has(print)) continue;

    const checkRan = ranThisTime === null ? null : ranThisTime.has(previous.check ?? '');
    disappeared.push({
      ...previous, fingerprint: print,
      // Never "resolved" on absence alone. The most this can say is that the check ran and
      // did not reproduce it, which is evidence; and where the check did not run, it is not
      // even that.
      outcome: checkRan === true ? 'notReproduced' : 'notObserved',
      note: checkRan === true
        ? 'The check that found this ran again and did not reproduce it. That is grounds for a person '
          + 'to mark it resolved; it is not a resolution on its own.'
        : checkRan === false
          ? 'The check that found this did not run in this scan, so its absence is not evidence of '
            + 'anything.'
          : 'This scan did not report it. Which checks ran was not recorded, so nothing can be '
            + 'concluded from the absence.'
    });
  }

  return {
    findings,
    disappeared,
    summary: {
      current: current.length,
      baseline: baseline.length,
      new: findings.filter(f => f.isNew).length,
      regressed: findings.filter(f => f.isRegression).length,
      carriedForward: findings.filter(f => !f.isNew && !f.isRegression).length,
      notReproduced: disappeared.filter(d => d.outcome === 'notReproduced').length,
      notObserved: disappeared.filter(d => d.outcome === 'notObserved').length
    }
  };
}

// ---------------------------------------------------------------------------
// The false-positive workflow
// ---------------------------------------------------------------------------

export const TRIAGE_STATUSES = new Set([
  'Potential', 'Confirmed', 'FalsePositive', 'NeedsReview', 'Resolved', 'Regressed', 'Accepted'
]);

/** Statuses that stop a finding counting against a gate, and therefore need a person. */
const NEEDS_A_PERSON = new Set(['FalsePositive', 'Accepted']);

/**
 * Applies a triage decision to a finding.
 *
 * Refuses rather than warns. A false-positive mark with no reason and no name is somebody
 * switching the check off, and a workflow that accepts it quietly is how a security gate
 * becomes decoration. The refusal is the feature.
 */
export function triage(finding, { status, justification, decidedBy, at = new Date().toISOString() }) {
  if (!TRIAGE_STATUSES.has(status)) {
    throw new Error(`Unknown security finding status '${status}'.`);
  }
  if (NEEDS_A_PERSON.has(status)) {
    if (!justification?.trim()) {
      throw new Error(
        `Refusing to mark ${finding.category ?? 'this finding'} as ${status} with no justification. `
        + 'A suppression with no stated reason is indistinguishable from turning the check off, and '
        + 'the gate counts it as open either way.');
    }
    if (!decidedBy?.trim()) {
      throw new Error(
        `Refusing to mark ${finding.category ?? 'this finding'} as ${status} with no named decision-maker. `
        + 'Somebody has to be accountable for a finding being set aside.');
    }
    if (justification.trim().length < 20) {
      throw new Error(
        `Refusing to mark ${finding.category ?? 'this finding'} as ${status}: the justification is too `
        + 'short to be one. State what was checked and what it showed.');
    }
  }

  // The decision is appended, never overwritten. The audit trail is the whole point of the
  // workflow, and a status field that only holds the latest answer is not one.
  const history = [...(finding.triageHistory ?? []), {
    at, status, justification: justification ?? null, decidedBy: decidedBy ?? null,
    from: finding.status ?? 'Potential'
  }];

  return { ...finding, status, justification: justification ?? null, decidedBy: decidedBy ?? null,
           triagedAt: at, triageHistory: history };
}

/**
 * A false positive must not silently suppress the same flaw somewhere else.
 *
 * Marking one endpoint's BOLA finding a false positive says something about that endpoint.
 * Applying it to every BOLA finding in the application would hide real ones, so the
 * suppression is keyed on the fingerprint and this says so explicitly rather than leaving it
 * to be discovered.
 */
export function suppressionApplies(suppression, finding) {
  return suppression.fingerprint === fingerprint(finding);
}
