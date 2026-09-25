/**
 * What an autonomous pass proposes to do, before it does any of it.
 *
 * The plan is the screen where a person authorizes work against a live environment, so every
 * claim here is about whether that person could refuse intelligently: does each category say
 * why it is there, is the estimate labelled an estimate, is the uncovered half named, and
 * does approving or rejecting actually do what it says.
 *
 * One real pass is driven to the point where it stops and asks. Everything after that
 * interrogates what it recorded.
 */
import { golden, suite } from '../harness.mjs';
import { LAB, lab, requireEnvironment } from '../platform.mjs';
import {
  collect, decidePlan, seedWorkspace, settle, startPass
} from '../agent-pass.mjs';

const BANK = LAB.banking;

export default async function run() {
  suite('Autonomous planning');
  await requireEnvironment([BANK]);
  await lab.reset(BANK);

  // One workspace with business context, so the plan has something to honour and something
  // to exclude. Without either, half of what a plan is for cannot be observed.
  const world = await seedWorkspace('AgentPlan', BANK, {
    context: {
      criticalJourneys: 'payment\nlogin',
      highRiskAreas: 'authentication',
      // A route the lab actually has. Excluding one it does not would still be listed in the
      // plan, and would prove nothing about whether the exclusion is honoured — which is the
      // part that matters and the part a first draft of this suite failed to test.
      excludedAreas: '/statements',
      notes: 'The golden lab. Staging only.'
    }
  });

  // Enough pages that the excluded one is genuinely inside the set the pass considers. A
  // first draft used eight, the excluded route fell outside them, and the exclusion test
  // passed for the wrong reason — nothing was excluded because nothing was reached.
  const { runId } = await startPass(world.tenant, world.application.id, { maxPages: 15 });
  const pass = await collect(world.tenant, runId);

  const evidence = {
    'plan.json': JSON.stringify(pass.plan, null, 2),
    'run.json': JSON.stringify(pass.summary, null, 2),
    'decisions.json': JSON.stringify(pass.decisions, null, 2)
  };

  /** Declares one claim about the plan the pass already produced. */
  const claim = (id, objective, expected, check, severity = 'high') => golden({
    id, objective,
    preconditions: ['a real autonomous pass has run against the lab bank and produced a plan'],
    input: `agent run ${runId}`,
    expected,
    evidence: Object.keys(evidence),
    severity,
    run: async () => {
      const outcome = await check();
      return {
        pass: Boolean(outcome?.pass ?? outcome),
        detail: outcome?.detail ?? '',
        evidence
      };
    }
  });

  const plan = pass.plan;
  const items = plan?.items ?? [];
  const category = name => items.find(i => i.category === name) ?? null;

  // ---- The plan exists at all ------------------------------------------------

  await claim('AQN-001', 'A pass produces a plan before it tests anything',
    'The run reaches a plan and the plan is readable through the API',
    () => ({ pass: Boolean(plan), detail: `plan status ${pass.planStatus}` }), 'critical');

  await claim('AQN-002', 'The pass stops rather than executing its own plan',
    'The run is awaiting approval, not running or completed',
    () => ({
      pass: pass.summary?.status === 'awaitingApproval',
      detail: `status ${pass.summary?.status}, phase ${pass.summary?.phase}`
    }), 'critical');

  await claim('AQN-003', 'Nothing has been executed at the point the plan is proposed',
    'testsExecuted is zero while the plan awaits an answer',
    () => ({
      pass: (pass.summary?.testsExecuted ?? -1) === 0,
      detail: `executed ${pass.summary?.testsExecuted}`
    }), 'critical');

  await claim('AQN-004', 'The reason the pass stopped says it is waiting for a person',
    'stopReason names the wait rather than describing a finished pass',
    () => ({
      pass: /approve the plan/i.test(pass.summary?.stopReason ?? ''),
      detail: pass.summary?.stopReason ?? '(none)'
    }));

  await claim('AQN-005', 'The plan is attached to the run that produced it',
    'The plan carries the agent run id',
    () => ({ pass: plan?.agentRunId === runId, detail: `${plan?.agentRunId}` }));

  await claim('AQN-006', 'The plan is proposed rather than already decided',
    'status is "proposed" and nobody is recorded as having decided it',
    () => ({
      pass: plan?.status === 'proposed' && !plan?.decidedByEmail,
      detail: `${plan?.status}, decidedBy ${plan?.decidedByEmail ?? 'nobody'}`
    }), 'critical');

  // ---- What is in it ----------------------------------------------------------

  await claim('AQN-007', 'The plan proposes more than one category of testing',
    'At least three categories, so a plan is a strategy rather than a single suite',
    () => ({ pass: items.length >= 3, detail: `${items.length} categories` }));

  await claim('AQN-008', 'Every category says why it is in the plan',
    'Each item carries a "why" of real length rather than a label',
    () => {
      const thin = items.filter(i => (i.why ?? '').length < 30).map(i => i.category);
      return { pass: thin.length === 0, detail: thin.length ? `thin: ${thin}` : 'all explained' };
    }, 'critical');

  await claim('AQN-009', 'Every category says what it covers',
    'Each item carries a coverage statement',
    () => {
      const missing = items.filter(i => !i.coverage).map(i => i.category);
      return { pass: missing.length === 0, detail: `${missing}` };
    });

  await claim('AQN-010', 'Every category says what running it could do to the application',
    'Each item carries a potential impact, so approving is an informed act',
    () => {
      const missing = items.filter(i => !i.potentialImpact).map(i => i.category);
      return { pass: missing.length === 0, detail: `${missing}` };
    }, 'critical');

  await claim('AQN-011', 'Every category carries a risk level',
    'Each item is classified rather than left unranked',
    () => ({
      pass: items.every(i => ['critical', 'high', 'medium', 'low'].includes(i.risk)),
      detail: items.map(i => `${i.category}:${i.risk}`).join(' ')
    }));

  await claim('AQN-012', 'The plan counts how many tests do not exist yet',
    'At least one category reports work it would have to generate',
    () => ({
      pass: items.some(i => i.toGenerate > 0),
      detail: items.map(i => `${i.category}:${i.toGenerate}`).join(' ')
    }));

  await claim('AQN-013', 'A smoke category covers the discovered pages',
    'Smoke is present and its count relates to what discovery found',
    () => ({
      pass: (category('smoke')?.testCount ?? 0) > 0,
      detail: `smoke ${category('smoke')?.testCount}`
    }));

  await claim('AQN-014', 'Security testing is planned for an authorized application',
    'A security category is present because the application carries an enabled scope',
    () => ({
      pass: Boolean(category('security')),
      detail: category('security') ? `${category('security').testCount} checks` : 'absent'
    }), 'critical');

  await claim('AQN-015', 'Accessibility is planned for an application with pages',
    'An accessibility category is present',
    () => ({ pass: Boolean(category('accessibility')), detail: `${category('accessibility')?.testCount}` }),
    'medium');

  // ---- Estimates ---------------------------------------------------------------

  await claim('AQN-016', 'Every category carries a time estimate',
    'estimatedSeconds is set on each item',
    () => ({
      pass: items.every(i => i.estimatedSeconds > 0),
      detail: items.map(i => `${i.category}:${i.estimatedSeconds}s`).join(' ')
    }));

  await claim('AQN-017', 'An estimate says whether it rests on history or on a default',
    'estimateFromHistory is present on every item, and false here because nothing has run',
    () => ({
      pass: items.every(i => i.estimateFromHistory === false),
      detail: items.map(i => `${i.category}:${i.estimateFromHistory}`).join(' ')
    }), 'critical');

  await claim('AQN-018', 'The summary describes the time as an estimate rather than a duration',
    'The word "estimate" appears in the plan summary',
    () => ({ pass: /estimate/i.test(plan?.summary ?? ''), detail: plan?.summary?.slice(0, 160) }));

  await claim('AQN-019', 'The summary says the estimates came from defaults for a new application',
    'It names the absence of execution history rather than presenting a confident number',
    () => ({
      pass: /from defaults/i.test(plan?.summary ?? ''),
      detail: plan?.summary?.slice(0, 200)
    }));

  await claim('AQN-020', 'The plan reports its own total rather than leaving it to be added up',
    'totalTests equals the sum of the included categories',
    () => {
      const sum = items.filter(i => i.included).reduce((n, i) => n + i.testCount, 0);
      return { pass: plan?.totalTests === sum, detail: `${plan?.totalTests} vs ${sum}` };
    });

  // ---- What it does not cover ------------------------------------------------------

  await claim('AQN-021', 'The plan names what it does not cover',
    'notCovered is non-empty',
    () => ({ pass: (plan?.notCovered ?? []).length > 0, detail: `${plan?.notCovered?.length} entries` }),
    'critical');

  await claim('AQN-022', 'An area a person excluded is named as not covered',
    'The exclusion appears in notCovered with the route the operator wrote',
    () => ({
      pass: (plan?.notCovered ?? []).some(n => n.includes('/statements')),
      detail: (plan?.notCovered ?? []).join(' | ').slice(0, 200)
    }), 'critical');

  await claim('AQN-023', 'The plan says nothing in it touches an excluded area',
    'The exclusion entry states that the plan does not touch it',
    () => ({
      pass: (plan?.notCovered ?? []).some(n => /Nothing in this plan touches them/i.test(n)),
      detail: (plan?.notCovered ?? []).find(n => n.includes('/statements')) ?? '(none)'
    }));

  await claim('AQN-024', 'The plan says an application is larger than its crawl',
    'notCovered names what discovery did not reach',
    () => ({
      pass: (plan?.notCovered ?? []).some(n => /larger than its crawl/i.test(n)),
      detail: (plan?.notCovered ?? []).join(' | ').slice(0, 200)
    }), 'critical');

  await claim('AQN-025', 'The summary says the uncovered areas are listed rather than implied',
    'The summary points at the uncovered list instead of leaving absence to be noticed',
    () => ({
      pass: /rather than left to be inferred from absence/i.test(plan?.summary ?? ''),
      detail: plan?.summary?.slice(-200)
    }));

  // ---- Risk analysis ------------------------------------------------------------------

  await claim('AQN-026', 'A person naming a critical area raises the journey category',
    'The critical-journey category is at critical risk because somebody said payments matter',
    () => {
      const journey = category('criticalJourney');
      return { pass: journey?.risk === 'critical', detail: `${journey?.risk ?? 'absent'}` };
    }, 'critical');

  await claim('AQN-027', 'The plan quotes the areas a person named',
    'The journey category\'s reasoning contains the operator\'s own words',
    () => {
      const journey = category('criticalJourney');
      return { pass: /payment/i.test(journey?.why ?? ''), detail: journey?.why?.slice(0, 160) ?? 'absent' };
    });

  await claim('AQN-028', 'Every area the pass assessed is recorded as a finding',
    'The run carries risk findings, not only the areas it chose to act on',
    () => ({ pass: pass.findings.length > 0, detail: `${pass.findings.length} findings` }),
    'critical');

  await claim('AQN-029', 'A risk finding explains itself rather than giving a bare score',
    'Each finding carries detail beyond its title',
    () => {
      const thin = pass.findings.filter(f => (f.detail ?? '').length < 20);
      return { pass: thin.length === 0, detail: `${thin.length} thin of ${pass.findings.length}` };
    });

  await claim('AQN-030', 'A deterministic risk finding is not attributed to a model',
    'Risk findings are marked as not AI-generated',
    () => {
      const ai = pass.findings.filter(f => f.isAiGenerated);
      return { pass: ai.length === 0, detail: `${ai.length} attributed to a model` };
    }, 'critical');

  await claim('AQN-031', 'Risk confidence is never certainty',
    'No finding claims 100',
    () => {
      const certain = pass.findings.filter(f => f.confidence >= 100);
      return { pass: certain.length === 0, detail: `${certain.length} at 100` };
    }, 'critical');

  await claim('AQN-032', 'Excluded pages are left out of the ranking entirely',
    'No finding is recorded against the excluded area',
    () => {
      const excluded = pass.findings.filter(f => (f.route ?? '').startsWith('/statements'));
      return { pass: excluded.length === 0, detail: `${excluded.length} findings on /statements` };
    }, 'critical');

  await claim('AQN-033', 'The pass records that it left excluded pages alone',
    'A decision explains the exclusion in the agent\'s own trail',
    () => {
      const decision = pass.decisions.find(d => /excluded them/i.test(d.summary ?? ''));
      return { pass: Boolean(decision), detail: decision?.summary ?? '(no such decision)' };
    });

  // ---- The decision trail --------------------------------------------------------------

  await claim('AQN-034', 'Proposing a plan is itself a recorded decision',
    'A decision in the planning phase reports the proposal',
    () => {
      const decision = pass.decisions.find(d => d.phase === 'planning' && /Proposed/i.test(d.summary));
      return { pass: Boolean(decision), detail: decision?.summary ?? '(none)' };
    }, 'critical');

  await claim('AQN-035', 'The planning decision carries the evidence it rests on',
    'It names the pages, endpoints and authorization it counted',
    () => {
      const decision = pass.decisions.find(d => d.phase === 'planning');
      const names = (decision?.evidence ?? []).map(e => e.name);
      return {
        pass: names.includes('pagesPlannable') && names.includes('securityAuthorized'),
        detail: names.join(', ')
      };
    }, 'critical');

  await claim('AQN-036', 'The planning decision records what a person excluded',
    'The evidence quotes the exclusion rather than only its effect',
    () => {
      const decision = pass.decisions.find(d => d.phase === 'planning');
      const value = (decision?.evidence ?? []).find(e => e.name === 'excludedByAPerson')?.value;
      return { pass: /statements/i.test(value ?? ''), detail: value ?? '(none)' };
    });

  await claim('AQN-037', 'The planning decision was not taken by a model',
    'modelContributed is false and the cost is zero',
    () => {
      const decision = pass.decisions.find(d => d.phase === 'planning');
      return {
        pass: decision?.modelContributed === false && Number(decision?.aiCostUsd) === 0,
        detail: `model ${decision?.modelContributed}, cost ${decision?.aiCostUsd}`
      };
    }, 'critical');

  await claim('AQN-038', 'Decisions are numbered in the order they happened',
    'Sequence numbers ascend without gaps from one',
    () => {
      const sequences = pass.decisions.map(d => d.sequence);
      const expected = sequences.map((_, i) => i + 1);
      return { pass: String(sequences) === String(expected), detail: `${sequences}` };
    });

  await claim('AQN-039', 'The timeline is assembled from what was recorded',
    'It carries at least as many entries as there are steps and decisions',
    () => ({
      pass: pass.timeline.length >= pass.steps.length,
      detail: `${pass.timeline.length} entries, ${pass.steps.length} steps, ${pass.decisions.length} decisions`
    }));

  await claim('AQN-040', 'The timeline is in chronological order',
    'Each entry is at or after the one before it',
    () => {
      const times = pass.timeline.map(e => Date.parse(e.at));
      const ordered = times.every((t, i) => i === 0 || t >= times[i - 1]);
      return { pass: ordered, detail: `${times.length} entries` };
    });

  // ---- Deciding it ----------------------------------------------------------------------

  await golden({
    id: 'AQN-041',
    objective: 'Rejecting a plan without a reason is refused',
    preconditions: ['a pass is awaiting a decision on its plan'],
    input: 'a rejection with an empty note',
    expected: 'The API refuses it, because a refusal with no reason leaves the next person to '
      + 'propose the same plan again',
    evidence: ['rejection.json'],
    severity: 'high',
    run: async () => {
      const response = await decidePlan(world.tenant, runId, { approve: false, note: '   ' });
      return {
        pass: !response.ok && /needs a reason/i.test(response.text),
        detail: `${response.status} ${response.text.slice(0, 160)}`,
        evidence: { 'rejection.json': response.text }
      };
    }
  });

  await golden({
    id: 'AQN-042',
    objective: 'Approving a plan with every category switched off is refused',
    preconditions: ['a pass is awaiting a decision on its plan'],
    input: 'an approval naming no categories',
    expected: 'The API refuses it: a pass that tests nothing and finishes reporting as though '
      + 'it had run is worse than one nobody started',
    evidence: ['empty-approval.json'],
    severity: 'critical',
    run: async () => {
      const response = await decidePlan(world.tenant, runId, {
        approve: true, includedCategories: [], note: 'Nothing this cycle.'
      });
      return {
        pass: !response.ok && /tests nothing/i.test(response.text),
        detail: `${response.status} ${response.text.slice(0, 200)}`,
        evidence: { 'empty-approval.json': response.text }
      };
    }
  });

  await golden({
    id: 'AQN-043',
    objective: 'Approving a plan records who approved it and what they left out',
    preconditions: ['a pass is awaiting a decision on its plan'],
    input: 'an approval naming a subset of categories',
    expected: 'The plan is approved, the excluded categories stay in it marked excluded, and '
      + 'the decision is recorded against a named person',
    evidence: ['approval.json', 'plan-after.json'],
    severity: 'critical',
    run: async () => {
      const response = await decidePlan(world.tenant, runId, {
        approve: true,
        includedCategories: ['smoke', 'api', 'security'],
        note: 'Smoke, API and security for this cycle.'
      });
      const after = response.json;
      const excluded = (after?.items ?? []).filter(i => !i.included).map(i => i.category);
      return {
        pass: response.ok && after?.status === 'approved'
          && Boolean(after?.decidedByEmail) && excluded.length > 0
          && (after?.items ?? []).length === items.length,
        detail: `status ${after?.status}, decidedBy ${after?.decidedByEmail}, `
          + `excluded ${excluded.join(',')}, items ${after?.items?.length} of ${items.length}`,
        evidence: {
          'approval.json': JSON.stringify(after, null, 2),
          'plan-after.json': JSON.stringify(after?.items, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'AQN-044',
    objective: 'A plan is decided once',
    preconditions: ['the plan has already been approved'],
    input: 'a second decision on the same plan',
    expected: 'The API refuses it and names who decided it first',
    evidence: ['second-decision.json'],
    severity: 'high',
    run: async () => {
      const response = await decidePlan(world.tenant, runId, {
        approve: false, note: 'Changed my mind about the whole thing.'
      });
      return {
        pass: response.status === 409 && /already approved/i.test(response.text),
        detail: `${response.status} ${response.text.slice(0, 200)}`,
        evidence: { 'second-decision.json': response.text }
      };
    }
  });

  await golden({
    id: 'AQN-045',
    objective: 'An approved plan releases the pass to carry on',
    preconditions: ['the plan has been approved'],
    input: `agent run ${runId}`,
    expected: 'The run leaves awaitingApproval and reaches a further state without anybody '
      + 'restarting it',
    evidence: ['resumed.json'],
    severity: 'critical',
    run: async () => {
      const summary = await settle(world.tenant, runId, { timeoutMs: 300_000 });
      return {
        pass: summary?.status !== 'awaitingApproval' || summary?.phase !== 'awaitingApproval'
          || Boolean(summary?.stopReason && !/approve the plan/i.test(summary.stopReason)),
        detail: `status ${summary?.status}, phase ${summary?.phase}, ${summary?.stopReason?.slice(0, 120)}`,
        evidence: { 'resumed.json': JSON.stringify(summary, null, 2) }
      };
    }
  });

  return { applicationId: world.application.id, runId, tenant: world.tenant };
}
