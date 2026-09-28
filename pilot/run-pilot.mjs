#!/usr/bin/env node
/**
 * The real-world pilot: QA NXT's autonomous agent against Verdaccio.
 *
 * Verdaccio is a private npm registry — a Vue front end over an Express API, written by
 * people who have never heard of QA NXT, with its own routes, its own login and its own
 * conventions. That is the point. Every application the platform has been tested against so
 * far was written alongside it, which is the right way to build a test platform and tells you
 * nothing about how it behaves on somebody else's code.
 *
 * What this script does, and does not:
 *
 *   - It onboards a real third-party application, runs discovery, records what a person knows
 *     about it, and drives one bounded autonomous pass end to end, answering its questions.
 *   - It then writes down what the pass actually established, with the numbers it produced.
 *   - It does not decide whether the pass did well. That judgement is in the pilot report,
 *     next to the things the pass got wrong, and nothing here is tuned to flatter it.
 *
 * The registry runs locally with no uplink, holds three packages published for this purpose,
 * and is not production. Authorization for testing it is exactly that: it is ours, it is
 * disposable, and the security scope is written to loopback only.
 *
 * Usage: node pilot/run-pilot.mjs [--base http://localhost:4873] [--out pilot/pilot-run.json]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  newTenant, createProject, createEnvironment, runDiscovery, request
} from '../verification/golden-tests/platform.mjs';
import {
  agentApprovals, agentDecisions, agentPlan, agentRun, agentTimeline, authorizeSecurity,
  decideApproval, decidePlan, setContext, settle
} from '../verification/golden-tests/agent-pass.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const BASE = arg('--base', 'http://localhost:4873');
const OUT = resolve(process.cwd(), arg('--out', 'pilot/pilot-run.json'));

const log = message => console.log(`\u001b[2m${new Date().toISOString().slice(11, 19)}\u001b[0m ${message}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Onboarding, exactly as a team would
// ---------------------------------------------------------------------------

log(`Pilot target: ${BASE}`);
const reachable = await fetch(BASE).then(r => r.status, () => null);
if (reachable === null) {
  console.error(`\nThe pilot registry is not answering on ${BASE}.`);
  console.error('Start it first:  cd /home/user/verdaccio-pilot && node_modules/.bin/verdaccio --config conf/config.yaml');
  process.exit(2);
}
log(`Registry answered ${reachable}.`);

const tenant = await newTenant('Pilot');
const project = await createProject(tenant, 'Verdaccio pilot');
log(`Tenant and project created (${project.id}).`);

// Verdaccio's own login lives on the header of the web UI rather than on a /login route, and
// the pilot deliberately does not hand the agent credentials. An unauthenticated pass is the
// honest starting point for an application nobody has onboarded before: whatever it reaches,
// it reaches as an anonymous visitor.
// Registered through the API directly rather than through the golden harness's helper,
// because that helper labels everything "Test lab application" — and the one thing this
// record must not say is that Verdaccio is part of the lab.
const registered = await request('/api/v1/applications', {
  token: tenant.token, method: 'POST',
  body: {
    projectId: project.id, name: 'Verdaccio', baseUrl: BASE,
    description: 'Verdaccio 6.10.4 — an independently developed private npm registry, '
               + 'run locally for this pilot. Not written for QA NXT and not part of the test lab.',
    allowedDomains: new URL(BASE).hostname,
    maxPages: 25, maxCrawlDepth: 3, explorationTimeoutSeconds: 240,
    // No credentials. An application nobody has onboarded before starts as an anonymous
    // visitor sees it, and what the agent cannot reach that way is a finding about the
    // pilot rather than something to work around.
    authStrategy: 'none', loginUrl: null, credentials: null
  }
});
if (!registered.ok) {
  console.error(`Could not register the application: ${registered.status} ${registered.text.slice(0, 400)}`);
  process.exit(1);
}
const application = registered.json;
log(`Application registered (${application.id}).`);

const environment = await createEnvironment(tenant, project.id, {
  name: 'Verdaccio pilot', key: 'pilot', kind: 'qa', baseUrl: BASE, apiBaseUrl: BASE
});
log(`Environment registered as qa (${environment.id}).`);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

log('Running discovery. This drives a real browser over a real application.');
const discovery = await runDiscovery(tenant, application.id, { maxPages: 25, maxDepth: 3, timeoutMs: 420_000 });
const [pages, endpoints] = await Promise.all([
  request(`/api/v1/applications/${application.id}/pages`, { token: tenant.token }),
  request(`/api/v1/applications/${application.id}/api-endpoints`, { token: tenant.token })
]);
log(`Discovery found ${(pages.json ?? []).length} page(s) and ${(endpoints.json ?? []).length} endpoint(s).`);

// ---------------------------------------------------------------------------
// What a person knows that the crawl cannot
// ---------------------------------------------------------------------------

await setContext(tenant, application.id, {
  criticalJourneys: 'search for a package\nread a package page',
  highRiskAreas: 'login',
  // Publishing writes to disk and changes the registry's contents. Excluded rather than
  // trusted to the policy engine: the exclusion is a person's statement, and it is the one
  // instruction in this pilot that nothing is allowed to outvote.
  excludedAreas: '/-/verdaccio/sec\n/-/npm/v1/tokens',
  notes: 'A private npm registry run locally for this pilot. No uplink; three packages.'
});
log('Business context recorded.');

await authorizeSecurity(tenant, application.id, {
  authorizationNote: 'Authorized for the QA NXT pilot. Local, disposable registry owned by us.',
  allowedDomains: '127.0.0.1,localhost',
  allowedApiDomains: '127.0.0.1,localhost',
  allowActiveTesting: true, allowDestructiveTesting: false, allowProduction: false,
  maxRequestsPerSecond: 10, maxConcurrentRequests: 2, maxScanDurationMinutes: 5
});
log('Security scope authorized for loopback only.');

// ---------------------------------------------------------------------------
// One bounded pass, with its questions answered
// ---------------------------------------------------------------------------

const started = await request('/api/v1/agent/runs', {
  token: tenant.token, method: 'POST',
  body: {
    applicationId: application.id,
    name: 'Verdaccio pilot pass',
    objective: 'Find out what this registry does and what nothing covers.',
    buildRef: `verdaccio-6.10.4`,
    explore: false, execute: true,
    maxPages: 20, maxTargets: 5, maxGeneratedTests: 12, timeBudgetSeconds: 900
  }
});
if (!started.ok) {
  console.error(`The pass would not start: ${started.status} ${started.text.slice(0, 400)}`);
  process.exit(1);
}
const runId = started.json.id;
log(`Pass ${runId} queued.`);

const answers = [];
let summary = await settle(tenant, runId);

// The plan comes first and is a proposal. Approving it here is a person's decision recorded
// as one — the pilot is not testing whether the agent can proceed without anybody.
if (summary?.status === 'awaitingApproval') {
  const plan = await agentPlan(tenant, runId);
  if (plan.ok && plan.json?.status === 'proposed') {
    log(`Plan proposed: ${plan.json.summary?.slice(0, 120)}`);
    await decidePlan(tenant, runId, { approve: true, note: 'Approved for the pilot; the registry is ours and disposable.' });
    answers.push({ kind: 'plan', note: 'approved' });
    summary = await settle(tenant, runId);
  }
}

for (let round = 0; round < 8; round++) {
  if (!['awaitingApproval', 'queued', 'running'].includes(String(summary?.status))) break;
  const approvals = await agentApprovals(tenant, runId);
  const pending = (approvals.json ?? []).filter(a => a.status === 'pending');
  if (pending.length === 0) {
    if (summary?.status === 'awaitingApproval') { await sleep(3000); summary = await settle(tenant, runId); continue; }
    break;
  }
  for (const approval of pending) {
    log(`Question: ${approval.tool} — ${String(approval.proposedAction ?? '').slice(0, 100)}`);
    const response = await decideApproval(tenant, approval.id, {
      grant: true,
      justification: 'Granted for the pilot. The registry is local, disposable and owned by us.'
    });
    answers.push({ kind: 'approval', tool: approval.tool, status: response.status });
  }
  summary = await settle(tenant, runId);
}

summary = await settle(tenant, runId, { finished: true, timeoutMs: 600_000 });
log(`Pass finished: ${summary?.status} / ${summary?.phase}`);

// ---------------------------------------------------------------------------
// What it established
// ---------------------------------------------------------------------------

const [detail, plan, decisions, approvals, timeline] = await Promise.all([
  agentRun(tenant, runId), agentPlan(tenant, runId), agentDecisions(tenant, runId),
  agentApprovals(tenant, runId), agentTimeline(tenant, runId)
]);

const release = await request(
  `/api/v1/release/quality?projectId=${project.id}&build=verdaccio-6.10.4`, { token: tenant.token });

const testRun = summary?.testRunId
  ? await request(`/api/v1/testruns/${summary.testRunId}`, { token: tenant.token })
  : null;

const record = {
  target: { baseUrl: BASE, product: 'Verdaccio', version: '6.10.4',
            note: 'Independently developed. Run locally with no uplink for this pilot.' },
  ranAt: new Date().toISOString(),
  applicationId: application.id, projectId: project.id, agentRunId: runId,
  discovery: {
    discoveryRunId: discovery?.id ?? null,
    pages: (pages.json ?? []).map(p => ({ route: p.route, title: p.title, kind: p.kind })),
    endpoints: (endpoints.json ?? []).map(e => ({ method: e.method, urlTemplate: e.urlTemplate }))
  },
  answers,
  summary: detail.json?.summary ?? summary,
  bounds: detail.json?.bounds ?? null,
  steps: detail.json?.steps ?? [],
  findings: detail.json?.findings ?? [],
  plan: plan.ok ? plan.json : { status: plan.status },
  decisions: decisions.json ?? [],
  approvals: approvals.json ?? [],
  timeline: timeline.json ?? [],
  testRun: testRun?.ok ? testRun.json : { status: testRun?.status ?? null },
  release: release.ok ? release.json : { status: release.status }
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);

console.log('');
console.log(`  Pages discovered:     ${record.discovery.pages.length}`);
console.log(`  Endpoints discovered: ${record.discovery.endpoints.length}`);
console.log(`  Phases recorded:      ${record.steps.length}`);
console.log(`  Decisions recorded:   ${record.decisions.length}`);
console.log(`  Questions asked:      ${record.approvals.length}`);
console.log(`  Tests generated:      ${record.summary?.testsGenerated ?? 0}`);
console.log(`  Tests executed:       ${record.summary?.testsExecuted ?? 0}`);
console.log(`  Proposals made:       ${record.summary?.proposalsMade ?? 0}`);
console.log(`  Model spend:          $${record.summary?.aiCostUsd ?? 0}`);
console.log(`  Stopped because:      ${String(record.summary?.stopReason ?? '').slice(0, 140)}`);
console.log('');
console.log(`  Written to ${OUT}`);
console.log('');
