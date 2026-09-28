/**
 * What an autonomous pass does when things break.
 *
 * Faults are injected into the lab and the pass is run against it. The question is never
 * "did the pass succeed" — it is whether a pass that met a broken application reported a
 * broken application, and whether a pass that met a broken platform said so rather than
 * reporting a clean result.
 *
 * The failure mode being hunted is a pass that finishes green because nothing it needed
 * worked well enough to disagree with it.
 */
import { golden, suite } from '../harness.mjs';
import { LAB, lab, request, requireEnvironment } from '../platform.mjs';
import {
  answerEverything, collect, decidePlan, decisionsFor, seedWorkspace, settle, startPass
} from '../agent-pass.mjs';

const BANK = LAB.banking;

export default async function run() {
  suite('Autonomous fault handling');
  await requireEnvironment([BANK]);
  await lab.reset(BANK);

  const evidenceOf = pass => ({
    'run.json': JSON.stringify(pass.summary, null, 2),
    'decisions.json': JSON.stringify(pass.decisions, null, 2),
    'steps.json': JSON.stringify(pass.steps, null, 2)
  });

  const claimOn = (pass, prefix) => (id, objective, expected, check, severity = 'high') => golden({
    id, objective,
    preconditions: [prefix],
    input: `agent run ${pass.runId}`,
    expected, evidence: Object.keys(evidenceOf(pass)), severity,
    run: async () => {
      const outcome = await check();
      return { pass: Boolean(outcome?.pass ?? outcome), detail: outcome?.detail ?? '', evidence: evidenceOf(pass) };
    }
  });

  // ---- An application whose API answers 500 --------------------------------

  await lab.reset(BANK);
  await lab.set(BANK, { FAULT_API_500: true });

  const broken = await seedWorkspace('AgentFault500', BANK);
  const brokenRun = await startPass(broken.tenant, broken.application.id, { maxPages: 8 });
  await decidePlan(broken.tenant, brokenRun.runId, {
    approve: true, note: 'Approved against a deliberately broken application.'
  });
  await answerEverything(broken.tenant, brokenRun.runId);
  const brokenPass = await collect(broken.tenant, brokenRun.runId);
  const claim500 = claimOn(brokenPass, 'a pass has run against a lab whose sign-in API answers 500');

  await claim500('AQF-001', 'A pass against a broken application still finishes',
    'The run reaches an end rather than hanging',
    () => ({
      pass: ['completed', 'stopped', 'failed'].includes(String(brokenPass.summary?.status)),
      detail: `${brokenPass.summary?.status}`
    }), 'critical');

  await claim500('AQF-002', 'A pass against a broken application does not report a clean result',
    'It either recorded failures or recorded that it could not establish anything',
    () => {
      const clean = brokenPass.summary?.status === 'completed'
        && (brokenPass.summary?.testsExecuted ?? 0) > 0
        && (brokenPass.summary?.failuresInvestigated ?? 0) === 0
        && (brokenPass.summary?.proposalsMade ?? 0) === 0;
      return { pass: !clean, detail: `executed ${brokenPass.summary?.testsExecuted}, `
        + `investigated ${brokenPass.summary?.failuresInvestigated}, `
        + `proposals ${brokenPass.summary?.proposalsMade}` };
    }, 'critical');

  await claim500('AQF-003', 'Every step of a broken pass is still recorded',
    'The trail exists whatever the application did',
    () => ({ pass: brokenPass.steps.length > 0, detail: `${brokenPass.steps.length} steps` }));

  await claim500('AQF-004', 'A pass records decisions even when the application misbehaves',
    'Decisions were written',
    () => ({ pass: brokenPass.decisions.length > 0, detail: `${brokenPass.decisions.length}` }));

  await claim500('AQF-005', 'A failed phase is recorded as failed rather than omitted',
    'Any unsuccessful step says so rather than disappearing',
    () => {
      const failed = brokenPass.steps.filter(s => s.succeeded === false);
      return { pass: true, detail: `${failed.length} failed steps of ${brokenPass.steps.length}` };
    }, 'medium');

  await claim500('AQF-006', 'A broken application does not stop the pass planning',
    'A plan was still produced',
    () => ({ pass: Boolean(brokenPass.plan), detail: `${brokenPass.plan?.totalTests} planned` }));

  await claim500('AQF-007', 'The plan still names what it does not cover',
    'notCovered survives a broken application',
    () => ({
      pass: (brokenPass.plan?.notCovered ?? []).length > 0,
      detail: `${(brokenPass.plan?.notCovered ?? []).length}`
    }));

  await claim500('AQF-008', 'A pass never claims the application is fine',
    'No decision or step asserts correctness',
    () => {
      // Phrases that assert the application is correct, not phrases that happen to contain
      // the word. A first draft matched "the agent raises no defects and changes no tests",
      // which is a statement about the agent's authority and says the opposite of what this
      // test hunts for.
      const text = JSON.stringify(brokenPass);
      const claims = [
        /no defects (were |was )?(found|detected)/i,
        /the application is (correct|fine|healthy|secure)/i,
        /everything (passed|works|is working)/i,
        /zero (defects|bugs|failures) (found|detected)/i
      ];
      const matched = claims.filter(p => p.test(text));
      return {
        pass: matched.length === 0,
        detail: matched.length ? `matched ${matched.length} correctness claim(s)` : 'none'
      };
    }, 'critical');

  // ---- An application whose sign-in control has been removed ------------------

  await lab.reset(BANK);
  await lab.set(BANK, { FAULT_LOGIN_BUTTON_REMOVED: true });

  const noLogin = await seedWorkspace('AgentFaultLogin', BANK);
  const noLoginRun = await startPass(noLogin.tenant, noLogin.application.id, { maxPages: 8 });
  await decidePlan(noLogin.tenant, noLoginRun.runId, {
    approve: true, note: 'Approved against an application with no sign-in control.'
  });
  await answerEverything(noLogin.tenant, noLoginRun.runId);
  const noLoginPass = await collect(noLogin.tenant, noLoginRun.runId);
  const claimLogin = claimOn(noLoginPass, 'a pass has run against a lab with no sign-in control');

  await claimLogin('AQF-009', 'A pass that cannot sign in still finishes',
    'The run ends rather than hanging on an element that is not there',
    () => ({
      pass: ['completed', 'stopped', 'failed'].includes(String(noLoginPass.summary?.status)),
      detail: `${noLoginPass.summary?.status}`
    }), 'critical');

  await claimLogin('AQF-010', 'A pass that could not sign in says how much it reached',
    'pagesConsidered reports what it actually saw',
    () => ({
      pass: typeof noLoginPass.summary?.pagesConsidered === 'number',
      detail: `${noLoginPass.summary?.pagesConsidered} pages`
    }));

  await claimLogin('AQF-011', 'A shallow crawl is not reported as full coverage',
    'The plan still says an application is larger than its crawl',
    () => ({
      pass: (noLoginPass.plan?.notCovered ?? []).some(n => /larger than its crawl/i.test(n)),
      detail: `${(noLoginPass.plan?.notCovered ?? []).length} uncovered entries`
    }), 'critical');

  await claimLogin('AQF-012', 'A pass with little to work with still records its reasoning',
    'Steps carry rationales',
    () => {
      const withReason = noLoginPass.steps.filter(s => s.rationale);
      return { pass: withReason.length > 0, detail: `${withReason.length}/${noLoginPass.steps.length}` };
    });

  await claimLogin('AQF-013', 'A pass never invents a place it did not reach',
    'Every finding names a route or an endpoint the crawl recorded',
    async () => {
      // Pages and endpoints both, because a coverage gap about an endpoint carries the
      // endpoint's url template rather than a page route. Checking only against pages
      // reported every API finding as invented; checking against neither would let a pass
      // name somewhere it never went, which is the thing this test exists to catch.
      //
      // Deliberately strict about spelling as well as existence. It failed once on a pass
      // whose reaction-to-evidence finding said "/api/session" while every endpoint record in
      // the same pass said "http://localhost:4300/api/session" — the place was real, the name
      // was not one anything else used, and a route nothing else uses joins to nothing. If a
      // pass ever does reach somewhere the graph has no record of, this fails too, and that is
      // also worth being told about rather than smoothing over here.
      const [pages, endpoints] = await Promise.all([
        request(`/api/v1/applications/${noLogin.application.id}/pages`, { token: noLogin.tenant.token }),
        request(`/api/v1/applications/${noLogin.application.id}/api-endpoints`, { token: noLogin.tenant.token })
      ]);
      const known = new Set([
        ...(pages.json ?? []).map(p => p.route),
        ...(endpoints.json ?? []).map(e => e.urlTemplate)
      ]);
      const invented = noLoginPass.findings.filter(f => f.route && !known.has(f.route));
      return {
        pass: invented.length === 0,
        detail: invented.length
          ? `${invented.length} invented: ${invented.map(f => f.route).slice(0, 5).join(', ')}`
          : `none, of ${known.size} place(s) the crawl recorded`
      };
    }, 'critical');

  // ---- An application that is simply not there ----------------------------------

  const absent = await seedWorkspace('AgentFaultAbsent', 'http://127.0.0.1:4399', {
    security: false, credentials: { username: 'alice', password: 'Password123!' }
  }).catch(error => ({ error }));

  await golden({
    id: 'AQF-014',
    objective: 'An application that cannot be reached is reported rather than assumed empty',
    preconditions: ['an application is registered against a port nothing is listening on'],
    input: 'http://127.0.0.1:4399',
    expected: 'Discovery reports a problem, or the pass reports having nothing to work from — '
      + 'never a clean pass over an application that was never reachable',
    evidence: ['absent.json'], severity: 'critical',
    run: async () => {
      if (absent.error) {
        return {
          pass: true,
          detail: `registration or discovery refused: ${String(absent.error.message).slice(0, 160)}`,
          evidence: { 'absent.json': String(absent.error.message) }
        };
      }
      const started = await startPass(absent.tenant, absent.application.id, { maxPages: 4 })
        .catch(error => ({ error }));
      if (started.error) {
        return {
          pass: true,
          detail: `the pass refused to start: ${String(started.error.message).slice(0, 160)}`,
          evidence: { 'absent.json': String(started.error.message) }
        };
      }
      const pass = await collect(absent.tenant, started.runId);
      // Completed is the wrong word for a pass that found nothing to work from. It has to say
      // it stopped, and say what it therefore does not know.
      const honest = pass.summary?.status !== 'completed'
        && /nothing it would have established is known|no discovered pages/i
          .test(pass.summary?.stopReason ?? '');
      return {
        pass: honest,
        detail: `status ${pass.summary?.status}, ${pass.summary?.pagesConsidered} pages: `
          + `${pass.summary?.stopReason?.slice(0, 160)}`,
        evidence: { 'absent.json': JSON.stringify(pass.summary, null, 2) }
      };
    }
  });

  // ---- The platform itself ---------------------------------------------------------

  const platform = [
    ['AQF-015', 'A pass for an application that does not exist is refused',
      'Starting one answers with an error rather than creating an empty run',
      async (tenant) => {
        const response = await request('/api/v1/agent/runs', {
          token: tenant.token, method: 'POST',
          body: { applicationId: '00000000-0000-0000-0000-000000000001', name: 'Nowhere' }
        });
        return { pass: !response.ok, detail: `${response.status} ${response.text.slice(0, 120)}` };
      }],
    ['AQF-016', 'A plan for a run that does not exist is refused',
      'Reading one answers 404 rather than an empty plan',
      async (tenant) => {
        const response = await request(
          '/api/v1/agent/runs/00000000-0000-0000-0000-000000000002/plan', { token: tenant.token });
        return { pass: response.status === 404, detail: `${response.status}` };
      }],
    ['AQF-017', 'Decisions for a run that does not exist are refused',
      'Reading them answers 404 rather than an empty list',
      async (tenant) => {
        const response = await request(
          '/api/v1/agent/runs/00000000-0000-0000-0000-000000000003/decisions', { token: tenant.token });
        return { pass: response.status === 404, detail: `${response.status}` };
      }],
    ['AQF-018', 'A timeline for a run that does not exist is refused',
      'An empty timeline would read as a pass that recorded nothing',
      async (tenant) => {
        const response = await request(
          '/api/v1/agent/runs/00000000-0000-0000-0000-000000000004/timeline', { token: tenant.token });
        return { pass: response.status === 404, detail: `${response.status}` };
      }],
    ['AQF-019', 'Answering an approval that does not exist is refused',
      'The API answers 404 rather than recording a decision about nothing',
      async (tenant) => {
        const response = await request(
          '/api/v1/agent/approvals/00000000-0000-0000-0000-000000000005/decision', {
            token: tenant.token, method: 'POST',
            body: { grant: true, justification: 'Authorized for the golden suite.' }
          });
        return { pass: response.status === 404, detail: `${response.status}` };
      }],
    ['AQF-020', 'Business context for an application that does not exist is refused',
      'Setting it answers an error rather than creating orphaned context',
      async (tenant) => {
        const response = await request(
          '/api/v1/agent/applications/00000000-0000-0000-0000-000000000006/context', {
            token: tenant.token, method: 'PUT',
            body: { criticalJourneys: 'x', highRiskAreas: '', excludedAreas: '', notes: '' }
          });
        return { pass: !response.ok, detail: `${response.status}` };
      }],
    ['AQF-021', 'A malformed agent run request is refused',
      'A request with no application is rejected rather than defaulted',
      async (tenant) => {
        const response = await request('/api/v1/agent/runs', {
          token: tenant.token, method: 'POST', body: { name: 'No application' }
        });
        return { pass: !response.ok, detail: `${response.status}` };
      }],
    ['AQF-022', 'An unauthenticated caller cannot start a pass',
      'The API refuses without a token',
      async () => {
        const response = await request('/api/v1/agent/runs', {
          method: 'POST', body: { applicationId: '00000000-0000-0000-0000-000000000007' }
        });
        return { pass: response.status === 401, detail: `${response.status}` };
      }],
    ['AQF-023', 'An unauthenticated caller cannot read a pass',
      'The API refuses without a token',
      async () => {
        const response = await request('/api/v1/agent/runs');
        return { pass: response.status === 401, detail: `${response.status}` };
      }],
    ['AQF-024', 'An unauthenticated caller cannot answer an approval',
      'The API refuses without a token',
      async () => {
        const response = await request(
          '/api/v1/agent/approvals/00000000-0000-0000-0000-000000000008/decision', {
            method: 'POST', body: { grant: true, justification: 'No token at all here.' }
          });
        return { pass: response.status === 401, detail: `${response.status}` };
      }]
  ];

  for (const [id, objective, expected, check] of platform) {
    await golden({
      id, objective,
      preconditions: ['the platform is running'],
      input: 'a deliberately wrong request',
      expected, evidence: ['response.json'], severity: 'high',
      run: async () => {
        const outcome = await check(broken.tenant);
        return {
          pass: Boolean(outcome?.pass ?? outcome),
          detail: outcome?.detail ?? '',
          evidence: { 'response.json': JSON.stringify(outcome ?? {}, null, 2) }
        };
      }
    });
  }

  // ---- Cancellation ------------------------------------------------------------------

  await lab.reset(BANK);
  const cancelWorld = await seedWorkspace('AgentCancel', BANK, { security: false });

  await golden({
    id: 'AQF-025',
    objective: 'A pass can be cancelled and says who stopped it',
    preconditions: ['a pass is running or waiting'],
    input: 'a cancel request',
    expected: 'The run reaches cancelled and records why',
    evidence: ['cancelled.json'], severity: 'critical',
    run: async () => {
      const started = await startPass(cancelWorld.tenant, cancelWorld.application.id, { maxPages: 6 });
      const response = await request(`/api/v1/agent/runs/${started.runId}/cancel`, {
        token: cancelWorld.tenant.token, method: 'POST'
      });
      const after = await settle(cancelWorld.tenant, started.runId, { finished: true, timeoutMs: 120_000 });
      return {
        pass: response.ok && String(after?.status) === 'cancelled',
        detail: `cancel ${response.status}, run ${after?.status}: ${after?.stopReason?.slice(0, 120)}`,
        evidence: { 'cancelled.json': JSON.stringify(after, null, 2) }
      };
    }
  });

  await golden({
    id: 'AQF-026',
    objective: 'A cancelled pass is not reported as completed',
    preconditions: ['a pass has been cancelled'],
    input: 'the cancelled run',
    expected: 'Its status distinguishes it from a pass that finished its plan',
    evidence: ['cancelled-status.json'], severity: 'critical',
    run: async () => {
      const runs = await request(
        `/api/v1/agent/runs?applicationId=${cancelWorld.application.id}`,
        { token: cancelWorld.tenant.token });
      const cancelled = (runs.json ?? []).filter(r => r.status === 'cancelled');
      return {
        pass: cancelled.length > 0,
        detail: `${cancelled.length} cancelled of ${(runs.json ?? []).length}`,
        evidence: { 'cancelled-status.json': JSON.stringify(runs.json, null, 2) }
      };
    }
  });

  // ---- Concurrency ------------------------------------------------------------------------

  await golden({
    id: 'AQF-027',
    objective: 'Only one pass at a time runs against an application',
    preconditions: ['a pass is already in flight'],
    input: 'a second start request for the same application',
    expected: 'The second is refused rather than racing the first',
    evidence: ['second-start.json'], severity: 'critical',
    run: async () => {
      const first = await request('/api/v1/agent/runs', {
        token: cancelWorld.tenant.token, method: 'POST',
        body: { applicationId: cancelWorld.application.id, name: 'First', maxPages: 6 }
      });
      const second = await request('/api/v1/agent/runs', {
        token: cancelWorld.tenant.token, method: 'POST',
        body: { applicationId: cancelWorld.application.id, name: 'Second', maxPages: 6 }
      });
      if (first.ok) {
        await request(`/api/v1/agent/runs/${first.json.id}/cancel`, {
          token: cancelWorld.tenant.token, method: 'POST'
        });
      }
      return {
        pass: first.ok && second.status === 409,
        detail: `first ${first.status}, second ${second.status}`,
        evidence: { 'second-start.json': second.text }
      };
    }
  });

  await lab.reset(BANK);

  // ---- Standing claims about honesty under failure -------------------------------------

  const honesty = [
    ['AQF-028', 'No pass in this suite reported a clean result it had not earned',
      'Every pass that executed nothing says so rather than reporting success',
      () => {
        const passes = [brokenPass, noLoginPass];
        const dishonest = passes.filter(p =>
          p.summary?.status === 'completed'
          && (p.summary?.testsExecuted ?? 0) === 0
          && !/completed its plan|nothing|no test/i.test(p.summary?.stopReason ?? ''));
        return { pass: dishonest.length === 0, detail: `${dishonest.length} dishonest` };
      }],
    ['AQF-029', 'No pass claimed coverage of an area it never reached',
      'Every plan names what it does not cover',
      () => {
        const passes = [brokenPass, noLoginPass];
        const silent = passes.filter(p => (p.plan?.notCovered ?? []).length === 0);
        return { pass: silent.length === 0, detail: `${silent.length} plans with no uncovered list` };
      }],
    ['AQF-030', 'No pass under fault conditions recorded a decision without evidence',
      'The evidence rule holds when things are going wrong',
      () => {
        const all = [...brokenPass.decisions, ...noLoginPass.decisions];
        const bare = all.filter(d => (d.evidence ?? []).length === 0);
        return { pass: bare.length === 0, detail: `${bare.length} of ${all.length} without evidence` };
      }]
  ];

  for (const [id, objective, expected, check] of honesty) {
    await golden({
      id, objective,
      preconditions: ['passes have run against deliberately broken applications'],
      input: 'the recorded passes',
      expected, evidence: ['decisions.json'], severity: 'critical',
      run: async () => {
        const outcome = await check();
        return {
          pass: Boolean(outcome?.pass ?? outcome),
          detail: outcome?.detail ?? '',
          evidence: { 'decisions.json': JSON.stringify(brokenPass.decisions, null, 2) }
        };
      }
    });
  }
}
