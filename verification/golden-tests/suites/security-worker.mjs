/**
 * A security scan AIRA runs itself.
 *
 * The other security suites drive the engine directly, or record a scan somebody else ran.
 * This one starts at a button and ends at a stored finding: the control plane decides what is
 * permitted, queues a job, a worker picks it up, issues real requests at the lab, reports what
 * it did and did not do, and the gate reads coverage off the record. Every layer between those
 * two ends is one where "the code exists" and "it works" are different claims.
 *
 * The lab here is the headers lab, chosen because its flaws are readable from responses the
 * application already serves. That keeps the round trip about the round trip: no synthetic
 * identity has to sign in for a finding to appear, so a failure here is a failure of the path
 * rather than of a login flow.
 *
 * What this suite deliberately does not do is assert that the scan found everything. Detection
 * rates are measured in the scanning suite against ground truth. Here the question is narrower
 * and different: did what the worker did arrive intact, and does the record say what happened.
 */
import { ROOT, golden, suite, notVerified } from '../harness.mjs';
import {
  createProject, newTenant, registerApplication, request, runDiscovery
} from '../platform.mjs';
import { CONFIDENCE_ORDER, SEVERITY_ORDER } from '../../../packages/security-engine/src/gate.mjs';
import { LABS, isolateFaults, restoreFaults } from '../security/scenarios.mjs';

const HEADERS_LAB = 'http://127.0.0.1:4406';

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
  maxRequestsPerSecond: 20,
  maxConcurrentRequests: 2,
  maxScanDurationMinutes: 10,
  allowActiveTesting: true,
  allowDestructiveTesting: false,
  allowProduction: false,
  ...overrides
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Waits for a worker to report a scan back.
 *
 * Returns whatever the scan looks like when the wait runs out rather than throwing, so a
 * timeout is recorded as a test that failed with the scan's state attached instead of a suite
 * that could not complete.
 */
async function waitForScan(api, scanId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await api(`/api/v1/security/scans/${scanId}`);
    last = response.json;
    if (last?.status === 'completed' || last?.status === 'failed') return last;
    await sleep(2000);
  }
  return { ...(last ?? {}), status: last?.status ?? 'unknown', timedOut: true };
}

export default async function run() {
  suite('Security scans AIRA runs itself');

  const tenant = await newTenant('SecWorker');
  const project = await createProject(tenant, 'Security worker');
  const api = (path, options = {}) => request(path, { token: tenant.token, ...options });

  const application = await registerApplication(tenant, project.id, {
    name: 'Headers lab', baseUrl: HEADERS_LAB,
    loginUrl: null, username: null, password: null, maxPages: 10
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  // -----------------------------------------------------------------------
  // SECW — what is refused before anything is queued
  // -----------------------------------------------------------------------

  await golden({
    id: 'SECW-001',
    objective: 'A scan cannot be started against an application nobody has authorized',
    preconditions: ['an application with no security scope'],
    input: 'POST /api/v1/security/scans/start',
    expected: 'Refused as a security policy violation, naming the written authorization that is '
      + 'missing. The refusal has to happen here rather than in the worker: once a job carrying a '
      + 'target is on a queue, the decision has already been made',
    evidence: ['response.json'],
    severity: 'critical',
    run: async () => {
      const response = await api('/api/v1/security/scans/start', {
        method: 'POST', body: { applicationId: application.id }
      });
      const body = JSON.stringify(response.json ?? {});
      return {
        pass: response.status === 403 && body.includes('written authorization'),
        detail: `${response.status}: ${response.json?.title ?? response.json?.detail ?? ''}`,
        evidence: { 'response.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  // Authorize it, so everything below is about the path rather than about the refusal.
  const authorized = await api(`/api/v1/security/applications/${application.id}/scope`, {
    method: 'PUT', body: scopeBody()
  });

  await golden({
    id: 'SECW-002',
    objective: 'A scan cannot be started against an application discovery has not walked',
    preconditions: ['an authorized application, nothing discovered'],
    input: 'POST /api/v1/security/scans/start',
    expected: '400 naming discovery. A scan with no targets issues no requests and would still be '
      + 'stored as a scan, and a stored scan with no findings is read as a clean result',
    evidence: ['response.json'],
    severity: 'critical',
    run: async () => {
      const response = await api('/api/v1/security/scans/start', {
        method: 'POST', body: { applicationId: application.id }
      });
      const body = JSON.stringify(response.json ?? {});
      return {
        pass: response.status === 400
          && body.includes('Run discovery')
          && body.includes('reads as a clean result'),
        detail: `${response.status}: ${response.json?.title ?? ''}`,
        evidence: {
          'response.json': { status: response.status, body: response.json, scope: authorized.status }
        }
      };
    }
  }, context);

  // -----------------------------------------------------------------------
  // The round trip
  // -----------------------------------------------------------------------

  const discovery = await runDiscovery(tenant, application.id, { maxPages: 10, maxDepth: 2 });
  const surface = (await api(`/api/v1/security/applications/${application.id}/surface`)).json;

  await golden({
    id: 'SECW-003',
    objective: 'Starting a scan queues a job and records a scan that has not run yet',
    preconditions: ['an authorized, discovered application'],
    input: 'POST /api/v1/security/scans/start with no narrowing',
    expected: '202 with the queue and job it was placed on, and a stored scan whose gate says NOT '
      + 'SCANNED rather than reporting a clean result it has no basis for',
    evidence: ['started.json', 'queued.json'],
    severity: 'critical',
    run: async () => {
      const started = await api('/api/v1/security/scans/start', {
        method: 'POST', body: { applicationId: application.id }
      });
      if (!started.ok) {
        return {
          pass: false, detail: `${started.status}: ${started.json?.title ?? started.text?.slice(0, 200)}`,
          evidence: { 'started.json': { status: started.status, body: started.json } }
        };
      }

      const queued = (await api(`/api/v1/security/scans/${started.json.securityScanId}`)).json;

      // Read immediately, so this describes the scan before a worker could have finished it.
      // Where the worker is quick, a completed scan is not a failure of the claim being made
      // here — only a queued one that reads as clean would be.
      const honest = queued?.status !== 'queued'
        || (queued.gate.summary.startsWith('NOT SCANNED') && queued.findings.length === 0);

      return {
        pass: started.status === 202
          && started.json.queue === 'aira:security'
          && typeof started.json.jobId === 'string'
          && started.json.targets > 0
          && honest,
        detail: `${started.status}; ${started.json.targets} target(s), `
          + `${started.json.checksToRun} of ${started.json.checksConfigured} check(s); `
          + `stored status ${queued?.status}`,
        metrics: { targets: started.json.targets, checks: started.json.checksToRun },
        evidence: {
          'started.json': started.json,
          'queued.json': {
            status: queued?.status, findings: queued?.findings?.length,
            gate: queued?.gate?.outcome, summary: queued?.gate?.summary
          }
        }
      };
    }
  }, context);

  // The scan the rest of the suite reads. Started once and waited for once: every test below
  // asks a different question about the same run, which is also how a person would read it.
  const started = await api('/api/v1/security/scans/start', {
    method: 'POST', body: { applicationId: application.id }
  });
  const scan = started.ok ? await waitForScan(api, started.json.securityScanId) : null;

  await golden({
    id: 'SECW-004',
    objective: 'A worker runs the scan against the application and reports back',
    preconditions: ['a queued scan and a running worker'],
    input: 'The queued job, consumed from aira:security',
    expected: 'The scan completes, having issued real requests, and its findings are stored against '
      + 'the application. This is the claim the whole capability rests on and nothing else in the '
      + 'suite establishes it',
    evidence: ['scan.json'],
    severity: 'critical',
    run: async () => ({
      pass: scan?.status === 'completed'
        && scan.requestsIssued > 0
        && scan.findings.length > 0,
      detail: scan?.timedOut
        ? `the scan was still ${scan.status} after the wait ran out`
        : `${scan?.status}: ${scan?.requestsIssued} request(s), ${scan?.findings?.length} finding(s), `
          + `${scan?.testsExecuted} check(s) executed`,
      metrics: {
        requestsIssued: scan?.requestsIssued ?? 0,
        findings: scan?.findings?.length ?? 0,
        executed: scan?.testsExecuted ?? 0
      },
      evidence: {
        'scan.json': {
          status: scan?.status, requestsIssued: scan?.requestsIssued,
          requestsBlocked: scan?.requestsBlocked, testsExecuted: scan?.testsExecuted,
          testsSkipped: scan?.testsSkipped, durationMs: scan?.durationMs,
          findings: (scan?.findings ?? []).map(f => ({
            category: f.category, severity: f.severity, confidence: f.confidence,
            endpoint: f.endpoint, cwe: f.cwe, owasp: f.owaspWebCategory
          })),
          gate: scan?.gate
        }
      }
    })
  }, context);

  await golden({
    id: 'SECW-005',
    objective: 'Every finding the worker reported arrived with a severity and confidence the '
      + 'platform recognises',
    preconditions: ['the completed scan'],
    input: 'The stored findings',
    expected: 'Each carries a severity band and a confidence level, both from the shared vocabulary. '
      + 'A finding whose confidence did not survive the trip reads as whatever the receiving side '
      + 'defaults to, and every default is a judgement nobody made',
    evidence: ['findings.json'],
    severity: 'critical',
    run: async () => {
      const severities = Object.keys(SEVERITY_ORDER).map(s => s.toLowerCase());
      const confidences = Object.keys(CONFIDENCE_ORDER).map(c => c.toLowerCase());
      const findings = scan?.findings ?? [];
      const malformed = findings.filter(f =>
        !severities.includes(String(f.severity).toLowerCase())
        || !confidences.includes(String(f.confidence).toLowerCase()));

      return {
        pass: findings.length > 0 && malformed.length === 0,
        detail: `${findings.length} finding(s); ${malformed.length} carry a severity or confidence `
          + 'outside the shared vocabulary',
        evidence: {
          'findings.json': {
            vocabulary: { severities, confidences },
            findings: findings.map(f => ({
              category: f.category, severity: f.severity, confidence: f.confidence
            })),
            malformed
          }
        }
      };
    }
  }, context);

  await golden({
    id: 'SECW-006',
    objective: 'The gate reads coverage from what the worker executed, not from what was asked for',
    preconditions: ['the completed scan'],
    input: 'The scan\'s gate result',
    expected: 'The coverage rule states executed over configured using the numbers the worker '
      + 'reported, and the summary carries the sentence distinguishing what was reached from what '
      + 'was not',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      const gate = scan?.gate;
      const coverage = (gate?.rules ?? []).find(r => r.name.includes('configured checks'));
      const executedInRule = Number(/(\d+) of (\d+) configured/.exec(coverage?.explanation ?? '')?.[1]);

      return {
        pass: Boolean(coverage)
          && executedInRule === scan.testsExecuted
          && /untested, not clean|not a statement that the application is secure/.test(gate.summary),
        detail: coverage?.explanation ?? 'no coverage rule',
        metrics: { executedInRule, executedOnScan: scan?.testsExecuted ?? -1 },
        evidence: { 'gate.json': { outcome: gate?.outcome, summary: gate?.summary, rules: gate?.rules } }
      };
    }
  }, context);

  await golden({
    id: 'SECW-007',
    objective: 'A narrowed run reports partial coverage and does not pass the gate on that basis',
    preconditions: ['an authorized, discovered application'],
    input: 'A scan narrowed to one of the implied checks',
    expected: 'The full implied set still travels as the configured set, so the coverage rule fails '
      + 'and the gate asks for review. Narrowing a run must cost coverage; if it narrowed the '
      + 'denominator too, running one check would report as complete',
    evidence: ['narrowed.json'],
    severity: 'critical',
    run: async () => {
      const implied = surface?.checksImplied ?? [];
      if (implied.length < 2) {
        return {
          pass: false, detail: `the surface implies ${implied.length} check(s); at least two are needed`,
          evidence: { 'narrowed.json': { implied } }
        };
      }

      const response = await api('/api/v1/security/scans/start', {
        method: 'POST', body: { applicationId: application.id, checksToRun: [implied[0]] }
      });
      if (!response.ok) {
        return {
          pass: false, detail: `${response.status}: ${response.json?.title ?? ''}`,
          evidence: { 'narrowed.json': { status: response.status, body: response.json } }
        };
      }

      const narrowed = await waitForScan(api, response.json.securityScanId);
      const coverageRule = (narrowed?.gate?.rules ?? []).find(r => r.name.includes('configured checks'));

      return {
        pass: response.json.checksConfigured === implied.length
          && response.json.checksToRun === 1
          && narrowed?.status === 'completed'
          && coverageRule?.passed === false
          && narrowed.gate.outcome !== 'pass',
        detail: `configured ${response.json.checksConfigured}, asked for ${response.json.checksToRun}; `
          + `gate ${narrowed?.gate?.outcome}: ${coverageRule?.explanation ?? 'no coverage rule'}`,
        evidence: {
          'narrowed.json': {
            started: response.json,
            outcome: narrowed?.gate?.outcome,
            coverage: coverageRule,
            summary: narrowed?.gate?.summary
          }
        }
      };
    }
  }, context);

  await golden({
    id: 'SECW-008',
    objective: 'Every implied check that did not execute is named as untested',
    preconditions: ['the completed scan'],
    input: 'The implied checks, the count that executed, and the gate summary\'s untested areas',
    expected: 'At least as many implied checks are named untested as failed to produce a verdict. '
      + 'A check that quietly does not run is indistinguishable in a report from one that ran and '
      + 'found nothing, and the distance between those two is the whole reason coverage is reported',
    evidence: ['untested.json'],
    severity: 'critical',
    run: async () => {
      const implied = surface?.checksImplied ?? [];
      const summary = scan?.gate?.summary ?? '';
      const executed = scan?.testsExecuted ?? 0;

      // "Untested: …" is the tail of the summary; every check named there produced no verdict.
      const marker = summary.indexOf('Untested:');
      const untestedText = marker >= 0 ? summary.slice(marker) : '';
      const named = implied.filter(check => untestedText.includes(check));

      // Which checks fall short changes as runners are written — xss.dom moved out of this set
      // the moment it got a browser — so the rule is asserted rather than the roster.
      const missing = Math.max(0, implied.length - executed);

      return {
        pass: named.length >= missing,
        detail: `${implied.length} implied, ${executed} executed, ${missing} without a verdict; `
          + `${named.length} named untested${named.length ? `: ${named.join(', ')}` : ''}`,
        metrics: { implied: implied.length, executed, missing, named: named.length },
        evidence: { 'untested.json': { implied, executed, missing, named, summary } }
      };
    }
  }, context);

  await golden({
    id: 'SECW-009',
    objective: 'Starting a scan is recorded in the audit trail as its own act',
    preconditions: ['the scans started above'],
    input: 'The audit log',
    expected: 'A securityScanStarted entry naming the person, the scan and what it was configured to '
      + 'run — distinct from securityScanRecorded. Starting a scan is the moment authorization is '
      + 'spent, and a scan that starts and never reports leaves only this line behind',
    evidence: ['audit.json'],
    severity: 'critical',
    run: async () => {
      const audit = await api('/api/v1/audit?take=100');
      const entries = (audit.json?.entries ?? []).filter(e => e.action === 'securityScanStarted');
      const first = entries[0];
      const changes = first ? JSON.parse(first.changesJson ?? '{}') : {};

      return {
        pass: entries.length > 0
          && Boolean(first.userId)
          && first.entityType === 'SecurityScan'
          && typeof changes.checksConfigured === 'number',
        detail: `${entries.length} start entr(ies); first names ${changes.checksConfigured} configured `
          + `check(s) and ${changes.targets} target(s)`,
        evidence: {
          'audit.json': {
            entries: entries.map(e => ({
              action: e.action, entityId: e.entityId, summary: e.summary,
              changes: JSON.parse(e.changesJson ?? '{}'), userEmail: e.userEmail
            }))
          }
        }
      };
    }
  }, context);

  await golden({
    id: 'SECW-010',
    objective: 'The engine and the platform agree on what the severity and confidence words mean',
    preconditions: ['the engine source and the platform\'s enums'],
    input: 'SEVERITY_ORDER and CONFIDENCE_ORDER against SecuritySeverity and SecurityConfidence',
    expected: 'Identical names in identical order. The worker sends a number and the platform reads '
      + 'an enum; if the two orderings ever diverge, every finding in transit is silently '
      + 'reclassified and nothing fails',
    evidence: ['parity.json'],
    severity: 'critical',
    run: async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const source = readFileSync(resolve(ROOT, 'apps/api/src/Aira.Domain/Security/SecurityEnums.cs'), 'utf8');

      const ordinalsOf = (enumName) => {
        const body = new RegExp(`enum ${enumName}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? '';
        const found = {};
        for (const [, name, value] of body.matchAll(/^\s*([A-Z][A-Za-z]*)\s*=\s*(\d+)\s*,?\s*$/gm)) {
          found[name] = Number(value);
        }
        return found;
      };

      const severity = ordinalsOf('SecuritySeverity');
      const confidence = ordinalsOf('SecurityConfidence');

      const compare = (engine, platform) => Object.entries(engine)
        .filter(([name, value]) => platform[name] !== value)
        .map(([name, value]) => `${name}: engine ${value}, platform ${platform[name] ?? 'absent'}`);

      const mismatches = [
        ...compare(SEVERITY_ORDER, severity),
        ...compare(CONFIDENCE_ORDER, confidence)
      ];

      return {
        pass: Object.keys(severity).length > 0
          && Object.keys(confidence).length > 0
          && mismatches.length === 0,
        detail: mismatches.length === 0
          ? `${Object.keys(severity).length} severity band(s) and ${Object.keys(confidence).length} `
            + 'confidence level(s) agree'
          : mismatches.join('; '),
        evidence: {
          'parity.json': {
            engine: { severity: SEVERITY_ORDER, confidence: CONFIDENCE_ORDER },
            platform: { severity, confidence },
            mismatches
          }
        }
      };
    }
  }, context);

  await golden({
    id: 'SECW-011',
    objective: 'Discovery is what decides where a scan points',
    preconditions: ['the discovery run above'],
    input: 'The discovered surface and the scan that was started from it',
    expected: 'The surface names its own caveats, starting with the one saying it describes what '
      + 'discovery walked. A scan inherits that limit, and a reader who is told the coverage '
      + 'fraction without it will read it as a fraction of the application',
    evidence: ['surface.json'],
    severity: 'high',
    run: async () => ({
      pass: discovery.status === 'completed'
        && (surface?.items?.length ?? 0) > 0
        && (surface?.caveats ?? []).length > 0,
      detail: `discovery ${discovery.status}, ${surface?.items?.length} surface item(s), `
        + `${surface?.caveats?.length} caveat(s)`,
      metrics: { items: surface?.items?.length ?? 0, caveats: surface?.caveats?.length ?? 0 },
      evidence: {
        'surface.json': {
          discovery: { status: discovery.status, pages: discovery.pagesDiscovered },
          items: surface?.items, caveats: surface?.caveats, implied: surface?.checksImplied
        }
      }
    })
  }, context);

  // -----------------------------------------------------------------------
  // SECW — the one check that needs a browser
  // -----------------------------------------------------------------------

  /**
   * Detection and precision for DOM XSS, through the whole path.
   *
   * The xss lab gets its own application, because this is the only check whose verdict comes
   * from what a page did rather than from what it answered — and the only way to be sure the
   * worker really opened a browser is to make it produce a finding that could not exist
   * otherwise.
   */
  const domApp = await registerApplication(tenant, project.id, {
    name: 'XSS lab', baseUrl: LABS.xss,
    loginUrl: null, username: null, password: null, maxPages: 10
  });
  await api(`/api/v1/security/applications/${domApp.id}/scope`, { method: 'PUT', body: scopeBody() });
  const domDiscovery = await runDiscovery(tenant, domApp.id, { maxPages: 10, maxDepth: 2 });

  /** Runs a scan of the xss lab narrowed to xss.dom, with the given faults isolated. */
  const scanDom = async (faults) => {
    await isolateFaults(LABS.xss, faults);
    const started = await api('/api/v1/security/scans/start', {
      method: 'POST', body: { applicationId: domApp.id, checksToRun: ['xss.dom'] }
    });
    if (!started.ok) return { started, scan: null };
    return { started, scan: await waitForScan(api, started.json.securityScanId) };
  };

  const domVulnerable = await scanDom(['VULN_DOM_XSS']);
  const domCorrected = await scanDom([]);
  await restoreFaults(LABS.xss);

  await golden({
    id: 'SECW-013',
    objective: 'A DOM sink no response can reveal is found by driving a real browser',
    preconditions: ['the xss lab with VULN_DOM_XSS on, discovered and authorized'],
    input: 'A scan narrowed to xss.dom',
    expected: 'A DomXSS finding at /dom, carrying evidence. The fragment never reaches the '
      + 'server, so nothing in any response distinguishes the vulnerable page from the corrected '
      + 'one — a finding here can only come from having watched the page execute it',
    evidence: ['scan.json'],
    severity: 'critical',
    run: async () => {
      const findings = domVulnerable.scan?.findings ?? [];
      const dom = findings.find(f => f.category === 'DomXSS');
      return {
        pass: domVulnerable.scan?.status === 'completed'
          && Boolean(dom)
          && dom.endpoint === '/dom',
        detail: dom
          ? `${dom.category} at ${dom.endpoint} (${dom.severity}, ${dom.confidence}, ${dom.cwe})`
          : `no DomXSS finding; scan ${domVulnerable.scan?.status}, `
            + `${findings.length} finding(s), ${domVulnerable.scan?.testsExecuted} check(s) executed`,
        metrics: { findings: findings.length },
        evidence: {
          'scan.json': {
            started: domVulnerable.started.json,
            status: domVulnerable.scan?.status,
            requestsIssued: domVulnerable.scan?.requestsIssued,
            testsExecuted: domVulnerable.scan?.testsExecuted,
            findings: findings.map(f => ({
              category: f.category, severity: f.severity, confidence: f.confidence,
              endpoint: f.endpoint, parameter: f.parameter, cwe: f.cwe
            })),
            gate: domVulnerable.scan?.gate?.summary
          }
        }
      };
    }
  }, context);

  await golden({
    id: 'SECW-014',
    objective: 'The same page with the sink corrected produces no finding',
    preconditions: ['the xss lab with every fault off'],
    input: 'The same scan, narrowed to xss.dom',
    expected: 'No DomXSS finding. The corrected page writes the same value to textContent '
      + 'instead of innerHTML, and a check that reported one here would be keying on the sink '
      + 'being present rather than on it being reachable',
    evidence: ['scan.json'],
    severity: 'critical',
    run: async () => {
      const findings = domCorrected.scan?.findings ?? [];
      const dom = findings.filter(f => f.category === 'DomXSS');
      return {
        pass: domCorrected.scan?.status === 'completed' && dom.length === 0,
        detail: dom.length === 0
          ? `no DomXSS finding from ${domCorrected.scan?.requestsIssued} request(s)`
          : `${dom.length} false positive(s): ${dom.map(f => f.endpoint).join(', ')}`,
        evidence: {
          'scan.json': {
            status: domCorrected.scan?.status,
            requestsIssued: domCorrected.scan?.requestsIssued,
            testsExecuted: domCorrected.scan?.testsExecuted,
            findings: findings.map(f => ({ category: f.category, endpoint: f.endpoint }))
          }
        }
      };
    }
  }, context);

  await golden({
    id: 'SECW-015',
    objective: 'The browser-driven check counts as executed coverage, not as an untested area',
    preconditions: ['the completed DOM scans'],
    input: 'The scan record for the corrected run',
    expected: 'xss.dom appears as executed and is absent from the untested areas. Before a '
      + 'browser existed it could only ever be reported untested, and the gap between those two '
      + 'is the whole of what this check adds',
    evidence: ['coverage.json'],
    severity: 'critical',
    run: async () => {
      const scan = domCorrected.scan;
      const summary = scan?.gate?.summary ?? '';
      const executed = (scan?.testsExecuted ?? 0) > 0;
      const claimedUntested = /xss\.dom[^.]*(not attempted|no runner|cannot decide)/.test(summary);

      return {
        pass: executed && !claimedUntested,
        detail: `${scan?.testsExecuted} check(s) executed; ${claimedUntested ? 'still' : 'not'} `
          + 'reported as untested',
        evidence: { 'coverage.json': { testsExecuted: scan?.testsExecuted, summary } }
      };
    }
  }, context);

  await golden({
    id: 'SECW-012',
    objective: 'Scanning an application twice does not empty the first scan\'s record',
    preconditions: ['two completed scans of the same application, reporting the same findings'],
    input: 'The earlier scan, read back after the later one recorded the same flaws',
    expected: 'It still reports what it found, at the severity it found it. A finding is a flaw and '
      + 'outlives the scans that see it, so a scan read as "findings whose last sighting was this '
      + 'one" empties out the moment anything scans again — and an emptied scan does not read as '
      + '"look elsewhere", it reads as a run that found nothing',
    evidence: ['both.json'],
    severity: 'critical',
    run: async () => {
      // Every completed scan of this application, oldest first. By this point the suite has
      // run several, all reporting the same flaws in the same lab.
      const listed = (await api(`/api/v1/security/scans?applicationId=${application.id}&take=20`)).json ?? [];
      const completed = listed.filter(s => s.status === 'completed');
      if (completed.length < 2) {
        return {
          pass: false, detail: `${completed.length} completed scan(s); two are needed`,
          evidence: { 'both.json': { listed } }
        };
      }

      const full = [];
      for (const summary of completed) {
        const detail = (await api(`/api/v1/security/scans/${summary.id}`)).json;
        full.push({
          reference: detail.reference,
          startedAt: detail.startedAt,
          testsExecuted: detail.testsExecuted,
          findings: detail.findings.length,
          gate: detail.gate.outcome
        });
      }

      // A scan that executed checks and reported nothing is the shape this bug takes, so that
      // is what is looked for rather than a count on one particular scan.
      const emptied = full.filter(scan => scan.testsExecuted > 0 && scan.findings === 0);

      return {
        pass: emptied.length === 0,
        detail: `${full.length} completed scan(s); ${emptied.length} executed checks and hold no `
          + 'findings',
        metrics: { scans: full.length, emptied: emptied.length },
        evidence: { 'both.json': { scans: full, emptied } }
      };
    }
  }, context);

  // -----------------------------------------------------------------------
  // SECW — scheduling one
  // -----------------------------------------------------------------------

  await golden({
    id: 'SECW-016',
    objective: 'A security schedule names the application it scans, and refuses without one',
    preconditions: ['the authorized application'],
    input: 'A security schedule with no application, then one with it',
    expected: 'The first is refused; the second is stored as a security schedule against that '
      + 'application. A schedule that fires for ever and starts nothing reads in a list exactly '
      + 'like one that is working',
    evidence: ['schedules.json'],
    severity: 'critical',
    run: async () => {
      const without = await api('/api/v1/schedules', {
        method: 'POST',
        body: {
          projectId: project.id, name: 'Security schedule with no application',
          cronExpression: '0 2 * * *', timeZone: 'UTC', kind: 'securityScan'
        }
      });

      const withOne = await api('/api/v1/schedules', {
        method: 'POST',
        body: {
          projectId: project.id, name: 'Nightly security scan',
          cronExpression: '0 2 * * *', timeZone: 'UTC',
          kind: 'securityScan', applicationId: application.id
        }
      });

      // Left disabled: this suite proves it is stored and refused correctly, and a schedule
      // left armed in a verification run would fire against the lab at two in the morning.
      if (withOne.ok) {
        await api(`/api/v1/schedules/${withOne.json.id}`, {
          method: 'PATCH', body: { isEnabled: false }
        });
      }

      return {
        pass: without.status === 400
          && withOne.ok
          && withOne.json.kind === 'securityScan'
          && withOne.json.applicationId === application.id
          && Boolean(withOne.json.nextRunAt),
        detail: `without an application ${without.status}; with one ${withOne.status} `
          + `(${withOne.json?.kind}, next run ${withOne.json?.nextRunAt})`,
        evidence: {
          'schedules.json': {
            without: { status: without.status, body: without.json },
            withOne: withOne.json
          }
        }
      };
    }
  }, context);

  // What this path does not cover, stated rather than left to be inferred.
  notVerified({
    id: 'SECW-N003',
    objective: 'A schedule firing a security scan on its cron, end to end',
    expected: 'The scan is queued with the schedule named, the worker runs it, and the scope in '
      + 'force at that moment decides — not the one in force when the schedule was written',
    severity: 'high'
  }, 'Not executed here. SECW-016 covers what a security schedule stores and refuses, and the '
   + 'firing itself was driven against a running stack with a one-minute cron: the scan was '
   + 'queued, ran, completed with findings, and both scheduleFired and securityScanStarted were '
   + 'written to the trail naming the schedule. What no automated test covers is the wait, which '
   + 'is at least a minute of real time and would make this suite one nobody runs.\n\n'
   + 'Also NOT VERIFIED: that scheduling cannot be used to reach destructive or production '
   + 'scanning. Those are refused by the launcher reading permissions a background sweep does '
   + 'not hold, and no stock role holds project:write without security:scan, so the escalation '
   + 'has no path through the default role matrix to exercise. The refusals are unit tested '
   + '(SecurityScheduleTests).');

  notVerified({
    id: 'SECW-N001',
    objective: 'A worker-run scan against an authorized production environment',
    expected: 'Only passive checks run, and only where somebody holds security:production',
    severity: 'critical'
  }, 'Not executed. Production security testing is off by default and no production environment '
   + 'exists here. The launcher refuses production without the permission and the guard refuses '
   + 'each request as well, but the permitted path is not exercised anywhere and is NOT VERIFIED.');

  notVerified({
    id: 'SECW-N002',
    objective: 'The sweep that abandons a scan no worker reported, end to end',
    expected: 'A scan nobody reports is ended with its reason stated, its gate still reads NOT '
      + 'SCANNED, and a late report supersedes it',
    severity: 'high'
  }, 'Not executed here. The sweep and both of its consequences are covered by nine unit tests '
   + '(SecurityScanReaperTests, AbandonedSecurityScanTests) and were driven end to end against a '
   + 'running stack by stopping the worker and restarting it. What no automated test covers is '
   + 'that round trip itself: it needs a grace period to elapse, and a golden suite that waited '
   + 'out a timer would be one nobody runs. The wait, not the behaviour, is what is NOT VERIFIED '
   + 'here.');
}
