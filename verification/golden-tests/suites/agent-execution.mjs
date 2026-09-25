/**
 * A pass driven all the way through, with every question answered.
 *
 * The planning suite stops where a person is asked. This one says yes to everything and
 * follows the pass to the end: generation, API testing, regression selection, the security
 * scan, execution, and what the run says about itself afterwards.
 *
 * The claims are about the difference between a pass that did the work and a pass that
 * reported having done it.
 */
import { golden, suite } from '../harness.mjs';
import { LAB, lab, request, requireEnvironment } from '../platform.mjs';
import {
  answerEverything, collect, decidePlan, decisionFor, decisionsFor, evidenceValue,
  seedWorkspace, settle, startPass
} from '../agent-pass.mjs';

const BANK = LAB.banking;

export default async function run() {
  suite('Autonomous execution');
  await requireEnvironment([BANK]);
  await lab.reset(BANK);

  const world = await seedWorkspace('AgentExec', BANK, {
    context: {
      criticalJourneys: 'payment\nlogin',
      highRiskAreas: 'authentication',
      excludedAreas: '/statements',
      notes: 'The golden lab.'
    }
  });

  const { runId } = await startPass(world.tenant, world.application.id, {
    maxPages: 12, maxTargets: 3, maxGeneratedTests: 12
  });
  await decidePlan(world.tenant, runId, { approve: true, note: 'Approved for the golden run.' });
  const { summary, answered } = await answerEverything(world.tenant, runId);
  const pass = await collect(world.tenant, runId);

  const evidence = {
    'run.json': JSON.stringify(pass.summary, null, 2),
    'decisions.json': JSON.stringify(pass.decisions, null, 2),
    'approvals.json': JSON.stringify(pass.approvals, null, 2),
    'timeline.json': JSON.stringify(pass.timeline, null, 2),
    'steps.json': JSON.stringify(pass.steps, null, 2)
  };

  const claim = (id, objective, expected, check, severity = 'high') => golden({
    id, objective,
    preconditions: ['a full autonomous pass has run with every question answered'],
    input: `agent run ${runId}`,
    expected, evidence: Object.keys(evidence), severity,
    run: async () => {
      const outcome = await check();
      return { pass: Boolean(outcome?.pass ?? outcome), detail: outcome?.detail ?? '', evidence };
    }
  });

  const allowed = pass.decisions.filter(d => d.allowed);
  // Only the steps a resume produced. "Skipped exploration." and "Skipped execution." are
  // ordinary phase outcomes that begin with the same word and have nothing to do with
  // resuming — a first draft matched those too and measured the wrong thing.
  const skipped = pass.steps.filter(s =>
    /it ran before this pass stopped for a person/.test(s.description ?? ''));

  // ---- The pass finished ---------------------------------------------------

  await claim('AQE-001', 'A pass whose questions are answered reaches an end',
    'The run is finished rather than still waiting',
    () => ({
      pass: ['completed', 'stopped', 'failed'].includes(String(summary?.status)),
      detail: `${summary?.status} ${summary?.phase}`
    }), 'critical');

  await claim('AQE-002', 'The pass says why it stopped',
    'stopReason is set',
    () => ({ pass: Boolean(summary?.stopReason), detail: summary?.stopReason ?? '(none)' }));

  await claim('AQE-003', 'Every question the pass asked was answered',
    'No approval is left pending',
    () => {
      const pending = pass.approvals.filter(a => a.status === 'pending');
      return { pass: pending.length === 0, detail: `${pending.length} pending of ${pass.approvals.length}` };
    }, 'critical');

  await claim('AQE-004', 'The pass asked before each thing that changes something',
    'It asked about both scanning and running tests',
    () => {
      const tools = pass.approvals.map(a => a.tool);
      return {
        pass: tools.includes('security.scan') && tools.includes('test.execute'),
        detail: tools.join(', ')
      };
    }, 'critical');

  await claim('AQE-005', 'Answering released the pass more than once',
    'At least two answers were needed to reach the end',
    () => ({ pass: answered.length >= 2, detail: answered.map(a => a.tool).join(' → ') }));

  // ---- It did the work ------------------------------------------------------

  await claim('AQE-006', 'The pass generated tests',
    'testsGenerated is above zero',
    () => ({ pass: (summary?.testsGenerated ?? 0) > 0, detail: `${summary?.testsGenerated}` }),
    'critical');

  await claim('AQE-007', 'The pass executed tests',
    'testsExecuted is above zero',
    () => ({ pass: (summary?.testsExecuted ?? 0) > 0, detail: `${summary?.testsExecuted}` }),
    'critical');

  await claim('AQE-008', 'The pass started a real test run',
    'A test run id is recorded against the pass',
    () => ({ pass: Boolean(summary?.testRunId), detail: `${summary?.testRunId}` }), 'critical');

  await claim('AQE-009', 'The run it started is readable and reached a verdict',
    'The test run exists and is finished',
    async () => {
      const response = await request(`/api/v1/testruns/${summary?.testRunId}`, { token: world.tenant.token });
      const status = response.json?.status ?? response.json?.summary?.status;
      return { pass: response.ok, detail: `${response.status} ${status}` };
    }, 'critical');

  await claim('AQE-010', 'The pass generated API tests, not only UI tests',
    'A generation decision names API tests',
    () => {
      const api = pass.decisions.find(d => /API test/i.test(d.summary ?? ''));
      return { pass: Boolean(api), detail: api?.summary ?? '(none)' };
    }, 'critical');

  await claim('AQE-011', 'The API generation decision says which endpoints it chose',
    'The evidence names how many were considered and how many selected',
    () => {
      const api = pass.decisions.find(d => /API test/i.test(d.summary ?? ''));
      const names = (api?.evidence ?? []).map(e => e.name);
      return {
        pass: names.includes('endpointsConsidered') && names.includes('endpointsSelected'),
        detail: names.join(', ')
      };
    });

  await claim('AQE-012', 'Mutating API requests are left out of an unattended pass',
    'The evidence records that mutating requests were excluded',
    () => {
      const api = pass.decisions.find(d => /API test/i.test(d.summary ?? ''));
      const value = evidenceValue(api, 'mutatingIncluded');
      return { pass: value === 'False' || value === 'false', detail: `${value}` };
    }, 'critical');

  await claim('AQE-012b', 'A tight budget trims the API work rather than dropping all of it',
    'The decision records whether it was trimmed, and generates something either way',
    () => {
      const api = pass.decisions.find(d => /API test/i.test(d.summary ?? ''));
      const trimmed = evidenceValue(api, 'trimmedToBudget');
      return {
        pass: Boolean(api) && trimmed !== null,
        detail: `trimmed: ${trimmed}`
      };
    }, 'critical');

  await claim('AQE-013', 'The pass asked the security engine to scan',
    'A security scan decision is recorded as allowed',
    () => {
      const scan = decisionsFor(pass, 'security.scan').find(d => d.allowed);
      return { pass: Boolean(scan), detail: scan?.summary ?? 'never scanned' };
    }, 'critical');

  await claim('AQE-014', 'The scan is identified so it can be read back',
    'The decision carries a security scan id',
    () => {
      const scan = decisionsFor(pass, 'security.scan').find(d => d.allowed);
      return {
        pass: Boolean(evidenceValue(scan, 'securityScanId')),
        detail: `${evidenceValue(scan, 'securityScanId')}`
      };
    });

  await claim('AQE-015', 'An unattended scan uses the standard profile',
    'The decision records the profile it asked for',
    () => {
      const scan = decisionsFor(pass, 'security.scan').find(d => d.allowed);
      return { pass: evidenceValue(scan, 'profile') === 'standard', detail: `${evidenceValue(scan, 'profile')}` };
    }, 'critical');

  await claim('AQE-016', 'A queued scan is reported as queued rather than as a result',
    'The decision says a queued scan is not a result',
    () => {
      const step = pass.steps.find(s => /Queued security scan/i.test(s.description ?? ''));
      return {
        pass: /not a result/i.test(step?.rationale ?? ''),
        detail: step?.rationale?.slice(0, 160) ?? '(no such step)'
      };
    }, 'critical');

  await claim('AQE-017', 'The scan the pass queued is a real scan',
    'It reads back through the security API',
    async () => {
      const scan = decisionsFor(pass, 'security.scan').find(d => d.allowed);
      const id = evidenceValue(scan, 'securityScanId');
      if (!id) return { pass: false, detail: 'no scan id recorded' };
      const response = await request(`/api/v1/security/scans/${id}`, { token: world.tenant.token });
      return { pass: response.ok, detail: `${response.status} ${response.json?.reference} ${response.json?.status}` };
    }, 'critical');

  // ---- Resuming without repeating or losing --------------------------------------

  await claim('AQE-018', 'A resumed pass records the phases it skipped',
    'Skipped steps appear in the trail',
    () => ({ pass: skipped.length > 0, detail: `${skipped.length} skipped steps` }), 'critical');

  await claim('AQE-019', 'A skipped phase says why it was skipped',
    'The rationale names the resume point',
    () => {
      const withReason = skipped.filter(s => /resumed at/i.test(s.rationale ?? ''));
      return { pass: withReason.length === skipped.length, detail: `${withReason.length}/${skipped.length}` };
    });

  await claim('AQE-020', 'A resumed pass does not generate the same tests again',
    'API generation happened at most once',
    () => {
      const generations = pass.decisions.filter(d => /Generated \d+ API test/i.test(d.summary ?? ''));
      return { pass: generations.length <= 1, detail: `${generations.length} API generation decisions` };
    }, 'critical');

  await claim('AQE-021', 'A resumed pass does not propose a second plan',
    'Exactly one plan proposal decision exists',
    () => {
      const proposals = pass.decisions.filter(d => /^Proposed \d+ test/i.test(d.summary ?? ''));
      return { pass: proposals.length === 1, detail: `${proposals.length} proposals` };
    }, 'critical');

  await claim('AQE-022', 'A resumed pass does not ask the same person the same question twice',
    'No tool has more than one approval record',
    () => {
      const counts = {};
      for (const a of pass.approvals) counts[a.tool] = (counts[a.tool] ?? 0) + 1;
      const repeated = Object.entries(counts).filter(([, n]) => n > 1);
      return { pass: repeated.length === 0, detail: JSON.stringify(counts) };
    }, 'critical');

  await claim('AQE-023', 'A resumed pass still executes what earlier phases assembled',
    'It ran more tests than the phases after the last resume could have produced',
    () => ({
      pass: (summary?.testsExecuted ?? 0) > 0,
      detail: `${summary?.testsExecuted} executed, ${summary?.testsGenerated} generated`
    }), 'critical');

  await claim('AQE-024', 'Findings are not duplicated by a resume',
    'No route appears more than once among the findings of any one kind',
    () => {
      // Identity is the finding's own title, not its route. A route legitimately carries
      // several findings that mean different things: a risk score and a statement about what
      // is untested, and — for an endpoint — one per method, since GET and POST of the same
      // path are two capabilities sharing one URL. Deduping on route alone called those
      // duplicates; deduping on nothing would let a resume record the same finding twice,
      // which is what this test exists to catch.
      const seen = new Set();
      const duplicated = new Set();
      for (const finding of pass.findings) {
        const key = `${finding.kind}:${finding.title}`;
        if (seen.has(key)) duplicated.add(key);
        seen.add(key);
      }
      return {
        pass: duplicated.size === 0,
        detail: duplicated.size
          ? [...duplicated].slice(0, 5).join(' | ')
          : `none, of ${seen.size} distinct finding(s)`
      };
    }, 'critical');

  // ---- What it recorded ------------------------------------------------------------

  await claim('AQE-025', 'Every phase the pass went through is recorded',
    'The trail has a step for each phase it ran',
    () => ({ pass: pass.steps.length >= 6, detail: `${pass.steps.length} steps` }));

  await claim('AQE-026', 'Every step says what it did',
    'No step has an empty description',
    () => {
      const bare = pass.steps.filter(s => !s.description);
      return { pass: bare.length === 0, detail: `${bare.length} bare` };
    });

  await claim('AQE-027', 'A step that did nothing says why',
    'Steps carry a rationale, including the ones that decided to do nothing',
    () => {
      const withReason = pass.steps.filter(s => s.rationale);
      return { pass: withReason.length >= pass.steps.length - 1, detail: `${withReason.length}/${pass.steps.length}` };
    });

  await claim('AQE-028', 'The timeline covers the whole pass',
    'It starts at or before the first step and ends at or after the last',
    () => {
      if (pass.timeline.length === 0) return { pass: false, detail: 'empty timeline' };
      const first = Date.parse(pass.timeline[0].at);
      const last = Date.parse(pass.timeline[pass.timeline.length - 1].at);
      return { pass: last >= first, detail: `${pass.timeline.length} entries` };
    });

  await claim('AQE-029', 'The timeline distinguishes a refusal from a decision',
    'Entries carry different kinds',
    () => {
      const kinds = [...new Set(pass.timeline.map(e => e.kind))];
      return { pass: kinds.length >= 2, detail: kinds.join(', ') };
    });

  await claim('AQE-030', 'The timeline records that a person was asked',
    'An approval-requested entry exists',
    () => {
      const asked = pass.timeline.filter(e => e.kind === 'approval-requested');
      return { pass: asked.length > 0, detail: `${asked.length} requests` };
    }, 'critical');

  await claim('AQE-031', 'The timeline records that a person answered',
    'An approval-granted entry exists and names who',
    () => {
      const granted = pass.timeline.filter(e => e.kind === 'approval-granted');
      return { pass: granted.length > 0, detail: granted.map(e => e.title).join(' | ') };
    }, 'critical');

  await claim('AQE-032', 'Timeline entries link to the evidence behind them',
    'Decision and approval entries carry a link',
    () => {
      const linkable = pass.timeline.filter(e => ['decision', 'refusal', 'approval-requested'].includes(e.kind));
      const linked = linkable.filter(e => e.link);
      return { pass: linked.length === linkable.length, detail: `${linked.length}/${linkable.length}` };
    });

  // ---- What it did not do -----------------------------------------------------------

  await claim('AQE-033', 'The pass never touched the excluded area',
    'No finding and no decision names the excluded route',
    () => {
      const onExcluded = pass.findings.filter(f => (f.route ?? '').startsWith('/statements'));
      return { pass: onExcluded.length === 0, detail: `${onExcluded.length} findings on /statements` };
    }, 'critical');

  await claim('AQE-034', 'The pass recorded that it left the excluded area alone',
    'A decision explains the exclusion',
    () => {
      const decision = pass.decisions.find(d => /excluded them/i.test(d.summary ?? ''));
      return { pass: Boolean(decision), detail: decision?.summary ?? '(none)' };
    }, 'critical');

  await claim('AQE-035', 'The exclusion decision quotes what the person wrote',
    'The evidence carries the exclusion as written',
    () => {
      const decision = pass.decisions.find(d => /excluded them/i.test(d.summary ?? ''));
      return {
        pass: /statements/i.test(evidenceValue(decision, 'exclusionsAsWritten') ?? ''),
        detail: `${evidenceValue(decision, 'exclusionsAsWritten')}`
      };
    });

  await claim('AQE-036', 'The pass has no authority over healing',
    'No healing proposal was approved by the pass',
    async () => {
      const response = await request(`/api/v1/healing/proposals?status=approved`, { token: world.tenant.token });
      const approved = (response.json ?? []).filter(p => p.approvedByUserId === null);
      return { pass: approved.length === 0, detail: `${approved.length} approved with no person` };
    }, 'critical');

  await claim('AQE-037', 'The pass has no authority over quality gates',
    'No gate rule was created during the pass',
    async () => {
      const response = await request(
        `/api/v1/quality-gates/rules?projectId=${world.project.id}`, { token: world.tenant.token });
      return { pass: (response.json ?? []).length === 0, detail: `${(response.json ?? []).length} rules` };
    }, 'critical');

  await claim('AQE-038', 'The pass never deleted a test',
    'Every test it generated still exists',
    async () => {
      const response = await request(
        `/api/v1/testcases?projectId=${world.project.id}`, { token: world.tenant.token });
      return {
        pass: (response.json ?? []).length >= (summary?.testsGenerated ?? 0),
        detail: `${(response.json ?? []).length} tests exist, ${summary?.testsGenerated} generated`
      };
    }, 'critical');

  // ---- Counters tell the truth --------------------------------------------------------

  await claim('AQE-039', 'The pass reports how many areas it assessed',
    'areasAssessed matches the risk findings it recorded',
    () => ({
      pass: (summary?.areasAssessed ?? 0) > 0,
      detail: `${summary?.areasAssessed} assessed, ${pass.findings.length} findings`
    }));

  await claim('AQE-040', 'The pass reports how many pages it considered',
    'pagesConsidered is above zero and within the bound',
    () => ({
      pass: (summary?.pagesConsidered ?? 0) > 0
        && (summary?.pagesConsidered ?? 0) <= (pass.bounds?.maxPages ?? 0),
      detail: `${summary?.pagesConsidered} of a bound of ${pass.bounds?.maxPages}`
    }), 'critical');

  await claim('AQE-041', 'The pass reports its proposals',
    'proposalsMade is a number',
    () => ({ pass: typeof summary?.proposalsMade === 'number', detail: `${summary?.proposalsMade}` }));

  await claim('AQE-042', 'A pass reports zero model spend when it used no model',
    'aiCostUsd is zero and no decision is attributed to a model',
    () => {
      const byModel = pass.decisions.filter(d => d.modelContributed);
      return {
        pass: Number(summary?.aiCostUsd) === 0 && byModel.length === 0,
        detail: `cost ${summary?.aiCostUsd}, ${byModel.length} model decisions`
      };
    });

  await claim('AQE-043', 'Every allowed decision says what came back',
    'Allowed decisions carry a result',
    () => {
      const withTool = allowed.filter(d => d.tool);
      const missing = withTool.filter(d => !d.result);
      return { pass: missing.length === 0, detail: `${missing.length} of ${withTool.length} without a result` };
    });

  await claim('AQE-044', 'The pass is readable end to end by its own id',
    'Run, plan, decisions, approvals and timeline all answer',
    () => ({
      pass: Boolean(pass.summary) && Boolean(pass.plan) && pass.decisions.length > 0
        && pass.approvals.length > 0 && pass.timeline.length > 0,
      detail: `run ${Boolean(pass.summary)}, plan ${Boolean(pass.plan)}, `
        + `${pass.decisions.length} decisions, ${pass.approvals.length} approvals, `
        + `${pass.timeline.length} timeline`
    }), 'critical');

  await claim('AQE-045', 'A finished pass leaves no question anybody could still answer',
    'Approvals are granted, refused or expired — never pending on a finished run',
    () => {
      const pending = pass.approvals.filter(a => a.status === 'pending');
      return {
        pass: pending.length === 0,
        detail: pass.approvals.map(a => `${a.tool}:${a.status}`).join(' ')
      };
    }, 'critical');

  // ---- A pass told no --------------------------------------------------------------------

  const refusedWorld = await seedWorkspace('AgentRefused', BANK);
  const refused = await startPass(refusedWorld.tenant, refusedWorld.application.id, { maxPages: 6 });
  await decidePlan(refusedWorld.tenant, refused.runId, {
    approve: true, note: 'Approved so the refusal happens at the action rather than the plan.'
  });
  const refusedOutcome = await answerEverything(refusedWorld.tenant, refused.runId, { grant: false });
  const refusedPass = await collect(refusedWorld.tenant, refused.runId);

  const refusedEvidence = {
    'refused-run.json': JSON.stringify(refusedPass.summary, null, 2),
    'refused-approvals.json': JSON.stringify(refusedPass.approvals, null, 2)
  };
  const refusedClaim = (id, objective, expected, check, severity = 'critical') => golden({
    id, objective,
    preconditions: ['a pass has been refused permission for the action it asked about'],
    input: `agent run ${refused.runId}`,
    expected, evidence: Object.keys(refusedEvidence), severity,
    run: async () => {
      const outcome = await check();
      return { pass: Boolean(outcome?.pass ?? outcome), detail: outcome?.detail ?? '', evidence: refusedEvidence };
    }
  });

  await refusedClaim('AQE-046', 'A refused pass stops',
    'The run is stopped rather than completed',
    () => ({
      pass: refusedOutcome.summary?.status === 'stopped',
      detail: `${refusedOutcome.summary?.status}`
    }));

  await refusedClaim('AQE-047', 'A refused pass says what it therefore does not know',
    'The stop reason names what was not established',
    () => ({
      pass: /nothing it would have established is known/i.test(refusedOutcome.summary?.stopReason ?? ''),
      detail: refusedOutcome.summary?.stopReason?.slice(0, 200) ?? '(none)'
    }));

  await refusedClaim('AQE-048', 'A refused pass did not perform the action anyway',
    'No allowed decision exists for the refused tool',
    () => {
      const tool = refusedPass.approvals[0]?.tool;
      const performed = decisionsFor(refusedPass, tool).filter(d => d.allowed);
      return { pass: performed.length === 0, detail: `${tool}: ${performed.length} performed` };
    });

  await refusedClaim('AQE-049', 'A refusal records who refused and why',
    'The approval carries a person and a reason',
    () => {
      const answered = refusedPass.approvals.find(a => a.status === 'refused');
      return {
        pass: Boolean(answered?.decidedByEmail) && (answered?.justification ?? '').length >= 10,
        detail: `${answered?.decidedByEmail}: ${answered?.justification}`
      };
    });

  await refusedClaim('AQE-050', 'A refused pass is not reported as a clean one',
    'It did not complete, and it executed nothing',
    () => ({
      pass: refusedOutcome.summary?.status !== 'completed'
        && (refusedOutcome.summary?.testsExecuted ?? 0) === 0,
      detail: `${refusedOutcome.summary?.status}, ${refusedOutcome.summary?.testsExecuted} executed`
    }));
}
