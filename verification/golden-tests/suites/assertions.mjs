/**
 * Assertions: does each kind hold when it should, and fail when it should?
 *
 * Every assertion type is exercised twice — once where it must hold and once where it must
 * not. A suite that only checks the passing direction cannot tell a working assertion from
 * one that always returns true, which is precisely the defect BUG-0010 turned out to be.
 *
 * Two journeys carry all of it: one where every assertion is satisfied, and one where every
 * assertion is deliberately wrong. The second runs with `continueOnFailure` unavailable, so
 * it is split into one journey per failing assertion to be sure each is reached.
 */
import { golden, suite } from '../harness.mjs';
import {
  LAB, createProject, execute, importJourney, journey, lab, newTenant, registerApplication,
  runDiscovery, step
} from '../platform.mjs';

const BANK = LAB.banking;

/**
 * Two step builders the shared kit does not carry, because until BUG-0017 neither
 * assertion could be imported: the recorded-journey contract had no field for a count or
 * an attribute name, so the engine's implementation of both was unreachable.
 */
// Counted by CSS rather than by test id: getByTestId is an exact match, so it can never
// return more than the one element, and a count assertion needs a locator that matches a
// set. The account rows carry one test id each, prefixed alike.
const assertCount = (selector, count, url) => ({
  action: 'assertCount', description: `${selector} matches ${count} element(s)`,
  target: { strategy: 'css', value: selector, exact: false, fallbacks: [] }, count, url
});

const assertAttribute = (testId, attribute, expected, url) => ({
  action: 'assertAttribute', description: `${testId}'s ${attribute} is "${expected}"`,
  target: { strategy: 'testId', value: testId, exact: false, fallbacks: [] },
  attribute, expected, url
});

/** One row per account, each with its own test id under a shared prefix. */
const ACCOUNT_ROWS = '[data-testid^="account-row-"]';

const signIn = () => [
  step.navigate(`${BANK}/login`),
  step.fill('username', 'alice', `${BANK}/login`),
  step.fill('password', '${secret:app_password}', `${BANK}/login`),
  step.click('login-submit', `${BANK}/login`)
];

export default async function run() {
  suite('Assertions');
  await lab.reset(BANK);

  const tenant = await newTenant('Assertions');
  const project = await createProject(tenant, 'Golden assertions');
  const application = await registerApplication(tenant, project.id, {
    name: 'QA NXT Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
    username: 'alice', password: 'Password123!'
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  /** Runs one journey and returns its run plus the last action, which is the assertion. */
  async function runAssertion(name, steps) {
    const imported = await importJourney(tenant, {
      projectId: project.id, applicationId: application.id,
      journey: journey({ name, startUrl: `${BANK}/login`, steps })
    });
    const result = await execute(tenant, {
      projectId: project.id, testCaseId: imported.testCaseId, name
    });
    const actions = result.detail?.actions ?? [];
    return {
      status: result.run?.status,
      assertion: actions.at(-1) ?? null,
      healingEvents: result.detail?.healingEvents ?? [],
      failure: result.detail?.failure ?? null
    };
  }

  /**
   * Each case: the assertion that must hold, and the one that must not.
   * Both are executed, because either half alone proves nothing.
   */
  const CASES = [
    {
      id: 'ASRT-001', kind: 'assertVisible',
      holds: [...signIn(), step.assertVisible('total-balance', `${BANK}/dashboard`)],
      breaks: [...signIn(), step.assertVisible('no-such-element-anywhere', `${BANK}/dashboard`)],
      severity: 'critical'
    },
    {
      id: 'ASRT-002', kind: 'assertText',
      holds: [...signIn(), step.assertText('page-title', 'Dashboard', `${BANK}/dashboard`)],
      breaks: [...signIn(), step.assertText('page-title', 'Something Else Entirely', `${BANK}/dashboard`)],
      severity: 'critical'
    },
    {
      id: 'ASRT-003', kind: 'assertUrl',
      holds: [...signIn(), step.assertUrl('/dashboard', `${BANK}/dashboard`)],
      breaks: [...signIn(), step.assertUrl('/nowhere-at-all', `${BANK}/dashboard`)],
      severity: 'critical'
    },
    {
      id: 'ASRT-004', kind: 'assertValue',
      holds: [...signIn(), step.click('nav-transactions', `${BANK}/dashboard`),
        step.fill('filter-min', '250', `${BANK}/transactions`),
        step.assertValue('filter-min', '250', `${BANK}/transactions`)],
      breaks: [...signIn(), step.click('nav-transactions', `${BANK}/dashboard`),
        step.fill('filter-min', '250', `${BANK}/transactions`),
        step.assertValue('filter-min', '999', `${BANK}/transactions`)],
      severity: 'critical'
    },
    {
      id: 'ASRT-009', kind: 'assertCount',
      // Alice holds three accounts, so the accounts table renders three rows. Ten is wrong
      // about the application, and an assertion that works must fail on it.
      holds: [...signIn(), step.click('nav-accounts', `${BANK}/dashboard`),
        assertCount(ACCOUNT_ROWS, 3, `${BANK}/accounts`)],
      breaks: [...signIn(), step.click('nav-accounts', `${BANK}/dashboard`),
        assertCount(ACCOUNT_ROWS, 10, `${BANK}/accounts`)],
      severity: 'high'
    },
    {
      id: 'ASRT-010', kind: 'assertAttribute',
      // The field carries name="username"; it carries no type attribute at all, which is
      // why an earlier version of this check failed against a perfectly healthy page.
      holds: [step.navigate(`${BANK}/login`), assertAttribute('username', 'name', 'username', `${BANK}/login`)],
      breaks: [step.navigate(`${BANK}/login`), assertAttribute('username', 'name', 'account-number', `${BANK}/login`)],
      severity: 'high'
    },
    {
      id: 'ASRT-005', kind: 'assertHidden',
      // The payments table is absent until a payment is made, and present afterwards.
      holds: [...signIn(), step.click('nav-payments', `${BANK}/dashboard`),
        step.assertHidden('payments-table', `${BANK}/payments`)],
      breaks: [...signIn(), step.click('nav-payments', `${BANK}/dashboard`),
        step.assertHidden('payment-submit', `${BANK}/payments`)],
      severity: 'high'
    }
  ];

  const outcomes = [];

  for (const testCase of CASES) {
    const holds = await runAssertion(`${testCase.id} holds`, testCase.holds);
    const breaks = await runAssertion(`${testCase.id} breaks`, testCase.breaks);
    outcomes.push({ id: testCase.id, kind: testCase.kind, holds, breaks });

    await golden({
      id: testCase.id,
      objective: `${testCase.kind} holds when it should and fails when it should not`,
      preconditions: ['the lab bank is running with no faults'],
      input: `Two journeys: one where the ${testCase.kind} is satisfied, one where it is deliberately wrong`,
      expected: 'The first run passes; the second FAILS with a message naming expected and actual',
      evidence: [`${testCase.id}-both-directions.json`],
      severity: testCase.severity,
      run: async () => {
        const passedWhenTrue = holds.status === 'passed' && holds.assertion?.status === 'passed';
        const failedWhenFalse = breaks.status !== 'passed' && breaks.assertion?.status !== 'passed';
        const message = breaks.assertion?.errorMessage ?? '';
        // "No element matched …" explains the failure as well as "Expected X but found Y"
        // does: it names what was wanted and says it was not there. An earlier version of
        // this check demanded the word "expected" and called a perfectly clear message a
        // failure.
        const explains = /expected/i.test(message) || /no element matched/i.test(message);
        return {
          pass: passedWhenTrue && failedWhenFalse && explains,
          detail: `holds → ${holds.status}; breaks → ${breaks.status}; `
            + `message: ${message.slice(0, 110) || 'none'}`,
          evidence: {
            [`${testCase.id}-both-directions.json`]: {
              holds: { status: holds.status, assertion: holds.assertion },
              breaks: { status: breaks.status, assertion: breaks.assertion, failure: breaks.failure }
            }
          }
        };
      }
    }, context);
  }

  // ---- ASRT-006: an assertion failure is not a locator problem -------------
  await golden({
    id: 'ASRT-006',
    objective: 'A failed assertion on an element that exists does not trigger healing',
    preconditions: ['ASRT-002 ran an assertText against the right element with the wrong text'],
    input: 'The healing events recorded for that run',
    expected: 'No healing was attempted: the locator was fine, the value was not',
    evidence: ['no-healing-on-assertion.json'],
    severity: 'high',
    run: async () => {
      const textCase = outcomes.find(entry => entry.id === 'ASRT-002');
      const events = textCase?.breaks.healingEvents ?? [];
      return {
        pass: events.length === 0,
        detail: `${events.length} healing event(s) on a failed text assertion`,
        evidence: { 'no-healing-on-assertion.json': { healingEvents: events, assertion: textCase?.breaks.assertion } }
      };
    }
  }, context);

  // ---- ASRT-007: the failure message carries expected and actual -----------
  await golden({
    id: 'ASRT-007',
    objective: 'A failed assertion reports what it expected and what it found',
    preconditions: ['the five breaking assertions above ran'],
    input: 'Each failing assertion\'s error message',
    expected: 'Every message names both sides of the comparison',
    evidence: ['assertion-messages.json'],
    severity: 'high',
    run: async () => {
      const messages = outcomes.map(entry => ({
        id: entry.id, kind: entry.kind, message: entry.breaks.assertion?.errorMessage ?? null
      }));
      // "Expected X … but Y" or an element that could not be found at all: both say what
      // was wanted and what was there.
      const informative = messages.filter(entry =>
        entry.message
        && (/expected/i.test(entry.message) || /no element matched/i.test(entry.message))
        && /(but|found|read|no element|not visible|was visible)/i.test(entry.message));
      return {
        pass: informative.length === messages.length,
        detail: `${informative.length}/${messages.length} failing assertion(s) name expected and actual`,
        evidence: { 'assertion-messages.json': messages }
      };
    }
  }, context);

  // ---- ASRT-008: assertions survive a healed locator ----------------------
  await golden({
    id: 'ASRT-008',
    objective: 'Assertions run after a healed step, so a heal that reaches the wrong element is caught',
    preconditions: ['the locator lab renames its submit control', 'healing is set to auto'],
    input: 'A journey whose click heals and whose next step asserts on the outcome',
    expected: 'The assertion is evaluated after the heal and decides the verdict',
    evidence: ['assertion-after-heal.json'],
    severity: 'critical',
    run: async () => {
      const healProject = await createProject(tenant, 'Assertions after healing', {
        healingPolicy: 'auto', healingConfidenceThreshold: 60
      });
      const healApp = await registerApplication(tenant, healProject.id, {
        name: 'QA NXT Locator Lab', baseUrl: LAB.healing, loginUrl: `${LAB.healing}/login`,
        username: 'alice', password: 'Password123!', maxPages: 6
      });

      // Healing scores a candidate against the discovered fingerprint, so the application
      // has to have been crawled first — without it the same break scores in the fifties
      // and nothing is applied at any sensible threshold.
      await runDiscovery(tenant, healApp.id, { maxPages: 6, timeoutMs: 180_000 });

      const healJourney = journey({
        name: 'Assertion after a heal',
        startUrl: `${LAB.healing}/login`,
        steps: [
          step.navigate(`${LAB.healing}/login`),
          step.fill('username', 'alice', `${LAB.healing}/login`),
          step.fill('password', '${secret:app_password}', `${LAB.healing}/login`),
          step.click('login-submit', `${LAB.healing}/login`),
          step.assertText('welcome-heading', 'You are signed in', `${LAB.healing}/welcome`)
        ]
      });
      const imported = await importJourney(tenant, {
        projectId: healProject.id, applicationId: healApp.id, journey: healJourney
      });

      await lab.set(LAB.healing, { FAULT_TESTID_ONLY_CHANGED: true });
      const result = await execute(tenant, {
        projectId: healProject.id, testCaseId: imported.testCaseId, name: 'ASRT after heal'
      });
      await lab.reset(LAB.healing);

      const actions = result.detail?.actions ?? [];
      const click = actions.find(action => action.action === 'click');
      const assertion = actions.find(action => action.action === 'assertText');
      return {
        pass: click?.wasHealed === true && assertion?.status === 'passed',
        detail: `the click ${click?.wasHealed ? 'healed' : 'did not heal'}`
          + `${click?.healingConfidence ? ` at ${click.healingConfidence}%` : ''}; `
          + `the assertion that followed ${assertion?.status}`,
        evidence: { 'assertion-after-heal.json': { status: result.run?.status, click, assertion } }
      };
    }
  }, context);

  await lab.reset(BANK);
  return context;
}
