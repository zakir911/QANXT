/**
 * Isolation, the audit trail, and whether one failure can be followed end to end.
 *
 * Three questions that are usually asked of a platform only after something has gone wrong,
 * and are therefore worth asking while nothing has.
 *
 * **Isolation.** Every continuous-quality surface added in CQ-3 to CQ-9 is a new place for a
 * tenant boundary to leak: API tests, contract baselines, schedules, integrations, test data,
 * regression selection, quality gates and now the audit trail itself. Each is checked the way
 * a customer would find the hole — by identifier, over the same HTTP API — and every denial is
 * paired with a control read by the rightful owner. "404 for everyone" is not isolation; it is
 * a broken endpoint that happens to look secure.
 *
 * **Audit.** The trail is the only record of who asked for something. It is checked for the
 * actions nobody is present for (a schedule firing), the actions that change what the platform
 * will permit (authorizing production, changing a gate), and the actions that failed — because
 * a run of failed sign-ins is the thing a review is actually looking for, and it is invisible
 * unless failure is recorded as explicitly as success.
 *
 * **Observability.** A correlation id is only worth having if it survives the whole way. It is
 * followed from the caller's own header, through the API's response, into the audit record, and
 * on to the execution the worker ran.
 */
import { golden, suite } from '../harness.mjs';
import {
  LAB, createEnvironment, createGateRule, createProject, importJourney, journey, lab,
  newTenant, registerApplication, request, startRun, step, waitForRun
} from '../platform.mjs';

const BANK = LAB.banking;
// The sink is only a URL to point an integration at here; nothing in this suite delivers to it.
const SINK = process.env.LAB_SINK_URL ?? 'http://localhost:4360';

const audit = (tenant, query = '') => request(`/api/v1/audit${query}`, { token: tenant.token });

/** A denial plus the owner's control read, which is the only pair that proves isolation. */
async function crossTenant({ owner, intruder, path }) {
  const denied = await request(path, { token: intruder.token });
  const control = await request(path, { token: owner.token });
  return {
    denied,
    control,
    isolated: !denied.ok && control.ok,
    detail: `intruder ${denied.status}, owner ${control.status}`
  };
}

export default async function run() {
  suite('Isolation, audit and observability');
  await lab.reset(BANK);

  // Tenant A owns everything below. Tenant B is a real, fully registered organization that
  // simply has no business seeing any of it.
  const tenantA = await newTenant('IsoA');
  const tenantB = await newTenant('IsoB');

  const projectA = await createProject(tenantA, 'Isolation project A');
  const applicationA = await registerApplication(tenantA, projectA.id, {
    name: 'QA NXT Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
    username: 'alice', password: 'Password123!'
  });

  const environmentA = await createEnvironment(tenantA, projectA.id, {
    name: 'Staging A', key: 'staging-a', kind: 'staging', baseUrl: BANK,
    allowedDomains: new URL(BANK).hostname
  });

  // ---- Tenant A's continuous-quality surfaces -------------------------------

  const apiTestA = await request('/api/v1/testcases/api-tests', {
    token: tenantA.token, method: 'POST',
    body: {
      projectId: projectA.id, applicationId: applicationA.id,
      suiteName: 'Tenant A API suite',
      name: 'Tenant A API test',
      objective: 'Exists so that tenant B can fail to read it',
      steps: [{
        description: 'Read the accounts endpoint',
        request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' } },
        assertions: [{ type: 'httpStatusEquals', expected: '200' }]
      }]
    }
  });

  const scheduleA = await request('/api/v1/schedules', {
    token: tenantA.token, method: 'POST',
    body: {
      projectId: projectA.id, name: 'Tenant A nightly',
      cronExpression: '0 2 * * *', timeZone: 'UTC'
    }
  });

  const integrationA = await request('/api/v1/integrations', {
    token: tenantA.token, method: 'POST',
    body: {
      projectId: projectA.id, kind: 'webhook', name: 'Tenant A channel',
      settings: { url: `${SINK}/hook` },
      credentials: { signingSecret: 'tenant-a-signing-secret-value' }
    }
  });

  const dataSetA = await request('/api/v1/test-data', {
    token: tenantA.token, method: 'POST',
    body: {
      projectId: projectA.id, name: 'Tenant A data',
      fields: [{ key: 'accountName', kind: 'static', value: 'Tenant A account' }]
    }
  });

  const gateRuleA = await createGateRule(tenantA, projectA.id, {
    name: 'Tenant A rule', metric: 'failedCount', operator: 'lessThanOrEqual',
    threshold: 0, onBreach: 'fail'
  });

  // ---- Isolation -----------------------------------------------------------

  await golden({
    id: 'ISO-001', severity: 'critical',
    objective: 'An API test belonging to another tenant cannot be read by identifier',
    preconditions: ['two registered organizations', 'tenant A owns an API test'],
    input: `GET /api/v1/testcases/${apiTestA.json?.testCaseId} as tenant B, and as tenant A`,
    expected: 'Tenant B is refused; tenant A reads it',
    evidence: ['isolation.json'],
    run: async () => {
      const result = await crossTenant({
        owner: tenantA, intruder: tenantB, path: `/api/v1/testcases/${apiTestA.json.testCaseId}`
      });
      return {
        pass: result.isolated,
        detail: result.detail,
        metrics: { intruderStatus: result.denied.status, ownerStatus: result.control.status },
        evidence: {
          'isolation.json': JSON.stringify({
            resource: 'api-test', id: apiTestA.json.testCaseId,
            intruder: { status: result.denied.status, body: result.denied.text.slice(0, 400) },
            owner: { status: result.control.status }
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'ISO-002', severity: 'critical',
    objective: 'Contract baselines and the API inventory are scoped to the owning tenant',
    preconditions: ["tenant A owns an application"],
    input: `GET /api/v1/api-contracts/inventory?applicationId=${applicationA.id} as both tenants`,
    expected: 'Tenant B is refused or sees nothing of tenant A; tenant A sees its own',
    evidence: ['inventory.json'],
    run: async () => {
      const path = `/api/v1/api-contracts/inventory?applicationId=${applicationA.id}`;
      const intruder = await request(path, { token: tenantB.token });
      const owner = await request(path, { token: tenantA.token });

      // Either a refusal or an empty result is correct here — an inventory is a list, and a
      // list scoped to a tenant legitimately comes back empty rather than forbidden. What is
      // not acceptable is tenant B seeing tenant A's endpoints.
      const leaked = intruder.ok && (intruder.json?.endpoints?.length ?? 0) > 0;
      return {
        pass: owner.ok && !leaked,
        detail: `intruder ${intruder.status} with ${intruder.json?.endpoints?.length ?? 0} endpoint(s), `
          + `owner ${owner.status}`,
        metrics: { intruderEndpoints: intruder.json?.endpoints?.length ?? 0 },
        evidence: {
          'inventory.json': JSON.stringify({
            intruder: { status: intruder.status, endpoints: intruder.json?.endpoints?.length ?? 0 },
            owner: { status: owner.status, endpoints: owner.json?.endpoints?.length ?? 0 }
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'ISO-003', severity: 'critical',
    objective: 'A schedule cannot be read, changed or deleted across a tenant boundary',
    preconditions: ['tenant A owns a schedule'],
    input: 'GET, PATCH and DELETE on tenant A\'s schedule as tenant B',
    expected: 'All three are refused, and the schedule still exists and is unchanged afterwards',
    evidence: ['schedule-isolation.json'],
    run: async () => {
      const id = scheduleA.json.id;
      const read = await request(`/api/v1/schedules/${id}`, { token: tenantB.token });
      const patched = await request(`/api/v1/schedules/${id}`, {
        token: tenantB.token, method: 'PATCH', body: { isEnabled: false, name: 'Owned by B' }
      });
      const deleted = await request(`/api/v1/schedules/${id}`, {
        token: tenantB.token, method: 'DELETE'
      });

      // The point of the write attempts is not the status code. It is that the schedule is
      // still there, still enabled and still called what its owner called it.
      const after = await request(`/api/v1/schedules/${id}`, { token: tenantA.token });
      const intact = after.ok && after.json.name === 'Tenant A nightly' && after.json.isEnabled === true;

      return {
        pass: !read.ok && !patched.ok && !deleted.ok && intact,
        detail: `read ${read.status}, patch ${patched.status}, delete ${deleted.status}; `
          + `afterwards name "${after.json?.name}" enabled=${after.json?.isEnabled}`,
        metrics: { read: read.status, patch: patched.status, delete: deleted.status },
        evidence: {
          'schedule-isolation.json': JSON.stringify({
            attempts: { read: read.status, patch: patched.status, delete: deleted.status },
            afterwards: { name: after.json?.name, isEnabled: after.json?.isEnabled }
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'ISO-004', severity: 'critical',
    objective: "Another tenant's notification integration is neither listed nor readable, and its secret never leaves the platform",
    preconditions: ['tenant A owns a webhook integration with a signing secret'],
    input: 'GET /api/v1/integrations as tenant B, and the integration by id',
    expected: "Tenant B sees none of tenant A's integrations, and the signing secret appears in no response to either tenant",
    evidence: ['integration-isolation.json'],
    run: async () => {
      const secret = 'tenant-a-signing-secret-value';
      const id = integrationA.json.id;

      const listed = await request(`/api/v1/integrations?projectId=${projectA.id}`, { token: tenantB.token });
      const byId = await request(`/api/v1/integrations/${id}`, { token: tenantB.token });
      const ownerList = await request(`/api/v1/integrations?projectId=${projectA.id}`, { token: tenantA.token });

      const sawTenantA = listed.ok && JSON.stringify(listed.json ?? '').includes(id);
      // The owner's own read must not return the secret either. A credential is write-only
      // by design: whoever configured it has it already, and nobody else should get it back.
      const secretLeaked = [listed, byId, ownerList].some(r => r.text.includes(secret));

      return {
        pass: !sawTenantA && !byId.ok && ownerList.ok && !secretLeaked,
        detail: `tenant B list ${listed.status} (saw tenant A: ${sawTenantA}), by id ${byId.status}; `
          + `owner list ${ownerList.status}; signing secret present in any response: ${secretLeaked}`,
        metrics: { secretLeaked: secretLeaked ? 1 : 0 },
        evidence: {
          'integration-isolation.json': JSON.stringify({
            tenantBList: { status: listed.status, sawOwnersIntegration: sawTenantA },
            tenantBById: { status: byId.status },
            ownerList: { status: ownerList.status },
            signingSecretFoundInAnyResponse: secretLeaked
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'ISO-005', severity: 'critical',
    objective: "A test data set cannot be read or previewed by another tenant",
    preconditions: ['tenant A owns a test data set'],
    input: "GET the set and its preview as tenant B",
    expected: 'Both are refused; tenant A reads both',
    evidence: ['test-data-isolation.json'],
    run: async () => {
      const id = dataSetA.json.id;
      const read = await crossTenant({ owner: tenantA, intruder: tenantB, path: `/api/v1/test-data/${id}` });
      const preview = await crossTenant({
        owner: tenantA, intruder: tenantB, path: `/api/v1/test-data/${id}/preview`
      });
      return {
        pass: read.isolated && preview.isolated,
        detail: `read: ${read.detail}; preview: ${preview.detail}`,
        metrics: { readIntruder: read.denied.status, previewIntruder: preview.denied.status },
        evidence: {
          'test-data-isolation.json': JSON.stringify({
            read: { intruder: read.denied.status, owner: read.control.status },
            preview: { intruder: preview.denied.status, owner: preview.control.status }
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'ISO-006', severity: 'critical',
    objective: 'Quality gate rules are scoped to their project and tenant',
    preconditions: ["tenant A owns a gate rule"],
    input: "GET and DELETE tenant A's gate rule as tenant B",
    expected: 'Tenant B is refused and the rule survives',
    evidence: ['gate-isolation.json'],
    run: async () => {
      const listed = await request(`/api/v1/quality-gates?projectId=${projectA.id}`, { token: tenantB.token });
      const removed = await request(`/api/v1/quality-gates/${gateRuleA.id}`, {
        token: tenantB.token, method: 'DELETE'
      });
      const after = await request(`/api/v1/quality-gates?projectId=${projectA.id}`, { token: tenantA.token });
      const survives = after.ok && JSON.stringify(after.json).includes(gateRuleA.id);
      const sawIt = listed.ok && JSON.stringify(listed.json ?? '').includes(gateRuleA.id);

      return {
        pass: !sawIt && !removed.ok && survives,
        detail: `tenant B list ${listed.status} (saw the rule: ${sawIt}), delete ${removed.status}; `
          + `rule still present for its owner: ${survives}`,
        metrics: { list: listed.status, delete: removed.status },
        evidence: {
          'gate-isolation.json': JSON.stringify({
            tenantBList: { status: listed.status, sawOwnersRule: sawIt },
            tenantBDelete: { status: removed.status },
            ruleSurvives: survives
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'ISO-007', severity: 'critical',
    objective: "The audit trail is scoped to one organization, and there is no parameter that would widen it",
    preconditions: ['both tenants have produced audit records by registering and creating projects'],
    input: 'GET /api/v1/audit as each tenant, and an attempt to ask for the other organization',
    expected: "Neither tenant's records appear in the other's trail, including when the other's organization id is supplied",
    evidence: ['audit-isolation.json'],
    run: async () => {
      const a = await audit(tenantA, '?limit=200');
      const b = await audit(tenantB, '?limit=200');

      // Organization is not a query parameter. Supplying it must change nothing rather than
      // being honoured — an ignored parameter is the correct behaviour, a respected one is a
      // tenant boundary with a query string for a door.
      const forced = await audit(tenantB, `?limit=200&organizationId=${tenantA.organizationId}`);

      const orgsIn = page => new Set((page.json?.entries ?? []).map(e => e.organizationId));
      const aOrgs = orgsIn(a);
      const bOrgs = orgsIn(b);
      const forcedOrgs = orgsIn(forced);

      const clean = aOrgs.size === 1 && aOrgs.has(tenantA.organizationId)
        && bOrgs.size === 1 && bOrgs.has(tenantB.organizationId)
        && !forcedOrgs.has(tenantA.organizationId);

      return {
        pass: a.ok && b.ok && clean,
        detail: `tenant A sees ${a.json?.entries?.length ?? 0} record(s) from ${aOrgs.size} org(s); `
          + `tenant B ${b.json?.entries?.length ?? 0} from ${bOrgs.size}; `
          + `forcing organizationId returned ${forcedOrgs.size} org(s), tenant A's included: `
          + `${forcedOrgs.has(tenantA.organizationId)}`,
        metrics: { tenantAOrgs: aOrgs.size, tenantBOrgs: bOrgs.size },
        evidence: {
          'audit-isolation.json': JSON.stringify({
            tenantA: { status: a.status, entries: a.json?.entries?.length ?? 0, organizations: [...aOrgs] },
            tenantB: { status: b.status, entries: b.json?.entries?.length ?? 0, organizations: [...bOrgs] },
            forcedOrganizationId: {
              status: forced.status, organizations: [...forcedOrgs],
              includedOtherTenant: forcedOrgs.has(tenantA.organizationId)
            }
          }, null, 2)
        }
      };
    }
  });

  // ---- Audit ---------------------------------------------------------------

  await golden({
    id: 'AUD-001', severity: 'critical',
    objective: 'Authorizing production testing is recorded, with the written reason that was given',
    preconditions: ['a production environment exists and has not been authorized'],
    input: 'POST /api/v1/environments/{id}/authorize-production, then read the trail',
    expected: 'An audit record names the environment and carries the reason',
    evidence: ['authorize-audit.json'],
    run: async () => {
      const production = await createEnvironment(tenantA, projectA.id, {
        name: 'Production A', key: 'prod-a', kind: 'production', baseUrl: BANK,
        allowedDomains: new URL(BANK).hostname
      });
      const note = 'Change 4821 approved by the release board on 2026-09-23.';
      const authorized = await request(
        `/api/v1/environments/${production.id}/authorize-production`,
        { token: tenantA.token, method: 'POST', body: { authorized: true, note } });

      const trail = await audit(tenantA, `?entityId=${production.id}&limit=50`);
      const entries = trail.json?.entries ?? [];
      const record = entries.find(e => JSON.stringify(e).includes('4821'));

      return {
        pass: authorized.ok && Boolean(record),
        detail: authorized.ok
          ? `authorization ${authorized.status}; ${entries.length} audit record(s) for the environment; `
            + `the reason is on the trail: ${Boolean(record)}`
          : `authorization failed: ${authorized.status} ${authorized.text.slice(0, 200)}`,
        metrics: { records: entries.length },
        evidence: {
          'authorize-audit.json': JSON.stringify({
            environmentId: production.id,
            authorizationStatus: authorized.status,
            entries: entries.map(e => ({
              action: e.action, summary: e.summary, succeeded: e.succeeded,
              correlationId: e.correlationId
            }))
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'AUD-002', severity: 'high',
    objective: 'Creating, changing and deleting a schedule are each recorded separately',
    preconditions: ['a project exists'],
    input: 'Create, patch and delete a schedule, then read the trail for it',
    expected: 'Three distinct audit actions appear for the same entity',
    evidence: ['schedule-audit.json'],
    run: async () => {
      const created = await request('/api/v1/schedules', {
        token: tenantA.token, method: 'POST',
        body: {
          projectId: projectA.id, name: 'Audited schedule',
          cronExpression: '0 3 * * *', timeZone: 'UTC'
        }
      });
      const id = created.json.id;
      await request(`/api/v1/schedules/${id}`, {
        token: tenantA.token, method: 'PATCH', body: { cronExpression: '0 4 * * *' }
      });
      await request(`/api/v1/schedules/${id}`, { token: tenantA.token, method: 'DELETE' });

      const trail = await audit(tenantA, `?entityId=${id}&limit=50`);
      const actions = new Set((trail.json?.entries ?? []).map(e => e.action));

      return {
        pass: ['scheduleCreated', 'scheduleUpdated', 'scheduleDeleted'].every(a => actions.has(a)),
        detail: `actions recorded: ${[...actions].sort().join(', ') || 'none'}`,
        metrics: { distinctActions: actions.size },
        evidence: {
          'schedule-audit.json': JSON.stringify({
            scheduleId: id,
            entries: (trail.json?.entries ?? []).map(e => ({
              action: e.action, summary: e.summary, occurredAt: e.occurredAt
            }))
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'AUD-003', severity: 'high',
    objective: 'Changing a quality gate is recorded, because it changes what the platform will let through',
    preconditions: ['a project exists'],
    input: 'Create a gate rule, then read the trail filtered to gate changes',
    expected: 'A qualityGateChanged record exists and names the rule',
    evidence: ['gate-audit.json'],
    run: async () => {
      const rule = await createGateRule(tenantA, projectA.id, {
        name: 'Audited gate rule', metric: 'passRatePercent',
        operator: 'greaterThanOrEqual', threshold: 95, onBreach: 'fail'
      });
      const trail = await audit(tenantA, '?action=qualityGateChanged&limit=50');
      const entries = trail.json?.entries ?? [];
      const named = entries.some(e => e.summary?.includes('Audited gate rule'));

      return {
        pass: trail.ok && named,
        detail: `${entries.length} qualityGateChanged record(s); the new rule is named: ${named}`,
        metrics: { records: entries.length },
        evidence: {
          'gate-audit.json': JSON.stringify({
            ruleId: rule.id,
            entries: entries.map(e => ({ action: e.action, summary: e.summary }))
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'AUD-006', severity: 'critical',
    objective: 'Reading the audit trail needs its own permission, which ordinary read access does not carry',
    preconditions: ['the organization can invite a user with a lesser role'],
    input: 'Invite a Viewer, sign in as them, and read results and then the trail',
    expected: 'The viewer can read test results and is refused the audit trail',
    evidence: ['permission.json'],
    run: async () => {
      const invited = await request('/api/v1/users', {
        token: tenantA.token, method: 'POST',
        body: {
          email: `viewer-${Math.random().toString(36).slice(2, 10)}@example.test`,
          displayName: 'Audit Viewer', role: 'viewer'
        }
      });
      if (!invited.ok) {
        return { pass: false, detail: `could not invite a viewer: ${invited.status} ${invited.text.slice(0, 200)}` };
      }

      const signedIn = await request('/api/v1/auth/login', {
        method: 'POST',
        body: { email: invited.json.user.email, password: invited.json.temporaryPassword }
      });
      if (!signedIn.ok) {
        return { pass: false, detail: `the invited viewer could not sign in: ${signedIn.status}` };
      }
      const viewer = { token: signedIn.json.accessToken };

      // The control matters: if the viewer were refused everything, a 403 on the audit
      // endpoint would prove nothing about the permission.
      const results = await request(`/api/v1/projects`, { token: viewer.token });
      const trail = await request('/api/v1/audit?limit=10', { token: viewer.token });

      return {
        pass: results.ok && trail.status === 403,
        detail: `viewer reading projects: ${results.status}; reading the audit trail: ${trail.status}`,
        metrics: { projects: results.status, audit: trail.status },
        evidence: {
          'permission.json': JSON.stringify({
            role: 'viewer',
            projectsStatus: results.status,
            auditStatus: trail.status,
            expected: 'projects 200, audit 403'
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'AUD-004', severity: 'critical',
    objective: 'A failed action is recorded as failed, not omitted',
    preconditions: ['an organization exists'],
    input: 'Three sign-in attempts with the wrong password, then read the trail for failures',
    expected: 'Each attempt appears with succeeded=false',
    evidence: ['failed-logins.json'],
    run: async () => {
      // One attempt, deliberately. Three would also exercise the sign-in rate limiter, and a
      // rejected request never reaches the auth service, so the count would depend on how
      // much of the per-minute budget other tests had already spent. The claim here is that
      // a failure is recorded as a failure; one record establishes it. The limiter's own
      // visibility is AUD-008's job.
      const attempted = await request('/api/v1/auth/login', {
        method: 'POST',
        body: { email: tenantA.email, password: 'ThisIsNotThePassword!' }
      });
      if (attempted.status === 429) {
        return { pass: false, detail: 'the sign-in attempt was rate limited before it could be audited' };
      }

      const trail = await audit(tenantA, '?succeeded=false&limit=50');
      const entries = trail.json?.entries ?? [];
      const failures = entries.filter(e => e.action === 'loginFailed');

      // The password must not be anywhere in the record of the attempt to use it.
      const leaked = JSON.stringify(entries).includes('ThisIsNotThePassword');

      return {
        pass: failures.length >= 1 && !leaked,
        detail: `sign-in refused with ${attempted.status}; ${failures.length} loginFailed record(s) `
          + `with succeeded=false; the attempted password appears in the trail: ${leaked}`,
        metrics: { failedLogins: failures.length, passwordLeaked: leaked ? 1 : 0 },
        evidence: {
          'failed-logins.json': JSON.stringify({
            entries: failures.map(e => ({
              action: e.action, succeeded: e.succeeded, summary: e.summary,
              occurredAt: e.occurredAt
            })),
            attemptedPasswordPresent: leaked
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'AUD-005', severity: 'critical',
    objective: 'The audit trail has no write path: it cannot be added to, edited or deleted through the API',
    preconditions: ['the audit endpoint exists'],
    input: 'POST, PATCH, PUT and DELETE against /api/v1/audit and a record within it',
    expected: 'Every write verb is refused; the record count is unchanged afterwards',
    evidence: ['append-only.json'],
    run: async () => {
      const before = await audit(tenantA, '?limit=1');
      const target = (await audit(tenantA, '?limit=1')).json?.entries?.[0];

      const attempts = {};
      for (const [label, path, method] of [
        ['postCollection', '/api/v1/audit', 'POST'],
        ['deleteCollection', '/api/v1/audit', 'DELETE'],
        ['patchRecord', `/api/v1/audit/${target?.id}`, 'PATCH'],
        ['putRecord', `/api/v1/audit/${target?.id}`, 'PUT'],
        ['deleteRecord', `/api/v1/audit/${target?.id}`, 'DELETE']
      ]) {
        const response = await request(path, {
          token: tenantA.token, method,
          body: method === 'POST' || method === 'PATCH' || method === 'PUT'
            ? { summary: 'forged', succeeded: true } : undefined
        });
        attempts[label] = response.status;
      }

      const after = await audit(tenantA, '?limit=1');
      // 404 (no route) and 405 (route, wrong verb) are both correct refusals. What matters is
      // that none of them succeeded and the count did not move.
      const allRefused = Object.values(attempts).every(status => status >= 400);
      const unchanged = before.json?.total === after.json?.total;

      return {
        pass: allRefused && unchanged,
        detail: `${Object.entries(attempts).map(([k, v]) => `${k} ${v}`).join(', ')}; `
          + `total ${before.json?.total} → ${after.json?.total}`,
        metrics: { totalBefore: before.json?.total ?? 0, totalAfter: after.json?.total ?? 0 },
        evidence: {
          'append-only.json': JSON.stringify({
            attempts, totalBefore: before.json?.total, totalAfter: after.json?.total
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'AUD-007', severity: 'critical',
    objective: 'Configuring a secret is audited without the secret being recorded',
    preconditions: ['a project exists'],
    input: 'Create an integration carrying a signing secret, then read every audit record it produced',
    expected: 'The configuration is recorded and the secret value appears nowhere in the trail',
    evidence: ['secret-audit.json'],
    run: async () => {
      const secret = 'do-not-write-this-anywhere-3f8a2c';
      const created = await request('/api/v1/integrations', {
        token: tenantA.token, method: 'POST',
        body: {
          projectId: projectA.id, kind: 'webhook', name: 'Secret-bearing integration',
          settings: { url: `${SINK}/hook` },
          credentials: { signingSecret: secret }
        }
      });

      const trail = await audit(tenantA, '?limit=200');
      const body = JSON.stringify(trail.json ?? {});
      const leaked = body.includes(secret);
      const recorded = (trail.json?.entries ?? []).some(e =>
        e.summary?.includes('Secret-bearing integration')
        || e.action === 'integrationConfigured' || e.action === 'secretConfigured');

      return {
        pass: created.ok && recorded && !leaked,
        detail: `integration ${created.status}; the configuration is on the trail: ${recorded}; `
          + `the secret value appears in the trail: ${leaked}`,
        metrics: { secretLeaked: leaked ? 1 : 0 },
        evidence: {
          'secret-audit.json': JSON.stringify({
            integrationStatus: created.status,
            configurationRecorded: recorded,
            secretValueFoundInTrail: leaked,
            actions: [...new Set((trail.json?.entries ?? []).map(e => e.action))]
          }, null, 2)
        }
      };
    }
  });

  // ---- Observability -------------------------------------------------------

  await golden({
    id: 'OBS-001', severity: 'high',
    objective: 'Every response carries a correlation id, and one supplied by the caller is honoured rather than replaced',
    preconditions: ['the API is running'],
    input: 'A request with no correlation header, and one carrying a caller-supplied id',
    expected: 'The first is given an id; the second comes back with the id that was sent',
    evidence: ['correlation.json'],
    run: async () => {
      const minted = await request('/api/v1/projects', { token: tenantA.token });
      const supplied = `golden-${Math.random().toString(36).slice(2, 12)}`;
      const echoed = await request('/api/v1/projects', {
        token: tenantA.token, headers: { 'x-correlation-id': supplied }
      });

      const mintedId = minted.headers?.get?.('x-correlation-id');
      const echoedId = echoed.headers?.get?.('x-correlation-id');

      return {
        pass: Boolean(mintedId) && echoedId === supplied,
        detail: `minted "${mintedId}"; supplied "${supplied}" came back as "${echoedId}"`,
        metrics: { mintedLength: mintedId?.length ?? 0 },
        evidence: {
          'correlation.json': JSON.stringify({
            mintedWhenAbsent: mintedId, supplied, echoed: echoedId
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'OBS-002', severity: 'critical',
    objective: 'The correlation id on a response is the one on the audit record that request produced',
    preconditions: ['the audit trail is readable'],
    input: 'Create a project with a known correlation id, then look that id up in the trail',
    expected: 'The audit record for the creation carries exactly the id the caller sent',
    evidence: ['correlation-to-audit.json'],
    run: async () => {
      const supplied = `golden-trace-${Math.random().toString(36).slice(2, 12)}`;
      const created = await request('/api/v1/projects', {
        token: tenantA.token, method: 'POST',
        headers: { 'x-correlation-id': supplied },
        body: {
          name: 'Correlated project', key: `C${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          description: 'Created to be found again by correlation id'
        }
      });

      const traced = await request(`/api/v1/audit/correlation/${supplied}`, { token: tenantA.token });
      const entries = traced.json?.entries ?? [];
      const found = entries.find(e => e.entityId === created.json?.id);

      return {
        pass: created.ok && Boolean(found),
        detail: created.ok
          ? `${entries.length} record(s) carry correlation ${supplied}; the created project is among them: `
            + `${Boolean(found)}${found ? ` (${found.action})` : ''}`
          : `the project could not be created: ${created.status}`,
        metrics: { entries: entries.length },
        evidence: {
          'correlation-to-audit.json': JSON.stringify({
            correlationId: supplied,
            projectId: created.json?.id,
            entries: entries.map(e => ({
              action: e.action, entityType: e.entityType, entityId: e.entityId,
              correlationId: e.correlationId
            }))
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'OBS-003', severity: 'critical',
    objective: 'A correlation id survives from the caller through the queue to the execution the worker ran',
    preconditions: ['the banking application is running and a worker is available'],
    input: 'Start a run with a caller-supplied correlation id and read the execution back',
    expected: 'The execution records a correlation id, and it is the one the caller supplied',
    evidence: ['execution-correlation.json'],
    run: async () => {
      const imported = await importJourney(tenantA, {
        projectId: projectA.id, applicationId: applicationA.id,
        journey: journey({
          name: 'Correlation journey',
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

      const supplied = `golden-run-${Math.random().toString(36).slice(2, 12)}`;
      const started = await request('/api/v1/testruns', {
        token: tenantA.token, method: 'POST',
        headers: { 'x-correlation-id': supplied },
        body: { projectId: projectA.id, testCaseIds: [imported.testCaseId], headless: true }
      });
      if (!started.ok) {
        return { pass: false, detail: `the run could not be started: ${started.status} ${started.text.slice(0, 200)}` };
      }

      const finished = await waitForRun(tenantA, started.json.id);
      const executions = await request(`/api/v1/testruns/${started.json.id}/executions`,
        { token: tenantA.token });
      const execution = (executions.json ?? [])[0];
      const carried = execution?.correlationId;

      return {
        pass: Boolean(carried) && carried === supplied,
        detail: `run ${finished.status}; the execution carries correlation "${carried}" `
          + `(supplied "${supplied}")`,
        metrics: { matched: carried === supplied ? 1 : 0 },
        evidence: {
          'execution-correlation.json': JSON.stringify({
            supplied, runId: started.json.id,
            executionId: execution?.id, executionCorrelationId: carried,
            runStatus: finished.status
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'OBS-004', severity: 'high',
    objective: 'Liveness and readiness answer different questions, and liveness depends on nothing',
    preconditions: ['the API is running with its database and queue reachable'],
    input: 'GET /live, /ready and /health',
    expected: 'All three answer; /live reports healthy without consulting a dependency',
    evidence: ['health.json'],
    run: async () => {
      const results = {};
      for (const path of ['/live', '/ready', '/health']) {
        const response = await fetch(`${(await import('../platform.mjs')).API}${path}`);
        results[path] = { status: response.status, body: (await response.text()).slice(0, 100) };
      }
      // /live must be healthy and must not be reporting on a dependency: its body is the
      // aggregate status alone, with no check names in it.
      const liveIsIndependent = results['/live'].status === 200
        && !results['/live'].body.toLowerCase().includes('database')
        && !results['/live'].body.toLowerCase().includes('redis');

      return {
        pass: Object.values(results).every(r => r.status === 200) && liveIsIndependent,
        detail: Object.entries(results)
          .map(([path, r]) => `${path} ${r.status} "${r.body}"`).join('; '),
        metrics: { live: results['/live'].status, ready: results['/ready'].status },
        evidence: { 'health.json': JSON.stringify(results, null, 2) }
      };
    }
  });

  await golden({
    id: 'OBS-005', severity: 'high',
    objective: 'A correlation id a caller invents is bounded, so it cannot be used to write arbitrary text into every log line',
    preconditions: ['the API is running'],
    input: 'A request carrying a 500-character correlation header',
    expected: 'The oversized value is rejected and replaced with one the platform generated',
    evidence: ['oversized-correlation.json'],
    run: async () => {
      const oversized = 'A'.repeat(500);
      const response = await request('/api/v1/projects', {
        token: tenantA.token, headers: { 'x-correlation-id': oversized }
      });
      const returned = response.headers?.get?.('x-correlation-id') ?? '';

      return {
        pass: response.ok && returned !== oversized && returned.length > 0 && returned.length <= 64,
        detail: `sent ${oversized.length} characters; the platform used a ${returned.length}-character id `
          + `of its own: ${returned !== oversized}`,
        metrics: { sentLength: oversized.length, returnedLength: returned.length },
        evidence: {
          'oversized-correlation.json': JSON.stringify({
            sentLength: oversized.length, returnedLength: returned.length,
            reflectedVerbatim: returned === oversized
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'AUD-008', severity: 'high',
    objective: 'A burst of credential attempts is refused, and the refusals are recorded as a security event rather than as ordinary traffic',
    preconditions: [
      'the API writes to /tmp/qanxt-api.log',
      'the sign-in rate limit is configured',
      'this test exhausts the credential rate-limit budget for its address; newTenant retries '
        + 'on 429 so a later suite is not stranded by it'
    ],
    input: 'Twenty sign-in attempts in a row, then the API log',
    expected: 'The budget is exhausted and the refusals appear at warning level, named as the rate limiter and as a credential endpoint',
    evidence: ['rate-limit.json'],
    run: async () => {
      const { readFileSync, existsSync } = await import('node:fs');
      const logPath = process.env.QANXT_API_LOG ?? '/tmp/qanxt-api.log';
      if (!existsSync(logPath)) {
        return { pass: false, detail: `the API log is not at ${logPath}; set QANXT_API_LOG` };
      }
      const before = readFileSync(logPath, 'utf8').length;

      const statuses = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await request('/api/v1/auth/login', {
          method: 'POST',
          body: { email: `nobody-${attempt}@example.test`, password: 'WrongPassword!1' }
        });
        statuses.push(response.status);
      }
      const refused = statuses.filter(status => status === 429).length;

      // Only the lines this test caused, so an earlier burst cannot make it pass.
      const written = readFileSync(logPath, 'utf8').slice(before);
      const refusalLines = written.split('\n')
        .filter(line => line.includes('Rate limit refused') && line.includes('/api/v1/auth/login'));
      // Serilog renders the level inside the timestamp bracket — "[04:48:10 WRN]" — so the
      // level is matched with its trailing bracket rather than as "[WRN]".
      const atWarning = refusalLines.filter(line => / WRN\]/.test(line)).length;
      // Matched on the rendered property rather than on a bare "true" anywhere in the line:
      // .NET writes a boolean as "True", and a substring search for "true" happened to be
      // both wrong and the kind of assertion that would later pass by accident.
      const namedAsCredential = refusalLines
        .filter(line => line.includes('credential endpoint: True')).length;
      const attributed = refusalLines
        .filter(line => line.includes('"SourceContext": "QaNxt.Api.RateLimiter"')).length;

      return {
        pass: refused > 0 && atWarning === refusalLines.length
          && namedAsCredential === refusalLines.length && attributed === refusalLines.length,
        detail: `${refused} of ${statuses.length} attempt(s) refused with 429; `
          + `${refusalLines.length} limiter line(s) written — ${atWarning} at warning level, `
          + `${namedAsCredential} named as a credential endpoint, ${attributed} attributed to the limiter`,
        metrics: { refused, refusalLines: refusalLines.length, atWarning, attributed },
        evidence: {
          'rate-limit.json': JSON.stringify({
            statuses, refused,
            limiterLines: refusalLines.slice(0, 5),
            atWarningLevel: atWarning,
            markedAsCredentialEndpoint: namedAsCredential,
            attributedToTheRateLimiter: attributed
          }, null, 2)
        }
      };
    }
  });
}
