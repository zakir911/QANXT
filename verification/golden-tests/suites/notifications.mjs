/**
 * Notifications: telling somebody, and being able to show that you did.
 *
 * The Integration entity had a table, permissions and no service — nothing ever read it, so
 * nothing was ever sent. What makes this worth verifying rather than reading is that every
 * interesting property is about a real outbound request: did it arrive, what was in it, was
 * it signed, and what happens when the receiver misbehaves.
 *
 * So these run against `test-lab/notification-sink`, a real HTTP server that keeps what it
 * receives. It is not a mock of Slack and nothing here claims Slack accepts the payload;
 * what is claimed is that QA NXT sent one, that its body had a given shape, that the
 * signature verified, and that a receiver returning 500 or hanging is handled the way the
 * code says it is.
 *
 * The one thing that matters most is NOT-005: a message must never carry a secret. That is
 * checked against the bytes on the wire, not against the code that built them.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { golden, suite } from '../harness.mjs';
import {
  API, LAB, createEnvironment, createProject, lab, newTenant, registerApplication,
  request, requireApiTest, startRun, waitForRun
} from '../platform.mjs';

const BANK = LAB.banking;
const SINK = process.env.LAB_SINK_URL ?? 'http://localhost:4360';
const CREDENTIALS = { username: 'alice', password: 'Password123!' };
const SIGNING_SECRET = 'a-secret-nobody-should-ever-see-on-the-wire';

const sink = {
  async reset() {
    await fetch(`${SINK}/reset`, { method: 'POST' });
  },
  async received() {
    const response = await fetch(`${SINK}/received`);
    return (await response.json()).received ?? [];
  },
  /** Waits for at least `count` deliveries, or gives up and returns what arrived. */
  async waitFor(count, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const all = await sink.received();
      if (all.length >= count) return all;
      await sleep(500);
    }
    return sink.received();
  }
};

const createIntegration = (tenant, body) =>
  request('/api/v1/integrations', { token: tenant.token, method: 'POST', body });

const deliveries = (tenant, projectId) =>
  request(`/api/v1/integrations/deliveries?projectId=${projectId}`, { token: tenant.token });

export default async function run() {
  suite('Notifications');

  // If the sink is not up, every test below would fail for the same uninformative reason.
  const health = await fetch(`${SINK}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `The notification sink is not answering at ${SINK}. Start it with `
      + '"bash test-lab/scripts/lab-ctl.sh start".');
  }

  await lab.reset(BANK);
  await sink.reset();

  const tenant = await newTenant('Notifications');
  const project = await createProject(tenant, 'Golden notifications');
  const application = await registerApplication(tenant, project.id, {
    name: 'Lab Bank notified', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
  });
  const qa = await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };
  const shared = { projectId: project.id, applicationId: application.id };

  const passing = await requireApiTest(tenant, {
    ...shared, suiteName: 'Notified', name: 'The application answers', tags: 'smoke',
    steps: [{
      description: 'Health check',
      request: { method: 'GET', path: '/health', auth: { mode: 'none' } },
      assertions: [{ type: 'httpStatusEquals', expected: '200' }]
    }]
  });

  const failing = await requireApiTest(tenant, {
    ...shared, suiteName: 'Notified', name: 'The accounts endpoint answers anonymously',
    steps: [{
      description: 'Read the accounts with no credentials',
      request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' } },
      assertions: [{ type: 'httpStatusEquals', expected: '200' }]
    }]
  });

  // ---- NOT-001: a test delivery actually arrives ------------------------
  await golden({
    id: 'NOT-001',
    objective: 'A webhook integration delivers, and the receiver gets a signed, well-formed body',
    preconditions: ['the notification sink is running'],
    input: 'POST /api/v1/integrations/{id}/test',
    expected: 'The sink receives one POST carrying the documented payload, with a signature '
      + 'that verifies against the configured secret',
    evidence: ['delivery.json'],
    severity: 'critical',
    run: async () => {
      await sink.reset();
      const created = await createIntegration(tenant, {
        projectId: project.id, kind: 'webhook', name: 'Sink (NOT-001)',
        settings: { url: `${SINK}/hook?secret=${encodeURIComponent(SIGNING_SECRET)}` },
        credentials: { signingSecret: SIGNING_SECRET }
      });

      if (!created.ok) {
        return { pass: false, detail: `the integration was refused: ${created.status} ${created.text.slice(0, 200)}` };
      }

      const result = await request(`/api/v1/integrations/${created.json.id}/test`, {
        token: tenant.token, method: 'POST'
      });

      const [delivery] = await sink.waitFor(1, 15_000);

      // Cleaned up so it does not receive the runs the later tests start.
      await request(`/api/v1/integrations/${created.json.id}`, { token: tenant.token, method: 'DELETE' });

      return {
        pass: result.json?.delivered === true
          && result.json?.statusCode === 200
          && delivery !== undefined
          && delivery.signatureValid === true
          && delivery.body?.schemaVersion === 1
          && delivery.body?.title === 'QA NXT test notification'
          && delivery.headers['x-qanxt-event'] === 'RunPassed',
        detail: `delivered=${result.json?.delivered} status=${result.json?.statusCode}; `
          + `sink got ${delivery ? 1 : 0} delivery, signature valid: ${delivery?.signatureValid}`,
        evidence: { 'delivery.json': delivery ?? { nothing: 'arrived' } }
      };
    }
  }, context);

  // ---- NOT-002: a failing run tells somebody ----------------------------
  await golden({
    id: 'NOT-002',
    objective: 'A run with failing tests produces a notification naming the failure',
    preconditions: ['a webhook subscribed to the default events'],
    input: 'A run of one passing and one failing test',
    expected: 'One RunFailed delivery carrying the counts and the gate verdict — and the '
      + 'body saying how many failed, not merely that something did',
    evidence: ['delivery.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      await sink.reset();

      const created = await createIntegration(tenant, {
        projectId: project.id, kind: 'webhook', name: 'Sink (NOT-002)',
        settings: { url: `${SINK}/hook` }
      });

      const started = await startRun(tenant, {
        projectId: project.id, testCaseIds: [passing.testCaseId, failing.testCaseId],
        name: 'NOT-002 run', environmentId: qa.id
      });
      await waitForRun(tenant, started.id);

      const all = await sink.waitFor(1, 30_000);
      await request(`/api/v1/integrations/${created.json.id}`, { token: tenant.token, method: 'DELETE' });

      const failure = all.find(delivery => delivery.body?.event === 'RunFailed');

      return {
        pass: failure !== undefined
          && failure.body.facts?.failed === 1
          && failure.body.facts?.passed === 1
          && failure.body.severity === 'Problem'
          && failure.body.run?.id === started.id
          && /failed/i.test(failure.body.title),
        detail: `${all.length} delivery(ies): ${all.map(d => d.body?.event).join(', ')}; `
          + `title "${failure?.body?.title}"; facts ${JSON.stringify(failure?.body?.facts ?? {})}`,
        metrics: { deliveries: all.length },
        evidence: { 'delivery.json': failure ?? { received: all.map(d => d.body?.event) } }
      };
    }
  }, context);

  // ---- NOT-003: a passing run is silent by default ----------------------
  await golden({
    id: 'NOT-003',
    objective: 'A green run sends nothing unless somebody asked for it',
    preconditions: ['a webhook with no explicit event list'],
    input: 'A run in which every test passes',
    expected: 'No delivery at all. A channel that posts every success is one nobody reads '
      + 'by the second week, and the failure they needed scrolls past with it',
    evidence: ['received.json'],
    severity: 'high',
    run: async () => {
      await lab.reset(BANK);
      await sink.reset();

      const created = await createIntegration(tenant, {
        projectId: project.id, kind: 'webhook', name: 'Sink (NOT-003)',
        settings: { url: `${SINK}/hook` }
      });

      const started = await startRun(tenant, {
        projectId: project.id, testCaseIds: [passing.testCaseId],
        name: 'NOT-003 run', environmentId: qa.id
      });
      await waitForRun(tenant, started.id);

      // Long enough that a delivery which was going to happen has happened.
      await sleep(5000);
      const all = await sink.received();
      await request(`/api/v1/integrations/${created.json.id}`, { token: tenant.token, method: 'DELETE' });

      return {
        pass: all.length === 0,
        detail: all.length === 0
          ? 'nothing was sent, as intended'
          : `${all.length} unwanted delivery(ies): ${all.map(d => d.body?.event).join(', ')}`,
        metrics: { deliveries: all.length },
        evidence: { 'received.json': all }
      };
    }
  }, context);

  // ---- NOT-004: opting in to successes works ----------------------------
  await golden({
    id: 'NOT-004',
    objective: 'A team that wants a heartbeat from a green run can have one',
    preconditions: ['a webhook whose events include runPassed'],
    input: 'A run in which every test passes',
    expected: 'A RunPassed delivery — the default is quiet, not incapable',
    evidence: ['delivery.json'],
    severity: 'medium',
    run: async () => {
      await lab.reset(BANK);
      await sink.reset();

      const created = await createIntegration(tenant, {
        projectId: project.id, kind: 'webhook', name: 'Sink (NOT-004)',
        settings: { url: `${SINK}/hook`, events: 'runPassed,runFailed' }
      });

      const started = await startRun(tenant, {
        projectId: project.id, testCaseIds: [passing.testCaseId],
        name: 'NOT-004 run', environmentId: qa.id
      });
      await waitForRun(tenant, started.id);

      const all = await sink.waitFor(1, 30_000);
      await request(`/api/v1/integrations/${created.json.id}`, { token: tenant.token, method: 'DELETE' });

      const passed = all.find(delivery => delivery.body?.event === 'RunPassed');

      return {
        pass: passed !== undefined && passed.body.severity === 'Information',
        detail: `${all.length} delivery(ies): ${all.map(d => d.body?.event).join(', ')}`,
        evidence: { 'delivery.json': passed ?? { received: all.map(d => d.body?.event) } }
      };
    }
  }, context);

  // ---- NOT-005: no secret ever reaches the wire -------------------------
  await golden({
    id: 'NOT-005',
    objective: 'No notification body contains a credential, checked against the bytes sent',
    preconditions: ['an integration with a signing secret, and an application with a password'],
    input: 'Every delivery made during this suite',
    expected: 'The signing secret, the application password and the session token appear '
      + 'nowhere in any body — the signature header is derived from the secret and is not '
      + 'the secret',
    evidence: ['scanned.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      await sink.reset();

      const created = await createIntegration(tenant, {
        projectId: project.id, kind: 'webhook', name: 'Sink (NOT-005)',
        settings: { url: `${SINK}/hook?secret=${encodeURIComponent(SIGNING_SECRET)}` },
        credentials: { signingSecret: SIGNING_SECRET }
      });

      const started = await startRun(tenant, {
        projectId: project.id, testCaseIds: [passing.testCaseId, failing.testCaseId],
        name: 'NOT-005 run', environmentId: qa.id
      });
      await waitForRun(tenant, started.id);
      const all = await sink.waitFor(1, 30_000);
      await request(`/api/v1/integrations/${created.json.id}`, { token: tenant.token, method: 'DELETE' });

      // Everything that must never appear. The token is included because a message
      // carrying one would let whoever holds the webhook URL act as the platform.
      const forbidden = [
        { what: 'the signing secret', value: SIGNING_SECRET },
        { what: "the application's password", value: CREDENTIALS.password },
        { what: 'the session token', value: tenant.token }
      ];

      const findings = [];
      for (const delivery of all) {
        for (const secret of forbidden) {
          if (delivery.bodyText.includes(secret.value)) {
            findings.push({ event: delivery.body?.event, leaked: secret.what });
          }
        }
      }

      const signed = all.filter(delivery => delivery.headers['x-qanxt-signature']);

      return {
        // Deliveries must have happened, or this proves nothing about what they contain.
        pass: all.length > 0 && findings.length === 0 && signed.length === all.length,
        detail: findings.length === 0
          ? `${all.length} delivery(ies) scanned for ${forbidden.length} secret(s): none present; `
            + `${signed.length} signed`
          : `LEAKED: ${JSON.stringify(findings)}`,
        metrics: { scanned: all.length, leaks: findings.length },
        evidence: {
          'scanned.json': {
            deliveries: all.length,
            checkedFor: forbidden.map(secret => secret.what),
            findings,
            bodies: all.map(delivery => delivery.bodyText)
          }
        }
      };
    }
  }, context);

  // ---- NOT-006: a receiver that refuses is recorded, not swallowed ------
  await golden({
    id: 'NOT-006',
    objective: 'A failed delivery is recorded with the reason, and never fails the run',
    preconditions: ['a webhook pointed at an endpoint that answers 500'],
    input: 'A run that would notify',
    expected: 'The run completes normally, and a delivery record says it was not delivered '
      + 'and why — a notification that silently fails is worse than none, because the team '
      + 'has stopped watching the thing it was supposed to watch for them',
    evidence: ['deliveries.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      await sink.reset();

      const created = await createIntegration(tenant, {
        projectId: project.id, kind: 'webhook', name: 'Sink (NOT-006)',
        settings: { url: `${SINK}/hook/500` }
      });

      const started = await startRun(tenant, {
        projectId: project.id, testCaseIds: [failing.testCaseId],
        name: 'NOT-006 run', environmentId: qa.id
      });
      const finished = await waitForRun(tenant, started.id);

      await sleep(3000);
      const { json: records } = await deliveries(tenant, project.id);
      await request(`/api/v1/integrations/${created.json.id}`, { token: tenant.token, method: 'DELETE' });

      const mine = (records ?? []).filter(record => record.testRunId === started.id);
      const failedDelivery = mine.find(record => record.delivered === false);

      return {
        // The run is the important half: a broken webhook must not turn a finished run
        // into an errored one.
        pass: finished?.status === 'failed'
          && failedDelivery !== undefined
          && failedDelivery.statusCode === 500
          && (failedDelivery.detail ?? '').includes('500'),
        detail: `run ended "${finished?.status}"; ${mine.length} delivery record(s); `
          + `failed record: status ${failedDelivery?.statusCode}, "${failedDelivery?.detail}"`,
        evidence: { 'deliveries.json': mine }
      };
    }
  }, context);

  // ---- NOT-007: a credential in settings is refused ---------------------
  await golden({
    id: 'NOT-007',
    objective: 'A credential submitted as a readable setting is refused, not quietly stored',
    preconditions: ['none'],
    input: 'Integrations with signingSecret, apiKey and webhookUrl in settings',
    expected: 'Each refused with a message saying where it belongs — settings are returned '
      + 'to anyone with read permission, so a secret there is readable by every viewer',
    evidence: ['refusals.json'],
    severity: 'critical',
    run: async () => {
      const cases = [
        { settings: { url: `${SINK}/hook`, signingSecret: 'oops' }, because: 'a signing secret' },
        { settings: { url: `${SINK}/hook`, apiKey: 'oops' }, because: 'an api key' },
        { settings: { webhookUrl: `${SINK}/hook` }, because: 'a Slack webhook URL' },
        { settings: { url: `${SINK}/hook` }, because: 'nothing sensitive', shouldSucceed: true }
      ];

      const refusals = [];
      for (const testCase of cases) {
        const response = await createIntegration(tenant, {
          projectId: project.id, kind: 'webhook',
          name: `NOT-007 ${testCase.because}`, settings: testCase.settings
        });
        refusals.push({
          because: testCase.because,
          status: response.status,
          message: response.json?.title ?? response.text?.slice(0, 200)
        });
        if (response.ok && response.json?.id) {
          await request(`/api/v1/integrations/${response.json.id}`, { token: tenant.token, method: 'DELETE' });
        }
      }

      const bad = refusals.filter(refusal => refusal.because !== 'nothing sensitive');
      const good = refusals.find(refusal => refusal.because === 'nothing sensitive');

      return {
        pass: bad.every(refusal => refusal.status === 400 && /credential/i.test(refusal.message ?? ''))
          && good?.status === 201,
        detail: `${bad.filter(r => r.status === 400).length}/${bad.length} refused; `
          + `the harmless one returned ${good?.status}`,
        evidence: { 'refusals.json': refusals }
      };
    }
  }, context);

  // ---- NOT-008: an outbound webhook is not an SSRF primitive ------------
  await golden({
    id: 'NOT-008',
    objective: 'A webhook cannot be pointed at cloud metadata',
    preconditions: ['none'],
    input: 'A delivery to http://169.254.169.254/latest/meta-data/',
    expected: 'Refused by the target policy before any request is made. "Configure a '
      + 'webhook" must not mean "ask QA NXT to fetch a URL for you and tell you what it said"',
    evidence: ['result.json'],
    severity: 'critical',
    run: async () => {
      const created = await createIntegration(tenant, {
        projectId: project.id, kind: 'webhook', name: 'Metadata (NOT-008)',
        settings: { url: 'http://169.254.169.254/latest/meta-data/' }
      });

      if (!created.ok) {
        // Refusing at configuration time is also a correct answer.
        return {
          pass: created.status === 400 || created.status === 403,
          detail: `refused at creation: ${created.status} ${created.json?.title ?? ''}`,
          evidence: { 'result.json': { stage: 'create', status: created.status, body: created.json } }
        };
      }

      const result = await request(`/api/v1/integrations/${created.json.id}/test`, {
        token: tenant.token, method: 'POST'
      });
      await request(`/api/v1/integrations/${created.json.id}`, { token: tenant.token, method: 'DELETE' });

      return {
        pass: result.json?.delivered === false
          && /refused|not permitted|metadata|link-local|private/i.test(result.json?.detail ?? ''),
        detail: `delivered=${result.json?.delivered}; "${result.json?.detail}"`,
        evidence: { 'result.json': result.json }
      };
    }
  }, context);
}
