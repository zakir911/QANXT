/**
 * Security scopes, scans and findings, through AIRA's own API.
 *
 * The scanning and gate suites drive the engine directly. This one goes through the
 * platform: the authorization somebody wrote, the scan recorded against it, the findings
 * stored, the second scan that produces a regression, and the triage decision that needs a
 * person. It is the path a team actually uses, and the one where "the code exists" is
 * furthest from "it works".
 *
 * Every refusal here is a rule from the brief, tested at the layer that enforces it rather
 * than the layer that documents it.
 */
import { golden, suite } from '../harness.mjs';
import {
  LAB, createProject, newTenant, registerApplication, request
} from '../platform.mjs';
import { evaluateSecurityGate } from '../security/gate.mjs';

const AUTHORIZATION = 'Authorized for automated security testing by the AIRA verification suite, '
  + 'against a synthetic lab application containing no real data, for the duration of this run.';

const scopeBody = (overrides = {}) => ({
  enabled: true,
  authorizationNote: AUTHORIZATION,
  allowedDomains: '127.0.0.1',
  allowedApiDomains: '',
  allowedPaths: '',
  blockedPaths: '',
  environmentId: null,
  maxRequestsPerSecond: 10,
  maxConcurrentRequests: 2,
  maxScanDurationMinutes: 10,
  allowActiveTesting: true,
  allowDestructiveTesting: false,
  allowProduction: false,
  ...overrides
});

const finding = (overrides = {}) => ({
  category: 'BOLA',
  title: 'alice can read a resource owned by bob',
  testId: 'authz.bola',
  endpoint: '/api/accounts/{id}',
  httpMethod: 'GET',
  parameter: 'id',
  observedAsRole: 'alice',
  severity: 3,              // High
  confidence: 2,            // High
  severityFactorsJson: JSON.stringify({
    exploitability: 'trivial', impact: 'serious', privilegeRequired: 'authenticatedUser',
    affectedData: 'personalData', exposure: 'authenticatedUsers', score: 14, maxScore: 19
  }),
  cwe: 'CWE-639',
  cweConfidence: 'confirmed',
  owaspApiCategory: 'API1:2023',
  owaspWebCategory: 'A01:2021',
  owaspEdition: '2021',
  description: 'bob reads acc-1002 and receives 200. alice, who does not own it, requests the same '
    + 'identifier and receives 200 with acc-1002 in the body.',
  impact: 'Any authenticated user can read another user\'s data by changing an identifier.',
  remediation: 'Check ownership on every object lookup.',
  reproductionSteps: '1. Sign in as bob, GET /api/accounts/acc-1002 → 200.\n'
    + '2. Sign in as alice, GET /api/accounts/acc-1002 → 200 with bob\'s data.',
  evidencePath: 'evidence/SECD-001/latest',
  exchangeCount: 2,
  ...overrides
});

const scanBody = (applicationId, projectId, overrides = {}) => ({
  applicationId, projectId, environmentId: null,
  profile: 1,               // Standard
  requestsIssued: 120,
  testsExecuted: 5,
  testsSkipped: 0,
  durationMs: 4200,
  findings: [finding()],
  blockedRequests: [],
  checksConfigured: ['authz.bola', 'authz.vertical', 'authz.readonly', 'authz.missing', 'authz.token'],
  checksExecuted: ['authz.bola', 'authz.vertical', 'authz.readonly', 'authz.missing', 'authz.token'],
  untestedAreas: ['DOM-based XSS (needs a browser-driven scan)'],
  ...overrides
});

export default async function run() {
  suite('Security scopes, scans and findings');

  const tenant = await newTenant('SecPlatform');
  const project = await createProject(tenant, 'Security platform');
  const application = await registerApplication(tenant, project.id, {
    name: 'Access control lab', baseUrl: LAB.securityAccessControl ?? 'http://127.0.0.1:4401',
    loginUrl: null, username: null, password: null
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };
  const api = (path, options = {}) => request(path, { token: tenant.token, ...options });

  // -----------------------------------------------------------------------
  // SECPL — authorization
  // -----------------------------------------------------------------------
  await golden({
    id: 'SECPL-001',
    objective: 'An application with no security scope returns 404, not an empty permissive scope',
    preconditions: ['an application nobody has authorized'],
    input: 'GET the application\'s security scope',
    expected: '404. "Nobody has authorized this" and "there is a scope that allows nothing" are '
      + 'different facts, and returning a default-shaped object invites a caller to treat the first '
      + 'as configuration to tweak',
    evidence: ['response.json'],
    severity: 'critical',
    run: async () => {
      const response = await api(`/api/v1/security/applications/${application.id}/scope`);
      return {
        pass: response.status === 404,
        detail: `${response.status}`,
        evidence: { 'response.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  await golden({
    id: 'SECPL-002',
    objective: 'A scope cannot be enabled without a written authorization',
    preconditions: ['the application'],
    input: 'A scope with enabled true and an empty authorization note',
    expected: '400, naming the field. Authorization is a written statement by a person, and the '
      + 'absence of a restriction is not permission',
    evidence: ['response.json'],
    severity: 'critical',
    run: async () => {
      const response = await api(`/api/v1/security/applications/${application.id}/scope`, {
        method: 'PUT', body: scopeBody({ authorizationNote: '   ' })
      });
      return {
        pass: response.status === 400
          && JSON.stringify(response.json ?? {}).includes('authorizationNote'),
        detail: `${response.status}: ${response.json?.detail ?? response.json?.title ?? ''}`,
        evidence: { 'response.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  await golden({
    id: 'SECPL-003',
    objective: 'A scope cannot be enabled with an empty domain allowlist',
    preconditions: ['the application'],
    input: 'A scope with a written authorization and no allowed domains',
    expected: '400. An empty allowlist permits nothing, and saving one as though it were a working '
      + 'scope hides that',
    evidence: ['response.json'],
    severity: 'critical',
    run: async () => {
      const response = await api(`/api/v1/security/applications/${application.id}/scope`, {
        method: 'PUT', body: scopeBody({ allowedDomains: '' })
      });
      return {
        pass: response.status === 400,
        detail: `${response.status}: ${response.json?.detail ?? ''}`,
        evidence: { 'response.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  await golden({
    id: 'SECPL-004',
    objective: 'Destructive testing and production can never be authorized together',
    preconditions: ['an organization admin, who holds security:production'],
    input: 'A scope with allowProduction and allowDestructiveTesting both true',
    expected: 'Refused as a security policy violation, at the point somebody tries to configure it '
      + 'rather than one request at a time later',
    evidence: ['response.json'],
    severity: 'critical',
    run: async () => {
      const response = await api(`/api/v1/security/applications/${application.id}/scope`, {
        method: 'PUT',
        body: scopeBody({ allowProduction: true, allowDestructiveTesting: true })
      });
      return {
        pass: response.status === 403 || response.status === 422 || response.status === 400,
        detail: `${response.status}: ${response.json?.detail ?? ''}`,
        evidence: { 'response.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  await golden({
    id: 'SECPL-005',
    objective: 'A valid authorization is stored, stamped with who gave it and when',
    preconditions: ['the application'],
    input: 'A scope with a written authorization and a named host',
    expected: 'Stored, enabled, and carrying authorizedByUserId and authorizedAt — a scan has to be '
      + 'able to point at a written authorization somebody gave',
    evidence: ['scope.json'],
    severity: 'critical',
    run: async () => {
      const response = await api(`/api/v1/security/applications/${application.id}/scope`, {
        method: 'PUT', body: scopeBody()
      });
      const scope = response.json;
      return {
        pass: response.ok && scope?.enabled === true
          && scope.authorizationNote === AUTHORIZATION
          && scope.authorizedByUserId === tenant.userId
          && typeof scope.authorizedAt === 'string',
        detail: response.ok
          ? `enabled, authorized by ${scope?.authorizedByUserId} at ${scope?.authorizedAt}`
          : `${response.status}: ${response.text?.slice(0, 200)}`,
        evidence: { 'scope.json': scope }
      };
    }
  }, context);

  // -----------------------------------------------------------------------
  // SECPL — recording a scan
  // -----------------------------------------------------------------------
  await golden({
    id: 'SECPL-006',
    objective: 'A finding with no evidence is refused rather than stored',
    preconditions: ['an authorized scope'],
    input: 'A scan whose finding declares zero exchanges',
    expected: '400, naming the finding. Filtering evidence-free findings out later means every '
      + 'list, count and report has to remember to — and one of them will not',
    evidence: ['response.json'],
    severity: 'critical',
    run: async () => {
      const response = await api('/api/v1/security/scans', {
        method: 'POST',
        body: scanBody(application.id, project.id, { findings: [finding({ exchangeCount: 0 })] })
      });
      return {
        pass: response.status === 400 && JSON.stringify(response.json ?? {}).includes('evidence'),
        detail: `${response.status}: ${response.json?.detail ?? ''}`,
        evidence: { 'response.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  let firstScan = null;
  await golden({
    id: 'SECPL-007',
    objective: 'A scan is recorded with its findings, and the first sighting is Potential, not Confirmed',
    preconditions: ['an authorized scope'],
    input: 'One scan carrying one BOLA finding with two exchanges',
    expected: 'Stored, the finding status Potential. One scan is a detection; Confirmed is reserved '
      + 'for something reproduced',
    evidence: ['scan.json'],
    severity: 'critical',
    run: async () => {
      const response = await api('/api/v1/security/scans', {
        method: 'POST', body: scanBody(application.id, project.id)
      });
      firstScan = response.json;
      const found = firstScan?.findings?.[0];
      return {
        // The API serialises enums in camelCase. Asserting the wire form rather than the
        // C# name is deliberate: this suite is testing the contract a client sees.
        pass: response.ok && firstScan?.findings?.length === 1
          && found?.status === 'potential' && found?.isNew === true
          && found?.severity === 'high' && found?.cwe === 'CWE-639',
        detail: response.ok
          ? `${firstScan.reference}: ${found?.category} ${found?.severity} ${found?.status}`
          : `${response.status}: ${response.text?.slice(0, 200)}`,
        evidence: { 'scan.json': firstScan }
      };
    }
  }, context);

  await golden({
    id: 'SECPL-008',
    objective: 'The same flaw found again updates its row rather than arriving as a new finding',
    preconditions: ['one scan already recorded'],
    input: 'A second scan reporting the same flaw, reworded and re-scored',
    expected: 'One finding, not two, now Confirmed and no longer new — the fingerprint survives '
      + 'rewording and a severity revision, or every run would report a wall of new findings',
    evidence: ['scan.json', 'findings.json'],
    severity: 'critical',
    run: async () => {
      const response = await api('/api/v1/security/scans', {
        method: 'POST',
        body: scanBody(application.id, project.id, {
          findings: [finding({ title: 'Completely different wording', severity: 4 })]
        })
      });
      const list = await api(`/api/v1/security/findings?applicationId=${application.id}`);
      const found = response.json?.findings?.[0];
      return {
        pass: response.ok && list.json?.length === 1
          && found?.status === 'confirmed' && found?.isNew === false
          && found?.severity === 'critical'
          && found?.fingerprint === firstScan?.findings?.[0]?.fingerprint,
        detail: `${list.json?.length} finding(s) total; status ${found?.status}, `
          + `severity ${found?.severity} (was high), same fingerprint: `
          + `${found?.fingerprint === firstScan?.findings?.[0]?.fingerprint}`,
        metrics: { findings: list.json?.length ?? -1 },
        evidence: { 'scan.json': response.json, 'findings.json': list.json }
      };
    }
  }, context);

  // -----------------------------------------------------------------------
  // SECPL — triage
  // -----------------------------------------------------------------------
  await golden({
    id: 'SECPL-009',
    objective: 'A false positive with no justification is refused',
    preconditions: ['a stored finding'],
    input: 'Triage to FalsePositive with an empty justification',
    expected: '400. A suppression with no stated reason is indistinguishable from turning the check off',
    evidence: ['response.json'],
    severity: 'critical',
    run: async () => {
      const list = await api(`/api/v1/security/findings?applicationId=${application.id}`);
      const response = await api(`/api/v1/security/findings/${list.json[0].id}/triage`, {
        method: 'POST', body: { status: 'FalsePositive', justification: '' }
      });
      return {
        pass: response.status === 400,
        detail: `${response.status}: ${response.json?.detail ?? ''}`,
        evidence: { 'response.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  await golden({
    id: 'SECPL-010',
    objective: 'A justification too short to be one is refused',
    preconditions: ['a stored finding'],
    input: 'Triage to Accepted with the justification "not real"',
    expected: '400. "not real" is not a reason, and a workflow that accepts it quietly is how a '
      + 'security gate becomes decoration',
    evidence: ['response.json'],
    severity: 'critical',
    run: async () => {
      const list = await api(`/api/v1/security/findings?applicationId=${application.id}`);
      const response = await api(`/api/v1/security/findings/${list.json[0].id}/triage`, {
        method: 'POST', body: { status: 'Accepted', justification: 'not real' }
      });
      return {
        pass: response.status === 400,
        detail: `${response.status}: ${response.json?.detail ?? ''}`,
        evidence: { 'response.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  await golden({
    id: 'SECPL-011',
    objective: 'A properly justified decision is accepted and recorded against the person who made it',
    preconditions: ['a stored finding'],
    input: 'Triage to Resolved with a justification of substance',
    expected: 'Stored, carrying dispositionNote and dispositionByUserId, and written to the audit log',
    evidence: ['finding.json', 'audit.json'],
    severity: 'critical',
    run: async () => {
      const list = await api(`/api/v1/security/findings?applicationId=${application.id}`);
      const response = await api(`/api/v1/security/findings/${list.json[0].id}/triage`, {
        method: 'POST',
        body: {
          status: 'Resolved',
          justification: 'The handler now filters by the caller\'s own id; verified against the source '
            + 'and re-tested manually against both accounts.'
        }
      });
      const audit = await api('/api/v1/audit?take=10');
      const entries = audit.json?.entries ?? [];
      const triaged = entries.find(e => e.action === 'securityFindingTriaged');
      return {
        pass: response.ok && response.json?.status === 'resolved'
          && response.json?.dispositionByUserId === tenant.userId
          && triaged !== undefined
          // The audit record has to carry the transition, not merely that something happened.
          && String(triaged?.changesJson ?? '').includes('confirmed'),
        detail: response.ok
          ? `${response.json.status}, decided by ${response.json.dispositionByUserId}; `
            + `audit entry ${triaged ? 'written' : 'MISSING'}`
          : `${response.status}: ${response.text?.slice(0, 200)}`,
        evidence: { 'finding.json': response.json, 'audit.json': triaged ?? entries }
      };
    }
  }, context);

  // -----------------------------------------------------------------------
  // SECPL — regression
  // -----------------------------------------------------------------------
  await golden({
    id: 'SECPL-012',
    objective: 'A resolved finding detected again becomes a regression, and its disposition does not survive',
    preconditions: ['a finding marked Resolved with a justification'],
    input: 'A third scan reporting the same flaw',
    expected: 'Status Regressed, regressedAt set, resolvedAt cleared and the disposition removed. An '
      + 'acceptance of a flaw that was then repaired says nothing about the flaw reappearing',
    evidence: ['scan.json'],
    severity: 'critical',
    run: async () => {
      const response = await api('/api/v1/security/scans', {
        method: 'POST', body: scanBody(application.id, project.id)
      });
      const found = response.json?.findings?.[0];
      return {
        // Null fields are omitted from the response, so these compare against undefined-or-null
        // rather than against null alone. Asserting `=== null` on a key the serialiser drops
        // fails a behaviour that is entirely correct.
        pass: response.ok && found?.status === 'regressed' && found?.isRegression === true
          && (found?.regressedAt ?? null) !== null
          && (found?.resolvedAt ?? null) === null
          && (found?.dispositionNote ?? null) === null,
        detail: `${found?.status}; regressedAt ${found?.regressedAt}; `
          + `resolvedAt ${found?.resolvedAt ?? 'cleared'}; `
          + `disposition ${(found?.dispositionNote ?? null) === null ? 'cleared' : 'STILL SET'}`,
        evidence: { 'scan.json': response.json }
      };
    }
  }, context);

  await golden({
    id: 'SECPL-013',
    objective: 'A regression makes the stored scan\'s gate decision FAIL',
    preconditions: ['the scan that produced the regression'],
    input: 'GET that scan',
    expected: 'The gate embedded in the scan reads FAIL, naming the regression. The gate is computed '
      + 'from what the scan recorded, not from what the scope says today',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const scans = await api(`/api/v1/security/scans?applicationId=${application.id}&take=1`);
      const scan = await api(`/api/v1/security/scans/${scans.json[0].id}`);
      const gate = scan.json?.gate;
      return {
        pass: gate?.outcome === 'fail' && gate?.blocked === true
          && gate.reasons?.some(r => r.includes('have come back')),
        detail: `${gate?.outcome}: ${(gate?.reasons ?? []).join(' ')}`,
        evidence: { 'gate.json': gate }
      };
    }
  }, context);

  await golden({
    id: 'SECPL-016',
    objective: 'The platform\'s gate and the JavaScript mirror produce the same decision and the same words',
    preconditions: ['a stored scan whose gate the API computed'],
    input: 'The same coverage and findings, evaluated by the JavaScript mirror',
    expected: 'Identical outcome, identical rule verdicts and an identical summary. Two implementations '
      + 'of one control that drift are worse than one control, because everybody believes the wrong half',
    evidence: ['parity.json'],
    severity: 'critical',
    run: async () => {
      const scans = await api(`/api/v1/security/scans?applicationId=${application.id}&take=1`);
      const stored = (await api(`/api/v1/security/scans/${scans.json[0].id}`)).json;
      const body = scanBody(application.id, project.id);

      const mirrored = evaluateSecurityGate({
        scanRan: true,
        profile: 'Standard',
        requestsIssued: stored.requestsIssued,
        requestsBlocked: stored.requestsBlocked,
        checksConfigured: body.checksConfigured,
        checksExecuted: body.checksExecuted,
        untestedAreas: body.untestedAreas
      }, stored.findings.map(f => ({
        id: f.id,
        category: f.category,
        // The API serialises enums in camelCase; the mirror's tables are keyed on the
        // capitalised names. Normalising here rather than loosening either side, because the
        // point of the comparison is that the two agree on the decision, not on the casing.
        severity: f.severity.charAt(0).toUpperCase() + f.severity.slice(1),
        confidence: f.confidence.charAt(0).toUpperCase() + f.confidence.slice(1),
        status: f.status.charAt(0).toUpperCase() + f.status.slice(1),
        isNew: f.isNew, isRegression: f.isRegression, hasEvidence: true,
        justification: f.dispositionNote ?? null,
        decidedBy: f.dispositionByUserId ?? null
      })));

      const sameOutcome = stored.gate.outcome === mirrored.outcomeName.toLowerCase();
      const sameSummary = stored.gate.summary === mirrored.summary;
      const storedRules = stored.gate.rules.map(r => `${r.name}=${r.passed}`).join('|');
      const mirrorRules = mirrored.rules.map(r => `${r.name}=${r.passed}`).join('|');

      return {
        pass: sameOutcome && sameSummary && storedRules === mirrorRules,
        detail: [
          sameOutcome ? null : `outcome ${stored.gate.outcome} vs ${mirrored.outcomeName.toLowerCase()}`,
          sameSummary ? null : 'summary differs',
          storedRules === mirrorRules ? null : 'rule verdicts differ'
        ].filter(Boolean).join('; ')
          || `both ${stored.gate.outcome}, ${stored.gate.rules.length} rule(s) agreeing, identical summary`,
        evidence: {
          'parity.json': {
            platform: { outcome: stored.gate.outcome, summary: stored.gate.summary, rules: stored.gate.rules },
            mirror: { outcome: mirrored.outcomeName.toLowerCase(), summary: mirrored.summary, rules: mirrored.rules }
          }
        }
      };
    }
  }, context);

  await golden({
    id: 'SECPL-014',
    objective: 'A scan cannot be recorded against an application nobody has authorized',
    preconditions: ['a second application with no security scope'],
    input: 'A scan recorded against it',
    expected: 'Refused as a security policy violation. If a scan somehow ran, that is a defect worth '
      + 'surfacing rather than a record worth keeping',
    evidence: ['response.json'],
    severity: 'critical',
    run: async () => {
      const unauthorized = await registerApplication(tenant, project.id, {
        name: 'Unauthorized application', baseUrl: 'http://127.0.0.1:4402',
        loginUrl: null, username: null, password: null
      });
      const response = await api('/api/v1/security/scans', {
        method: 'POST', body: scanBody(unauthorized.id, project.id)
      });
      return {
        pass: response.status === 403 || response.status === 422,
        detail: `${response.status}: ${response.json?.detail ?? ''}`,
        evidence: { 'response.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  await golden({
    id: 'SECPL-015',
    objective: 'Another tenant cannot read this tenant\'s security findings',
    preconditions: ['a second organization'],
    input: 'The other tenant listing findings for this application',
    expected: 'Nothing. A security finding is a working description of how to break an application, '
      + 'and tenant isolation matters more here than anywhere else in the product',
    evidence: ['response.json'],
    severity: 'critical',
    run: async () => {
      const intruder = await newTenant('SecIntruder');
      const findings = await request(
        `/api/v1/security/findings?applicationId=${application.id}`, { token: intruder.token });
      const scans = await request(
        `/api/v1/security/scans?applicationId=${application.id}`, { token: intruder.token });
      const scope = await request(
        `/api/v1/security/applications/${application.id}/scope`, { token: intruder.token });

      const leaked = (findings.json?.length ?? 0) + (scans.json?.length ?? 0);
      return {
        // 403 is also correct: a fresh organization admin holds security:read, so the
        // interesting answer is that the rows are invisible rather than that the route is.
        pass: (findings.status === 403 || leaked === 0) && scope.status !== 200,
        detail: `findings ${findings.status} (${findings.json?.length ?? 0} row(s)), `
          + `scans ${scans.status} (${scans.json?.length ?? 0} row(s)), scope ${scope.status}`,
        metrics: { leakedRows: leaked },
        evidence: {
          'response.json': {
            findings: { status: findings.status, count: findings.json?.length ?? 0 },
            scans: { status: scans.status, count: scans.json?.length ?? 0 },
            scope: { status: scope.status }
          }
        }
      };
    }
  }, context);
}
