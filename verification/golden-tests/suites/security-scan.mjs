/**
 * The security scanning suite.
 *
 * Every scenario in the catalogue is run twice against the lab and produces three recorded
 * results, because "the scanner found something" is three different claims and only one of
 * them is usually tested:
 *
 *   SECD  detection — with the flaw switched on alone, the check reports it
 *   SECP  precision — with the flaw switched off, the check reports nothing
 *   SECM  mapping   — the finding carries the CWE, OWASP category and severity band the
 *                     ground truth names
 *
 * The precision half is the one that decides whether anyone keeps using the tool. A
 * detector that reports BOLA everywhere detects every BOLA there is, and is worthless. So
 * each scenario isolates its flaw — every other fault in that lab is switched off — and a
 * check that keys on the wrong signal fails rather than passing by coincidence.
 *
 * SECS runs the endpoints the ground truth calls correct, with the lab left fully
 * vulnerable, because that is when false positives actually happen: a scanner that has just
 * found four real flaws is the one most likely to invent a fifth.
 *
 * Nothing in this suite runs against anything but the local lab. The scope is narrow, the
 * identities are synthetic, and the scope guard refuses anything else — which SECG proves
 * rather than asserts.
 */
import { ROOT, golden, suite, notVerified } from '../harness.mjs';
import { SecurityScanner } from '../../../packages/security-engine/src/engine.mjs';
import {
  DENIAL, SECURITY_PROFILE, SECURITY_RISK, evaluateScope, labScope
} from '../../../packages/security-engine/src/scope-guard.mjs';
import { MAX_SCORE, SeverityFactors } from '../../../packages/security-engine/src/severity.mjs';
import { writeFindingEvidence, redactText } from '../../../packages/security-engine/src/evidence.mjs';
import * as xssChecks from '../../../packages/security-engine/src/checks-xss.mjs';
import {
  LABS, SCENARIOS, SAFE_SCENARIOS, expectedFor, expectedSeverity,
  isolateFaults, resetLab, restoreFaults
} from '../security/scenarios.mjs';

const pad = n => String(n).padStart(3, '0');

/** A scope for the lab and nothing else. Destructive probes need the wider one. */
const scanner = ({ destructive = false } = {}) => new SecurityScanner({
  scope: labScope(destructive ? { allowDestructiveTesting: true } : {}),
  profile: destructive ? SECURITY_PROFILE.DEEP : SECURITY_PROFILE.STANDARD,
  context: { callerMayRunDestructiveScans: destructive }
});

/** Everything a scenario's three tests need, gathered by running the check twice. */
async function measure(scenario) {
  const expected = expectedFor(scenario.lab, scenario.vuln);

  await isolateFaults(scenario.lab, [scenario.vuln]);
  const vulnerable = await scenario.run(scanner({ destructive: scenario.destructive }));

  await isolateFaults(scenario.lab, []);
  const corrected = await scenario.run(scanner({ destructive: scenario.destructive }));

  await restoreFaults(scenario.lab);
  await resetLab(scenario.lab);

  const detected = (vulnerable.findings ?? []).filter(f => f.category === scenario.expectCategory);
  const falsePositives = (corrected.findings ?? []).filter(f => f.category === scenario.expectCategory);

  return { expected, vulnerable, corrected, detected, falsePositives };
}

const summarise = result => ({
  skipped: result.skipped ?? false,
  denial: result.decision?.reason ?? null,
  inconclusive: result.inconclusive ?? false,
  reason: result.reason ?? null,
  detail: result.detail ?? null,
  findings: (result.findings ?? []).map(f => ({
    category: f.category, title: f.title, cwe: f.cwe,
    owaspApi: f.owaspApiCategory ?? null, owaspWeb: f.owaspWebCategory ?? null,
    severity: f.severityFactors?.severity ?? null,
    score: f.severityFactors?.score ?? null,
    confidence: f.confidence ?? null,
    exchanges: (f.exchanges ?? []).length
  }))
});

export default async function run() {
  suite('Security scanning');

  const context = { applicationVersion: '1.0.0' };
  const measurements = [];

  // -----------------------------------------------------------------------
  // SECD / SECP / SECM — one scenario at a time
  // -----------------------------------------------------------------------
  for (const [index, scenario] of SCENARIOS.entries()) {
    const n = pad(index + 1);
    const measured = await measure(scenario);
    measurements.push({ scenario, measured });
    const { expected, vulnerable, corrected, detected, falsePositives } = measured;

    await golden({
      id: `SECD-${n}`,
      objective: scenario.objective,
      preconditions: [
        `${scenario.vuln} switched on and every other fault in the lab switched off`,
        'the lab audit agrees with the ground truth'
      ],
      input: `${scenario.family}: the ${scenario.key} check against the lab`,
      expected: `Exactly one ${scenario.expectCategory} finding, carrying the exchanges that establish it`,
      evidence: ['vulnerable.json'],
      severity: 'critical',
      run: async () => ({
        // Evidence is not optional. A finding with no exchanges cannot be checked by
        // anyone, and an unverifiable finding is indistinguishable from an invented one.
        pass: detected.length === 1 && (detected[0].exchanges ?? []).length > 0,
        detail: detected.length === 1
          ? `${detected[0].category}: ${detected[0].title} (${detected[0].exchanges.length} exchange(s))`
          : vulnerable.skipped
            ? `the scope guard refused the probe: ${vulnerable.decision?.reason}`
            : vulnerable.inconclusive
              ? `inconclusive: ${vulnerable.reason}`
              : `expected 1 ${scenario.expectCategory}, got ${detected.length} `
                + `[${(vulnerable.findings ?? []).map(f => f.category).join(', ') || 'none'}]`,
        metrics: { detected: detected.length, exchanges: detected[0]?.exchanges?.length ?? 0 },
        evidence: { 'vulnerable.json': summarise(vulnerable) }
      })
    }, context);

    await golden({
      id: `SECP-${n}`,
      objective: `The ${scenario.key} check reports nothing once the flaw is corrected`,
      preconditions: [`every fault in the lab switched off, including ${scenario.vuln}`],
      input: `The same ${scenario.key} check against the corrected application`,
      expected: 'No finding of this category — a detector that reports the same thing whether or not '
        + 'the flaw is present is not a detector',
      evidence: ['corrected.json'],
      severity: 'critical',
      run: async () => ({
        pass: falsePositives.length === 0,
        detail: falsePositives.length === 0
          ? corrected.detail ?? corrected.reason ?? 'no finding'
          : `FALSE POSITIVE: ${falsePositives.map(f => f.title).join('; ')}`,
        metrics: { falsePositives: falsePositives.length },
        evidence: { 'corrected.json': summarise(corrected) }
      })
    }, context);

    await golden({
      id: `SECM-${n}`,
      objective: `The ${scenario.key} finding carries the CWE, OWASP category and severity it should`,
      preconditions: ['the detection scenario produced a finding'],
      input: 'The finding produced by the detection scenario, compared against the lab ground truth',
      expected: expected
        ? `CWE ${expected.cwe}, OWASP ${expected.owaspWeb ?? expected.owaspApi ?? '—'}, severity `
          + `${expectedSeverity(expected)}, and a severity derived from stored factors rather than assigned`
        : 'a ground truth entry naming the CWE and severity',
      evidence: ['mapping.json'],
      severity: 'high',
      run: async () => {
        const finding = detected[0];
        if (!finding || !expected) {
          return {
            pass: false,
            detail: !expected ? `no ground truth entry for ${scenario.vuln}` : 'no finding to check',
            evidence: { 'mapping.json': { expected, got: null } }
          };
        }
        const cweOk = finding.cwe === expected.cwe;
        const owaspOk = !expected.owaspWeb || finding.owaspWebCategory === expected.owaspWeb;
        const owaspApiOk = !expected.owaspApi || finding.owaspApiCategory === expected.owaspApi;
        const severityOk = finding.severityFactors?.severity === expectedSeverity(expected);
        // The severity has to be recomputable from the stored factors. A number a model
        // produced and nobody can reproduce is an opinion with a decimal point.
        const factors = finding.severityFactors;
        const recomputed = factors instanceof SeverityFactors
          ? new SeverityFactors(factors.exploitability, factors.impact, factors.privilegeRequired,
                                factors.affectedData, factors.exposure, factors.requiresUnusualConditions)
          : null;
        const reproducible = recomputed !== null && recomputed.score === factors.score
          && recomputed.severity === factors.severity;

        return {
          pass: cweOk && owaspOk && owaspApiOk && severityOk && reproducible,
          detail: [
            cweOk ? null : `CWE ${finding.cwe} ≠ ${expected.cwe}`,
            owaspOk ? null : `OWASP web ${finding.owaspWebCategory} ≠ ${expected.owaspWeb}`,
            owaspApiOk ? null : `OWASP API ${finding.owaspApiCategory} ≠ ${expected.owaspApi}`,
            severityOk ? null : `severity ${factors?.severity} ≠ ${expectedSeverity(expected)}`,
            reproducible ? null : 'severity not reproducible from the stored factors'
          ].filter(Boolean).join('; ')
            || `${finding.cwe}, ${finding.owaspWebCategory}, ${factors.severity} `
               + `(${factors.score}/${MAX_SCORE}) — ${factors.explain()}`,
          metrics: { score: factors?.score ?? -1, maxScore: MAX_SCORE },
          evidence: {
            'mapping.json': {
              expected, got: {
                cwe: finding.cwe, cweConfidence: finding.cweConfidence,
                owaspWeb: finding.owaspWebCategory, owaspApi: finding.owaspApiCategory,
                confidence: finding.confidence,
                severity: factors?.toJSON() ?? null
              }
            }
          }
        };
      }
    }, context);
  }

  // -----------------------------------------------------------------------
  // SECS — the endpoints that must stay quiet
  // -----------------------------------------------------------------------
  for (const [index, safe] of SAFE_SCENARIOS.entries()) {
    const n = pad(index + 1);
    await restoreFaults(safe.lab);
    await resetLab(safe.lab);
    const result = await safe.run(scanner());

    await golden({
      id: `SECS-${n}`,
      objective: safe.objective,
      preconditions: ['the lab left in its ordinary, fully vulnerable state'],
      input: `${safe.endpoint}, which the lab ground truth calls correct`,
      expected: 'No finding. Any finding here is a false positive on an endpoint that does nothing wrong',
      evidence: ['result.json'],
      severity: 'critical',
      run: async () => ({
        pass: (result.findings ?? []).length === 0,
        detail: (result.findings ?? []).length === 0
          ? result.detail ?? 'no finding'
          : `FALSE POSITIVE: ${result.findings.map(f => f.category).join(', ')}`,
        metrics: { findings: (result.findings ?? []).length },
        evidence: { 'result.json': summarise(result) }
      })
    }, context);
  }

  // -----------------------------------------------------------------------
  // SECX — what this scan cannot decide, recorded as untested
  // -----------------------------------------------------------------------
  await restoreFaults(LABS.xss);
  const dom = await xssChecks.checkDomXss(scanner(), { baseUrl: LABS.xss, path: '/dom' });
  await golden({
    id: 'SECX-001',
    objective: 'DOM-based XSS is reported as not tested by a response-only scan, never as absent',
    preconditions: ['the xss lab with VULN_DOM_XSS on'],
    input: 'GET /dom, whose source is location.hash and whose sink is innerHTML',
    expected: 'notTestable, with the reason and the sinks observed — the brief requires tested coverage '
      + 'to be distinguishable from untested areas, and "no DOM XSS found" from a scan that cannot see '
      + 'the DOM is a claim the evidence does not support',
    evidence: ['not-testable.json'],
    severity: 'critical',
    run: async () => ({
      pass: dom.notTestable === true && (dom.findings ?? []).length === 0
        && typeof dom.reason === 'string' && dom.reason.length > 0,
      detail: dom.notTestable ? dom.detail : 'the check did not declare itself not-testable',
      metrics: { sinks: dom.observed?.sinks?.length ?? 0, sources: dom.observed?.sources?.length ?? 0 },
      evidence: { 'not-testable.json': { reason: dom.reason, observed: dom.observed, detail: dom.detail } }
    })
  }, context);

  // -----------------------------------------------------------------------
  // SECG — the scope guard, proved rather than asserted
  // -----------------------------------------------------------------------
  const guardCases = [
    { id: 'no scope at all', scope: null, request: { url: `${LABS.api}/api/users`, method: 'GET' },
      expect: DENIAL.SCOPE_MISSING,
      why: 'The absence of a restriction is not permission. An application nobody has authorized '
        + 'security testing against gets nothing.' },
    { id: 'scope disabled', scope: labScope({ enabled: false }), request: { url: `${LABS.api}/api/users` },
      expect: DENIAL.SCOPE_DISABLED, why: 'A scope that exists but is switched off permits nothing.' },
    { id: 'no written authorization', scope: labScope({ authorizationNote: '' }),
      request: { url: `${LABS.api}/api/users` }, expect: DENIAL.SCOPE_MISSING,
      why: 'Authorization is a written statement by a person, not a default.' },
    { id: 'empty domain allowlist', scope: labScope({ allowedDomains: [] }),
      request: { url: `${LABS.api}/api/users` }, expect: DENIAL.DOMAIN_NOT_ALLOWED,
      why: 'An empty allowlist permits nothing. Treating it as "no restriction" is how a scanner '
        + 'ends up on the internet.' },
    { id: 'a host nobody authorized', scope: labScope(),
      request: { url: 'https://example.com/' }, expect: DENIAL.DOMAIN_NOT_ALLOWED,
      why: 'Arbitrary URLs are never allowed.' },
    { id: 'cloud metadata, despite an allowlist that names it', scope: labScope({ allowedDomains: ['169.254.169.254'] }),
      request: { url: 'http://169.254.169.254/latest/meta-data/' }, expect: DENIAL.DOMAIN_NOT_ALLOWED,
      why: 'Never a legitimate target, whatever the scope says. A scope cannot opt in to this.' },
    { id: 'GCP metadata by name', scope: labScope({ allowedDomains: ['metadata.google.internal'] }),
      request: { url: 'http://metadata.google.internal/computeMetadata/v1/' },
      expect: DENIAL.DOMAIN_NOT_ALLOWED, why: 'The same, by hostname rather than address.' },
    { id: 'a non-http scheme', scope: labScope(), request: { url: 'file:///etc/passwd' },
      expect: DENIAL.DOMAIN_NOT_ALLOWED, why: 'Only http and https are ever issued.' },
    { id: 'a blocked path', scope: labScope({ blockedPaths: ['/api/admin/*'] }),
      request: { url: `${LABS.accessControl}/api/admin/users` }, expect: DENIAL.PATH_BLOCKED,
      why: 'A path the owner excluded stays excluded.' },
    { id: 'a path outside the allowlist', scope: labScope({ allowedPaths: ['/api/public/*'] }),
      request: { url: `${LABS.api}/api/users` }, expect: DENIAL.PATH_NOT_ALLOWED,
      why: 'Where an allowlist of paths exists, everything else is out of scope.' },
    { id: 'active testing when the scope permits passive only', scope: labScope({ allowActiveTesting: false }),
      request: { url: `${LABS.api}/api/users`, risk: SECURITY_RISK.ACTIVE },
      expect: DENIAL.ACTIVE_NOT_ALLOWED, why: 'Passive means passive.' },
    { id: 'a DELETE under an ordinary scope', scope: labScope(),
      request: { url: `${LABS.api}/api/notes/1`, method: 'DELETE', profile: SECURITY_PROFILE.DEEP },
      expect: DENIAL.DESTRUCTIVE_NOT_ALLOWED,
      why: 'Destructive testing is off by default and the verb raises the risk regardless of what the '
        + 'check declared.' },
    { id: 'a POST declared passive', scope: labScope({ allowActiveTesting: false }),
      request: { url: `${LABS.api}/api/notes`, method: 'POST', risk: SECURITY_RISK.PASSIVE },
      expect: DENIAL.ACTIVE_NOT_ALLOWED,
      why: 'The declared risk can be raised by the verb and never lowered. A check cannot talk its way '
        + 'past the guard by understating what it is about to do.' },
    { id: 'the passive profile asked for an active probe', scope: labScope(),
      request: { url: `${LABS.api}/api/users`, risk: SECURITY_RISK.ACTIVE, profile: SECURITY_PROFILE.PASSIVE },
      expect: DENIAL.PROFILE_DOES_NOT_PERMIT, why: 'The profile bounds what the scan will do.' },
    { id: 'an account without permission for active scans', scope: labScope(),
      request: { url: `${LABS.api}/api/users`, risk: SECURITY_RISK.ACTIVE },
      context: { callerMayRunActiveScans: false }, expect: DENIAL.PERMISSION_DENIED,
      why: 'The caller\'s permissions bound the scan as well as the scope.' },
    { id: 'production, unauthorized', scope: labScope(),
      request: { url: `${LABS.api}/api/users` }, context: { isProductionEnvironment: true },
      expect: DENIAL.PRODUCTION_NOT_AUTHORIZED,
      why: 'Production security testing is disabled by default, which the brief requires.' },
    { id: 'production, allowed by the scope but not authorized for this run', scope: labScope({ allowProduction: true }),
      request: { url: `${LABS.api}/api/users` },
      context: { isProductionEnvironment: true, productionTestingAuthorized: false },
      expect: DENIAL.PRODUCTION_NOT_AUTHORIZED,
      why: 'A standing permission is not a decision to run today.' },
    { id: 'a different environment from the one authorized', scope: labScope({ environmentId: 'env-qa' }),
      request: { url: `${LABS.api}/api/users`, environmentId: 'env-staging' },
      expect: DENIAL.PRODUCTION_NOT_AUTHORIZED,
      why: 'Authorization names an environment, and another one is not covered by it.' },
    { id: 'over the rate limit', scope: labScope({ maxRequestsPerSecond: 5 }),
      request: { url: `${LABS.api}/api/users` }, context: { requestsInLastSecond: 5 },
      expect: DENIAL.RATE_LIMIT, why: 'A limit a caller can decline to observe is documentation.' },
    { id: 'over the concurrency limit', scope: labScope({ maxConcurrentRequests: 2 }),
      request: { url: `${LABS.api}/api/users` }, context: { requestsInFlight: 2 },
      expect: DENIAL.CONCURRENCY_LIMIT, why: 'The same, for parallelism.' },
    { id: 'past the scan duration', scope: labScope({ maxScanDurationMinutes: 10 }),
      request: { url: `${LABS.api}/api/users` }, context: { scanElapsedMinutes: 10 },
      expect: DENIAL.DURATION_EXCEEDED, why: 'A scan that runs forever is an incident.' },
    { id: 'a URL that is not absolute', scope: labScope(), request: { url: '/api/users' },
      expect: DENIAL.DOMAIN_NOT_ALLOWED, why: 'A relative URL names no host, so no host was authorized.' },
    { id: 'no HTTP method', scope: labScope(), request: { url: `${LABS.api}/api/users`, method: '' },
      expect: DENIAL.METHOD_NOT_ALLOWED, why: 'A request that names no verb is refused rather than guessed at.' }
  ];

  for (const [index, testCase] of guardCases.entries()) {
    const n = pad(index + 1);
    await golden({
      id: `SECG-${n}`,
      objective: `The scope guard refuses ${testCase.id}`,
      preconditions: ['the guard evaluated directly, with no application involved'],
      input: testCase.id,
      expected: `Refused with ${testCase.expect}. ${testCase.why}`,
      evidence: ['decision.json'],
      severity: 'critical',
      run: async () => {
        const decision = evaluateScope(testCase.scope, {
          method: 'GET', risk: SECURITY_RISK.PASSIVE, profile: SECURITY_PROFILE.STANDARD,
          ...testCase.request
        }, testCase.context ?? {});
        return {
          pass: decision.allowed === false && decision.reason === testCase.expect,
          detail: decision.allowed
            ? `ALLOWED — it should have been refused with ${testCase.expect}`
            : `${decision.reason}: ${decision.explanation}`,
          metrics: { rungsPassed: decision.checksPassed?.length ?? 0 },
          evidence: { 'decision.json': { case: testCase.id, why: testCase.why, decision } }
        };
      }
    }, context);
  }

  // The one that must be allowed. A guard that refuses everything is not a control, it is
  // an outage, and a suite of refusals alone cannot tell the two apart.
  await golden({
    id: 'SECG-024',
    objective: 'The scope guard allows the scan it was written to allow',
    preconditions: ['the lab scope, a lab host, an active probe'],
    input: 'GET against the api lab under the lab scope',
    expected: 'Allowed, having passed every rung in order — otherwise the twenty-three refusals above '
      + 'prove only that the guard says no to everything',
    evidence: ['decision.json'],
    severity: 'critical',
    run: async () => {
      const decision = evaluateScope(labScope(), {
        url: `${LABS.api}/api/users`, method: 'GET', risk: SECURITY_RISK.ACTIVE,
        profile: SECURITY_PROFILE.STANDARD
      }, {});
      const order = ['authorization', 'target-policy', 'domain', 'path', 'method', 'risk', 'environment', 'rate'];
      return {
        pass: decision.allowed === true
          && JSON.stringify(decision.checksPassed) === JSON.stringify(order),
        detail: decision.allowed
          ? `allowed; rungs in order: ${decision.checksPassed.join(' → ')}`
          : `refused: ${decision.reason}`,
        evidence: { 'decision.json': decision }
      };
    }
  }, context);

  // -----------------------------------------------------------------------
  // SECE — evidence and redaction
  // -----------------------------------------------------------------------
  await golden({
    id: 'SECE-001',
    objective: 'A finding with no exchange is refused rather than recorded',
    preconditions: ['the evidence writer'],
    input: 'A finding declared with an empty exchange list',
    expected: 'It throws. A finding nobody can check is indistinguishable from one that was invented, '
      + 'and the brief forbids calling a vulnerability confirmed without reproducible evidence',
    evidence: ['refusal.json'],
    severity: 'critical',
    run: async ({ save }) => {
      let threw = null;
      try {
        writeFindingEvidence({
          root: '/tmp/aira-evidence-selfcheck', findingId: 'no-evidence',
          finding: { category: 'Invented', title: 'A finding with nothing behind it' }, exchanges: []
        });
      } catch (error) { threw = String(error.message); }
      return {
        pass: threw !== null,
        detail: threw ?? 'the writer accepted a finding with no evidence',
        evidence: { 'refusal.json': { threw } }
      };
    }
  }, context);

  await golden({
    id: 'SECE-002',
    objective: 'Secrets are removed from sanitized evidence and non-secrets survive it',
    preconditions: ['the redaction function'],
    input: 'A bearer token, a password, an API key and an ordinary sentence',
    expected: 'Every secret gone, every non-secret intact — redaction that eats the evidence is as '
      + 'useless as redaction that leaks it',
    evidence: ['redaction.json'],
    severity: 'critical',
    run: async () => {
      const secrets = [
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.synthetic.value',
        '{"password":"lab-password"}',
        'sk_test_synthetic_4f8a2c9e1b7d3a5f6c0e'
      ];
      const keep = 'The owner received 200 and the intruder received 200 for account acc-1002.';
      const redactedSecrets = secrets.map(s => redactText(s, ['lab-password']));
      const redactedKeep = redactText(keep, ['lab-password']);

      const leaked = redactedSecrets.filter((out, i) =>
        out.includes('eyJhbGciOiJIUzI1NiJ9') || out.includes('lab-password')
        || out.includes('sk_test_synthetic_4f8a2c9e1b7d3a5f6c0e'));
      const eaten = redactedKeep !== keep;

      return {
        pass: leaked.length === 0 && !eaten,
        detail: leaked.length > 0 ? `leaked: ${leaked.join(' | ')}`
          : eaten ? `redaction removed non-secret text: ${redactedKeep}`
            : 'all three secrets removed, the descriptive sentence untouched',
        metrics: { leaked: leaked.length },
        evidence: { 'redaction.json': { redactedSecrets, redactedKeep, eaten } }
      };
    }
  }, context);

  await golden({
    id: 'SECE-003',
    objective: 'Blocked requests are recorded, so coverage can be read from what a scan did not do',
    preconditions: ['a scope that refuses the host'],
    input: 'Three probes against a host the scope does not allow',
    expected: 'Three refusals in the scanner summary, each naming the reason — a scan that silently '
      + 'skips what it could not reach reports the same clean result as one that reached everything',
    evidence: ['summary.json'],
    severity: 'critical',
    run: async () => {
      const narrow = new SecurityScanner({ scope: labScope({ allowedDomains: ['nothing.invalid'] }) });
      for (const path of ['/api/users', '/api/notes', '/api/search']) {
        await narrow.request({ url: `${LABS.api}${path}`, testId: 'SECE-003' });
      }
      const summary = narrow.summary();
      return {
        pass: summary.requestsBlocked === 3 && summary.requestsIssued === 0
          && summary.blocked.every(b => b.reason === DENIAL.DOMAIN_NOT_ALLOWED),
        detail: `${summary.requestsIssued} issued, ${summary.requestsBlocked} blocked `
          + `(${[...new Set(summary.blocked.map(b => b.reason))].join(', ')})`,
        metrics: { issued: summary.requestsIssued, blocked: summary.requestsBlocked },
        evidence: { 'summary.json': summary }
      };
    }
  }, context);

  await golden({
    id: 'SECE-004',
    objective: 'Evidence is written in both raw and sanitized form, and hashed',
    preconditions: ['a real finding from the detection scenarios'],
    input: 'The excessive-data finding, whose response carries synthetic secrets',
    expected: 'request, response, sanitized-request, sanitized-response, reproduction.md, metadata.json '
      + 'and sha256.txt, with the secrets present in the raw copy and absent from the sanitized one',
    evidence: ['written.json'],
    severity: 'critical',
    run: async ({ save }) => {
      await isolateFaults(LABS.api, ['VULN_EXCESSIVE_DATA']);
      const s = scanner();
      const session = await s.signIn(LABS.api, 'alice');
      const { checkExcessiveData } = await import('../../../packages/security-engine/src/checks-api.mjs');
      const result = await checkExcessiveData(s, {
        baseUrl: LABS.api, path: '/api/users', actor: { cookie: session.cookie, label: 'alice' }
      });
      await restoreFaults(LABS.api);

      const finding = result.findings?.[0];
      if (!finding) return { pass: false, detail: 'no finding to write evidence for', evidence: {} };

      const root = save('evidence-root/.keep', '').replace('/.keep', '');
      const written = writeFindingEvidence({
        root, findingId: 'SECE-004-excessive-data', finding,
        exchanges: finding.exchanges, literals: finding.redactLiterals ?? []
      });

      const { readFileSync } = await import('node:fs');
      const raw = readFileSync(`${root}/SECE-004-excessive-data/response.txt`, 'utf8');
      const clean = readFileSync(`${root}/SECE-004-excessive-data/sanitized-response.txt`, 'utf8');
      const secret = 'sk_test_synthetic_u-alice';

      return {
        pass: raw.includes(secret) && !clean.includes(secret)
          && written.files.length >= 6 && typeof written.digest === 'string',
        detail: `${written.files.length} file(s); the secret is ${raw.includes(secret) ? 'present' : 'ABSENT'} `
          + `in the raw copy and ${clean.includes(secret) ? 'STILL PRESENT' : 'absent'} in the sanitized one`,
        metrics: { files: written.files.length },
        evidence: { 'written.json': { files: written.files, sha256: written.digest } }
      };
    }
  }, context);

  await golden({
    id: 'SECE-005',
    objective: 'Every finding the engine can emit declares a confidence',
    preconditions: ['the engine source'],
    input: 'Each finding literal across the seven check families',
    expected: 'All of them set a confidence from the engine\'s own three factors. A finding with no '
      + 'confidence does not read as unknown anywhere downstream — it reads as whatever the reader\'s '
      + 'fallback is, and every fallback is a number nobody chose for it',
    evidence: ['sites.json'],
    severity: 'critical',
    run: async () => {
      const { readdirSync, readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const dir = resolve(ROOT, 'packages/security-engine/src');

      const sites = [];
      for (const file of readdirSync(dir).filter(f => f.startsWith('checks-'))) {
        const lines = readFileSync(resolve(dir, file), 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (!/^\s*severityFactors:/.test(line)) return;
          // A finding literal is written in one place, so its confidence is within a few
          // dozen lines of its severity either way.
          const window = lines.slice(Math.max(0, index - 30), index + 30).join('\n');
          sites.push({
            file, line: index + 1, declaresConfidence: /^\s*confidence:/m.test(window)
          });
        });
      }

      const silent = sites.filter(site => !site.declaresConfidence);
      return {
        pass: sites.length > 0 && silent.length === 0,
        detail: `${sites.length} finding site(s); ${silent.length} declare no confidence`,
        metrics: { sites: sites.length, silent: silent.length },
        evidence: { 'sites.json': { sites, silent } }
      };
    }
  }, context);

  // -----------------------------------------------------------------------
  // SECF — the profile matrix
  // -----------------------------------------------------------------------
  const profileMatrix = [
    { profile: SECURITY_PROFILE.PASSIVE, risk: SECURITY_RISK.PASSIVE, allowed: true },
    { profile: SECURITY_PROFILE.PASSIVE, risk: SECURITY_RISK.ACTIVE, allowed: false },
    { profile: SECURITY_PROFILE.PASSIVE, risk: SECURITY_RISK.STATE_CHANGING, allowed: false },
    { profile: SECURITY_PROFILE.PASSIVE, risk: SECURITY_RISK.DESTRUCTIVE, allowed: false },
    { profile: SECURITY_PROFILE.STANDARD, risk: SECURITY_RISK.PASSIVE, allowed: true },
    { profile: SECURITY_PROFILE.STANDARD, risk: SECURITY_RISK.ACTIVE, allowed: true },
    { profile: SECURITY_PROFILE.STANDARD, risk: SECURITY_RISK.STATE_CHANGING, allowed: true },
    { profile: SECURITY_PROFILE.STANDARD, risk: SECURITY_RISK.DESTRUCTIVE, allowed: false },
    { profile: SECURITY_PROFILE.REGRESSION, risk: SECURITY_RISK.ACTIVE, allowed: true },
    { profile: SECURITY_PROFILE.REGRESSION, risk: SECURITY_RISK.DESTRUCTIVE, allowed: false },
    { profile: SECURITY_PROFILE.DEEP, risk: SECURITY_RISK.STATE_CHANGING, allowed: true },
    { profile: SECURITY_PROFILE.DEEP, risk: SECURITY_RISK.DESTRUCTIVE, allowed: true }
  ];

  for (const [index, cell] of profileMatrix.entries()) {
    const n = pad(index + 1);
    const riskName = ['passive', 'active', 'state-changing', 'destructive'][cell.risk];
    await golden({
      id: `SECF-${n}`,
      objective: `The ${cell.profile} profile ${cell.allowed ? 'permits' : 'refuses'} a ${riskName} probe`,
      preconditions: ['a scope that permits destructive testing, so the profile is the only thing deciding'],
      input: `profile=${cell.profile}, risk=${riskName}`,
      expected: cell.allowed
        ? 'Allowed, because this profile covers this risk level'
        : 'Refused with profileDoesNotPermit, because the profile is the promise made to whoever '
          + 'approved the scan about what it would do',
      evidence: ['decision.json'],
      severity: 'high',
      run: async () => {
        const decision = evaluateScope(
          labScope({ allowDestructiveTesting: true }),
          { url: `${LABS.api}/api/users`, method: 'GET', risk: cell.risk, profile: cell.profile },
          { callerMayRunDestructiveScans: true });
        return {
          pass: decision.allowed === cell.allowed
            && (cell.allowed || decision.reason === DENIAL.PROFILE_DOES_NOT_PERMIT),
          detail: decision.allowed ? 'allowed' : `${decision.reason}: ${decision.explanation}`,
          evidence: { 'decision.json': { profile: cell.profile, risk: riskName, decision } }
        };
      }
    }, context);
  }

  // -----------------------------------------------------------------------
  // SECR — what the numbers actually are
  // -----------------------------------------------------------------------
  const detectionRate = measurements.filter(m => m.measured.detected.length === 1).length;
  const falsePositiveCount = measurements.reduce((n, m) => n + m.measured.falsePositives.length, 0);

  await golden({
    id: 'SECR-001',
    objective: 'The measured detection and false-positive rates are recorded, not claimed',
    preconditions: ['every detection and precision scenario has run'],
    input: `${measurements.length} scenarios, each run against the flaw and against its correction`,
    expected: 'Every scenario detects its flaw and none reports it when corrected. The numbers are '
      + 'the ones this run measured against this lab, and say nothing about any other application',
    evidence: ['rates.json'],
    severity: 'critical',
    run: async () => ({
      pass: detectionRate === measurements.length && falsePositiveCount === 0,
      detail: `${detectionRate}/${measurements.length} detected, ${falsePositiveCount} false positive(s) `
        + 'on the corrected application',
      metrics: { scenarios: measurements.length, detected: detectionRate, falsePositives: falsePositiveCount },
      evidence: {
        'rates.json': {
          note: 'Measured against the AIRA security lab on this run. Detection rate against a lab whose '
            + 'flaws were written alongside the checks is not a detection rate against an unknown '
            + 'application, and must not be quoted as one.',
          scenarios: measurements.length,
          detected: detectionRate,
          falsePositives: falsePositiveCount,
          byScenario: measurements.map(({ scenario, measured }) => ({
            key: scenario.key, vulnerability: scenario.vuln, family: scenario.family,
            detected: measured.detected.length, falsePositives: measured.falsePositives.length,
            severity: measured.detected[0]?.severityFactors?.severity ?? null
          }))
        }
      }
    })
  }, context);

  // What this suite does not cover, stated rather than left to be inferred.
  notVerified({
    id: 'SECN-001',
    objective: 'Security scanning against a production environment',
    expected: 'Refused unless explicitly authorized for that run',
    severity: 'critical'
  }, 'Not executed. Production security testing is disabled by default and no production environment '
   + 'exists here. The refusal path is verified by SECG-016 and SECG-017; the permitted path is not '
   + 'exercised anywhere and is NOT VERIFIED.');

  notVerified({
    id: 'SECN-002',
    objective: 'Browser-driven DOM XSS detection',
    expected: 'A browser-driven scan reaches the sinks a response-only scan cannot',
    severity: 'high'
  }, 'Not implemented. SECX-001 records DOM XSS as not testable by this scan rather than as absent. '
   + 'Until a browser-driven security scan exists, DOM-based XSS is an untested area of coverage.');

  notVerified({
    id: 'SECN-003',
    objective: 'Detection rate against an application AIRA has not seen',
    expected: 'A measured rate that generalises',
    severity: 'critical'
  }, 'Not measured, and not measurable here. Every flaw in the lab was written alongside the check that '
   + 'finds it. The rate in SECR-001 describes this lab and nothing else.');

  for (const lab of Object.values(LABS)) {
    await restoreFaults(lab);
    await resetLab(lab);
  }
}
