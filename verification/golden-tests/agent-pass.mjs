/**
 * Driving a real autonomous pass, and keeping everything it recorded.
 *
 * An agent pass is expensive — it crawls, plans, generates, waits on a scan and runs tests —
 * so the suites do not start one per assertion. They start a small number of real passes and
 * then make many distinct claims about what each one recorded.
 *
 * That is not a shortcut. The expensive part is the pass; the claims are the point. Each
 * golden test still declares its own objective, expectation and evidence, and each fails on
 * its own. What they share is the run they interrogate, the way a set of tests about one
 * deployment share the deployment.
 *
 * Nothing here simulates the agent. If the background runner is not going, these time out,
 * which is the correct outcome: a suite that passes without the thing under test running is
 * the failure mode this whole project exists to object to.
 */
import { request, createEnvironment, createProject, newTenant, registerApplication, runDiscovery }
  from './platform.mjs';
import { sleep } from './harness.mjs';

/** A pass has to crawl, plan, scan and run. None of that is quick. */
const SETTLE_TIMEOUT_MS = 420_000;

/** States from which nothing further happens without somebody doing something. */
const SETTLED = ['completed', 'failed', 'stopped', 'cancelled', 'awaitingApproval'];
const FINISHED = ['completed', 'failed', 'stopped', 'cancelled'];

export const agentRun = (tenant, runId) =>
  request(`/api/v1/agent/runs/${runId}`, { token: tenant.token });

export const agentPlan = (tenant, runId) =>
  request(`/api/v1/agent/runs/${runId}/plan`, { token: tenant.token });

export const agentDecisions = (tenant, runId) =>
  request(`/api/v1/agent/runs/${runId}/decisions`, { token: tenant.token });

export const agentApprovals = (tenant, runId) =>
  request(`/api/v1/agent/runs/${runId}/approvals`, { token: tenant.token });

export const agentTimeline = (tenant, runId) =>
  request(`/api/v1/agent/runs/${runId}/timeline`, { token: tenant.token });

export const setContext = (tenant, applicationId, body) =>
  request(`/api/v1/agent/applications/${applicationId}/context`, {
    token: tenant.token, method: 'PUT', body
  });

export const authorizeSecurity = (tenant, applicationId, overrides = {}) =>
  request(`/api/v1/security/applications/${applicationId}/scope`, {
    token: tenant.token, method: 'PUT',
    body: {
      enabled: true,
      authorizationNote: 'Authorized for the golden test lab. Ticket AQ-19.',
      allowedDomains: '127.0.0.1,localhost',
      allowedApiDomains: '127.0.0.1,localhost',
      allowedPaths: null, blockedPaths: null, environmentId: null,
      maxRequestsPerSecond: 20, maxConcurrentRequests: 2, maxScanDurationMinutes: 5,
      allowActiveTesting: true, allowDestructiveTesting: false, allowProduction: false,
      ...overrides
    }
  });

export const decidePlan = (tenant, runId, body) =>
  request(`/api/v1/agent/runs/${runId}/plan/decision`, {
    token: tenant.token, method: 'POST', body
  });

export const decideApproval = (tenant, approvalId, body) =>
  request(`/api/v1/agent/approvals/${approvalId}/decision`, {
    token: tenant.token, method: 'POST', body
  });

/** Waits until the pass is in a state that needs somebody, or is over. */
export async function settle(tenant, runId, { finished = false, timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
  const wanted = finished ? FINISHED : SETTLED;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const poll = await agentRun(tenant, runId);
    last = poll.json?.summary ?? poll.json ?? last;
    if (wanted.includes(String(last?.status))) return last;
    await sleep(3000);
  }
  return last;
}

/**
 * Seeds a workspace the agent can work in.
 *
 * An environment is registered deliberately. Without one the policy engine reads the
 * environment as unknown and refuses everything that writes — correct behaviour, and it would
 * make every execution assertion in these suites measure the refusal instead of the thing.
 */
export async function seedWorkspace(label, baseUrl, {
  credentials = { username: 'alice', password: 'Password123!' },
  context = null, security = true, environmentKind = 'qa'
} = {}) {
  const tenant = await newTenant(label);
  const project = await createProject(tenant, `${label} project`);
  const application = await registerApplication(tenant, project.id, {
    name: `${label} application`, baseUrl, loginUrl: `${baseUrl}/login`, ...credentials
  });
  const environment = await createEnvironment(tenant, project.id, {
    name: `${label} ${environmentKind}`, key: environmentKind, kind: environmentKind,
    baseUrl, apiBaseUrl: baseUrl
  });

  const discovery = await runDiscovery(tenant, application.id, { timeoutMs: 300_000 });
  if (context) await setContext(tenant, application.id, context);
  if (security) await authorizeSecurity(tenant, application.id);

  return { tenant, project, application, environment, discovery };
}

/** Starts a pass and returns once it has settled. */
export async function startPass(tenant, applicationId, overrides = {}) {
  const started = await request('/api/v1/agent/runs', {
    token: tenant.token, method: 'POST',
    body: {
      applicationId, name: 'Golden autonomous pass', objective: 'Release validation',
      explore: false, execute: true,
      maxPages: 8, maxTargets: 3, maxGeneratedTests: 6, timeBudgetSeconds: 900,
      ...overrides
    }
  });
  if (!started.ok) throw new Error(`the pass would not start: ${started.status} ${started.text.slice(0, 300)}`);
  const summary = await settle(tenant, started.json.id);
  return { runId: started.json.id, summary };
}

/**
 * Answers every question a pass asks until it finishes, and keeps a record of each answer.
 *
 * Bounded, because a pass that keeps asking is a defect rather than something to wait out.
 */
export async function answerEverything(tenant, runId, { grant = true, rounds = 6 } = {}) {
  const answered = [];
  let summary = await settle(tenant, runId);

  for (let round = 0; round < rounds; round++) {
    if (FINISHED.includes(String(summary?.status))) break;

    const approvals = await agentApprovals(tenant, runId);
    const pending = (approvals.json ?? []).filter(a => a.status === 'pending');
    if (pending.length === 0) break;

    for (const approval of pending) {
      const response = await decideApproval(tenant, approval.id, {
        grant,
        justification: grant
          ? 'Authorized for the golden test lab, which exists to be tested.'
          : 'Refused by the golden suite to exercise the refusal path.'
      });
      answered.push({ tool: approval.tool, status: response.status, granted: grant });
    }
    summary = await settle(tenant, runId);
  }

  return { summary, answered };
}

/** Everything one pass left behind, read once so the assertions do not re-fetch it. */
export async function collect(tenant, runId) {
  const [run, plan, decisions, approvals, timeline] = await Promise.all([
    agentRun(tenant, runId), agentPlan(tenant, runId), agentDecisions(tenant, runId),
    agentApprovals(tenant, runId), agentTimeline(tenant, runId)
  ]);

  return {
    runId,
    summary: run.json?.summary ?? null,
    bounds: run.json?.bounds ?? null,
    steps: run.json?.steps ?? [],
    findings: run.json?.findings ?? [],
    plan: plan.ok ? plan.json : null,
    planStatus: plan.status,
    decisions: decisions.json ?? [],
    approvals: approvals.json ?? [],
    timeline: timeline.json ?? []
  };
}

/** A decision by the tool it used, or null. */
export const decisionFor = (pass, tool) =>
  pass.decisions.find(d => d.tool === tool) ?? null;

/** Every decision for a tool, because a pass may use one more than once. */
export const decisionsFor = (pass, tool) =>
  pass.decisions.filter(d => d.tool === tool);

/** The value of one named piece of evidence on a decision. */
export const evidenceValue = (decision, name) =>
  decision?.evidence?.find(e => e.name === name)?.value ?? null;
