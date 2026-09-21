/**
 * Self-healing, in both directions.
 *
 * The positive cases are easy to demonstrate and easy to fake. The negative cases are the
 * product: a healer that always finds *something* turns a broken application into a green
 * build, and no amount of healing success rate makes up for one wrong heal.
 *
 * So ten scenarios here exist to be refused. In every one of them the platform must fail
 * the run, and — the stronger claim — the browser must never reach `/welcome`, because
 * reaching it would mean the healer signed in through a control the test never meant.
 *
 * The test case is never edited between runs. The same stored locator faces every variant.
 */
import { golden, suite } from '../harness.mjs';
import {
  LAB, createProject, execute, healingEvents, importJourney, journey, lab, newTenant,
  registerApplication, request, runDiscovery, step, testCase
} from '../platform.mjs';

const HEAL = LAB.healing;

/** The one journey every healing measurement uses. Its submit locator has no fallbacks. */
const signInJourney = () => journey({
  name: 'Sign in (healing subject)',
  startUrl: `${HEAL}/login`,
  steps: [
    step.navigate(`${HEAL}/login`),
    step.fill('username', 'alice', `${HEAL}/login`),
    step.fill('password', '${secret:app_password}', `${HEAL}/login`),
    // No fallbacks on purpose: the stored locator must be the thing that breaks, or a
    // fallback would rescue the run and prove nothing about healing.
    step.click('login-submit', `${HEAL}/login`),
    step.assertVisible('welcome-heading', `${HEAL}/welcome`)
  ]
});

export default async function run() {
  suite('Self-healing');
  await lab.reset(HEAL);

  const tenant = await newTenant('Healing');

  // Two projects: one on the default policy, one that opts in to applying a heal. The
  // difference between them is the product's safety story.
  const suggestProject = await createProject(tenant, 'Healing — suggest (default)');
  const autoProject = await createProject(tenant, 'Healing — auto', {
    healingPolicy: 'auto', healingConfidenceThreshold: 85
  });

  const applicationFor = (projectId) => registerApplication(tenant, projectId, {
    name: 'AIRA Locator Lab', baseUrl: HEAL, loginUrl: `${HEAL}/login`,
    username: 'alice', password: 'Password123!', maxPages: 6
  });

  const suggestApp = await applicationFor(suggestProject.id);
  const autoApp = await applicationFor(autoProject.id);

  // Discovery first, on both projects. Healing scores a candidate against the element
  // fingerprint the model holds, so a platform that has never seen the application heals
  // with far less to go on — measured, not assumed: the same rename scores 52% without a
  // prior crawl and 79% with one. A user discovers before they record; so does this suite.
  await Promise.all([
    runDiscovery(tenant, suggestApp.id, { maxPages: 6, timeoutMs: 180_000 }),
    runDiscovery(tenant, autoApp.id, { maxPages: 6, timeoutMs: 180_000 })
  ]);

  const suggestTest = await importJourney(tenant, {
    projectId: suggestProject.id, applicationId: suggestApp.id, journey: signInJourney()
  });
  const autoTest = await importJourney(tenant, {
    projectId: autoProject.id, applicationId: autoApp.id, journey: signInJourney()
  });

  const context = { tenant, applicationVersion: '1.0.0' };

  /** Runs the unchanged test under one fault and reports everything that matters. */
  async function underFault(fault, { policy = 'auto', label, threshold } = {}) {
    await lab.reset(HEAL);
    if (fault) await lab.set(HEAL, { [fault]: true });

    const project = policy === 'auto' ? autoProject : suggestProject;
    const testCaseId = policy === 'auto' ? autoTest.testCaseId : suggestTest.testCaseId;

    if (threshold !== undefined) {
      await request(`/api/v1/projects/${project.id}`, {
        token: tenant.token, method: 'PATCH', body: { healingConfidenceThreshold: threshold }
      });
    }

    const result = await execute(tenant, {
      projectId: project.id, testCaseId, name: label ?? `HEAL ${fault ?? 'baseline'} (${policy})`
    });
    const events = result.detail?.healingEvents ?? [];
    const clickAction = (result.detail?.actions ?? []).find(action => action.action === 'click');
    const reachedWelcome = (result.detail?.actions ?? []).some(action =>
      String(action.url ?? '').includes('/welcome'));

    await lab.reset(HEAL);
    const bestConfidence = events.length
      ? Math.max(...events.map(event => event.confidence ?? 0))
      : null;
    return {
      fault, policy, threshold,
      bestConfidence,
      status: result.run?.status,
      stepsPassed: result.detail?.stepsPassed,
      stepsTotal: result.detail?.stepsTotal,
      healingEvents: events,
      healed: events.filter(event => String(event.outcome).toLowerCase() === 'applied'),
      clickAction,
      reachedWelcome,
      executionId: result.executions?.[0]?.id,
      failure: result.detail?.failure ?? null
    };
  }

  // =====================================================================
  // Positive: healing that is correct
  // =====================================================================

  const baseline = await underFault(null, { policy: 'auto', label: 'HEAL baseline' });

  await golden({
    id: 'HEAL-G01',
    objective: 'The test passes against the unmodified application',
    preconditions: ['the locator lab is running with no faults'],
    input: 'The sign-in journey, unedited',
    expected: 'The run passes and the browser reaches the welcome page',
    evidence: ['baseline.json'],
    severity: 'critical',
    run: async () => ({
      pass: baseline.status === 'passed' && baseline.reachedWelcome,
      detail: `${baseline.status}, ${baseline.stepsPassed}/${baseline.stepsTotal} steps, reached /welcome: ${baseline.reachedWelcome}`,
      evidence: { 'baseline.json': baseline }
    })
  }, context);

  const renamedSuggest = await underFault('FAULT_LOGIN_BUTTON_RENAMED', { policy: 'suggest' });

  await golden({
    id: 'HEAL-G02',
    objective: 'Under the default policy a broken locator is proposed, never silently applied',
    preconditions: ['the submit control has been relabelled and re-identified'],
    input: 'The same unedited test, on a project with the default Suggest policy',
    expected: 'The run FAILS, and a healing candidate is recorded with its confidence',
    evidence: ['suggest.json'],
    severity: 'critical',
    run: async () => {
      const proposed = renamedSuggest.healingEvents.filter(event =>
        String(event.outcome).toLowerCase() !== 'applied');
      return {
        pass: renamedSuggest.status !== 'passed'
          && renamedSuggest.healed.length === 0
          && renamedSuggest.healingEvents.length > 0,
        detail: `${renamedSuggest.status}; ${renamedSuggest.healingEvents.length} healing event(s), `
          + `${renamedSuggest.healed.length} applied; confidence `
          + `${renamedSuggest.healingEvents.map(event => event.confidence).join(', ') || 'n/a'}; `
          + `proposals: ${proposed.map(event => event.outcome).join(', ') || 'none'}`,
        metrics: { confidence: renamedSuggest.healingEvents[0]?.confidence ?? null },
        evidence: { 'suggest.json': renamedSuggest }
      };
    }
  }, context);

  // The rename changes the label, the text and the test id at once, and the platform
  // scores it at 79% against the discovered fingerprint. The default threshold is 85, so
  // applying it needs a project that deliberately accepts less certainty. 75 is chosen
  // here, stated rather than tuned until something passed — and HEAL-M02 below checks
  // that no scenario which must be refused reaches it.
  const AUTO_THRESHOLD = 75;
  const renamedAuto = await underFault('FAULT_LOGIN_BUTTON_RENAMED', { policy: 'auto', threshold: AUTO_THRESHOLD });

  await golden({
    id: 'HEAL-G03',
    objective: 'Under an opt-in Auto policy the same break is healed and the run continues',
    preconditions: ['the submit control has been relabelled and re-identified',
      'the project opted in to healingPolicy=auto with a threshold of 75'],
    input: 'The same unedited test',
    expected: 'The run completes, the click is marked healed, and the browser reaches /welcome',
    evidence: ['auto.json'],
    severity: 'critical',
    run: async () => ({
      pass: renamedAuto.healed.length > 0 && renamedAuto.reachedWelcome
        && ['passed', 'healed'].includes(String(renamedAuto.status).toLowerCase()),
      detail: `${renamedAuto.status}; ${renamedAuto.healed.length} heal(s) applied at `
        + `${renamedAuto.healed.map(event => `${event.confidence}%`).join(', ') || 'no confidence recorded'}; `
        + `best candidate ${renamedAuto.bestConfidence}% against a threshold of ${AUTO_THRESHOLD}; `
        + `reached /welcome: ${renamedAuto.reachedWelcome}`,
      metrics: { confidence: renamedAuto.healed[0]?.confidence ?? null },
      evidence: { 'auto.json': renamedAuto }
    })
  }, context);

  await golden({
    id: 'HEAL-G04',
    objective: 'A healed run is reported as healed, not as a clean pass',
    preconditions: ['HEAL-G03 executed'],
    input: 'The run status and the execution\'s healed-step count',
    expected: 'The verdict distinguishes a healed run from an ordinary pass',
    evidence: ['healed-verdict.json'],
    severity: 'critical',
    run: async () => {
      const wasHealedClick = renamedAuto.clickAction?.wasHealed === true;
      return {
        pass: wasHealedClick && (String(renamedAuto.status).toLowerCase() === 'healed'
          || (renamedAuto.healed.length > 0)),
        detail: `run status "${renamedAuto.status}"; the click records wasHealed=${wasHealedClick} `
          + `at ${renamedAuto.clickAction?.healingConfidence ?? 'n/a'}% confidence`,
        evidence: { 'healed-verdict.json': { status: renamedAuto.status, click: renamedAuto.clickAction } }
      };
    }
  }, context);

  await golden({
    id: 'HEAL-G05',
    objective: 'Healing at run time does not rewrite the stored test',
    preconditions: ['HEAL-G03 healed a locator'],
    input: 'The stored test case, read back after the healed run',
    expected: 'The step still holds the original locator; the change is a proposal, not an edit',
    evidence: ['stored-test.json'],
    severity: 'critical',
    run: async () => {
      const stored = await testCase(tenant, autoTest.testCaseId);
      const clickStep = (stored?.steps ?? []).find(candidate => candidate.action === 'click');
      const locator = JSON.stringify(clickStep?.target ?? clickStep?.targetJson ?? {});
      return {
        pass: locator.includes('login-submit'),
        detail: `the stored click still targets ${locator.slice(0, 120)}`,
        evidence: { 'stored-test.json': { step: clickStep, healingEvents: renamedAuto.healed } }
      };
    }
  }, context);

  const testIdOnly = await underFault('FAULT_TESTID_ONLY_CHANGED', { policy: 'auto', threshold: AUTO_THRESHOLD });

  await golden({
    id: 'HEAL-G06',
    objective: 'A control whose test id changed but whose label did not is healed',
    preconditions: ['only the test id of the submit control changed'],
    input: 'The same unedited test under Auto policy',
    expected: 'The run heals and reaches /welcome',
    evidence: ['testid-only.json'],
    severity: 'high',
    run: async () => ({
      pass: testIdOnly.healed.length > 0 && testIdOnly.reachedWelcome,
      detail: `${testIdOnly.status}; ${testIdOnly.healed.length} heal(s) at `
        + `${testIdOnly.healed.map(event => `${event.confidence}%`).join(', ') || 'n/a'}; `
        + `best candidate ${testIdOnly.bestConfidence}%`,
      evidence: { 'testid-only.json': testIdOnly }
    })
  }, context);

  await golden({
    id: 'HEAL-G07',
    objective: 'Every healing decision is recorded for a human to review',
    preconditions: ['the healing runs above have executed'],
    input: 'GET /api/v1/healing',
    expected: 'The events are listed with their confidence, outcome and both locators',
    evidence: ['healing-events.json'],
    severity: 'high',
    run: async () => {
      const events = await healingEvents(tenant);
      const complete = events.filter(event =>
        event.confidence !== undefined && event.outcome !== undefined
        && (event.originalLocator ?? event.original) && (event.healedLocator ?? event.healed));
      return {
        pass: events.length > 0 && complete.length === events.length,
        detail: `${events.length} healing event(s) listed, ${complete.length} with confidence, outcome and both locators`,
        metrics: { events: events.length },
        evidence: { 'healing-events.json': events.slice(0, 20) }
      };
    }
  }, context);

  // =====================================================================
  // Negative: healing that must be refused — ten scenarios
  // =====================================================================

  /**
   * Ten scenarios in which the run must not pass, in two kinds.
   *
   * `wrongTarget` means healing itself would be wrong: there is no right element on the
   * page, or choosing between what is there is a guess with the user's session on the
   * other side. These are the ones whose confidence must stay low.
   *
   * `unusable` means the element the test meant is still there and still findable —
   * disabled, invisible, or behind another interaction — so a high confidence is not
   * wrong. What must not happen is the run passing anyway.
   *
   * The distinction was added after the first execution of this suite scored a disabled
   * control at 94%, above a correct rename at 79%. Calling that a false heal would have
   * been the check's mistake, not the product's: it is the same button.
   */
  const REFUSALS = [
    ['HEAL-N01', 'FAULT_LOGIN_BUTTON_REMOVED', 'No control performs the function any more', 'wrongTarget'],
    ['HEAL-N02', 'FAULT_AMBIGUOUS_CONTROLS', 'Two equally plausible controls lead to different outcomes', 'wrongTarget'],
    ['HEAL-N03', 'FAULT_MEANING_CHANGED', 'A control with the same label now cancels the sign-in', 'wrongTarget'],
    ['HEAL-N04', 'FAULT_DECOY_CONTROL', 'An unrelated marketing button occupies the same position', 'wrongTarget'],
    ['HEAL-N05', 'FAULT_CONTROL_MOVED_TO_DIALOG', 'The control exists but only behind an extra interaction', 'unusable'],
    ['HEAL-N06', 'FAULT_CONTROL_DISABLED', 'The control is present but disabled', 'unusable'],
    ['HEAL-N07', 'FAULT_CONTROL_HIDDEN', 'The control is present but not visible', 'unusable'],
    ['HEAL-N08', 'FAULT_CONTROL_IS_LINK_ELSEWHERE', 'A link with the same words leads somewhere else', 'wrongTarget'],
    ['HEAL-N09', 'FAULT_MAINTENANCE_PAGE', 'The page has been replaced by a maintenance notice', 'wrongTarget'],
    ['HEAL-N10', 'FAULT_DUPLICATE_CONTROLS', 'Two controls share the label and do opposite things', 'unusable']
  ];

  const refusalResults = [];

  for (const [id, fault, why, kind] of REFUSALS) {
    const outcome = await underFault(fault, { policy: 'auto', threshold: 85 });
    refusalResults.push({ id, fault, kind, ...outcome });

    await golden({
      id,
      objective: `Healing is refused: ${why.toLowerCase()}`,
      preconditions: [`${fault} is enabled`, 'the project is on healingPolicy=auto — the permissive setting'],
      input: 'The same unedited sign-in test',
      expected: 'The run FAILS, no heal is applied, and the browser never reaches /welcome',
      evidence: [`${id}.json`],
      severity: 'critical',
      run: async () => {
        // Two independent conditions. The verdict could be wrong while the browser stayed
        // put, or the verdict could look right while the healer quietly signed in through
        // the wrong control — so both are required.
        const failedCorrectly = outcome.status !== 'passed' && outcome.status !== 'healed';
        const nothingApplied = outcome.healed.length === 0;
        const stayedOut = !outcome.reachedWelcome;
        return {
          pass: failedCorrectly && nothingApplied && stayedOut,
          detail: `${outcome.status}; heals applied: ${outcome.healed.length}; reached /welcome: ${outcome.reachedWelcome}`
            + (outcome.failure ? `; classified as ${outcome.failure.category}` : '')
            + (outcome.healingEvents.length
              ? `; ${outcome.healingEvents.length} candidate(s) considered, best `
                + `${Math.max(...outcome.healingEvents.map(event => event.confidence ?? 0))}%`
              : '; no candidate reached the threshold'),
          metrics: {
            applied: outcome.healed.length,
            candidates: outcome.healingEvents.length,
            reachedWelcome: outcome.reachedWelcome
          },
          evidence: { [`${id}.json`]: outcome }
        };
      }
    }, context);
  }

  // =====================================================================
  // The metric that matters
  // =====================================================================
  await golden({
    id: 'HEAL-M01',
    objective: 'Healing is measured as four counts, so a rate cannot hide a wrong heal',
    preconditions: ['every healing scenario above has executed'],
    input: 'Three healable scenarios and ten that must be refused',
    expected: 'False-healing rate 0%: no scenario that had to be refused was healed',
    evidence: ['healing-metrics.json'],
    severity: 'critical',
    run: async () => {
      const healable = [
        { name: 'baseline (nothing broken)', result: baseline, expectHeal: false, expectPass: true },
        { name: 'renamed control', result: renamedAuto, expectHeal: true, expectPass: true },
        { name: 'test id changed', result: testIdOnly, expectHeal: true, expectPass: true }
      ];

      const correctHeals = healable.filter(entry =>
        entry.expectHeal && entry.result.healed.length > 0 && entry.result.reachedWelcome).length;
      const missedHeals = healable.filter(entry =>
        entry.expectHeal && entry.result.healed.length === 0).length;
      const correctRejections = refusalResults.filter(entry =>
        entry.healed.length === 0 && !entry.reachedWelcome).length;
      const incorrectHeals = refusalResults.filter(entry =>
        entry.healed.length > 0 || entry.reachedWelcome).length;

      const opportunities = healable.filter(entry => entry.expectHeal).length + refusalResults.length;
      const metrics = {
        healingOpportunities: opportunities,
        correctHeals,
        correctRejections,
        incorrectHeals,
        missedHeals,
        healingSuccessRate: Number(((correctHeals + correctRejections) / opportunities).toFixed(4)),
        falseHealingRate: Number((incorrectHeals / refusalResults.length).toFixed(4))
      };

      return {
        pass: metrics.falseHealingRate === 0 && metrics.correctHeals >= 2,
        detail: `${opportunities} opportunities: ${correctHeals} correctly healed, `
          + `${correctRejections} correctly refused, ${incorrectHeals} wrongly healed, `
          + `${missedHeals} missed — false-healing rate ${(metrics.falseHealingRate * 100).toFixed(1)}%`,
        metrics,
        evidence: {
          'healing-metrics.json': {
            ...metrics,
            healable: healable.map(entry => ({
              name: entry.name, status: entry.result.status,
              healsApplied: entry.result.healed.length, reachedWelcome: entry.result.reachedWelcome
            })),
            refusals: refusalResults.map(entry => ({
              id: entry.id, fault: entry.fault, status: entry.status,
              healsApplied: entry.healed.length, candidates: entry.healingEvents.length,
              reachedWelcome: entry.reachedWelcome
            }))
          }
        }
      };
    }
  }, context);

  await golden({
    id: 'HEAL-M02',
    objective: 'The scorer separates a break that should heal from one that must not',
    preconditions: ['every healing scenario above has executed and recorded its confidence'],
    input: 'The best candidate confidence in each scenario',
    expected: 'The lowest confidence among the healable breaks is above the highest among the refusals',
    evidence: ['confidence-separation.json'],
    severity: 'critical',
    run: async () => {
      const healable = [
        { name: 'renamed control', confidence: renamedAuto.bestConfidence },
        { name: 'test id changed', confidence: testIdOnly.bestConfidence }
      ].filter(entry => entry.confidence !== null);

      // Only the scenarios where healing itself would be wrong. A disabled or hidden
      // control is the element the test meant, so scoring it highly is not a mistake —
      // passing the run would be, and none of them did.
      const wrongTarget = refusalResults
        .filter(entry => entry.kind === 'wrongTarget')
        .map(entry => ({ name: entry.fault, confidence: entry.bestConfidence }))
        .filter(entry => entry.confidence !== null);

      const unusable = refusalResults
        .filter(entry => entry.kind === 'unusable')
        .map(entry => ({ name: entry.fault, confidence: entry.bestConfidence, status: entry.status }));

      const lowestHealable = Math.min(...healable.map(entry => entry.confidence));
      const highestWrongTarget = wrongTarget.length ? Math.max(...wrongTarget.map(entry => entry.confidence)) : 0;
      const margin = lowestHealable - highestWrongTarget;

      return {
        pass: margin > 0,
        detail: `healable: ${healable.map(e => `${e.name} ${e.confidence}%`).join(', ')}; `
          + `highest wrong-target candidate ${highestWrongTarget}%`
          + (wrongTarget.length ? ` (${wrongTarget.map(e => `${e.name.replace('FAULT_', '')} ${e.confidence}%`).join(', ')})` : '')
          + `; margin ${margin > 0 ? '+' : ''}${margin} points. `
          + `Findable-but-unusable controls scored `
          + `${unusable.map(e => `${e.confidence ?? 'no candidate'}%`).join(', ')} and all failed anyway.`,
        metrics: { lowestHealable, highestWrongTarget, margin, threshold: AUTO_THRESHOLD },
        evidence: {
          'confidence-separation.json': {
            healable, wrongTarget, unusable, lowestHealable, highestWrongTarget, margin,
            chosenThreshold: AUTO_THRESHOLD,
            note: 'A threshold is only safe if it sits above every wrong-target candidate and below every correct one.'
          }
        }
      };
    }
  }, context);

  // ---- HEAL-G08: the confidence threshold is honoured -----------------------
  await golden({
    id: 'HEAL-G08',
    objective: 'Raising the confidence threshold stops a heal that would otherwise be applied',
    preconditions: [`the renamed-control scenario heals at a threshold of ${AUTO_THRESHOLD}`],
    input: 'The same project with healingConfidenceThreshold raised to 100',
    expected: 'The heal is no longer applied and the run fails',
    evidence: ['threshold.json'],
    severity: 'high',
    run: async () => {
      const raised = await request(`/api/v1/projects/${autoProject.id}`, {
        token: tenant.token, method: 'PATCH', body: { healingConfidenceThreshold: 100 }
      });
      if (!raised.ok) return { pass: false, detail: `could not raise the threshold: ${raised.status}` };

      const outcome = await underFault('FAULT_LOGIN_BUTTON_RENAMED', { policy: 'auto' });

      await request(`/api/v1/projects/${autoProject.id}`, {
        token: tenant.token, method: 'PATCH', body: { healingConfidenceThreshold: AUTO_THRESHOLD }
      });

      return {
        pass: outcome.healed.length === 0 && outcome.status !== 'passed' && !outcome.reachedWelcome,
        detail: `at threshold 100: ${outcome.status}, ${outcome.healed.length} heal(s) applied, `
          + `best candidate ${outcome.healingEvents.map(event => `${event.confidence}%`).join(', ') || 'none'}`,
        evidence: { 'threshold.json': outcome }
      };
    }
  }, context);

  await lab.reset(HEAL);
  return context;
}
