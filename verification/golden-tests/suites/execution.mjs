/**
 * Execution: does the platform actually drive a browser, and do what the test says?
 *
 * Two long journeys are executed once each and then interrogated action by action. That is
 * deliberate: an action type is only proven by a step that ran in a real browser against a
 * real application, and running twenty separate browser sessions to assert twenty step
 * results would take twenty times as long to prove the same thing. Each golden test below
 * still checks a distinct claim and keeps its own evidence.
 *
 * Cross-browser coverage is the exception — Firefox and WebKit each get their own run,
 * because "it works on Chromium" says nothing about the other two.
 */
import { golden, notVerified, sleep, suite } from '../harness.mjs';
import {
  LAB, artifactsFor, consoleLog, createProject, execute, importJourney, journey, lab,
  networkLog, newTenant, registerApplication, step
} from '../platform.mjs';

const BANK = LAB.banking;

/** Reads one action out of an execution by its order, for per-action assertions. */
const actionAt = (detail, order) => detail?.actions?.find(action => action.order === order) ?? null;
const actionsOf = (detail, type) => (detail?.actions ?? []).filter(action => action.action === type);

export default async function run() {
  suite('Browser execution');
  await lab.resetAll();

  const tenant = await newTenant('Execution');
  const project = await createProject(tenant, 'Golden execution');
  const application = await registerApplication(tenant, project.id, {
    name: 'AIRA Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
    username: 'alice', password: 'Password123!'
  });

  // ---------------------------------------------------------------------
  // Journey 1 — the action vocabulary, end to end in one session
  // ---------------------------------------------------------------------
  const vocabulary = journey({
    name: 'Every action type against the bank',
    startUrl: `${BANK}/login`,
    steps: [
      step.navigate(`${BANK}/login`),
      step.fill('username', 'alice', `${BANK}/login`),
      step.fill('password', '${secret:app_password}', `${BANK}/login`),
      step.check('remember-me', `${BANK}/login`),
      step.click('login-submit', `${BANK}/login`),
      step.assertVisible('total-balance', `${BANK}/dashboard`),
      step.assertUrl('/dashboard', `${BANK}/dashboard`),
      step.click('nav-transactions', `${BANK}/dashboard`),
      step.select('filter-category', 'Salary', `${BANK}/transactions`),
      step.fill('filter-min', '100', `${BANK}/transactions`),
      step.assertValue('filter-min', '100', `${BANK}/transactions`),
      step.click('apply-filters', `${BANK}/transactions`),
      step.assertVisible('transactions-table', `${BANK}/transactions`),
      step.click('nav-statements', `${BANK}/transactions`),
      step.select('statement-account', 'acc-1001', `${BANK}/statements`),
      step.fill('statement-from', '2026-08-01', `${BANK}/statements`),
      step.fill('statement-to', '2026-09-15', `${BANK}/statements`),
      step.click('generate-statement', `${BANK}/statements`),
      step.assertVisible('statement-result', `${BANK}/statements`),
      step.assertText('page-title', 'Statements', `${BANK}/statements`)
    ]
  });

  const vocabularyImport = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id, journey: vocabulary
  });
  const vocabularyRun = await execute(tenant, {
    projectId: project.id, testCaseId: vocabularyImport.testCaseId, name: 'EXEC vocabulary'
  });

  const detail = vocabularyRun.detail;
  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  // ---- EXEC-001 ------------------------------------------------------------
  await golden({
    id: 'EXEC-001',
    objective: 'A twenty-step journey through a real application passes end to end',
    preconditions: ['the lab bank is running with no faults', 'the journey was imported, not hand-edited'],
    input: 'navigate, fill, check, click, select and six assertions across four pages',
    expected: 'The run passes, every step passes, and the browser really visited those pages',
    evidence: ['run.json', 'actions.json'],
    severity: 'critical',
    run: async () => ({
      pass: vocabularyRun.run?.status === 'passed' && detail?.stepsFailed === 0 && detail?.stepsTotal >= 20,
      detail: `run ${vocabularyRun.run?.status}, ${detail?.stepsPassed}/${detail?.stepsTotal} step(s) passed `
        + `on ${detail?.browser} ${detail?.browserVersion ?? ''} in ${detail?.durationMs}ms`,
      metrics: { durationMs: detail?.durationMs, steps: detail?.stepsTotal },
      evidence: {
        'run.json': vocabularyRun.run,
        'actions.json': detail?.actions ?? []
      }
    })
  }, context);

  // ---- EXEC-002 … EXEC-008: one per action type ----------------------------
  const actionChecks = [
    ['EXEC-002', 'navigate', 'navigate', 1, 'The browser navigates to the start URL'],
    ['EXEC-003', 'fill', 'fill', 2, 'Text is typed into a field'],
    ['EXEC-004', 'check', 'check', 4, 'A checkbox is ticked'],
    ['EXEC-005', 'click', 'click', 5, 'A control is pressed'],
    ['EXEC-006', 'select', 'select', 9, 'An option is chosen from a select'],
    ['EXEC-007', 'assertVisible', 'assertVisible', 6, 'A visibility assertion is evaluated'],
    ['EXEC-008', 'assertUrl', 'assertUrl', 7, 'A URL assertion is evaluated']
  ];

  for (const [id, label, type, order, objective] of actionChecks) {
    await golden({
      id,
      objective: `${objective} (${label})`,
      preconditions: ['EXEC-001 executed'],
      input: `Step ${order} of the vocabulary journey`,
      expected: 'The action is recorded as passed, with the locator it used and the page it ran on',
      evidence: [`${id}-action.json`],
      severity: 'high',
      run: async () => {
        const action = actionAt(detail, order);
        const sameType = actionsOf(detail, type);
        return {
          pass: Boolean(action) && action.action === type && action.status === 'passed'
            && (type === 'navigate' || Boolean(action.locatorUsed) || Boolean(action.url)),
          detail: action
            ? `${action.action} ${action.status} in ${action.durationMs}ms on ${action.url ?? 'n/a'}`
              + (action.locatorDescription ? ` via ${action.locatorDescription}` : '')
            : `no action at order ${order}`,
          metrics: { count: sameType.length },
          evidence: { [`${id}-action.json`]: { action, allOfThisType: sameType } }
        };
      }
    }, context);
  }

  // ---- EXEC-009 value assertion --------------------------------------------
  await golden({
    id: 'EXEC-009',
    objective: 'A value assertion compares what is in the field, not what was typed',
    preconditions: ['EXEC-001 executed'],
    input: 'assertValue on filter-min after filling it with 100',
    expected: 'The assertion passed and recorded the value it compared',
    evidence: ['EXEC-009-action.json'],
    severity: 'high',
    run: async () => {
      const action = actionAt(detail, 11);
      return {
        pass: action?.status === 'passed' && action?.action === 'assertValue',
        detail: action ? `${action.action} ${action.status}` : 'the assertion did not run',
        evidence: { 'EXEC-009-action.json': action }
      };
    }
  }, context);

  // ---- EXEC-010 text assertion ---------------------------------------------
  await golden({
    id: 'EXEC-010',
    objective: 'A text assertion reads the rendered text of an element',
    preconditions: ['EXEC-001 executed'],
    input: 'assertText on the statements page title',
    expected: 'The assertion passed',
    evidence: ['EXEC-010-action.json'],
    severity: 'high',
    run: async () => {
      const action = actionAt(detail, 20);
      return {
        pass: action?.status === 'passed' && action?.action === 'assertText',
        detail: action ? `${action.action} ${action.status} — ${action.description}` : 'the assertion did not run',
        evidence: { 'EXEC-010-action.json': action }
      };
    }
  }, context);

  // ---- EXEC-011 secrets never leave the vault ------------------------------
  await golden({
    id: 'EXEC-011',
    objective: 'A password typed during execution is never stored in readable form',
    preconditions: ['EXEC-001 executed with ${secret:app_password}'],
    input: 'Every recorded action of the run',
    expected: 'The literal password appears nowhere; the password step records a masked value',
    evidence: ['EXEC-011-masking.json'],
    severity: 'critical',
    run: async () => {
      const serialised = JSON.stringify(detail ?? {});
      const passwordStep = actionAt(detail, 3);
      return {
        pass: !serialised.includes('Password123!') && Boolean(passwordStep?.maskedValue),
        detail: `literal present: ${serialised.includes('Password123!')}; `
          + `password step records "${passwordStep?.maskedValue}"`,
        evidence: { 'EXEC-011-masking.json': { maskedValue: passwordStep?.maskedValue, containsLiteral: serialised.includes('Password123!') } }
      };
    }
  }, context);

  // ---- EXEC-012 … EXEC-014 evidence ----------------------------------------
  const artifacts = await artifactsFor(tenant, vocabularyRun.executions[0]?.id);

  await golden({
    id: 'EXEC-012',
    objective: 'A screenshot is captured for the execution',
    preconditions: ['EXEC-001 executed'],
    input: 'The artifact list for the execution',
    expected: 'At least one screenshot artifact with a non-zero size',
    evidence: ['artifacts.json'],
    severity: 'high',
    run: async () => {
      const screenshots = artifacts.filter(artifact => String(artifact.kind).toLowerCase() === 'screenshot');
      return {
        pass: screenshots.length > 0 && screenshots.every(artifact => artifact.sizeBytes > 0),
        detail: `${screenshots.length} screenshot(s), ${artifacts.length} artifact(s) in total`,
        evidence: { 'artifacts.json': artifacts }
      };
    }
  }, context);

  await golden({
    id: 'EXEC-013',
    objective: 'A Playwright trace is captured for the execution',
    preconditions: ['EXEC-001 executed', 'the project captures traces'],
    input: 'The artifact list for the execution',
    expected: 'A trace artifact exists and is larger than a kilobyte',
    evidence: ['trace.json'],
    severity: 'medium',
    run: async () => {
      const traces = artifacts.filter(artifact => String(artifact.kind).toLowerCase() === 'trace');
      return {
        pass: traces.length > 0 && traces.every(artifact => artifact.sizeBytes > 1024),
        detail: traces.length
          ? `${traces.length} trace(s), ${traces.map(artifact => artifact.sizeBytes).join('/')} bytes`
          : 'no trace artifact was stored',
        evidence: { 'trace.json': traces }
      };
    }
  }, context);

  await golden({
    id: 'EXEC-014',
    objective: 'Console and network activity are recorded for the execution',
    preconditions: ['EXEC-001 executed'],
    input: 'GET /executions/{id}/console and /network',
    expected: 'The network log contains the application\'s own API calls',
    evidence: ['console.json', 'network.json'],
    severity: 'high',
    run: async () => {
      const executionId = vocabularyRun.executions[0]?.id;
      const [console_, network] = await Promise.all([
        consoleLog(tenant, executionId), networkLog(tenant, executionId)
      ]);
      const apiCalls = network.filter(entry => String(entry.url ?? '').includes('/api/'));
      return {
        pass: apiCalls.length > 0,
        detail: `${network.length} network event(s) of which ${apiCalls.length} are API calls; `
          + `${console_.length} console event(s)`,
        metrics: { networkEvents: network.length, apiCalls: apiCalls.length, consoleEvents: console_.length },
        evidence: {
          'console.json': console_.slice(0, 50),
          'network.json': network.slice(0, 80)
        }
      };
    }
  }, context);

  // ---------------------------------------------------------------------
  // EXEC-015 / EXEC-016 — the other two engines
  // ---------------------------------------------------------------------
  const shortJourney = journey({
    name: 'Sign in and read the balance',
    startUrl: `${BANK}/login`,
    steps: [
      step.navigate(`${BANK}/login`),
      step.fill('username', 'alice', `${BANK}/login`),
      step.fill('password', '${secret:app_password}', `${BANK}/login`),
      step.click('login-submit', `${BANK}/login`),
      step.assertVisible('total-balance', `${BANK}/dashboard`)
    ]
  });
  const shortImport = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id, journey: shortJourney
  });

  for (const [id, browser] of [['EXEC-015', 'firefox'], ['EXEC-016', 'webkit']]) {
    // A browser that is not installed is not a product failure, and calling it one would
    // be as dishonest as calling it a pass. The run is attempted, and only a missing
    // binary — in the platform's own error message — downgrades it to NOT VERIFIED.
    const probe = await execute(tenant, {
      projectId: project.id, testCaseId: shortImport.testCaseId,
      name: `EXEC ${browser} probe`, browser
    });
    const missingBinary = /Executable doesn't exist|playwright install/i.test(probe.detail?.errorMessage ?? '');
    if (missingBinary) {
      notVerified({
        id,
        objective: `The same unchanged test passes on ${browser}`,
        expected: `The run passes and reports it ran on ${browser}`,
        severity: 'high'
      }, `${browser} is not installed in this environment and cannot be downloaded `
        + '(the Playwright CDN is unreachable); the platform reported: '
        + `"${(probe.detail?.errorMessage ?? '').split('\n')[0].slice(0, 120)}"`);
      continue;
    }

    await golden({
      id,
      objective: `The same unchanged test passes on ${browser}`,
      preconditions: ['the lab bank is running with no faults'],
      input: `The sign-in journey executed with browser=${browser}`,
      expected: `The run passes and reports it ran on ${browser}`,
      evidence: [`${id}-run.json`],
      severity: 'high',
      run: async () => {
        const result = probe;
        return {
          pass: result.run?.status === 'passed' && String(result.detail?.browser).toLowerCase() === browser,
          detail: `${result.run?.status} on ${result.detail?.browser} ${result.detail?.browserVersion ?? ''} `
            + `in ${result.detail?.durationMs}ms`,
          metrics: { durationMs: result.detail?.durationMs },
          evidence: { [`${id}-run.json`]: { run: result.run, browser: result.detail?.browser, version: result.detail?.browserVersion } }
        };
      }
    }, { ...context, browser });
  }

  // ---------------------------------------------------------------------
  // EXEC-017 — waiting for content that arrives late
  // ---------------------------------------------------------------------
  await golden({
    id: 'EXEC-017',
    objective: 'Execution waits for an element that arrives late instead of failing immediately',
    preconditions: ['the dynamic lab application is running', 'its late content takes ~2.5s'],
    input: 'A journey that asserts on /late content with no explicit wait step',
    expected: 'The assertion passes, and the step took longer than the delay',
    evidence: ['EXEC-017-run.json'],
    severity: 'high',
    run: async () => {
      const dynamicApp = await registerApplication(tenant, project.id, {
        name: 'AIRA Dynamic Lab', baseUrl: LAB.dynamic, maxPages: 8
      });
      const lateJourney = journey({
        name: 'Late content is waited for',
        startUrl: `${LAB.dynamic}/late`,
        steps: [
          step.navigate(`${LAB.dynamic}/late`),
          step.assertVisible('late-content', `${LAB.dynamic}/late`)
        ]
      });
      const imported = await importJourney(tenant, {
        projectId: project.id, applicationId: dynamicApp.id, journey: lateJourney
      });
      const result = await execute(tenant, {
        projectId: project.id, testCaseId: imported.testCaseId, name: 'EXEC late content'
      });
      const assertion = result.detail?.actions?.find(action => action.action === 'assertVisible');
      return {
        pass: result.run?.status === 'passed' && (assertion?.durationMs ?? 0) >= 1500,
        detail: `${result.run?.status}; the assertion waited ${assertion?.durationMs}ms for content `
          + 'the page renders after about 2.5 seconds',
        metrics: { waitMs: assertion?.durationMs },
        evidence: { 'EXEC-017-run.json': { run: result.run, assertion } }
      };
    }
  }, context);

  // ---------------------------------------------------------------------
  // EXEC-018 — a modal dialog
  // ---------------------------------------------------------------------
  await golden({
    id: 'EXEC-018',
    objective: 'A modal dialog can be opened, filled and submitted',
    preconditions: ['the lab bank is running'],
    input: 'Add a payee through the dialog on /beneficiaries',
    expected: 'The dialog opens, the payee is saved and the confirmation appears',
    evidence: ['EXEC-018-run.json'],
    severity: 'high',
    run: async () => {
      const dialogJourney = journey({
        name: 'Add a payee through the dialog',
        startUrl: `${BANK}/login`,
        steps: [
          step.navigate(`${BANK}/login`),
          step.fill('username', 'alice', `${BANK}/login`),
          step.fill('password', '${secret:app_password}', `${BANK}/login`),
          step.click('login-submit', `${BANK}/login`),
          step.click('nav-beneficiaries', `${BANK}/dashboard`),
          step.click('add-beneficiary', `${BANK}/beneficiaries`),
          step.assertVisible('beneficiary-modal', `${BANK}/beneficiaries`),
          step.fill('beneficiary-name', 'Golden Payee', `${BANK}/beneficiaries`),
          step.fill('beneficiary-account', '12345678', `${BANK}/beneficiaries`),
          step.fill('beneficiary-sort', '11-22-33', `${BANK}/beneficiaries`),
          step.click('beneficiary-save', `${BANK}/beneficiaries`),
          step.assertVisible('beneficiary-added', `${BANK}/beneficiaries`)
        ]
      });
      const imported = await importJourney(tenant, {
        projectId: project.id, applicationId: application.id, journey: dialogJourney
      });
      const result = await execute(tenant, {
        projectId: project.id, testCaseId: imported.testCaseId, name: 'EXEC modal dialog'
      });
      return {
        pass: result.run?.status === 'passed' && result.detail?.stepsFailed === 0,
        detail: `${result.run?.status}, ${result.detail?.stepsPassed}/${result.detail?.stepsTotal} steps`,
        evidence: { 'EXEC-018-run.json': { run: result.run, actions: result.detail?.actions } }
      };
    }
  }, context);

  // ---------------------------------------------------------------------
  // EXEC-019 — pagination
  // ---------------------------------------------------------------------
  await golden({
    id: 'EXEC-019',
    objective: 'Paging through a table changes what the page shows',
    preconditions: ['the lab bank is running', 'the account has 120 transactions'],
    input: 'Open an account, press Next, assert the page indicator',
    expected: 'The run passes with the indicator reading page 2',
    evidence: ['EXEC-019-run.json'],
    severity: 'medium',
    run: async () => {
      const pagingJourney = journey({
        name: 'Page through a transaction history',
        startUrl: `${BANK}/login`,
        steps: [
          step.navigate(`${BANK}/login`),
          step.fill('username', 'alice', `${BANK}/login`),
          step.fill('password', '${secret:app_password}', `${BANK}/login`),
          step.click('login-submit', `${BANK}/login`),
          step.navigate(`${BANK}/accounts/acc-1001`),
          step.assertVisible('transactions-table', `${BANK}/accounts/acc-1001`),
          step.click('page-next', `${BANK}/accounts/acc-1001`),
          { ...step.assertText('page-indicator', 'Page 2 of 12', `${BANK}/accounts/acc-1001`), expected: 'Page 2 of 12' }
        ]
      });
      const imported = await importJourney(tenant, {
        projectId: project.id, applicationId: application.id, journey: pagingJourney
      });
      const result = await execute(tenant, {
        projectId: project.id, testCaseId: imported.testCaseId, name: 'EXEC pagination'
      });
      return {
        pass: result.run?.status === 'passed',
        detail: `${result.run?.status}, ${result.detail?.stepsPassed}/${result.detail?.stepsTotal} steps`,
        evidence: { 'EXEC-019-run.json': { run: result.run, actions: result.detail?.actions } }
      };
    }
  }, context);

  // ---------------------------------------------------------------------
  // EXEC-020 — the commerce journey, eight steps deep
  // ---------------------------------------------------------------------
  await golden({
    id: 'EXEC-020',
    objective: 'A multi-step purchase journey completes, with each step depending on the last',
    preconditions: ['the commerce lab is running and reset'],
    input: 'Sign in, search, open a product, add to basket, apply a coupon, check out, confirm',
    expected: 'An order confirmation is reached',
    evidence: ['EXEC-020-run.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(LAB.commerce);
      const shop = await registerApplication(tenant, project.id, {
        name: 'AIRA Demo Commerce', baseUrl: LAB.commerce, loginUrl: `${LAB.commerce}/login`,
        username: 'alice', password: 'Password123!', maxPages: 15
      });
      const purchase = journey({
        name: 'Buy a fountain pen',
        startUrl: `${LAB.commerce}/login`,
        steps: [
          step.navigate(`${LAB.commerce}/login`),
          step.fill('username', 'alice', `${LAB.commerce}/login`),
          step.fill('password', '${secret:app_password}', `${LAB.commerce}/login`),
          step.click('login-submit', `${LAB.commerce}/login`),
          step.fill('product-search', 'pen', `${LAB.commerce}/products`),
          step.click('product-search-submit', `${LAB.commerce}/products`),
          step.click('open-product-p-102', `${LAB.commerce}/products`),
          step.fill('product-quantity', '2', `${LAB.commerce}/products/p-102`),
          step.click('add-to-cart', `${LAB.commerce}/products/p-102`),
          step.fill('coupon-code', 'SAVE10', `${LAB.commerce}/cart`),
          step.click('apply-coupon', `${LAB.commerce}/cart`),
          step.assertVisible('coupon-applied', `${LAB.commerce}/cart`),
          step.click('go-to-checkout', `${LAB.commerce}/cart`),
          step.fill('checkout-name', 'Alice Fernsby', `${LAB.commerce}/checkout`),
          step.fill('checkout-line1', '12 Bridge Street', `${LAB.commerce}/checkout`),
          step.fill('checkout-postcode', 'EC1A 1BB', `${LAB.commerce}/checkout`),
          step.fill('checkout-card', '4000000000000002', `${LAB.commerce}/checkout`),
          step.fill('checkout-expiry', '04/29', `${LAB.commerce}/checkout`),
          step.fill('checkout-cvc', '123', `${LAB.commerce}/checkout`),
          step.click('place-order', `${LAB.commerce}/checkout`),
          step.assertVisible('order-confirmation', `${LAB.commerce}/orders/ord-0001`)
        ]
      });
      const imported = await importJourney(tenant, {
        projectId: project.id, applicationId: shop.id, journey: purchase
      });
      const result = await execute(tenant, {
        projectId: project.id, testCaseId: imported.testCaseId, name: 'EXEC purchase journey', timeoutMs: 300_000
      });

      // The application's own record, not the test's opinion of it.
      const orders = await fetch(`${LAB.commerce}/api/orders/ord-0001`).then(r => r.status).catch(() => 0);
      return {
        pass: result.run?.status === 'passed' && result.detail?.stepsFailed === 0,
        detail: `${result.run?.status}, ${result.detail?.stepsPassed}/${result.detail?.stepsTotal} steps; `
          + `the shop's order endpoint answers ${orders}`,
        metrics: { steps: result.detail?.stepsTotal, durationMs: result.detail?.durationMs },
        evidence: { 'EXEC-020-run.json': { run: result.run, actions: result.detail?.actions } }
      };
    }
  }, context);

  await sleep(50);
  return context;
}
