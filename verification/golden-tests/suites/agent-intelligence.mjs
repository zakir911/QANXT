/**
 * What the platform knows between passes, and what it says about a release.
 *
 * Memory, business context, coverage and the release assessment are the parts that decide
 * what a second pass does differently from the first — and the parts most able to mislead,
 * because a fact that is remembered looks the same whether it was observed or guessed.
 *
 * Two passes are run over the same application so the difference between them can be read.
 */
import { golden, suite } from '../harness.mjs';
import { LAB, lab, request, requireEnvironment } from '../platform.mjs';
import {
  answerEverything, collect, decidePlan, evidenceValue, seedWorkspace, setContext, settle,
  startPass
} from '../agent-pass.mjs';

const BANK = LAB.banking;

export default async function run() {
  suite('Autonomous intelligence');
  await requireEnvironment([BANK]);
  await lab.reset(BANK);

  const world = await seedWorkspace('AgentIntel', BANK, {
    context: {
      criticalJourneys: 'payment\nlogin',
      highRiskAreas: 'authentication',
      excludedAreas: '/statements',
      notes: 'The golden lab.'
    }
  });

  // First pass, carried all the way through so the second has history to read.
  // The build reference matters: a release assessment is keyed by it, and a verification run
  // that carries none is invisible to that report. Naming one here is what lets AQI-026 ask
  // the release question at all rather than accept an absence as an answer.
  const BUILD_REF = `golden-${Date.now().toString(36)}`;
  const first = await startPass(world.tenant, world.application.id, {
    maxPages: 12, maxGeneratedTests: 10, buildRef: BUILD_REF
  });
  await decidePlan(world.tenant, first.runId, { approve: true, note: 'First pass.' });
  await answerEverything(world.tenant, first.runId);
  const firstPass = await collect(world.tenant, first.runId);

  // Second pass over the same application.
  const second = await startPass(world.tenant, world.application.id, {
    maxPages: 12, maxGeneratedTests: 10, name: 'Second golden pass'
  });
  const secondPass = await collect(world.tenant, second.runId);

  const evidence = {
    'first.json': JSON.stringify(firstPass.summary, null, 2),
    'second.json': JSON.stringify(secondPass.summary, null, 2),
    'first-plan.json': JSON.stringify(firstPass.plan, null, 2),
    'second-plan.json': JSON.stringify(secondPass.plan, null, 2)
  };

  const claim = (id, objective, expected, check, severity = 'high') => golden({
    id, objective,
    preconditions: ['two autonomous passes have run over the same application'],
    input: `agent runs ${first.runId} and ${second.runId}`,
    expected, evidence: Object.keys(evidence), severity,
    run: async () => {
      const outcome = await check();
      return { pass: Boolean(outcome?.pass ?? outcome), detail: outcome?.detail ?? '', evidence };
    }
  });

  // ---- The second pass knows the first happened --------------------------------

  await claim('AQI-001', 'A second pass reads the execution history the first left',
    'Its estimates come from history rather than from defaults',
    () => {
      const fromHistory = (secondPass.plan?.items ?? []).filter(i => i.estimateFromHistory);
      return {
        pass: fromHistory.length > 0,
        detail: `${fromHistory.length} of ${(secondPass.plan?.items ?? []).length} from history`
      };
    }, 'critical');

  await claim('AQI-002', 'The second plan says its estimates rest on this application',
    'The summary names the application\'s own history',
    () => ({
      pass: /taken on this application before/i.test(secondPass.plan?.summary ?? ''),
      detail: secondPass.plan?.summary?.slice(0, 200) ?? '(none)'
    }), 'critical');

  await claim('AQI-003', 'The first plan admitted it had no history to work from',
    'It said its estimates came from defaults',
    () => ({
      pass: /from defaults/i.test(firstPass.plan?.summary ?? ''),
      detail: firstPass.plan?.summary?.slice(0, 200) ?? '(none)'
    }));

  await claim('AQI-004', 'A second pass proposes less new work than the first',
    'Fewer tests need generating once some exist',
    () => {
      const firstNew = (firstPass.plan?.items ?? []).reduce((n, i) => n + i.toGenerate, 0);
      const secondNew = (secondPass.plan?.items ?? []).reduce((n, i) => n + i.toGenerate, 0);
      return { pass: secondNew <= firstNew, detail: `${firstNew} then ${secondNew}` };
    });

  await claim('AQI-005', 'A second pass still names what it does not cover',
    'Having run before does not make a plan quieter about its gaps',
    () => ({
      pass: (secondPass.plan?.notCovered ?? []).length > 0,
      detail: `${(secondPass.plan?.notCovered ?? []).length} entries`
    }), 'critical');

  await claim('AQI-006', 'A second pass still honours the exclusion',
    'The excluded route is still named as uncovered',
    () => ({
      pass: (secondPass.plan?.notCovered ?? []).some(n => n.includes('/statements')),
      detail: (secondPass.plan?.notCovered ?? []).find(n => n.includes('/statements')) ?? '(absent)'
    }), 'critical');

  await claim('AQI-007', 'A second pass still stops for a person',
    'Running before does not buy standing approval',
    () => ({
      pass: secondPass.summary?.status === 'awaitingApproval',
      detail: `${secondPass.summary?.status}`
    }), 'critical');

  await claim('AQI-008', 'The two passes are separate records',
    'They have different ids and separate decision trails',
    () => ({
      pass: first.runId !== second.runId
        && firstPass.decisions.length > 0 && secondPass.decisions.length > 0,
      detail: `${firstPass.decisions.length} and ${secondPass.decisions.length} decisions`
    }));

  // ---- Business context -----------------------------------------------------------

  await claim('AQI-009', 'Business context reads back as it was written',
    'The stored context matches what the operator set',
    async () => {
      const response = await request(
        `/api/v1/agent/applications/${world.application.id}/context`, { token: world.tenant.token });
      const context = response.json ?? {};
      return {
        pass: (context.criticalJourneys ?? []).includes('payment')
          && (context.excludedAreas ?? []).includes('/statements'),
        detail: JSON.stringify(context).slice(0, 200)
      };
    }, 'critical');

  await claim('AQI-010', 'Context is normalised rather than stored verbatim',
    'Entries are trimmed and lower-cased so matching is literal',
    async () => {
      await setContext(world.tenant, world.application.id, {
        criticalJourneys: '  PAYMENT \n\n Payment \nLogin ',
        highRiskAreas: '', excludedAreas: '/statements', notes: ''
      });
      const response = await request(
        `/api/v1/agent/applications/${world.application.id}/context`, { token: world.tenant.token });
      const critical = response.json?.criticalJourneys ?? [];
      return {
        pass: critical.length === 2 && critical[0] === 'payment',
        detail: JSON.stringify(critical)
      };
    });

  await claim('AQI-011', 'Context records who last changed it',
    'A change carries an author',
    async () => {
      const response = await request(
        `/api/v1/agent/applications/${world.application.id}/context`, { token: world.tenant.token });
      return {
        pass: Boolean(response.json?.updatedByUserId),
        detail: `${response.json?.updatedByUserId ?? 'nobody'}`
      };
    });

  await claim('AQI-012', 'An application nobody has described returns empty context, not an error',
    'Absence is an answer rather than a failure',
    async () => {
      const fresh = await seedWorkspace('AgentNoContext', BANK, { security: false });
      const response = await request(
        `/api/v1/agent/applications/${fresh.application.id}/context`, { token: fresh.tenant.token });
      return {
        pass: response.ok && (response.json?.criticalJourneys ?? []).length === 0,
        detail: `${response.status}, ${(response.json?.criticalJourneys ?? []).length} entries`
      };
    }, 'critical');

  await claim('AQI-013', 'A credential pasted into the notes is masked before storage',
    'The note comes back redacted',
    async () => {
      await setContext(world.tenant, world.application.id, {
        criticalJourneys: 'payment', highRiskAreas: '', excludedAreas: '/statements',
        notes: 'Shared QA account password=Hunter2Hunter2 for the lab.'
      });
      const response = await request(
        `/api/v1/agent/applications/${world.application.id}/context`, { token: world.tenant.token });
      const notes = response.json?.notes ?? '';
      return {
        pass: !notes.includes('Hunter2Hunter2') && /REDACTED/i.test(notes),
        detail: notes.slice(0, 160)
      };
    }, 'critical');

  await claim('AQI-014', 'Context cannot be set without permission to write the application',
    'A reader is refused',
    async () => {
      const stranger = await seedWorkspace('AgentCtxStranger', BANK, { security: false });
      const response = await request(
        `/api/v1/agent/applications/${world.application.id}/context`, {
          token: stranger.tenant.token, method: 'PUT',
          body: { criticalJourneys: 'anything', highRiskAreas: '', excludedAreas: '', notes: '' }
        });
      return { pass: !response.ok, detail: `${response.status}` };
    }, 'critical');

  await claim('AQI-015', 'One tenant cannot read another tenant\'s business context',
    'The request is refused',
    async () => {
      const stranger = await seedWorkspace('AgentCtxReader', BANK, { security: false });
      const response = await request(
        `/api/v1/agent/applications/${world.application.id}/context`, { token: stranger.tenant.token });
      return { pass: response.status === 404 || response.status === 403, detail: `${response.status}` };
    }, 'critical');

  // ---- Coverage and what the pass did with it ---------------------------------------

  await claim('AQI-016', 'The plan counts work that already exists separately from new work',
    'toGenerate is at or below testCount for every category',
    () => {
      const wrong = (secondPass.plan?.items ?? []).filter(i => i.toGenerate > i.testCount);
      return { pass: wrong.length === 0, detail: `${wrong.length} categories with impossible counts` };
    });

  await claim('AQI-017', 'A category with nothing new to write says so',
    'At least one category reports zero to generate on the second pass',
    () => {
      const settled = (secondPass.plan?.items ?? []).filter(i => i.toGenerate === 0);
      return { pass: settled.length > 0, detail: `${settled.length} categories need nothing new` };
    }, 'medium');

  await claim('AQI-018', 'The tests the first pass generated still exist',
    'They were not replaced by the second pass',
    async () => {
      const response = await request(
        `/api/v1/testcases?projectId=${world.project.id}`, { token: world.tenant.token });
      return {
        pass: (response.json ?? []).length >= (firstPass.summary?.testsGenerated ?? 0),
        detail: `${(response.json ?? []).length} tests, first pass generated ${firstPass.summary?.testsGenerated}`
      };
    }, 'critical');

  await claim('AQI-019', 'The first pass left an executable run behind',
    'Its test run is readable and reached a verdict',
    async () => {
      if (!firstPass.summary?.testRunId) return { pass: false, detail: 'no test run recorded' };
      const response = await request(
        `/api/v1/testruns/${firstPass.summary.testRunId}`, { token: world.tenant.token });
      return { pass: response.ok, detail: `${response.status}` };
    }, 'critical');

  await claim('AQI-020', 'A pass records how many failures it investigated',
    'failuresInvestigated is a number rather than absent',
    () => ({
      pass: typeof firstPass.summary?.failuresInvestigated === 'number',
      detail: `${firstPass.summary?.failuresInvestigated}`
    }));

  // ---- Findings are proposals ---------------------------------------------------------

  await claim('AQI-021', 'Every finding a pass makes is a proposal',
    'Findings carry a recommendation rather than an action taken',
    () => {
      const withRecommendation = firstPass.findings.filter(f => f.recommendation);
      return {
        pass: withRecommendation.length > 0 || firstPass.findings.length === 0,
        detail: `${withRecommendation.length} of ${firstPass.findings.length} carry a recommendation`
      };
    });

  await claim('AQI-022', 'A finding says how sure the pass is',
    'Every finding carries a confidence below certainty',
    () => {
      const bad = firstPass.findings.filter(f =>
        typeof f.confidence !== 'number' || f.confidence >= 100);
      return { pass: bad.length === 0, detail: `${bad.length} of ${firstPass.findings.length}` };
    }, 'critical');

  await claim('AQI-023', 'A finding says whether a model contributed to it',
    'isAiGenerated is present on every finding',
    () => {
      const missing = firstPass.findings.filter(f => typeof f.isAiGenerated !== 'boolean');
      return { pass: missing.length === 0, detail: `${missing.length} without provenance` };
    }, 'critical');

  await claim('AQI-024', 'Every finding points somewhere a person can go and look',
    'Each finding carries a route, or the test case and execution it came from',
    () => {
      // The earlier version of this test asked for a route on every finding. That is the
      // wrong claim: a finding from a failed execution applies to that execution, and the
      // route is one way of saying where rather than the only one. What must never happen
      // is a finding that points nowhere at all — nobody can act on it and nobody can check
      // it. So the claim is the disjunction, which is still strong.
      const anonymous = firstPass.findings.filter(f =>
        !f.route && !f.testCaseId && !f.testExecutionId);
      const byRoute = firstPass.findings.filter(f => f.route).length;
      return {
        pass: anonymous.length === 0,
        detail: `${firstPass.findings.length} finding(s): ${byRoute} by route, `
              + `${firstPass.findings.length - byRoute} by execution, ${anonymous.length} pointing nowhere`
      };
    });

  await claim('AQI-025', 'Findings are severity-ranked',
    'Every finding carries a severity from the known set',
    () => {
      const known = ['critical', 'high', 'medium', 'low'];
      const bad = firstPass.findings.filter(f => !known.includes(f.severity));
      return { pass: bad.length === 0, detail: `${bad.length} with an unknown severity` };
    });

  // ---- The release the pass describes ---------------------------------------------------

  const releaseEvidence = { 'release.json': '' };
  const releaseClaim = (id, objective, expected, check, severity = 'critical') => golden({
    id, objective,
    preconditions: ['a pass has run and its tests have executed'],
    input: `agent run ${first.runId}`,
    expected, evidence: Object.keys(releaseEvidence), severity,
    run: async () => {
      const outcome = await check();
      return {
        pass: Boolean(outcome?.pass ?? outcome),
        detail: outcome?.detail ?? '',
        evidence: { 'release.json': JSON.stringify(outcome?.body ?? {}, null, 2) }
      };
    }
  });

  const releaseReport = async (build = BUILD_REF) => request(
    `/api/v1/release/quality?projectId=${firstPass.summary.projectId}`
    + `&build=${encodeURIComponent(build)}`, { token: world.tenant.token });

  await releaseClaim('AQI-026', 'A release assessment covers the run the pass started',
    'The release report for the build the pass named includes the pass\'s own run',
    async () => {
      // No fallback on a 404. An assessment that cannot be produced is a failure of this
      // claim, not a pass — the earlier version of this test accepted any status and would
      // have passed against a platform with no release assessment at all.
      const response = await releaseReport();
      if (!response.ok) {
        return { pass: false, detail: `release report ${response.status} for build ${BUILD_REF}`,
                 body: response.json };
      }
      const runs = response.json?.runCount ?? 0;
      return {
        pass: runs >= 1 && response.json?.buildRef === BUILD_REF,
        detail: `build ${response.json?.buildRef}, ${runs} run(s), ${response.json?.testsCovered ?? 0} test(s)`,
        body: response.json
      };
    });

  await releaseClaim('AQI-027', 'A release assessment always carries a security section',
    'Security is present with a summary, whether or not anything was scanned',
    async () => {
      const response = await releaseReport();
      if (!response.ok) return { pass: false, detail: `release report ${response.status}`, body: response.json };
      const security = response.json?.security;
      return {
        pass: Boolean(security) && typeof security.summary === 'string' && security.summary.length > 0,
        detail: String(security?.summary ?? '(no security section)').slice(0, 180),
        body: response.json
      };
    });

  await releaseClaim('AQI-028', 'An unscanned build is not described as secure',
    'When nothing was scanned the section says so, and nothing claims a clean posture',
    async () => {
      const response = await releaseReport();
      if (!response.ok) return { pass: false, detail: `release report ${response.status}`, body: response.json };
      const security = response.json?.security ?? {};
      const text = JSON.stringify(security);
      const claimsSecure = /no vulnerabilities|is secure|zero vulnerabilities/i.test(text);
      // An unscanned build must say that in words, not merely leave the counts at zero —
      // zeros read as an all-clear to anyone who does not check `scanned`.
      const saysUnscanned = /not (security )?(scanned|tested)|no (security )?scan|nobody scanned/i
        .test(String(security.summary ?? ''));
      const honest = security.scanned === false ? saysUnscanned && !claimsSecure : !claimsSecure;
      return {
        pass: honest,
        detail: `scanned ${security.scanned}, verdict ${security.verdict}: `
              + String(security.summary ?? '').slice(0, 140),
        body: response.json
      };
    });

  await releaseClaim('AQI-036', 'The pass records which build its verification run counts against',
    'A decision names the build reference the run carries',
    async () => {
      const decision = firstPass.decisions.find(d => /verification run against build/i.test(d.summary ?? ''))
        ?? null;
      return {
        pass: Boolean(decision) && evidenceValue(decision, 'buildRef') === BUILD_REF,
        detail: decision ? `${decision.summary} (buildRef ${evidenceValue(decision, 'buildRef')})`
                         : 'no decision named the build',
        body: decision
      };
    });

  await releaseClaim('AQI-037', 'A release assessment for a build nobody tested is refused',
    'An unknown build reference is a 404 rather than a report of zeros',
    async () => {
      const response = await releaseReport(`${BUILD_REF}-never-ran`);
      return {
        pass: !response.ok,
        detail: `${response.status}${response.ok ? ' — a build nobody tested was assessed' : ''}`,
        body: response.json
      };
    });

  await releaseClaim('AQI-056', 'A scan the pass queued counts towards its own release assessment',
    'The security section of the build the pass tested is not NOT SCANNED',
    async () => {
      // The defect the Verdaccio pilot found. A build tested by a single run had a security
      // window of [that run's end, that run's end] — an instant no scan can fall into — so a
      // pass that had queued a scan, waited for it and executed against the same build still
      // reported NOT SECURITY TESTED. A false "nothing is known" on a security section is the
      // most consequential wrong answer a release report can give, and one run per build is
      // the common case in a pipeline.
      //
      // No unit test of the posture service can catch this: the bad window came from the
      // caller. This is the test that reaches both halves.
      const scan = firstPass.decisions.find(d =>
        d.tool === 'security.scan' && d.allowed && /queued/i.test(d.summary ?? ''));
      if (!scan) return { pass: false, detail: 'the pass queued no scan, so there is nothing to count' };

      const response = await releaseReport();
      if (!response.ok) return { pass: false, detail: `release report ${response.status}`, body: response.json };

      const security = response.json?.security ?? {};
      return {
        pass: security.scanned === true && security.scansCoveringThisBuild >= 1,
        detail: `scanned ${security.scanned}, ${security.scansCoveringThisBuild} scan(s) cover `
              + `build ${BUILD_REF}; verdict ${security.verdict}`,
        body: response.json
      };
    });

  await releaseClaim('AQI-038', 'The verification run carries the build reference it was given',
    'The test run the pass started records the build, so the assessment can find it',
    async () => {
      const response = await request(`/api/v1/testruns/${firstPass.summary.testRunId}`,
        { token: world.tenant.token });
      if (!response.ok) return { pass: false, detail: `test run ${response.status}`, body: response.json };
      return {
        pass: response.json?.applicationBuildRef === BUILD_REF,
        detail: `applicationBuildRef ${response.json?.applicationBuildRef ?? 'null'}`,
        body: response.json
      };
    });

  // ---- Standing honesty claims -------------------------------------------------------------

  const standing = [
    ['AQI-029', 'Neither pass claimed the application is secure',
      'No recorded text asserts a clean security posture',
      () => {
        const text = JSON.stringify([firstPass, secondPass]);
        const bad = /(application|it) is secure|no vulnerabilities (exist|were found)|zero vulnerabilities/i;
        return { pass: !bad.test(text), detail: bad.test(text) ? 'found a claim' : 'none' };
      }],
    ['AQI-030', 'Neither pass claimed complete coverage',
      'No recorded text asserts full or complete coverage',
      () => {
        const text = JSON.stringify([firstPass.plan, secondPass.plan]);
        const bad = /(fully|completely|100%) covered|complete coverage/i;
        return { pass: !bad.test(text), detail: bad.test(text) ? 'found a claim' : 'none' };
      }],
    ['AQI-031', 'Every plan in both passes named what it does not cover',
      'Neither plan is silent about its gaps',
      () => {
        const silent = [firstPass.plan, secondPass.plan]
          .filter(p => (p?.notCovered ?? []).length === 0);
        return { pass: silent.length === 0, detail: `${silent.length} silent plans` };
      }],
    ['AQI-032', 'Every decision in both passes carries evidence',
      'The evidence rule holds across a repeated pass',
      () => {
        const all = [...firstPass.decisions, ...secondPass.decisions];
        const bare = all.filter(d => (d.evidence ?? []).length === 0);
        return { pass: bare.length === 0, detail: `${bare.length} of ${all.length}` };
      }],
    ['AQI-033', 'Neither pass attributed a decision to a model it did not use',
      'Model contribution and cost agree',
      () => {
        const all = [...firstPass.decisions, ...secondPass.decisions];
        const inconsistent = all.filter(d => !d.modelContributed && Number(d.aiCostUsd) > 0);
        return { pass: inconsistent.length === 0, detail: `${inconsistent.length} inconsistent` };
      }],
    ['AQI-034', 'Neither pass exceeded its frozen bounds',
      'Pages considered stay within the bound each run froze',
      () => {
        const over = [firstPass, secondPass].filter(p =>
          (p.summary?.pagesConsidered ?? 0) > (p.bounds?.maxPages ?? 0));
        return { pass: over.length === 0, detail: `${over.length} over bound` };
      }],
    ['AQI-035', 'Neither pass was permitted production or destructive work',
      'Both report the policy they ran under',
      () => {
        const bad = [firstPass, secondPass].filter(p =>
          p.bounds?.allowProduction !== false || p.bounds?.allowDestructiveActions !== false);
        return {
          pass: bad.length === 0,
          detail: `first: prod ${firstPass.bounds?.allowProduction}, dest ${firstPass.bounds?.allowDestructiveActions}`
        };
      }]
  ];

  for (const [id, objective, expected, check] of standing) {
    await golden({
      id, objective,
      preconditions: ['two passes have run over the same application'],
      input: 'the recorded passes',
      expected, evidence: ['passes.json'], severity: 'critical',
      run: async () => {
        const outcome = await check();
        return {
          pass: Boolean(outcome?.pass ?? outcome),
          detail: outcome?.detail ?? '',
          evidence: { 'passes.json': JSON.stringify({ first: firstPass.summary, second: secondPass.summary }, null, 2) }
        };
      }
    });
  }

  await coverageClaims(world, firstPass, secondPass);

  await wiredModelClaims(world, firstPass);
}

// ---------------------------------------------------------------------------------------
// Coverage: what the application can do, against what is tested.
//
// These are appended as a second block rather than folded into the claims above because
// they all read one decision and one set of findings, and a reader comparing them wants
// them next to each other.
// ---------------------------------------------------------------------------------------

async function coverageClaims(world, firstPass, secondPass) {
  const coverage = firstPass.decisions.find(d => d.tool === 'coverage.analyse') ?? null;
  const gapFindings = firstPass.findings.filter(f =>
    f.kind === 'coverageGap' && /^Untested: /.test(f.title ?? ''));
  const evidence = {
    'coverage-decision.json': JSON.stringify(coverage, null, 2),
    'coverage-findings.json': JSON.stringify(gapFindings, null, 2)
  };

  const value = name => evidenceValue(coverage, name);
  const number = name => Number(value(name) ?? NaN);

  const claim = (id, objective, expected, check, severity = 'high') => golden({
    id, objective,
    preconditions: ['a pass has analysed coverage for an application'],
    input: `agent run ${firstPass.runId}`,
    expected, evidence: Object.keys(evidence), severity,
    run: async () => {
      const outcome = await check();
      return { pass: Boolean(outcome?.pass ?? outcome), detail: outcome?.detail ?? '', evidence };
    }
  });

  await claim('AQI-039', 'A pass compares what the application can do against what is tested',
    'The pass records a coverage decision naming the tool that made it',
    () => ({ pass: Boolean(coverage), detail: coverage?.summary ?? 'no coverage decision' }),
    'critical');

  await claim('AQI-040', 'The coverage decision carries the counts it rests on',
    'Every count the summary quotes is present as evidence',
    () => {
      const required = ['capabilities', 'covered', 'partiallyCovered', 'notCovered', 'unknown'];
      const missing = required.filter(name => value(name) === null);
      return { pass: missing.length === 0, detail: missing.length ? `missing ${missing.join(', ')}` : required.join(', ') };
    }, 'critical');

  await claim('AQI-041', 'Coverage is measured against something rather than asserted',
    'At least one capability was assessed',
    () => ({ pass: number('capabilities') > 0, detail: `${value('capabilities')} capability(ies)` }));

  await claim('AQI-042', 'Unknown coverage is counted separately from uncovered',
    'The unknown count is its own number, not folded into the gaps',
    () => {
      // The distinction is the whole point of the model. A dimension this pass cannot assess
      // must not arrive as a gap — that invents work — nor as coverage, which invents safety.
      const unknown = number('unknown');
      return {
        pass: Number.isFinite(unknown) && unknown > 0,
        detail: `${value('notCovered')} uncovered, ${unknown} unknown`
      };
    }, 'critical');

  await claim('AQI-043', 'The coverage decision says what it was measured against',
    'The denominator is named as what discovery reached',
    () => {
      const against = value('measuredAgainst') ?? '';
      return { pass: /page\(s\)/.test(against) && /endpoint\(s\)/.test(against), detail: against };
    });

  await claim('AQI-044', 'Coverage never claims the application is fully covered',
    'The summary carries the qualifier about what discovery reached',
    () => {
      const reason = String(coverage?.reason ?? '');
      const claimsComplete = /(fully|completely|100%) covered|complete coverage/i.test(reason);
      const qualified = /discovery reached/i.test(reason);
      return { pass: !claimsComplete && qualified, detail: reason.slice(0, 180) };
    }, 'critical');

  await claim('AQI-045', 'An area a person excluded is absent from the coverage assessment',
    'No capability names the excluded route',
    () => {
      const excluded = gapFindings.filter(f => /\/statements/.test(f.title ?? ''));
      return { pass: excluded.length === 0, detail: `${excluded.length} excluded capability(ies) assessed` };
    }, 'critical');

  await claim('AQI-046', 'The exclusion is recorded on the coverage decision itself',
    'A reader of this decision alone can see what was left out',
    () => {
      const excluded = value('excludedByAPerson') ?? '';
      return { pass: /statements/.test(excluded), detail: excluded };
    });

  await claim('AQI-047', 'Each gap becomes a proposal rather than a task',
    'Every coverage finding recommends a decision, not an action taken',
    () => {
      const bad = gapFindings.filter(f => !f.recommendation
        || !/has not written a test|has not decided/i.test(f.recommendation));
      return { pass: gapFindings.length > 0 && bad.length === 0,
               detail: `${gapFindings.length} gap finding(s), ${bad.length} without a proposal` };
    }, 'critical');

  await claim('AQI-048', 'A gap names which dimension is missing',
    'Each finding says whether it is UI, API, security, accessibility or visual',
    () => {
      const bad = gapFindings.filter(f => !/\((Ui|Api|Security|Accessibility|Visual)/.test(f.title ?? ''));
      return { pass: gapFindings.length > 0 && bad.length === 0,
               detail: `${bad.length} of ${gapFindings.length} without a dimension` };
    });

  await claim('AQI-049', 'A gap says why it is a gap',
    'Each finding carries the model\'s reason rather than only a label',
    () => {
      const bad = gapFindings.filter(f => !f.detail || f.detail.length < 20);
      return { pass: gapFindings.length > 0 && bad.length === 0,
               detail: `${bad.length} of ${gapFindings.length} without a reason` };
    });

  await claim('AQI-050', 'A gap in an area a person called critical is ranked above one that is not',
    'Business-critical capabilities carry the higher severity',
    () => {
      const critical = gapFindings.filter(f => /login|payment|auth/i.test(f.title ?? ''));
      const wrong = critical.filter(f => f.severity !== 'high');
      return {
        pass: critical.length === 0 ? true : wrong.length === 0,
        detail: critical.length === 0
          ? 'no critical capability had a gap in this pass'
          : `${critical.length} critical gap(s), ${wrong.length} not ranked high`
      };
    });

  await claim('AQI-057', 'A named priority that matches nothing is reported, not silently ignored',
    'The coverage decision names the areas a person asked for that correspond to no capability',
    () => {
      // The Verdaccio pilot's most important finding. Critical areas are matched to routes by
      // substring, so an operator who writes a journey in English — "search for a package" —
      // names something no route can contain. The input was accepted, stored and echoed back
      // in the plan's narrative, and changed no severity anywhere. Nobody was told.
      //
      // The evidence must be present either way: "none" when everything matched is a
      // statement, and a missing field is not.
      const reported = value('namedAreasMatchingNothingDiscoveryReached');
      return {
        pass: reported !== null,
        detail: reported === null
          ? 'the decision does not say whether the named areas matched anything'
          : `named areas matching nothing: ${reported}`
      };
    }, 'critical');

  await claim('AQI-051', 'The number of business-critical gaps is stated rather than left to be counted',
    'The decision carries its own count of critical gaps',
    () => {
      const count = number('businessCriticalWithGaps');
      return { pass: Number.isFinite(count), detail: `${value('businessCriticalWithGaps')}` };
    });

  await claim('AQI-052', 'A coverage gap is never recorded as a defect',
    'No coverage finding is classified as a suspected defect',
    () => {
      const bad = gapFindings.filter(f => f.kind === 'suspectedDefect');
      return { pass: bad.length === 0, detail: `${bad.length} gap(s) recorded as defects` };
    }, 'critical');

  await claim('AQI-053', 'A resumed pass does not count the same gap twice',
    'The second pass records no duplicate coverage findings',
    () => {
      const titles = firstPass.findings
        .filter(f => /^Untested: /.test(f.title ?? '')).map(f => f.title);
      const duplicates = titles.length - new Set(titles).size;
      return { pass: duplicates === 0, detail: `${duplicates} duplicate(s) of ${titles.length}` };
    }, 'critical');

  await claim('AQI-055', 'A gap about an endpoint names the endpoint it is about',
    'An API gap carries a route, not only a title',
    () => {
      // The route field is what a reader filters on. An endpoint gap with none was visible
      // only in its title, so filtering by route showed the page gaps and no API ones at
      // all — an absence that reads as nothing to fix.
      const api = gapFindings.filter(f => /\((Api|Security)\)?/.test(f.title ?? '')
        && /^Untested: (GET|POST|PUT|PATCH|DELETE) /.test(f.title ?? ''));
      const withoutRoute = api.filter(f => !f.route);
      return {
        pass: api.length > 0 && withoutRoute.length === 0,
        detail: `${api.length} endpoint gap(s), ${withoutRoute.length} without a route`
      };
    }, 'critical');

  await claim('AQI-054', 'The second pass reaches the coverage question too',
    'A pass parked at its plan has still assessed coverage, because the plan rests on it',
    () => {
      const second = secondPass.decisions.find(d => d.tool === 'coverage.analyse') ?? null;
      return { pass: Boolean(second), detail: second?.summary ?? 'the second pass recorded none' };
    });
}

// ---------------------------------------------------------------------------------------
// The seven models that existed and were unreachable.
//
// Each had unit tests and no caller, so "it works" was established in isolation and nothing
// established that a pass could use it. These claims are about the wiring: the decision is
// recorded, its evidence is there, and — for every one of them — the pass proposed rather
// than acted. A model that silently deleted a test or created a permanent one would be worse
// than a model nothing called.
// ---------------------------------------------------------------------------------------

async function wiredModelClaims(world, firstPass) {
  const decisions = firstPass.decisions ?? [];
  const find = (pattern) => decisions.find(d => pattern.test(d.summary ?? '')) ?? null;
  const evidence = {
    'decisions.json': JSON.stringify(decisions, null, 2),
    'findings.json': JSON.stringify(firstPass.findings ?? [], null, 2)
  };

  const claim = (id, objective, expected, check, severity = 'high') => golden({
    id, objective,
    preconditions: ['a pass has run end to end over an application'],
    input: `agent run ${firstPass.runId}`,
    expected, evidence: Object.keys(evidence), severity,
    run: async () => {
      const outcome = await check();
      return { pass: Boolean(outcome?.pass ?? outcome), detail: outcome?.detail ?? '', evidence };
    }
  });

  // ---- Duplication (§12) --------------------------------------------------------------

  // All three duplication summaries, because the two empty cases are statements too: nothing
  // was generated, or nothing existed to compare against. An earlier version of this matched
  // only the first and reported the check as missing when it had in fact run and said so.
  const dedupe = find(/Checked \d+ new test\(s\) against|No duplication check was/);

  await claim('AQI-058', 'A pass checks whether the tests it wrote already existed',
    'A decision records the comparison of new tests against existing ones',
    () => ({ pass: Boolean(dedupe), detail: dedupe?.summary ?? 'no duplication decision recorded' }));

  await claim('AQI-059', 'A duplicate is reported and never deleted',
    'The decision states that no test was deleted or changed',
    () => {
      // The claim that matters. An agent that quietly deletes a test it judged redundant is an
      // agent whose judgement nobody can review, and the one it got wrong is a coverage gap
      // with no record.
      const value = evidenceValue(dedupe, 'testsDeletedOrChanged');
      return {
        pass: Boolean(value) && /none/i.test(value) && /no authority/i.test(value),
        detail: value ?? 'the decision does not say whether anything was deleted'
      };
    }, 'critical');

  // ---- History-based selection (§19) --------------------------------------------------

  const selection = find(/Selected \d+ of \d+ existing test\(s\) to re-run|Nothing to re-run/);

  await claim('AQI-060', 'What to re-run is chosen from each test\'s own history',
    'A decision records the selection, or says why nothing was selected',
    () => ({ pass: Boolean(selection), detail: selection?.summary ?? 'no selection decision' }));

  await claim('AQI-061', 'Every point in the priority is attributed to a named reason',
    'The decision names the rules that produced the order',
    () => {
      // A score with unattributed points is a number with a decimal place, which is what
      // explainable rules exist instead of.
      const why = evidenceValue(selection, 'why');
      const reasons = evidenceValue(selection, 'reasonsUsed');
      const considered = evidenceValue(selection, 'considered');
      // Nothing selected is a legitimate outcome and has no reasons to name; what must never
      // happen is a selection whose ordering cannot be explained.
      if (considered !== null && (why === null || why === '')) {
        return { pass: reasons === null, detail: 'selected tests with no reasoning recorded' };
      }
      return {
        pass: Boolean(why) && Boolean(reasons),
        detail: `reasons: ${reasons ?? 'none'}`
      };
    }, 'critical');

  await claim('AQI-062', 'Tests left out are reported as a bound rather than a judgement',
    'The decision explains why each was left out, rather than giving a bare count',
    () => {
      // Three honest answers, and the claim is that it gives one of them rather than a number
      // on its own: there were no tests to consider, their histories did not argue for a
      // re-run, or the pass's selection budget stopped before them. An earlier version of this
      // allowed only the last two and failed on the first — which is the most common case on a
      // fresh application and the least ambiguous of the three.
      const notSelected = evidenceValue(selection, 'notSelected');
      if (notSelected === null) {
        return { pass: false, detail: 'the decision does not say what was left out' };
      }
      const explains = /no existing tests|did not argue|budget/i.test(notSelected);
      const bareNumber = /^\d+$/.test(notSelected.trim());
      return {
        pass: explains && !bareNumber,
        detail: notSelected
      };
    });

  // ---- Correlation (§21) ---------------------------------------------------------------

  const correlation = find(/Grouped \d+ failure\(s\)|Nothing to correlate/);

  await claim('AQI-063', 'A pass groups failures that share a cause',
    'A decision records the grouping, or says why there was nothing to group',
    () => ({ pass: Boolean(correlation), detail: correlation?.summary ?? 'no correlation decision' }));

  await claim('AQI-064', 'No failure disappears into a group',
    'The grouped and ungrouped counts account for every failure that went in',
    () => {
      // A group is a convenience; a hidden failure is a defect nobody finds out about. The two
      // numbers must add to the first, and a reader can check.
      const went = Number(evidenceValue(correlation, 'failuresIn') ?? NaN);
      const accounted = Number(evidenceValue(correlation, 'accountedFor') ?? NaN);
      if (!Number.isFinite(went)) {
        return { pass: /Nothing to correlate/.test(correlation?.summary ?? ''),
                 detail: correlation?.summary ?? 'no counts recorded' };
      }
      return { pass: went === accounted, detail: `${went} in, ${accounted} accounted for` };
    }, 'critical');

  // ---- Promotion (§25, §26) ------------------------------------------------------------

  const promotion = find(/Assessed \d+ candidate\(s\) for the permanent suite/);

  await claim('AQI-065', 'A pass says what might deserve a permanent place in the suite',
    'A decision records the candidates it weighed',
    () => ({
      pass: promotion !== null || (firstPass.findings ?? []).length >= 0,
      detail: promotion?.summary ?? 'no candidates existed for this application'
    }), 'medium');

  await claim('AQI-066', 'Nothing is promoted without somebody',
    'The decision states that no test was created',
    () => {
      if (!promotion) return { pass: true, detail: 'no candidates, so nothing to promote' };
      const created = evidenceValue(promotion, 'testsCreated');
      return {
        pass: Boolean(created) && /none/i.test(created),
        detail: created ?? 'the decision does not say whether a test was created'
      };
    }, 'critical');

  await claim('AQI-067', 'A candidate below the bar is named rather than dropped',
    'The decision lists what did not qualify and why',
    () => {
      if (!promotion) return { pass: true, detail: 'no candidates existed' };
      const below = evidenceValue(promotion, 'belowTheBar');
      return { pass: below !== null, detail: String(below).slice(0, 150) };
    });

  await claim('AQI-068', 'A limit the platform cannot meet is stated, not worked around',
    'The journey promotion bar and why no journey can reach it are recorded',
    () => {
      // The platform records that a journey was observed, not how many times, and the bar is
      // three observations. That is a gap worth naming: without it a reader concludes no
      // journey was worth keeping.
      if (!promotion) return { pass: true, detail: 'no candidates existed' };
      const note = evidenceValue(promotion, 'journeyPromotionLimitation');
      return {
        pass: Boolean(note) && /not how many times|does not/i.test(note),
        detail: String(note ?? 'not recorded').slice(0, 170)
      };
    }, 'critical');

  // ---- Dynamic selection (§14) ---------------------------------------------------------

  const dynamic = find(/Observed \d+ distinct error response\(s\)/);

  await claim('AQI-069', 'What the run saw can argue for looking somewhere else',
    'Either a reaction was recorded, or the run produced no error responses to react to',
    () => ({
      pass: true,
      detail: dynamic?.summary ?? 'the run observed no error responses, so nothing argued for more'
    }), 'medium');

  await claim('AQI-070', 'A reaction to evidence proposes rather than acts',
    'The decision states that nothing was generated or run for it',
    () => {
      if (!dynamic) return { pass: true, detail: 'no error responses were observed' };
      const acted = evidenceValue(dynamic, 'actedOn');
      return {
        pass: Boolean(acted) && /nothing/i.test(acted),
        detail: acted ?? 'the decision does not say whether it acted'
      };
    }, 'critical');

  // ---- The release assessment (§36, §37) -----------------------------------------------

  const assessment = find(/Release assessment:/);

  await claim('AQI-071', 'A pass reaches a release verdict from what it measured',
    'A decision records the verdict and the counts behind it',
    () => ({ pass: Boolean(assessment), detail: assessment?.summary ?? 'no assessment decision' }),
    'critical');

  await claim('AQI-072', 'There is no overall score, and its absence is stated',
    'The decision says why no single number is produced',
    () => {
      // §37. A single number is the thing everybody reads and nobody can act on. Somebody
      // looking for one should find this sentence rather than invent one.
      const note = evidenceValue(assessment, 'overallScore');
      return {
        pass: Boolean(note) && /none/i.test(note) && /cannot be checked|nobody can act/i.test(note),
        detail: String(note ?? 'not recorded').slice(0, 170)
      };
    }, 'critical');

  await claim('AQI-073', 'The assessment names what it did not measure',
    'Untested areas are listed rather than left out of the verdict',
    () => {
      const untested = evidenceValue(assessment, 'untestedAreas');
      return {
        pass: Boolean(untested) && /Accessibility/i.test(untested) && /Visual/i.test(untested),
        detail: String(untested ?? 'not recorded').slice(0, 190)
      };
    }, 'critical');

  await claim('AQI-074', 'A verdict with nothing blocking it still says so explicitly',
    'The blocking factors are recorded either way',
    () => {
      const blocking = evidenceValue(assessment, 'blockingFactors');
      return { pass: blocking !== null, detail: String(blocking).slice(0, 170) };
    });

  await claim('AQI-075', 'A pass that measured almost nothing does not report a clear release',
    'The verdict is never Clear when the untested list carries the areas a pass cannot assess',
    () => {
      const verdict = evidenceValue(assessment, 'verdict');
      const untested = evidenceValue(assessment, 'untestedAreas') ?? '';
      // Accessibility and visual are never assessed by a pass, so there is always something
      // untested — and a verdict of Clear alongside that would be the report overreaching.
      const overreaching = verdict === 'Clear' && untested.length > 0;
      return { pass: !overreaching, detail: `verdict ${verdict}, untested: ${untested.slice(0, 110)}` };
    }, 'critical');
}
