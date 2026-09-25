/**
 * What an autonomous pass may do, and what stops it.
 *
 * The policy engine is the only thing standing between an unattended agent and an
 * application, so these are the claims that matter most in this phase. They are driven
 * through the real platform: passes are started with different policies and the refusals they
 * record are read back.
 *
 * A refusal is a success here. Most of these pass when the agent is stopped.
 */
import { golden, suite } from '../harness.mjs';
import { LAB, lab, request, requireEnvironment } from '../platform.mjs';
import {
  agentApprovals, authorizeSecurity, collect, decideApproval, decidePlan, decisionFor,
  decisionsFor, evidenceValue, seedWorkspace, settle, startPass
} from '../agent-pass.mjs';

const BANK = LAB.banking;

export default async function run() {
  suite('Autonomous policy');
  await requireEnvironment([BANK]);
  await lab.reset(BANK);

  // Two worlds: one ordinary, one with no environment at all so the unknown-environment rung
  // can be observed rather than argued about.
  const world = await seedWorkspace('AgentPolicy', BANK, {
    context: { criticalJourneys: 'payment', highRiskAreas: '', excludedAreas: '', notes: '' }
  });

  const { runId } = await startPass(world.tenant, world.application.id, { maxPages: 10 });
  await decidePlan(world.tenant, runId, { approve: true, note: 'Approved to exercise the policy.' });
  const settled = await settle(world.tenant, runId);
  const pass = await collect(world.tenant, runId);

  const evidence = {
    'decisions.json': JSON.stringify(pass.decisions, null, 2),
    'approvals.json': JSON.stringify(pass.approvals, null, 2),
    'run.json': JSON.stringify(pass.summary, null, 2)
  };

  const claim = (id, objective, expected, check, severity = 'high') => golden({
    id, objective,
    preconditions: ['a real autonomous pass has run against the lab bank'],
    input: `agent run ${runId}`,
    expected, evidence: Object.keys(evidence), severity,
    run: async () => {
      const outcome = await check();
      return { pass: Boolean(outcome?.pass ?? outcome), detail: outcome?.detail ?? '', evidence };
    }
  });

  const refusals = pass.decisions.filter(d => !d.allowed);
  const scanApproval = pass.approvals.find(a => a.tool === 'security.scan') ?? null;

  // ---- Everything goes through the gate ---------------------------------------

  await claim('AQP-001', 'Every action the pass takes is recorded as a decision',
    'The pass recorded decisions rather than acting silently',
    () => ({ pass: pass.decisions.length > 0, detail: `${pass.decisions.length} decisions` }),
    'critical');

  await claim('AQP-002', 'A refused action is recorded rather than dropped',
    'At least one decision is marked not allowed',
    () => ({ pass: refusals.length > 0, detail: `${refusals.length} refusals` }), 'critical');

  await claim('AQP-003', 'A refusal names which rung of the ladder stopped it',
    'Every refusal carries a denial code',
    () => {
      const missing = refusals.filter(d => !d.denial);
      return { pass: missing.length === 0, detail: refusals.map(d => `${d.tool}:${d.denial}`).join(' ') };
    }, 'critical');

  await claim('AQP-004', 'A refusal records how far it got before being stopped',
    'The evidence names the rungs that passed',
    () => {
      const withRungs = refusals.filter(d =>
        (d.evidence ?? []).some(e => e.name === 'policyRungsPassed'));
      return { pass: withRungs.length === refusals.length, detail: `${withRungs.length}/${refusals.length}` };
    }, 'critical');

  await claim('AQP-005', 'A refused action reports that it was not performed',
    'The result says so rather than leaving it blank',
    () => {
      const said = refusals.filter(d => /not performed/i.test(d.result ?? ''));
      return { pass: said.length === refusals.length, detail: `${said.length}/${refusals.length}` };
    });

  await claim('AQP-006', 'Every decision names the tool it was about, or records no tool',
    'A decision is attributable to a registered action or explicitly to none',
    () => {
      const unknown = pass.decisions.filter(d => d.tool && !/^[a-z]+\.[a-zA-Z]+$/.test(d.tool));
      return { pass: unknown.length === 0, detail: unknown.map(d => d.tool).join(',') || 'all well formed' };
    });

  await claim('AQP-007', 'Every decision carries the evidence it rests on',
    'No decision has an empty evidence list',
    () => {
      const bare = pass.decisions.filter(d => (d.evidence ?? []).length === 0);
      return { pass: bare.length === 0, detail: `${bare.length} without evidence` };
    }, 'critical');

  await claim('AQP-008', 'A permitted action records the risk it was judged at',
    'Allowed decisions that used a tool carry a risk level',
    () => {
      const withTool = pass.decisions.filter(d => d.allowed && d.tool);
      const missing = withTool.filter(d => !d.risk);
      return { pass: missing.length === 0, detail: `${missing.length} of ${withTool.length} missing` };
    });

  // ---- Approval ------------------------------------------------------------------

  await claim('AQP-009', 'A state-changing action stops for a person',
    'The pass asked before scanning rather than scanning',
    () => ({ pass: Boolean(scanApproval), detail: scanApproval ? scanApproval.status : 'never asked' }),
    'critical');

  await claim('AQP-010', 'The question names the tool it is about',
    'The approval carries the tool name',
    () => ({ pass: scanApproval?.tool === 'security.scan', detail: `${scanApproval?.tool}` }));

  await claim('AQP-011', 'The question says what the agent proposes to do',
    'The approval carries a proposal in words',
    () => ({ pass: (scanApproval?.proposal ?? '').length > 20, detail: scanApproval?.proposal ?? '' }));

  await claim('AQP-012', 'The question says what would happen if it is granted',
    'The approval carries an expected impact',
    () => ({
      pass: (scanApproval?.expectedImpact ?? '').length > 20,
      detail: scanApproval?.expectedImpact ?? '(none)'
    }), 'critical');

  await claim('AQP-013', 'The question carries the evidence behind it',
    'The approval has named evidence rather than a bare request',
    () => ({
      pass: (scanApproval?.evidence ?? []).length > 0,
      detail: (scanApproval?.evidence ?? []).map(e => e.name).join(', ')
    }));

  await claim('AQP-014', 'The question records the risk that triggered it',
    'The approval names a risk level at or above state-changing',
    () => ({
      pass: ['StateChanging', 'Destructive'].includes(scanApproval?.risk ?? ''),
      detail: `${scanApproval?.risk}`
    }));

  await claim('AQP-015', 'Asking is not granting',
    'A pending approval records nobody as having decided it',
    () => ({
      pass: scanApproval?.status === 'pending' && !scanApproval?.decidedByEmail,
      detail: `${scanApproval?.status}, ${scanApproval?.decidedByEmail ?? 'nobody'}`
    }), 'critical');

  await claim('AQP-016', 'The pass waits rather than proceeding without an answer',
    'The run is parked at awaiting approval',
    () => ({
      pass: settled?.status === 'awaitingApproval',
      detail: `${settled?.status}: ${settled?.stopReason?.slice(0, 120)}`
    }), 'critical');

  await claim('AQP-017', 'The pass did not perform the action it asked about',
    'No security scan decision is recorded as allowed',
    () => {
      const allowed = decisionsFor(pass, 'security.scan').filter(d => d.allowed);
      return { pass: allowed.length === 0, detail: `${allowed.length} allowed scans` };
    }, 'critical');

  await claim('AQP-018', 'The same question is not asked twice',
    'There is exactly one pending approval per tool',
    () => {
      const byTool = {};
      for (const a of pass.approvals.filter(x => x.status === 'pending'))
        byTool[a.tool] = (byTool[a.tool] ?? 0) + 1;
      const repeated = Object.entries(byTool).filter(([, n]) => n > 1);
      return { pass: repeated.length === 0, detail: JSON.stringify(byTool) };
    });

  // ---- Answering it ------------------------------------------------------------------

  await golden({
    id: 'AQP-019',
    objective: 'An answer with no reason is refused',
    preconditions: ['the pass has asked a question'],
    input: 'a grant with a two-word justification',
    expected: 'The API refuses it: an approval with nobody\'s reasoning behind it is '
      + 'indistinguishable from the control being switched off',
    evidence: ['thin-answer.json'], severity: 'critical',
    run: async () => {
      const response = await decideApproval(world.tenant, scanApproval.id,
        { grant: true, justification: 'fine' });
      return {
        pass: !response.ok && /indistinguishable/i.test(response.text),
        detail: `${response.status} ${response.text.slice(0, 200)}`,
        evidence: { 'thin-answer.json': response.text }
      };
    }
  });

  await golden({
    id: 'AQP-020',
    objective: 'Answering a question releases the pass',
    preconditions: ['the pass is parked on one unanswered question'],
    input: 'a granted approval with a reason',
    expected: 'The run leaves awaitingApproval without anybody restarting it',
    evidence: ['answer.json', 'released.json'], severity: 'critical',
    run: async () => {
      const response = await decideApproval(world.tenant, scanApproval.id, {
        grant: true, justification: 'Authorized for the golden lab, which exists to be tested.'
      });
      const after = await settle(world.tenant, runId, { timeoutMs: 120_000 });
      return {
        pass: response.ok && after?.status !== 'awaitingApproval',
        detail: `answer ${response.status}, run ${after?.status} ${after?.phase}`,
        evidence: {
          'answer.json': response.text,
          'released.json': JSON.stringify(after, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'AQP-021',
    objective: 'A question is answered once',
    preconditions: ['the question has already been answered'],
    input: 'a second answer to the same question',
    expected: 'The API refuses it and says who answered first',
    evidence: ['second-answer.json'], severity: 'high',
    run: async () => {
      const response = await decideApproval(world.tenant, scanApproval.id, {
        grant: false, justification: 'Actually, not this time after all.'
      });
      return {
        pass: response.status === 409 && /already granted/i.test(response.text),
        detail: `${response.status} ${response.text.slice(0, 180)}`,
        evidence: { 'second-answer.json': response.text }
      };
    }
  });

  await golden({
    id: 'AQP-022',
    objective: 'A granted answer is stored with who gave it and why',
    preconditions: ['the question has been answered'],
    input: `agent run ${runId}`,
    expected: 'The approval records the person, their reason and when',
    evidence: ['granted.json'], severity: 'critical',
    run: async () => {
      const approvals = await agentApprovals(world.tenant, runId);
      const granted = (approvals.json ?? []).find(a => a.tool === 'security.scan');
      return {
        pass: granted?.status === 'granted' && Boolean(granted.decidedByEmail)
          && (granted.justification ?? '').length >= 10 && Boolean(granted.decidedAt),
        detail: `${granted?.status} by ${granted?.decidedByEmail}: ${granted?.justification}`,
        evidence: { 'granted.json': JSON.stringify(granted, null, 2) }
      };
    }
  });

  // ---- Bounds --------------------------------------------------------------------------

  const budgeted = await startPass(world.tenant, world.application.id, {
    maxPages: 10, maxGeneratedTests: 1, name: 'Budget pass'
  });
  await decidePlan(world.tenant, budgeted.runId, { approve: true, note: 'Approved to spend the budget.' });
  await settle(world.tenant, budgeted.runId);
  const budgetPass = await collect(world.tenant, budgeted.runId);

  const budgetEvidence = { 'budget-decisions.json': JSON.stringify(budgetPass.decisions, null, 2) };
  const budgetClaim = (id, objective, expected, check, severity = 'high') => golden({
    id, objective,
    preconditions: ['a pass has run with a test budget of one'],
    input: `agent run ${budgeted.runId}`,
    expected, evidence: Object.keys(budgetEvidence), severity,
    run: async () => {
      const outcome = await check();
      return { pass: Boolean(outcome?.pass ?? outcome), detail: outcome?.detail ?? '', evidence: budgetEvidence };
    }
  });

  await budgetClaim('AQP-023', 'A spent test budget stops generation',
    'A refusal names the test budget',
    () => {
      const refused = budgetPass.decisions.find(d => d.denial === 'TestBudgetSpent');
      return { pass: Boolean(refused), detail: refused?.reason?.slice(0, 160) ?? '(none)' };
    }, 'critical');

  await budgetClaim('AQP-024', 'A spent budget is reported as a bound rather than a conclusion',
    'The refusal says tests nobody asked for are a cost',
    () => {
      const refused = budgetPass.decisions.find(d => d.denial === 'TestBudgetSpent');
      return {
        pass: /an agent that writes them without limit is one/i.test(refused?.reason ?? ''),
        detail: refused?.reason?.slice(0, 200) ?? '(none)'
      };
    });

  await budgetClaim('AQP-025', 'The run reports the bounds it actually ran under',
    'The bounds on the run match what was asked for',
    () => ({
      pass: budgetPass.bounds?.maxGeneratedTests === 1,
      detail: JSON.stringify(budgetPass.bounds)
    }));

  await budgetClaim('AQP-026', 'A pass never generates more tests than its budget',
    'testsGenerated is within the bound',
    () => ({
      pass: (budgetPass.summary?.testsGenerated ?? 0) <= 1,
      detail: `${budgetPass.summary?.testsGenerated} generated against a budget of 1`
    }), 'critical');

  // ---- An unknown environment ------------------------------------------------------------

  const undescribed = await seedWorkspace('AgentNoEnv', BANK, { security: false });
  // Remove the environment association by pointing the pass at an application whose project
  // has two environments and no scope naming one, so nothing identifies where it runs.
  await request(`/api/v1/environments`, {
    token: undescribed.tenant.token, method: 'POST',
    body: {
      projectId: undescribed.project.id, name: 'Second', key: 'uat', kind: 'uat',
      baseUrl: BANK, apiBaseUrl: BANK
    }
  });

  const unknown = await startPass(undescribed.tenant, undescribed.application.id, { maxPages: 6 });
  await decidePlan(undescribed.tenant, unknown.runId, {
    approve: true, note: 'Approved to exercise the unknown-environment rung.'
  });
  await settle(undescribed.tenant, unknown.runId);
  const unknownPass = await collect(undescribed.tenant, unknown.runId);

  const unknownEvidence = {
    'unknown-decisions.json': JSON.stringify(unknownPass.decisions, null, 2),
    'unknown-run.json': JSON.stringify(unknownPass.summary, null, 2)
  };
  const unknownClaim = (id, objective, expected, check, severity = 'high') => golden({
    id, objective,
    preconditions: ['a pass has run against an application whose environment nothing identifies'],
    input: `agent run ${unknown.runId}`,
    expected, evidence: Object.keys(unknownEvidence), severity,
    run: async () => {
      const outcome = await check();
      return { pass: Boolean(outcome?.pass ?? outcome), detail: outcome?.detail ?? '', evidence: unknownEvidence };
    }
  });

  await unknownClaim('AQP-027', 'An unknown environment refuses anything that writes',
    'A refusal names the unknown environment',
    () => {
      const refused = unknownPass.decisions.find(d => d.denial === 'EnvironmentUnknown');
      return { pass: Boolean(refused), detail: refused?.reason?.slice(0, 160) ?? 'no such refusal' };
    }, 'critical');

  await unknownClaim('AQP-028', 'The refusal says what to change rather than only what is wrong',
    'It names registering an environment or naming one on the scope',
    () => {
      const refused = unknownPass.decisions.find(d => d.denial === 'EnvironmentUnknown');
      return {
        pass: /Register an environment/i.test(refused?.reason ?? ''),
        detail: refused?.reason?.slice(0, 220) ?? '(none)'
      };
    }, 'critical');

  await unknownClaim('AQP-029', 'An unknown environment is not reported as production',
    'The denial is EnvironmentUnknown rather than ProductionNotPermitted',
    () => {
      const wrong = unknownPass.decisions.filter(d => d.denial === 'ProductionNotPermitted');
      return { pass: wrong.length === 0, detail: `${wrong.length} production refusals` };
    }, 'critical');

  await unknownClaim('AQP-030', 'An unknown environment still permits observation',
    'The pass reached a plan, which needs reading but not writing',
    () => ({
      pass: Boolean(unknownPass.plan),
      detail: unknownPass.plan ? `planned ${unknownPass.plan.totalTests} test(s)` : 'no plan'
    }), 'critical');

  await unknownClaim('AQP-031', 'An unscanned application is not planned for security testing',
    'No security category appears for an application with no scope',
    () => {
      const security = (unknownPass.plan?.items ?? []).find(i => i.category === 'security');
      return { pass: !security, detail: security ? 'present' : 'absent, as it should be' };
    }, 'critical');

  await unknownClaim('AQP-032', 'The absence of security testing is stated rather than implied',
    'notCovered says the application has no enabled scope',
    () => ({
      pass: (unknownPass.plan?.notCovered ?? []).some(n => /no enabled security scope/i.test(n)),
      detail: (unknownPass.plan?.notCovered ?? []).join(' | ').slice(0, 200)
    }), 'critical');

  await unknownClaim('AQP-033', 'An absence of authorization is not described as an absence of risk',
    'The wording distinguishes the two',
    () => ({
      pass: (unknownPass.plan?.notCovered ?? []).some(n =>
        /absence of authorization, not an absence of risk/i.test(n)),
      detail: (unknownPass.plan?.notCovered ?? []).find(n => /scope/i.test(n)) ?? '(none)'
    }));

  // ---- What the pass is never given ------------------------------------------------------

  const registryEvidence = { 'decisions.json': JSON.stringify(pass.decisions, null, 2) };
  const registryClaim = (id, objective, expected, check, severity = 'critical') => golden({
    id, objective,
    preconditions: ['passes have run against the lab'],
    input: 'every decision recorded by the passes in this suite',
    expected, evidence: Object.keys(registryEvidence), severity,
    run: async () => {
      const outcome = await check();
      return { pass: Boolean(outcome?.pass ?? outcome), detail: outcome?.detail ?? '', evidence: registryEvidence };
    }
  });

  const everyDecision = [...pass.decisions, ...budgetPass.decisions, ...unknownPass.decisions];
  const KNOWN_TOOLS = new Set([
    'browser.navigate', 'browser.click', 'browser.type', 'browser.select', 'browser.upload',
    'browser.capture', 'browser.inspect', 'api.request', 'api.inspect', 'security.scan',
    'security.validateScope', 'application.discover', 'test.generate', 'test.execute',
    'test.retry', 'evidence.capture', 'report.generate'
  ]);

  await registryClaim('AQP-034', 'Every tool a pass used is one the registry declares',
    'No decision names a tool outside the registry',
    () => {
      const unknownTools = [...new Set(everyDecision.map(d => d.tool).filter(t => t && !KNOWN_TOOLS.has(t)))];
      return { pass: unknownTools.length === 0, detail: unknownTools.join(', ') || 'all declared' };
    });

  await registryClaim('AQP-035', 'No pass performed a destructive action',
    'No decision was judged at destructive risk',
    () => {
      const destructive = everyDecision.filter(d => d.risk === 'Destructive' && d.allowed);
      return { pass: destructive.length === 0, detail: `${destructive.length}` };
    });

  await registryClaim('AQP-036', 'No pass acted with a model deciding for it',
    'No decision in these passes was attributed to a model',
    () => {
      const byModel = everyDecision.filter(d => d.modelContributed);
      return { pass: byModel.length === 0, detail: `${byModel.length} model-contributed` };
    }, 'high');

  await registryClaim('AQP-037', 'Model spend is reported even when it is nothing',
    'Every decision carries a cost figure rather than leaving it null',
    () => {
      const missing = everyDecision.filter(d => d.aiCostUsd === null || d.aiCostUsd === undefined);
      return { pass: missing.length === 0, detail: `${missing.length} without a cost` };
    }, 'high');

  await registryClaim('AQP-038', 'A pass reports what it spent on models',
    'The run carries an AI cost, zero or otherwise',
    () => ({
      pass: typeof pass.summary?.aiCostUsd === 'number',
      detail: `${pass.summary?.aiCostUsd}`
    }), 'high');

  await registryClaim('AQP-039', 'A pass never exceeds its model spend ceiling',
    'aiCostUsd is within the bound the run froze',
    () => ({
      pass: (pass.summary?.aiCostUsd ?? 0) <= (pass.bounds?.maxAiCostUsd ?? 0),
      detail: `${pass.summary?.aiCostUsd} of ${pass.bounds?.maxAiCostUsd}`
    }), 'high');

  await registryClaim('AQP-040', 'A decision a person took is attributed to them',
    'The plan approval carries an actor',
    () => {
      const approval = pass.decisions.find(d => /approved by/i.test(d.summary ?? ''));
      return { pass: Boolean(approval?.actorUserId), detail: `${approval?.actorUserId ?? 'nobody'}` };
    });

  await registryClaim('AQP-041', 'A decision the agent took has no person attributed to it',
    'Autonomous decisions carry no actor',
    () => {
      const autonomous = pass.decisions.filter(d => !/approved by|rejected by/i.test(d.summary ?? ''));
      const wrong = autonomous.filter(d => d.actorUserId);
      return { pass: wrong.length === 0, detail: `${wrong.length} wrongly attributed` };
    });

  await registryClaim('AQP-042', 'An identifier survives in the record rather than being masked away',
    'The approver\'s id is readable even though the narrative masks their address',
    () => {
      const approval = pass.decisions.find(d => /approved by/i.test(d.summary ?? ''));
      return {
        pass: Boolean(approval?.actorUserId) && !/[a-z0-9.]+@[a-z]/i.test(approval?.summary ?? ''),
        detail: `actor ${approval?.actorUserId}, summary "${approval?.summary}"`
      };
    }, 'high');

  await registryClaim('AQP-043', 'One tenant cannot read another tenant\'s pass',
    'A second organization asking for this run is refused',
    async () => {
      const stranger = await seedWorkspace('AgentStranger', BANK, { security: false });
      const response = await request(`/api/v1/agent/runs/${runId}/decisions`, {
        token: stranger.tenant.token
      });
      return { pass: response.status === 404 || response.status === 403, detail: `${response.status}` };
    });

  await registryClaim('AQP-044', 'A pass reports which bounds it ran under, not which are configured now',
    'The bounds are frozen on the run',
    () => ({
      pass: Boolean(pass.bounds) && typeof pass.bounds.maxPages === 'number',
      detail: JSON.stringify(pass.bounds)
    }), 'high');

  await registryClaim('AQP-045', 'Approval for high-risk actions cannot be switched off by asking',
    'A pass started asking for no approvals still asks',
    async () => {
      const bold = await startPass(world.tenant, world.application.id, {
        maxPages: 5, name: 'No-approval pass',
        policy: { maxActions: 500, maxRuntimeMinutes: 30, maxNewTests: 10, maxNewJourneys: 5,
          allowProduction: false, allowDestructiveActions: false, allowSecurityTesting: true,
          requireApprovalForHighRisk: false, maxParallelWorkers: 2 }
      });
      const detail = await request(`/api/v1/agent/runs/${bold.runId}`, { token: world.tenant.token });
      // The bound is frozen on the run; the flag it was asked to clear is not clearable.
      await decidePlan(world.tenant, bold.runId, { approve: true, note: 'Approved to check the flag.' });
      const after = await settle(world.tenant, bold.runId);
      const approvals = await agentApprovals(world.tenant, bold.runId);
      const asked = (approvals.json ?? []).length > 0;
      return {
        pass: asked || after?.status === 'awaitingApproval',
        detail: `${(approvals.json ?? []).length} question(s) asked, run ${after?.status}`
      };
    });
}
