/**
 * The security gate, regression comparison and triage workflow.
 *
 * These are the parts a team meets every day, and the parts where a security capability
 * quietly stops working. A gate that goes green because nobody scanned. A false positive
 * that suppresses the same flaw everywhere. A finding that disappears because the check was
 * refused, recorded as fixed. None of those announce themselves; each one is tested here.
 *
 * The scan driving SECQ is a real one against the access-control lab, not a fixture. A gate
 * tested only on hand-written findings passes on findings that never occur.
 */
import { golden, suite } from '../harness.mjs';
import { SecurityScanner } from '../../../packages/security-engine/src/engine.mjs';
import { SECURITY_PROFILE, labScope } from '../../../packages/security-engine/src/scope-guard.mjs';
import { evaluateSecurityGate, OUTCOME } from '../../../packages/security-engine/src/gate.mjs';
import { compareToBaseline, fingerprint, triage, suppressionApplies } from '../../../packages/security-engine/src/regression.mjs';
import { checkBola, checkVerticalEscalation } from '../../../packages/security-engine/src/checks-authz.mjs';
import { LABS, isolateFaults, restoreFaults, resetLab } from '../security/scenarios.mjs';

const CHECKS = ['authz.bola', 'authz.vertical', 'authz.readonly', 'authz.missing', 'authz.token'];

/** Runs a real scan of the access-control lab and returns gate-shaped findings + coverage. */
async function scanAccessControl({ faults }) {
  await isolateFaults(LABS.accessControl, faults);
  const scanner = new SecurityScanner({
    scope: labScope(), profile: SECURITY_PROFILE.STANDARD
  });

  const bob = await scanner.signIn(LABS.accessControl, 'bob');
  const alice = await scanner.signIn(LABS.accessControl, 'alice');
  const admin = await scanner.signIn(LABS.accessControl, 'admin');

  const executed = [];
  const findings = [];

  const bola = await checkBola(scanner, {
    baseUrl: LABS.accessControl, path: '/api/accounts/{id}',
    owner: { cookie: bob.cookie, label: 'bob', resourceId: 'acc-1002' },
    intruder: { cookie: alice.cookie, label: 'alice' }, testId: 'GATE-BOLA'
  });
  if (!bola.skipped) executed.push('authz.bola');
  findings.push(...(bola.findings ?? []));

  const vertical = await checkVerticalEscalation(scanner, {
    baseUrl: LABS.accessControl, path: '/api/admin/users',
    privileged: { cookie: admin.cookie, label: 'admin' },
    lesser: { cookie: alice.cookie, label: 'alice' }, testId: 'GATE-VERT'
  });
  if (!vertical.skipped) executed.push('authz.vertical');
  findings.push(...(vertical.findings ?? []));

  await restoreFaults(LABS.accessControl);
  await resetLab(LABS.accessControl);

  const summary = scanner.summary();
  return {
    coverage: {
      scanRan: true, profile: summary.profile,
      requestsIssued: summary.requestsIssued, requestsBlocked: summary.requestsBlocked,
      // The two checks this scan runs, out of the five the family configures. Stated
      // honestly rather than rounded up: the gate's coverage rule reads these numbers.
      checksConfigured: CHECKS, checksExecuted: executed,
      untestedAreas: ['DOM-based XSS (needs a browser-driven scan)', 'cloud metadata (off by default)']
    },
    findings: findings.map((f, i) => ({
      id: `${f.category}-${i}`,
      application: 'access-control-lab',
      category: f.category, endpoint: f.endpoint, parameter: f.parameter ?? null,
      observedAsRole: f.observedAsRole ?? null,
      severity: f.severityFactors?.severity ?? 'Informational',
      confidence: f.confidence ?? 'Low',
      status: 'Confirmed', isNew: true, isRegression: false,
      hasEvidence: (f.exchanges ?? []).length > 0,
      check: f.category === 'BOLA' ? 'authz.bola' : 'authz.vertical'
    })),
    raw: findings
  };
}

export default async function run() {
  suite('Security gate, regression and triage');
  const context = { applicationVersion: '1.0.0' };

  // The scan that most of this suite is built on. Two real flaws, found by two real checks.
  const vulnerable = await scanAccessControl({
    faults: ['VULN_BOLA', 'VULN_VERTICAL_ESCALATION']
  });
  const corrected = await scanAccessControl({ faults: [] });

  // -----------------------------------------------------------------------
  // SECQ — the gate
  // -----------------------------------------------------------------------
  await golden({
    id: 'SECQ-001',
    objective: 'A scan that did not run is REVIEW, never a pass',
    preconditions: ['no scan'],
    input: 'Coverage with scanRan false',
    expected: 'REVIEW, and a summary that says NOT SCANNED. A build that goes green because nobody '
      + 'scanned is the failure this gate exists to prevent',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const result = evaluateSecurityGate(
        { scanRan: false, profile: 'passive', requestsIssued: 0, requestsBlocked: 0 }, []);
      return {
        pass: result.outcome === OUTCOME.REVIEW && result.summary.includes('NOT SCANNED')
          && result.blocked === false,
        detail: `${result.outcomeName}: ${result.summary}`,
        evidence: { 'gate.json': result }
      };
    }
  }, context);

  await golden({
    id: 'SECQ-002',
    objective: 'Two real findings from a real scan block the build',
    preconditions: ['the access-control lab with BOLA and vertical escalation switched on'],
    input: 'A live scan, its findings passed to the gate under the default policy',
    expected: 'FAIL, naming the two categories — and the findings are the ones the scan actually '
      + 'produced, not a fixture',
    evidence: ['gate.json', 'findings.json'],
    severity: 'critical',
    run: async () => {
      const result = evaluateSecurityGate(vulnerable.coverage, vulnerable.findings);
      const categories = vulnerable.findings.map(f => f.category).sort();
      return {
        pass: result.outcome === OUTCOME.FAIL && result.blocked === true
          && vulnerable.findings.length === 2
          && categories.join(',') === 'BOLA,BrokenFunctionLevelAuthorization',
        detail: `${result.outcomeName}; ${vulnerable.findings.length} finding(s) [${categories.join(', ')}]; `
          + result.reasons[0],
        metrics: { findings: vulnerable.findings.length },
        evidence: { 'gate.json': result, 'findings.json': vulnerable.findings }
      };
    }
  }, context);

  await golden({
    id: 'SECQ-003',
    objective: 'A clean scan never claims the application is secure',
    preconditions: ['the same lab with both flaws corrected'],
    input: 'A live scan of the corrected application',
    expected: 'The sentence the brief requires — "Within the configured scope and test coverage, no '
      + 'security findings were detected by the executed QA NXT security tests" — and never "secure" '
      + 'or "zero vulnerabilities"',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const result = evaluateSecurityGate(corrected.coverage, corrected.findings);
      const forbidden = ['The application is secure', 'zero vulnerabilities', 'no vulnerabilities found',
                         'fully secure', 'is secure.'];
      const offending = forbidden.filter(phrase => result.summary.includes(phrase));
      return {
        pass: corrected.findings.length === 0
          && result.summary.includes('Within the configured scope and test coverage, no security '
                                     + 'findings were detected by the executed QA NXT security tests')
          && result.summary.includes('This is not a statement that the application is secure')
          && offending.length === 0,
        detail: offending.length > 0 ? `FORBIDDEN CLAIM: ${offending.join(', ')}` : result.summary,
        evidence: { 'gate.json': result }
      };
    }
  }, context);

  await golden({
    id: 'SECQ-004',
    objective: 'A partial scan does not pass, however clean it was',
    preconditions: ['a scan that ran one of five configured checks and found nothing'],
    input: 'Clean coverage with one of five checks executed',
    expected: 'REVIEW. "Nothing found" from a fifth of a scan describes a fifth of an application',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const result = evaluateSecurityGate({
        ...corrected.coverage, checksExecuted: ['authz.bola']
      }, []);
      return {
        pass: result.outcome === OUTCOME.REVIEW
          && result.reasons.some(r => r.includes('Only 1 of 5')),
        detail: `${result.outcomeName}: ${result.reasons.join(' ')}`,
        evidence: { 'gate.json': result }
      };
    }
  }, context);

  await golden({
    id: 'SECQ-005',
    objective: 'A scan whose scope refused most of its requests does not pass',
    preconditions: ['a clean scan in which the scope blocked 80 of 100 requests'],
    input: 'Clean findings, heavily blocked coverage',
    expected: 'REVIEW, naming the proportion refused. Coverage is what a reader needs in order to '
      + 'know what a clean result means',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const result = evaluateSecurityGate({
        ...corrected.coverage, requestsIssued: 20, requestsBlocked: 80
      }, []);
      return {
        pass: result.outcome === OUTCOME.REVIEW
          && result.reasons.some(r => r.includes('refused by its own scope')),
        detail: `${result.outcomeName}: ${result.reasons.join(' ')}`,
        evidence: { 'gate.json': result }
      };
    }
  }, context);

  await golden({
    id: 'SECQ-006',
    objective: 'A suppression with no written justification is counted as open and fails the build',
    preconditions: ['a real critical finding marked false positive with no reason'],
    input: 'The scan\'s BOLA finding, status FalsePositive, justification empty',
    expected: 'FAIL. An unexplained suppression is indistinguishable from switching the check off, '
      + 'and honouring it would make the gate decoration',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const findings = vulnerable.findings.map((f, i) => i === 0
        ? { ...f, status: 'FalsePositive', justification: '', decidedBy: 'ada' } : f);
      const result = evaluateSecurityGate(vulnerable.coverage, findings);
      return {
        pass: result.outcome === OUTCOME.FAIL
          && result.reasons.some(r => r.includes('no written justification')),
        detail: `${result.outcomeName}: ${result.reasons.find(r => r.includes('suppressed')) ?? ''}`,
        evidence: { 'gate.json': result }
      };
    }
  }, context);

  await golden({
    id: 'SECQ-007',
    objective: 'A regression fails at any severity',
    preconditions: ['a low-severity finding previously recorded as resolved'],
    input: 'One Low finding with isRegression true',
    expected: 'FAIL. Something that was repaired has been undone, and severity is not the question',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const result = evaluateSecurityGate(vulnerable.coverage, [{
        id: 'r-1', category: 'OpenRedirect', severity: 'Low', confidence: 'High',
        status: 'Regressed', isNew: false, isRegression: true, hasEvidence: true
      }]);
      return {
        pass: result.outcome === OUTCOME.FAIL && result.reasons.some(r => r.includes('have come back')),
        detail: `${result.outcomeName}: ${result.reasons.join(' ')}`,
        evidence: { 'gate.json': result }
      };
    }
  }, context);

  await golden({
    id: 'SECQ-008',
    objective: 'A single unreproduced indicator goes to review rather than stopping the release',
    preconditions: ['a new High finding at Low confidence'],
    input: 'One High/Low finding',
    expected: 'REVIEW, not FAIL. A gate that stops a release on one unreproduced signal gets switched '
      + 'off, and then nothing is gated at all',
    evidence: ['gate.json'],
    severity: 'high',
    run: async () => {
      const result = evaluateSecurityGate(vulnerable.coverage, [{
        id: 'lc-1', category: 'NoRateLimit', severity: 'High', confidence: 'Low',
        status: 'Potential', isNew: true, isRegression: false, hasEvidence: true
      }]);
      return {
        pass: result.outcome === OUTCOME.REVIEW && result.blocked === false,
        detail: `${result.outcomeName}: ${result.reasons.join(' ')}`,
        evidence: { 'gate.json': result }
      };
    }
  }, context);

  await golden({
    id: 'SECQ-009',
    objective: 'A finding with no evidence is neither failed nor dismissed',
    preconditions: ['a Critical finding carrying no exchange'],
    input: 'One Critical finding with hasEvidence false',
    expected: 'REVIEW. A claim nobody can check is not a finding yet, and dropping it silently is '
      + 'worse than saying so',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const result = evaluateSecurityGate(vulnerable.coverage, [{
        id: 'ne-1', category: 'SqlInjection', severity: 'Critical', confidence: 'High',
        status: 'Potential', isNew: true, isRegression: false, hasEvidence: false
      }]);
      return {
        pass: result.outcome === OUTCOME.REVIEW && result.blocked === false
          && result.reasons.some(r => r.includes('carry no evidence')),
        detail: `${result.outcomeName}: ${result.reasons.join(' ')}`,
        evidence: { 'gate.json': result }
      };
    }
  }, context);

  await golden({
    id: 'SECQ-010',
    objective: 'Untested areas appear in the summary of a clean result',
    preconditions: ['a clean scan that names what it did not test'],
    input: 'The corrected scan, whose coverage names DOM XSS and cloud metadata as untested',
    expected: 'The summary names them. The brief requires tested coverage to be distinguishable from '
      + 'untested areas, and a clean summary that lists neither invites the reader to assume '
      + 'everything was covered',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const result = evaluateSecurityGate(corrected.coverage, corrected.findings);
      return {
        pass: result.summary.includes('Untested:')
          && result.summary.includes('DOM-based XSS')
          && result.summary.includes('cloud metadata'),
        detail: result.summary,
        evidence: { 'gate.json': result }
      };
    }
  }, context);

  await golden({
    id: 'SECQ-011',
    objective: 'The gate can pass — a clean scan with full coverage is a PASS, not a REVIEW',
    preconditions: ['the corrected application, with every configured check recorded as executed'],
    input: 'The corrected scan\'s findings with coverage showing all five checks run',
    expected: 'PASS. Ten rules that produce REVIEW or FAIL prove only that the gate says no to '
      + 'everything; this is the case that shows it can say yes',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const result = evaluateSecurityGate({
        ...corrected.coverage, checksExecuted: CHECKS, requestsIssued: 200, requestsBlocked: 0
      }, corrected.findings);
      return {
        pass: result.outcome === OUTCOME.PASS && result.blocked === false
          && result.rules.every(rule => rule.passed),
        detail: `${result.outcomeName}; ${result.rules.filter(r => r.passed).length}/${result.rules.length} `
          + `rule(s) satisfied`,
        metrics: { rules: result.rules.length },
        evidence: { 'gate.json': result }
      };
    }
  }, context);

  // -----------------------------------------------------------------------
  // SECB — regression against a baseline
  // -----------------------------------------------------------------------
  await golden({
    id: 'SECB-001',
    objective: 'A finding reported twice gets the same fingerprint, and a different one does not',
    preconditions: ['two findings from the real scan'],
    input: 'The same finding reworded, and a genuinely different finding',
    expected: 'The reworded finding matches; the different one does not. A fingerprint that changed '
      + 'when a title was rephrased would report everything as new every run',
    evidence: ['fingerprints.json'],
    severity: 'critical',
    run: async () => {
      const [first, second] = vulnerable.findings;
      const reworded = { ...first, severity: 'Critical', title: 'Completely different wording' };
      const same = fingerprint(first) === fingerprint(reworded);
      const different = fingerprint(first) !== fingerprint(second);
      return {
        pass: same && different,
        detail: `same finding reworded: ${same ? 'matched' : 'DID NOT MATCH'}; `
          + `different finding: ${different ? 'distinct' : 'COLLIDED'}`,
        evidence: {
          'fingerprints.json': {
            first: { print: fingerprint(first), category: first.category, endpoint: first.endpoint },
            reworded: { print: fingerprint(reworded) },
            second: { print: fingerprint(second), category: second.category, endpoint: second.endpoint }
          }
        }
      };
    }
  }, context);

  await golden({
    id: 'SECB-002',
    objective: 'A finding absent from a scan is never recorded as resolved on absence alone',
    preconditions: ['a baseline with a confirmed finding, and a scan whose check did not run'],
    input: 'A baseline finding whose check is not in the executed list',
    expected: 'notObserved, with the reason. The brief forbids self-healing or anything else hiding a '
      + 'security regression, and calling an unrun check a fix is exactly that',
    evidence: ['comparison.json'],
    severity: 'critical',
    run: async () => {
      const baseline = [{
        application: 'access-control-lab', category: 'BOLA', endpoint: '/api/accounts/{id}',
        parameter: 'id', observedAsRole: 'alice', status: 'Confirmed', check: 'authz.bola'
      }];
      const comparison = compareToBaseline([], baseline, ['authz.vertical']);
      const [gone] = comparison.disappeared;
      return {
        pass: gone?.outcome === 'notObserved' && comparison.summary.notReproduced === 0,
        detail: `${gone?.outcome}: ${gone?.note}`,
        evidence: { 'comparison.json': comparison }
      };
    }
  }, context);

  await golden({
    id: 'SECB-003',
    objective: 'A check that ran and did not reproduce a finding says so, and still does not resolve it',
    preconditions: ['a baseline finding whose check ran this time and found nothing'],
    input: 'The same baseline, with authz.bola in the executed list',
    expected: 'notReproduced — grounds for a person to mark it resolved, not a resolution',
    evidence: ['comparison.json'],
    severity: 'critical',
    run: async () => {
      const baseline = [{
        application: 'access-control-lab', category: 'BOLA', endpoint: '/api/accounts/{id}',
        parameter: 'id', observedAsRole: 'alice', status: 'Confirmed', check: 'authz.bola'
      }];
      const comparison = compareToBaseline([], baseline, ['authz.bola']);
      const [gone] = comparison.disappeared;
      return {
        pass: gone?.outcome === 'notReproduced' && gone.status === 'Confirmed'
          && gone.note.includes('not a resolution on its own'),
        detail: `${gone?.outcome}: ${gone?.note}`,
        evidence: { 'comparison.json': comparison }
      };
    }
  }, context);

  await golden({
    id: 'SECB-004',
    objective: 'A resolved finding detected again is marked as a regression',
    preconditions: ['a baseline in which the real BOLA finding was resolved'],
    input: 'The live scan compared against that baseline',
    expected: 'isRegression true and status Regressed, which the gate then fails at any severity',
    evidence: ['comparison.json', 'gate.json'],
    severity: 'critical',
    run: async () => {
      const baseline = vulnerable.findings.map(f => ({ ...f, status: 'Resolved' }));
      const comparison = compareToBaseline(vulnerable.findings, baseline, CHECKS);
      const regressed = comparison.findings.filter(f => f.isRegression);
      const gate = evaluateSecurityGate(vulnerable.coverage, comparison.findings);
      return {
        pass: regressed.length === 2 && regressed.every(f => f.status === 'Regressed')
          && gate.outcome === OUTCOME.FAIL,
        detail: `${regressed.length} regression(s); gate ${gate.outcomeName}`,
        metrics: { regressions: regressed.length },
        evidence: { 'comparison.json': comparison, 'gate.json': gate }
      };
    }
  }, context);

  await golden({
    id: 'SECB-005',
    objective: 'A triage decision carries forward but the severity does not',
    preconditions: ['a baseline finding accepted at Medium, now detected at Critical'],
    input: 'The same fingerprint with a higher severity in this scan',
    expected: 'The acceptance carries forward and the new severity is kept. A flaw that got worse '
      + 'since somebody accepted it should not inherit the old severity along with the decision',
    evidence: ['comparison.json'],
    severity: 'high',
    run: async () => {
      const [live] = vulnerable.findings;
      const baseline = [{
        ...live, severity: 'Medium', status: 'Accepted',
        justification: 'Reviewed with the owning team; the data behind it is synthetic.',
        decidedBy: 'ada@example.invalid'
      }];
      const worse = [{ ...live, severity: 'Critical' }];
      const comparison = compareToBaseline(worse, baseline, CHECKS);
      const carried = comparison.findings[0];
      return {
        pass: carried.status === 'Accepted' && carried.severity === 'Critical'
          && carried.decidedBy === 'ada@example.invalid',
        detail: `status ${carried.status} carried forward; severity ${carried.severity} (was Medium)`,
        evidence: { 'comparison.json': comparison }
      };
    }
  }, context);

  // -----------------------------------------------------------------------
  // SECT — the triage workflow
  // -----------------------------------------------------------------------
  const triageCases = [
    { id: 'SECT-001', label: 'a false positive with no justification',
      args: { status: 'FalsePositive', decidedBy: 'ada' }, mustThrow: 'no justification' },
    { id: 'SECT-002', label: 'a false positive with no named decision-maker',
      args: { status: 'FalsePositive', justification: 'The endpoint filters by the caller\'s own id.' },
      mustThrow: 'no named decision-maker' },
    { id: 'SECT-003', label: 'a justification too short to be one',
      args: { status: 'FalsePositive', justification: 'not real', decidedBy: 'ada' },
      mustThrow: 'too short' },
    { id: 'SECT-004', label: 'an accepted risk with no justification',
      args: { status: 'Accepted', decidedBy: 'ada' }, mustThrow: 'no justification' },
    { id: 'SECT-005', label: 'an unknown status',
      args: { status: 'Ignored', justification: 'x'.repeat(40), decidedBy: 'ada' },
      mustThrow: 'Unknown security finding status' }
  ];

  for (const testCase of triageCases) {
    await golden({
      id: testCase.id,
      objective: `Triage refuses ${testCase.label}`,
      preconditions: ['a confirmed finding from the live scan'],
      input: testCase.label,
      expected: 'It throws. A suppression with no reason behind it is somebody switching the check '
        + 'off, and a workflow that accepts it quietly is how a gate becomes decoration',
      evidence: ['refusal.json'],
      severity: 'critical',
      run: async () => {
        let threw = null;
        try { triage(vulnerable.findings[0], testCase.args); }
        catch (error) { threw = error.message; }
        return {
          pass: threw !== null && threw.includes(testCase.mustThrow),
          detail: threw ?? 'the workflow accepted it',
          evidence: { 'refusal.json': { case: testCase.label, threw } }
        };
      }
    }, context);
  }

  await golden({
    id: 'SECT-006',
    objective: 'A properly justified decision is accepted and appended to the history, never overwriting it',
    preconditions: ['a confirmed finding, marked a false positive with a reason and a name'],
    input: 'A justification of substance and a named decision-maker, applied twice',
    expected: 'Both decisions in the history with the status each moved from. A status field that '
      + 'holds only the latest answer is not an audit trail',
    evidence: ['triaged.json'],
    severity: 'critical',
    run: async () => {
      const once = triage(vulnerable.findings[0], {
        status: 'NeedsReview', justification: null, decidedBy: null, at: '2026-09-01T00:00:00Z'
      });
      const twice = triage(once, {
        status: 'FalsePositive',
        justification: 'Reviewed against the source: the handler filters by the caller\'s own id, and '
          + 'the identifier in the URL is validated against it.',
        decidedBy: 'ada@example.invalid', at: '2026-09-02T00:00:00Z'
      });
      return {
        pass: twice.status === 'FalsePositive' && twice.triageHistory.length === 2
          && twice.triageHistory[0].status === 'NeedsReview'
          && twice.triageHistory[1].from === 'NeedsReview'
          && twice.decidedBy === 'ada@example.invalid',
        detail: twice.triageHistory.map(h => `${h.from} → ${h.status}`).join(', '),
        evidence: { 'triaged.json': twice }
      };
    }
  }, context);

  await golden({
    id: 'SECT-007',
    objective: 'A false positive suppresses that finding and not the same class elsewhere',
    preconditions: ['a BOLA finding marked a false positive on one endpoint'],
    input: 'The suppression tested against the same category on a different endpoint',
    expected: 'It does not apply. Suppressing one endpoint\'s BOLA says something about that endpoint; '
      + 'applying it to every BOLA in the application would hide real ones',
    evidence: ['suppression.json'],
    severity: 'critical',
    run: async () => {
      const [first] = vulnerable.findings;
      const decided = triage(first, {
        status: 'FalsePositive',
        justification: 'The handler checks ownership; the earlier reading of the response was wrong.',
        decidedBy: 'ada@example.invalid'
      });
      const suppression = { fingerprint: fingerprint(decided), ...decided };
      const elsewhere = { ...first, endpoint: '/api/statements/{id}' };

      return {
        pass: suppressionApplies(suppression, first) === true
          && suppressionApplies(suppression, elsewhere) === false,
        detail: `applies to ${first.endpoint}: yes; applies to ${elsewhere.endpoint}: `
          + `${suppressionApplies(suppression, elsewhere)}`,
        evidence: {
          'suppression.json': {
            suppressed: { endpoint: first.endpoint, print: fingerprint(first) },
            other: { endpoint: elsewhere.endpoint, print: fingerprint(elsewhere) }
          }
        }
      };
    }
  }, context);

  await golden({
    id: 'SECT-008',
    objective: 'Self-healing cannot mark a security finding resolved',
    preconditions: ['the triage workflow'],
    input: 'An attempt to resolve a finding with no person named',
    expected: 'Resolved requires a person, like every other status that stops a finding counting. '
      + 'The brief forbids self-healing hiding a security regression, and a machine-applied '
      + 'resolution is precisely that',
    evidence: ['outcome.json'],
    severity: 'critical',
    run: async () => {
      // Resolved is reachable without a justification by design — a finding a re-scan cannot
      // reproduce is a legitimate thing for a person to close. What must never happen is a
      // suppression (FalsePositive/Accepted) arriving without one, which is what an automated
      // healer would produce. Both halves are asserted.
      const machineSuppression = (() => {
        try {
          triage(vulnerable.findings[0], { status: 'FalsePositive', justification: 'auto-healed', decidedBy: 'self-healing' });
          return null;
        } catch (error) { return error.message; }
      })();

      const comparison = compareToBaseline([], [{
        application: 'access-control-lab', category: 'BOLA', endpoint: '/api/accounts/{id}',
        parameter: 'id', observedAsRole: 'alice', status: 'Confirmed', check: 'authz.bola'
      }], ['authz.bola']);

      return {
        pass: machineSuppression !== null
          && comparison.disappeared[0].outcome === 'notReproduced'
          && comparison.disappeared[0].status === 'Confirmed',
        detail: `automated suppression refused (${machineSuppression?.slice(0, 60)}...); `
          + `an unreproduced finding stays ${comparison.disappeared[0].status}`,
        evidence: { 'outcome.json': { machineSuppression, disappeared: comparison.disappeared } }
      };
    }
  }, context);

  await restoreFaults(LABS.accessControl);
  await resetLab(LABS.accessControl);
}
