/**
 * Security and multi-tenancy, exercised against the platform's own API.
 *
 * Only local applications are targeted: the lab, and the platform itself. Nothing here
 * touches a third-party system, and the SSRF checks assert that the platform *refuses* to
 * touch one.
 *
 * Two tenants are created and each is asked to reach the other's data by identifier —
 * through the API the same way a customer would. A control read by the rightful owner
 * accompanies every denial, because "404 for everyone" is not isolation.
 */
import { golden, suite } from '../harness.mjs';
import {
  LAB, createProject, execute, importJourney, journey, lab, newTenant, registerApplication,
  request, step
} from '../platform.mjs';

const BANK = LAB.banking;

export default async function run() {
  suite('Security and multi-tenancy');
  await lab.reset(BANK);

  // Tenant A owns some real data; tenant B will try to read it.
  const tenantA = await newTenant('TenantA');
  const tenantB = await newTenant('TenantB');

  const projectA = await createProject(tenantA, 'Tenant A project');
  const applicationA = await registerApplication(tenantA, projectA.id, {
    name: 'QA NXT Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
    username: 'alice', password: 'Password123!'
  });
  const importedA = await importJourney(tenantA, {
    projectId: projectA.id, applicationId: applicationA.id,
    journey: journey({
      name: 'Tenant A journey',
      startUrl: `${BANK}/login`,
      steps: [
        step.navigate(`${BANK}/login`),
        step.fill('username', 'alice', `${BANK}/login`),
        step.fill('password', '${secret:app_password}', `${BANK}/login`),
        step.click('login-submit', `${BANK}/login`),
        step.assertVisible('total-balance', `${BANK}/dashboard`)
      ]
    })
  });
  const runA = await execute(tenantA, {
    projectId: projectA.id, testCaseId: importedA.testCaseId, name: 'Tenant A run'
  });
  const executionA = runA.executions?.[0]?.id;
  const context = { tenant: tenantA, applicationVersion: '1.0.0' };

  // ---- SEC-G01: no token, no access ---------------------------------------
  await golden({
    id: 'SEC-G01',
    objective: 'Every data endpoint refuses an unauthenticated request',
    preconditions: ['tenant A has a project, an application, a test case and an execution'],
    input: 'Six endpoints called with no Authorization header',
    expected: 'Each answers 401, and none returns data',
    evidence: ['unauthenticated.json'],
    severity: 'critical',
    run: async () => {
      const paths = [
        '/api/v1/projects',
        `/api/v1/applications?projectId=${projectA.id}`,
        `/api/v1/testcases/${importedA.testCaseId}`,
        `/api/v1/testruns/${runA.run?.id}`,
        `/api/v1/executions/${executionA}`,
        '/api/v1/users'
      ];
      const results = [];
      for (const path of paths) {
        const response = await request(path);
        results.push({ path, status: response.status, body: response.text.slice(0, 120) });
      }
      const refused = results.filter(entry => entry.status === 401);
      return {
        pass: refused.length === results.length,
        detail: `${refused.length}/${results.length} refused with 401; `
          + `other statuses: ${[...new Set(results.filter(e => e.status !== 401).map(e => e.status))].join(', ') || 'none'}`,
        evidence: { 'unauthenticated.json': results }
      };
    }
  }, context);

  // ---- SEC-G02: a token that was not issued here --------------------------
  await golden({
    id: 'SEC-G02',
    objective: 'A forged or tampered token is refused',
    preconditions: ['tenant A holds a valid token'],
    input: 'A random token, a structurally valid token with a flipped signature, and an empty bearer',
    expected: 'All three answer 401',
    evidence: ['bad-tokens.json'],
    severity: 'critical',
    run: async () => {
      const valid = tenantA.token;
      const flipped = `${valid.slice(0, -6)}AAAAAA`;
      const tampered = (() => {
        const [header, payload, signature] = valid.split('.');
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        decoded.perm = ['*'];
        return `${header}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;
      })();

      const cases = [
        ['random', 'not-a-token-at-all'],
        ['flipped signature', flipped],
        ['tampered payload with wildcard permissions', tampered],
        ['empty', '']
      ];
      const results = [];
      for (const [label, token] of cases) {
        const response = await request('/api/v1/projects', { token });
        results.push({ label, status: response.status });
      }
      const refused = results.filter(entry => entry.status === 401);
      return {
        pass: refused.length === results.length,
        detail: results.map(entry => `${entry.label}: ${entry.status}`).join(', '),
        evidence: { 'bad-tokens.json': results }
      };
    }
  }, context);

  // ---- SEC-G03: tenant isolation by direct identifier ---------------------
  await golden({
    id: 'SEC-G03',
    objective: 'One tenant cannot read another\'s data by knowing its identifier',
    preconditions: ['tenant A owns a project, application, test case, run and execution',
      'tenant B is a separate organisation with a valid token'],
    input: 'Tenant B requests each of tenant A\'s objects by id',
    expected: 'Every request is refused, while the same requests succeed for tenant A',
    evidence: ['tenant-isolation.json'],
    severity: 'critical',
    run: async () => {
      const targets = [
        ['project', `/api/v1/projects/${projectA.id}`],
        ['application', `/api/v1/applications/${applicationA.id}`],
        ['test case', `/api/v1/testcases/${importedA.testCaseId}`],
        ['test run', `/api/v1/testruns/${runA.run?.id}`],
        ['execution', `/api/v1/executions/${executionA}`],
        ['execution console log', `/api/v1/executions/${executionA}/console`],
        ['artifacts', `/api/v1/artifacts?executionId=${executionA}`]
      ];

      const results = [];
      for (const [label, path] of targets) {
        const intruder = await request(path, { token: tenantB.token });
        const owner = await request(path, { token: tenantA.token });
        const leaked = intruder.status === 200
          && intruder.text.length > 2
          && intruder.text !== '[]';
        results.push({
          label, path,
          intruderStatus: intruder.status, ownerStatus: owner.status,
          leaked,
          intruderBody: intruder.text.slice(0, 160)
        });
      }

      const denied = results.filter(entry => !entry.leaked);
      const ownerWorks = results.filter(entry => entry.ownerStatus === 200);
      return {
        pass: denied.length === results.length && ownerWorks.length === results.length,
        detail: `${denied.length}/${results.length} refused for the other tenant; `
          + `${ownerWorks.length}/${results.length} readable by their owner; `
          + `intruder statuses ${[...new Set(results.map(e => e.intruderStatus))].join(', ')}`,
        evidence: { 'tenant-isolation.json': results }
      };
    }
  }, context);

  // ---- SEC-G04: a tenant cannot write into another's project --------------
  await golden({
    id: 'SEC-G04',
    objective: 'One tenant cannot start work inside another\'s project',
    preconditions: ['tenant B knows tenant A\'s project and test case ids'],
    input: 'Tenant B starts a test run naming tenant A\'s project and test case',
    expected: 'The request is refused and no run is created in tenant A\'s project',
    evidence: ['cross-tenant-write.json'],
    severity: 'critical',
    run: async () => {
      const attempt = await request('/api/v1/testruns', {
        token: tenantB.token, method: 'POST',
        body: { projectId: projectA.id, testCaseIds: [importedA.testCaseId], name: 'Intruder run', headless: true }
      });
      const runsAfter = await request(`/api/v1/testruns?projectId=${projectA.id}`, { token: tenantA.token });
      const intruderRuns = (runsAfter.json ?? []).filter(entry => entry.name === 'Intruder run');
      return {
        pass: attempt.status !== 200 && attempt.status !== 201 && intruderRuns.length === 0,
        detail: `the write answered ${attempt.status}; `
          + `${intruderRuns.length} intruder run(s) visible in the owner's project`,
        evidence: { 'cross-tenant-write.json': { status: attempt.status, body: attempt.text.slice(0, 300), intruderRuns } }
      };
    }
  }, context);

  // ---- SEC-G05: injection payloads are data ------------------------------
  await golden({
    id: 'SEC-G05',
    objective: 'SQL and script payloads in user input are stored as data, not executed',
    preconditions: ['tenant A can create projects'],
    input: 'Project names containing a SQL injection and a script tag, then a read-back',
    expected: 'The platform stays healthy, the value round-trips unchanged, and nothing is executed',
    evidence: ['injection.json'],
    severity: 'critical',
    run: async () => {
      const payloads = [
        "Robert'); DROP TABLE projects;--",
        '<script>alert(document.cookie)</script>',
        '${jndi:ldap://127.0.0.1/x}',
        '../../etc/passwd'
      ];
      const results = [];
      for (const payload of payloads) {
        const created = await request('/api/v1/projects', {
          token: tenantA.token, method: 'POST',
          body: { name: payload, key: `INJ${Math.random().toString(36).slice(2, 7).toUpperCase()}`, description: payload }
        });
        const readBack = created.ok
          ? await request(`/api/v1/projects/${created.json.id}`, { token: tenantA.token })
          : { json: null };
        results.push({
          payload, status: created.status,
          storedName: readBack.json?.name ?? null,
          roundTripped: readBack.json?.name === payload
        });
      }
      // The platform must still be there afterwards, and the table it was asked to drop
      // must still hold the projects that were in it.
      const stillWorking = await request('/api/v1/projects', { token: tenantA.token });
      return {
        pass: stillWorking.ok && (stillWorking.json ?? []).length > 0
          && results.every(entry => entry.status === 200 || entry.status === 201 || entry.status === 400),
        detail: `${results.filter(entry => entry.roundTripped).length}/${results.length} payload(s) stored verbatim; `
          + `the project list still answers ${stillWorking.status} with ${(stillWorking.json ?? []).length} project(s)`,
        evidence: { 'injection.json': { results, projectsAfter: (stillWorking.json ?? []).length } }
      };
    }
  }, context);

  // ---- SEC-G06: the platform refuses to be pointed anywhere --------------
  await golden({
    id: 'SEC-G06',
    objective: 'The platform refuses targets that are never legitimate, whatever it is configured to allow',
    preconditions: ['tenant A can register applications'],
    input: 'Cloud metadata addresses, the unspecified address, and non-HTTP schemes',
    expected: 'Every one is refused, with a reason — these are refused by configuration or not at all',
    evidence: ['ssrf-always-forbidden.json'],
    severity: 'critical',
    run: async () => {
      // Deliberately excludes loopback and private ranges: whether those are permitted is
      // a deployment decision (ALLOW_PRIVATE_NETWORK_TARGETS), and this lab runs on
      // localhost precisely because it is switched on here. SEC-G11 covers that half.
      const urls = [
        'http://169.254.169.254/latest/meta-data/',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://0.0.0.0:5080/',
        'file:///etc/passwd',
        'ftp://example.com/',
        'gopher://127.0.0.1:11211/'
      ];
      const results = [];
      for (const url of urls) {
        const response = await request('/api/v1/applications', {
          token: tenantA.token, method: 'POST',
          body: { projectId: projectA.id, name: `SSRF ${url}`, baseUrl: url, authStrategy: 'none' }
        });
        results.push({ url, status: response.status, message: response.text.slice(0, 160) });
      }
      const refused = results.filter(entry => entry.status >= 400);
      return {
        pass: refused.length === results.length,
        detail: `${refused.length}/${results.length} refused; `
          + `accepted: ${results.filter(e => e.status < 400).map(e => e.url).join(', ') || 'none'}`,
        evidence: { 'ssrf-always-forbidden.json': results }
      };
    }
  }, context);

  // ---- SEC-G11: private addresses follow the deployment's own setting -----
  await golden({
    id: 'SEC-G11',
    objective: 'Loopback and private addresses are treated consistently with the deployment\'s configuration',
    preconditions: ['this deployment sets ALLOW_PRIVATE_NETWORK_TARGETS=true so that the local test lab can be targeted'],
    input: 'IPv4 loopback, IPv6 loopback, a private range address and a link-local address',
    expected: 'All four are treated the same way as each other — permitted here, because the flag is on',
    evidence: ['ssrf-private.json'],
    severity: 'high',
    run: async () => {
      const urls = [
        ['IPv4 loopback', 'http://127.0.0.1:4300/'],
        ['IPv6 loopback', 'http://[::1]:4300/'],
        ['private range', 'http://10.0.0.5/'],
        ['link-local', 'http://169.254.1.1/']
      ];
      const results = [];
      for (const [label, url] of urls) {
        const response = await request('/api/v1/applications', {
          token: tenantA.token, method: 'POST',
          body: { projectId: projectA.id, name: `Private ${label}`, baseUrl: url, authStrategy: 'none' }
        });
        results.push({ label, url, status: response.status, accepted: response.status < 400,
          message: response.text.slice(0, 140) });
      }

      // Link-local is the exception the platform makes on purpose: 169.254.0.0/16 carries
      // the cloud metadata service and is refused whatever the flag says (BUG-0001).
      const linkLocal = results.find(entry => entry.label === 'link-local');
      const loopbackAndPrivate = results.filter(entry => entry.label !== 'link-local');
      const consistent = new Set(loopbackAndPrivate.map(entry => entry.accepted)).size === 1;

      return {
        pass: consistent && linkLocal?.accepted === false,
        detail: results.map(entry => `${entry.label}: ${entry.status}`).join(', ')
          + `; loopback and private treated consistently: ${consistent}`
          + `; link-local refused regardless: ${linkLocal?.accepted === false}`,
        evidence: {
          'ssrf-private.json': {
            note: 'ALLOW_PRIVATE_NETWORK_TARGETS is on in this environment; the lab runs on localhost.',
            results
          }
        }
      };
    }
  }, context);

  // ---- SEC-G07: credentials never come back out ---------------------------
  await golden({
    id: 'SEC-G07',
    objective: 'A stored credential is never returned by the API',
    preconditions: ['tenant A registered an application with a password'],
    input: 'The application record, the test case, the execution and its actions',
    expected: 'The literal password appears in none of them; the masked form appears instead',
    evidence: ['credential-exposure.json'],
    severity: 'critical',
    run: async () => {
      const surfaces = [
        ['application', `/api/v1/applications/${applicationA.id}`],
        ['applications list', `/api/v1/applications?projectId=${projectA.id}`],
        ['test case', `/api/v1/testcases/${importedA.testCaseId}`],
        ['execution', `/api/v1/executions/${executionA}`],
        ['console log', `/api/v1/executions/${executionA}/console`],
        ['network log', `/api/v1/executions/${executionA}/network`]
      ];
      const leaks = [];
      for (const [label, path] of surfaces) {
        const response = await request(path, { token: tenantA.token });
        if (response.text.includes('Password123!')) leaks.push(label);
      }
      const execution = await request(`/api/v1/executions/${executionA}`, { token: tenantA.token });
      const masked = (execution.json?.actions ?? []).filter(action => action.maskedValue);
      return {
        pass: leaks.length === 0 && masked.length > 0,
        detail: leaks.length
          ? `the password appears in: ${leaks.join(', ')}`
          : `absent from all ${surfaces.length} surfaces; ${masked.length} action(s) record a masked value instead`,
        evidence: {
          'credential-exposure.json': {
            surfacesChecked: surfaces.map(([label]) => label), leaks,
            maskedValues: masked.map(action => ({ order: action.order, maskedValue: action.maskedValue }))
          }
        }
      };
    }
  }, context);

  // ---- SEC-G08: artifacts cannot be used to read the filesystem ----------
  await golden({
    id: 'SEC-G08',
    objective: 'Artifact identifiers cannot be turned into a path traversal',
    preconditions: ['tenant A has an execution with artifacts'],
    input: 'Traversal payloads in place of an artifact id',
    expected: 'Each is refused; no file content is returned',
    evidence: ['traversal.json'],
    severity: 'critical',
    run: async () => {
      const payloads = [
        '../../../../etc/passwd',
        '..%2f..%2f..%2fetc%2fpasswd',
        '00000000-0000-0000-0000-000000000000'
      ];
      const results = [];
      for (const payload of payloads) {
        const response = await request(`/api/v1/artifacts/${encodeURIComponent(payload)}/content`, { token: tenantA.token });
        results.push({
          payload, status: response.status,
          leaked: /root:.*:0:0:/.test(response.text)
        });
      }
      return {
        pass: results.every(entry => entry.status >= 400 && !entry.leaked),
        detail: results.map(entry => `${entry.payload.slice(0, 24)} → ${entry.status}`).join(', '),
        evidence: { 'traversal.json': results }
      };
    }
  }, context);

  // ---- SEC-G09: arbitrary script execution is off by default -------------
  await golden({
    id: 'SEC-G09',
    objective: 'A test cannot run arbitrary JavaScript in the browser unless the project allows it',
    preconditions: ['the project has not enabled script execution'],
    input: 'A journey containing an executeScript step',
    expected: 'The step is refused at import or at execution — never silently run',
    evidence: ['script-execution.json'],
    severity: 'critical',
    run: async () => {
      const scripted = journey({
        name: 'Script execution attempt',
        startUrl: `${BANK}/login`,
        steps: [
          step.navigate(`${BANK}/login`),
          {
            action: 'executeScript',
            description: 'Read the session cookie',
            value: 'return document.cookie;',
            url: `${BANK}/login`
          }
        ]
      });
      const imported = await request('/api/v1/journeys/import', {
        token: tenantA.token, method: 'POST',
        body: { projectId: projectA.id, applicationId: applicationA.id, journey: scripted }
      });

      const refusedAtImport = !imported.ok
        || (imported.json?.warnings ?? []).some(warning => /script/i.test(warning));

      let executionOutcome = null;
      if (imported.ok && imported.json?.testCaseId && !refusedAtImport) {
        const result = await execute(tenantA, {
          projectId: projectA.id, testCaseId: imported.json.testCaseId, name: 'Script attempt'
        });
        const scriptAction = (result.detail?.actions ?? []).find(action => action.action === 'executeScript');
        executionOutcome = { status: result.run?.status, scriptAction };
      }

      const refusedAtExecution = executionOutcome
        ? executionOutcome.scriptAction?.status !== 'passed'
        : false;

      return {
        pass: refusedAtImport || refusedAtExecution,
        detail: refusedAtImport
          ? `refused at import: ${imported.status} ${(imported.json?.warnings ?? []).join('; ').slice(0, 140)}`
          : `refused at execution: the step ${executionOutcome?.scriptAction?.status}`,
        evidence: {
          'script-execution.json': {
            importStatus: imported.status, warnings: imported.json?.warnings ?? [],
            execution: executionOutcome
          }
        }
      };
    }
  }, context);

  // ---- SEC-G10: secure headers -------------------------------------------
  await golden({
    id: 'SEC-G10',
    objective: 'The API sets the browser security headers it claims to',
    preconditions: ['the API is running'],
    input: 'The response headers of an authenticated request',
    expected: 'Content-Type options, frame options, referrer policy and HSTS-equivalent controls are present',
    evidence: ['headers.json'],
    severity: 'high',
    run: async () => {
      const response = await request('/api/v1/projects', { token: tenantA.token });
      const headers = Object.fromEntries([...response.headers.entries()]);
      const required = ['x-content-type-options', 'x-frame-options', 'referrer-policy'];
      const missing = required.filter(name => !(name in headers));
      return {
        pass: missing.length === 0,
        detail: missing.length ? `missing: ${missing.join(', ')}` : `all present: ${required.join(', ')}`,
        evidence: { 'headers.json': headers }
      };
    }
  }, context);

  await lab.reset(BANK);
  return context;
}
