/**
 * Change impact and regression selection.
 *
 * The optimisation is not what these tests are about. A selector that narrows wrongly
 * produces a green pipeline that did not run the test which would have caught the defect,
 * and nobody finds out until production — so most of what follows is about what the
 * selector does when it is uncertain, and whether it can explain itself when it is not.
 *
 * Three properties have to hold, and each has a test that fails if it stops holding:
 *
 *   - A change it cannot map to anything runs everything, loudly. Never nothing.
 *   - A narrowed selection says, per test, why that test is in it.
 *   - A test the change genuinely reaches is never left out.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { golden, suite, ROOT } from '../harness.mjs';
import {
  API, LAB, createApiTest, createEnvironment, createProject, importJourney, journey, lab,
  newTenant, registerApplication, request, requireApiTest, runDiscovery, step
} from '../platform.mjs';

const BANK = LAB.banking;
const CREDENTIALS = { username: 'alice', password: 'Password123!' };

/**
 * Runs the CLI as a pipeline would, and reports its exit status rather than throwing.
 *
 * Both streams are captured. The CLI writes results to stdout and progress to stderr on
 * purpose, so that `--json` output stays machine-readable — a test that read only stdout
 * would see an empty transcript for every command whose output is meant for a person.
 */
function cli(args, { token, projectId } = {}) {
  const binary = resolve(ROOT, 'packages/cli/dist/qanxt.js');
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    env: {
      ...process.env,
      QANXT_API_URL: API,
      QANXT_TOKEN: token ?? '',
      QANXT_PROJECT_ID: projectId ?? '',
      NO_COLOR: '1'
    }
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    code: result.status ?? -1,
    stdout,
    stderr,
    /** What a person watching the pipeline would see, in order. */
    output: `${stdout}${stderr}`
  };
}

export default async function run() {
  suite('Regression selection');
  await lab.reset(BANK);

  const tenant = await newTenant('Regression');
  const project = await createProject(tenant, 'Golden regression selection');
  const application = await registerApplication(tenant, project.id, {
    name: 'Lab Bank regression', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
  });
  await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  await runDiscovery(tenant, application.id, { timeoutMs: 300_000 });

  // A small suite covering three different areas of the bank, so a narrowed selection has
  // something to narrow away from.
  const accountsTest = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id,
    journey: journey({
      name: 'Accounts list opens', startUrl: `${BANK}/accounts`,
      steps: [
        step.navigate(`${BANK}/accounts`, 'Open the accounts list'),
        step.assertVisible('accounts-table', `${BANK}/accounts`, 'The accounts are listed')
      ]
    })
  });

  const paymentsTest = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id,
    journey: journey({
      name: 'Payments page opens', startUrl: `${BANK}/payments`,
      steps: [
        step.navigate(`${BANK}/payments`, 'Open the payments page'),
        step.assertVisible('payment-form', `${BANK}/payments`, 'The payment form is shown')
      ]
    })
  });

  const profileTest = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id,
    journey: journey({
      name: 'Profile page opens', startUrl: `${BANK}/profile`,
      steps: [
        step.navigate(`${BANK}/profile`, 'Open the profile page'),
        step.assertVisible('profile-form', `${BANK}/profile`, 'The profile form is shown')
      ]
    })
  });

  const accountsApiTest = await requireApiTest(tenant, {
    projectId: project.id, applicationId: application.id,
    suiteName: 'Regression — API',
    name: 'The accounts endpoint answers',
    steps: [
      {
        description: 'Sign in',
        request: {
          method: 'POST', path: '/api/session', contentType: 'application/json',
          body: JSON.stringify({ username: CREDENTIALS.username, password: '${secret:app_password}' }),
          auth: { mode: 'none' }
        },
        assertions: [{ type: 'httpStatusEquals', expected: '200' }]
      },
      {
        description: 'Read the accounts',
        request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' } },
        assertions: [{ type: 'httpStatusEquals', expected: '200' }]
      }
    ]
  });

  const smokeTest = await requireApiTest(tenant, {
    projectId: project.id, applicationId: application.id,
    suiteName: 'Regression — API',
    name: 'The application is up',
    tags: 'smoke',
    steps: [{
      description: 'Health check',
      request: { method: 'GET', path: '/health', auth: { mode: 'none' } },
      assertions: [{ type: 'httpStatusEquals', expected: '200' }]
    }]
  });

  const rule = async (body) => {
    const response = await request(`/api/v1/regression/rules?projectId=${project.id}`, {
      token: tenant.token, method: 'POST', body
    });
    if (!response.ok) throw new Error(`rule refused: ${response.status} ${response.text.slice(0, 200)}`);
    return response.json;
  };

  const select = async (body) => {
    const response = await request('/api/v1/regression/select', {
      token: tenant.token, method: 'POST', body: { projectId: project.id, ...body }
    });
    return response;
  };

  await rule({
    pathPattern: 'src/pages/accounts/**', kind: 'route', value: '/accounts',
    notes: 'The accounts screens.'
  });
  await rule({
    pathPattern: 'src/api/accounts/**', kind: 'apiEndpoint', value: '/api/accounts',
    notes: 'The accounts service.'
  });
  await rule({
    pathPattern: 'src/shared/**', kind: 'everything', value: '',
    notes: 'Shared code reaches the whole application.'
  });

  // ---- REG-001: a change maps to what a rule says it affects -------------
  await golden({
    id: 'REG-001',
    objective: 'A changed file is mapped to what a rule says it affects, and the mapping is marked as declared',
    preconditions: ['three impact rules are configured'],
    input: 'A change to src/pages/accounts/List.tsx',
    expected: 'The /accounts route affected, the mapping marked declared, and the rule\'s '
      + 'own note carried into the reason',
    evidence: ['impact.json'],
    severity: 'critical',
    run: async () => {
      const response = await request('/api/v1/regression/impact', {
        token: tenant.token, method: 'POST',
        body: {
          projectId: project.id, applicationId: application.id,
          changedPaths: ['src/pages/accounts/List.tsx']
        }
      });

      const impact = response.json;
      const mapping = (impact?.impacts ?? [])[0];

      return {
        pass: response.ok
          && impact.affectedRoutes.includes('/accounts')
          && mapping?.isDeclared === true
          && mapping.reason.includes('The accounts screens'),
        detail: `${impact?.matchedPathCount}/${impact?.changedPathCount} path(s) mapped; `
          + `routes ${JSON.stringify(impact?.affectedRoutes)}; declared=${mapping?.isDeclared}`,
        evidence: { 'impact.json': impact }
      };
    }
  }, context);

  // ---- REG-002: a change to shared code reaches everything ---------------
  await golden({
    id: 'REG-002',
    objective: 'A change a rule marks as shared selects the whole suite rather than a narrowed set',
    preconditions: ['a rule maps src/shared/** to everything'],
    input: 'A change to src/shared/format.ts',
    expected: 'Every enabled test selected, with a note saying why',
    evidence: ['selection.json'],
    severity: 'critical',
    run: async () => {
      const response = await select({
        applicationId: application.id,
        changedPaths: ['src/shared/format.ts']
      });
      const selection = response.json;

      return {
        // Narrowing a change to shared code would be a guess dressed up as an optimisation.
        pass: response.ok
          && selection.mode === 'full'
          && selection.selectedCount === selection.totalCandidates
          && selection.notes.some(note => note.includes('affecting everything')),
        detail: `mode ${selection?.mode}, ${selection?.selectedCount}/${selection?.totalCandidates} selected`,
        evidence: { 'selection.json': selection }
      };
    }
  }, context);

  // ---- REG-003: a narrowed selection is genuinely narrowed ---------------
  await golden({
    id: 'REG-003',
    objective: 'A change to one area selects the tests that reach it and leaves the others out',
    preconditions: ['tests covering accounts, payments and profile exist'],
    input: 'A change to src/pages/accounts/List.tsx and src/api/accounts/service.ts',
    expected: 'The accounts tests and the smoke test selected; the payments and profile '
      + 'tests left out with their scores shown',
    evidence: ['selection.json'],
    severity: 'critical',
    run: async () => {
      const response = await select({
        applicationId: application.id,
        changedPaths: ['src/pages/accounts/List.tsx', 'src/api/accounts/service.ts']
      });
      const selection = response.json;

      const selected = new Set((selection?.selected ?? []).map(test => test.testCaseId));
      const excluded = new Set((selection?.excluded ?? []).map(test => test.testCaseId));

      return {
        pass: response.ok
          && selection.mode === 'impacted'
          && selected.has(accountsTest.testCaseId)
          && selected.has(accountsApiTest.testCaseId)
          && selected.has(smokeTest.testCaseId)
          && excluded.has(paymentsTest.testCaseId)
          && excluded.has(profileTest.testCaseId),
        detail: `${selection?.selectedCount}/${selection?.totalCandidates} selected: `
          + (selection?.selected ?? []).map(t => `${t.reference}(${t.score})`).join(' ')
          + ` | excluded: ` + (selection?.excluded ?? []).map(t => `${t.reference}(${t.score})`).join(' '),
        metrics: {
          selected: selection?.selectedCount ?? 0,
          total: selection?.totalCandidates ?? 0
        },
        evidence: { 'selection.json': selection }
      };
    }
  }, context);

  // ---- REG-004: a change it cannot map runs everything -------------------
  await golden({
    id: 'REG-004',
    objective: 'A change QA NXT cannot map to anything runs the whole suite, and says so',
    preconditions: ['no rule covers the changed path'],
    input: 'A change to infrastructure/terraform/main.tf',
    expected: 'Every test selected, the fallback reported, and the unmapped path named — '
      + 'never an empty selection, which a pipeline would read as a pass',
    evidence: ['selection.json'],
    severity: 'critical',
    run: async () => {
      const response = await select({
        applicationId: application.id,
        changedPaths: ['infrastructure/terraform/main.tf']
      });
      const selection = response.json;

      return {
        // This is the safety property the whole feature rests on.
        pass: response.ok
          && selection.fellBackToFull === true
          && selection.mode === 'full'
          && selection.selectedCount === selection.totalCandidates
          && selection.impact.unmatchedPaths.includes('infrastructure/terraform/main.tf'),
        detail: `fellBack=${selection?.fellBackToFull}, mode ${selection?.mode}, `
          + `${selection?.selectedCount}/${selection?.totalCandidates} selected; `
          + `unmatched: ${JSON.stringify(selection?.impact?.unmatchedPaths)}`,
        evidence: { 'selection.json': selection }
      };
    }
  }, context);

  // ---- REG-005: an empty change set runs everything ----------------------
  await golden({
    id: 'REG-005',
    objective: 'A selection with no changed paths at all runs everything rather than nothing',
    preconditions: ['none'],
    input: 'A selection request with an empty change set',
    expected: 'The whole suite, the fallback reported',
    evidence: ['selection.json'],
    severity: 'critical',
    run: async () => {
      const response = await select({ applicationId: application.id, changedPaths: [] });
      const selection = response.json;

      return {
        pass: response.ok
          && selection.fellBackToFull === true
          && selection.selectedCount === selection.totalCandidates,
        detail: `fellBack=${selection?.fellBackToFull}, `
          + `${selection?.selectedCount}/${selection?.totalCandidates} selected`,
        evidence: { 'selection.json': selection }
      };
    }
  }, context);

  // ---- REG-006: every selected test explains itself ----------------------
  await golden({
    id: 'REG-006',
    objective: 'Every selected test carries its score, the score\'s components and the reason for each',
    preconditions: ['REG-003 produced a narrowed selection'],
    input: 'The same accounts change',
    expected: 'Five named components per test, each capped and each with a sentence; and '
      + 'reasons that name the route the change affects',
    evidence: ['explained.json'],
    severity: 'critical',
    run: async () => {
      const response = await select({
        applicationId: application.id,
        changedPaths: ['src/pages/accounts/List.tsx']
      });
      const selection = response.json;
      const accounts = (selection?.selected ?? [])
        .find(test => test.testCaseId === accountsTest.testCaseId);

      const componentNames = (accounts?.components ?? []).map(c => c.name).sort();
      const everyComponentExplained = (accounts?.components ?? [])
        .every(c => typeof c.reason === 'string' && c.reason.length > 10 && c.maximum > 0);

      return {
        pass: accounts !== undefined
          && JSON.stringify(componentNames) === JSON.stringify(['always', 'history', 'impact', 'risk', 'staleness'])
          && everyComponentExplained
          && accounts.reasons.some(reason => reason.includes('/accounts')),
        detail: accounts === undefined
          ? 'the accounts test was not selected'
          : `score ${accounts.score} from ${accounts.components.length} component(s); `
            + `reasons: ${accounts.reasons.join(' | ')}`,
        evidence: { 'explained.json': accounts }
      };
    }
  }, context);

  // ---- REG-007: the smoke set runs whatever changed ----------------------
  await golden({
    id: 'REG-007',
    objective: 'A test tagged smoke is selected even when the change does not reach it',
    preconditions: ['a smoke-tagged test exists that the change does not touch'],
    input: 'A change to src/pages/accounts/List.tsx',
    expected: 'The smoke test selected, with the always component as its reason',
    evidence: ['selection.json'],
    severity: 'high',
    run: async () => {
      const response = await select({
        applicationId: application.id,
        changedPaths: ['src/pages/accounts/List.tsx']
      });
      const smoke = (response.json?.selected ?? [])
        .find(test => test.testCaseId === smokeTest.testCaseId);

      return {
        pass: smoke !== undefined
          && smoke.isImpacted === false
          && smoke.reasons.some(reason => reason.toLowerCase().includes('always')),
        detail: smoke === undefined
          ? 'the smoke test was not selected'
          : `selected at ${smoke.score}, impacted=${smoke.isImpacted}; ${smoke.reasons.join(' | ')}`,
        evidence: { 'selection.json': response.json }
      };
    }
  }, context);

  // ---- REG-008: an inferred mapping is labelled as inferred --------------
  await golden({
    id: 'REG-008',
    objective: 'A mapping QA NXT inferred from a file name is reported as inferred, not declared',
    preconditions: ['no rule covers the changed path, but its name resembles a route'],
    input: 'A change to app/screens/payments/PaymentsScreen.tsx',
    expected: 'The payments route affected, marked as inferred, with a reason saying so',
    evidence: ['impact.json'],
    severity: 'high',
    run: async () => {
      const response = await request('/api/v1/regression/impact', {
        token: tenant.token, method: 'POST',
        body: {
          projectId: project.id, applicationId: application.id,
          changedPaths: ['app/screens/payments/PaymentsScreen.tsx']
        }
      });
      const impact = response.json;
      const inferred = (impact?.impacts ?? []).filter(entry => !entry.isDeclared);

      return {
        // "Probably" is exactly the word a team needs to see next to a decision about
        // which tests to skip.
        pass: response.ok
          && inferred.length > 0
          && inferred.some(entry => entry.value.includes('payments'))
          && inferred.every(entry => entry.reason.includes('Inferred, not declared'))
          && impact.notes.some(note => note.includes('inferred from file and directory names')),
        detail: `${inferred.length} inferred mapping(s): `
          + inferred.map(entry => `${entry.kind} ${entry.value}`).join(', '),
        evidence: { 'impact.json': impact }
      };
    }
  }, context);

  // ---- REG-009: the CLI selects, explains and runs ------------------------
  await golden({
    id: 'REG-009',
    objective: 'A pipeline can select, inspect and run a regression set through the CLI',
    preconditions: ['the CLI is built', 'the lab bank is running'],
    input: '"qanxt regression select --explain", then "qanxt regression run", on a change '
      + 'to the accounts area',
    expected: 'select exits 0 and prints each test\'s components; run exits 0 and executes '
      + 'only the selected tests; the selection is written as an artifact',
    evidence: ['cli-output.txt', 'regression-selection.json'],
    severity: 'critical',
    run: async ({ save }) => {
      await lab.reset(BANK);
      const directory = mkdtempSync(join(tmpdir(), 'qanxt-regression-'));
      const changedFile = join(directory, 'changed.txt');
      writeFileSync(changedFile, 'src/pages/accounts/List.tsx\nsrc/api/accounts/service.ts\n');
      const selectionOut = join(directory, 'regression-selection.json');

      const options = { token: tenant.token, projectId: project.id };

      const explained = cli([
        'regression', 'select', '--changed-file', changedFile, '--explain',
        '--selection-out', selectionOut
      ], options);

      const ran = cli([
        'regression', 'run', '--changed-file', changedFile, '--timeout', '240'
      ], options);

      const transcript = [
        `$ qanxt regression select --changed-file changed.txt --explain   (exit ${explained.code})`,
        explained.output,
        `$ qanxt regression run --changed-file changed.txt                (exit ${ran.code})`,
        ran.output
      ].join('\n');

      let written = null;
      try {
        const { readFileSync } = await import('node:fs');
        written = JSON.parse(readFileSync(selectionOut, 'utf8'));
      } catch {
        // Reported by the assertion below rather than swallowed.
      }

      return {
        pass: explained.code === 0
          && ran.code === 0
          // --explain has to actually explain: the component table, not just the totals.
          && /impact\s+\d+\/40/.test(explained.output)
          && written !== null
          && written.selected.length > 0
          && written.selected.length < written.totalCandidates,
        detail: `select exit ${explained.code}, run exit ${ran.code}; `
          + `artifact: ${written === null ? 'not written' : `${written.selected.length}/${written.totalCandidates} test(s)`}`,
        metrics: { selectExit: explained.code, runExit: ran.code },
        evidence: {
          'cli-output.txt': transcript,
          'regression-selection.json': written ?? 'not written'
        }
      };
    }
  }, context);

  // ---- REG-010: the selection is reproducible -----------------------------
  await golden({
    id: 'REG-010',
    objective: 'The same change produces the same selection and the same scores',
    preconditions: ['nothing has run between the two selections'],
    input: 'The same selection request, twice',
    expected: 'Identical tests, identical scores, identical component points — nothing '
      + 'learned, nothing tuned, nothing that drifts on its own',
    evidence: ['first.json', 'second.json'],
    severity: 'critical',
    run: async () => {
      const body = {
        applicationId: application.id,
        changedPaths: ['src/pages/accounts/List.tsx']
      };

      const first = await select(body);
      const second = await select(body);

      const fingerprint = selection => (selection?.selected ?? [])
        .map(test => `${test.reference}:${test.score}:`
          + test.components.map(c => `${c.name}=${c.points}`).join(','))
        .join('|');

      const a = fingerprint(first.json);
      const b = fingerprint(second.json);

      return {
        // A release decision that cannot be reproduced is not a decision.
        pass: first.ok && second.ok && a === b && a.length > 0,
        detail: a === b
          ? `identical across both runs: ${(first.json?.selected ?? []).length} test(s)`
          : `differed:\n  ${a}\n  ${b}`,
        evidence: { 'first.json': first.json, 'second.json': second.json }
      };
    }
  }, context);

  // ---- REG-011: a rule with no pattern is refused -------------------------
  await golden({
    id: 'REG-011',
    objective: 'A rule that would silently match nothing, or affect nothing, is refused',
    preconditions: ['none'],
    input: 'A rule with a blank pattern, and one with a kind but no value',
    expected: 'Both refused with a message naming what is missing',
    evidence: ['refusals.json'],
    severity: 'high',
    run: async () => {
      const blankPattern = await request(`/api/v1/regression/rules?projectId=${project.id}`, {
        token: tenant.token, method: 'POST',
        body: { pathPattern: '   ', kind: 'route', value: '/x' }
      });

      const noValue = await request(`/api/v1/regression/rules?projectId=${project.id}`, {
        token: tenant.token, method: 'POST',
        body: { pathPattern: 'src/**', kind: 'route' }
      });

      return {
        // A rule that matches nothing is a no-op a team would never notice; one with no
        // value would map a change to the empty string.
        pass: blankPattern.status === 400 && noValue.status === 400,
        detail: `blank pattern: ${blankPattern.status}; missing value: ${noValue.status}`,
        evidence: {
          'refusals.json': {
            blankPattern: blankPattern.json,
            missingValue: noValue.json
          }
        }
      };
    }
  }, context);

  // ---- REG-012: a selection with no tests is refused ---------------------
  await golden({
    id: 'REG-012',
    objective: 'A selection that would contain no tests is refused rather than returned empty',
    preconditions: ['a tag filter that matches nothing'],
    input: 'A selection restricted to a tag no test carries',
    expected: 'A refusal saying a run with nothing in it would report success without '
      + 'testing anything',
    evidence: ['refusal.json'],
    severity: 'critical',
    run: async () => {
      const response = await select({
        applicationId: application.id,
        changedPaths: ['src/pages/accounts/List.tsx'],
        includeTags: ['a-tag-nothing-carries']
      });

      const message = response.json?.title ?? response.text;

      return {
        pass: response.status === 400 && message.includes('without testing anything'),
        detail: `status ${response.status}: ${String(message).slice(0, 200)}`,
        evidence: { 'refusal.json': response.json ?? response.text }
      };
    }
  }, context);
}
