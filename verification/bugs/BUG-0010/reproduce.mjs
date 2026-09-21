/**
 * BUG-0010 — an assertion step loses its expected value between import and execution.
 *
 * Runs three journeys twice each: a text assertion that should fail, a URL assertion that
 * should fail, and a value assertion that should pass. The third is the defect.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAB, createProject, execute, importJourney, journey, lab, newTenant, registerApplication, step
} from '../../golden-tests/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BANK = LAB.banking;
const signIn = () => [
  step.navigate(`${BANK}/login`),
  step.fill('username', 'alice', `${BANK}/login`),
  step.fill('password', '${secret:app_password}', `${BANK}/login`),
  step.click('login-submit', `${BANK}/login`)
];

const CASES = [
  {
    id: 'wrong-text', mustEnd: 'failed',
    why: 'the expected text does not match the page',
    steps: () => [...signIn(), step.assertText('page-title', 'Totally Wrong Title', `${BANK}/dashboard`)]
  },
  {
    id: 'wrong-url', mustEnd: 'failed',
    why: 'the expected fragment is not in the address',
    steps: () => [...signIn(), step.assertUrl('/nowhere-at-all', `${BANK}/dashboard`)]
  },
  {
    id: 'right-value', mustEnd: 'passed',
    why: 'the field really does hold 100',
    steps: () => [
      ...signIn(),
      step.click('nav-transactions', `${BANK}/dashboard`),
      step.fill('filter-min', '100', `${BANK}/transactions`),
      step.assertValue('filter-min', '100', `${BANK}/transactions`)
    ]
  }
];

const attempts = [];
for (const attempt of [1, 2]) {
  await lab.reset(BANK);
  const tenant = await newTenant(`Bug0010-${attempt}`);
  const project = await createProject(tenant, `BUG-0010 attempt ${attempt}`);
  const application = await registerApplication(tenant, project.id, {
    name: 'AIRA Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
    username: 'alice', password: 'Password123!'
  });

  for (const testCase of CASES) {
    const imported = await importJourney(tenant, {
      projectId: project.id, applicationId: application.id,
      journey: journey({ name: `${testCase.id} (${attempt})`, startUrl: `${BANK}/login`, steps: testCase.steps() })
    });
    const result = await execute(tenant, {
      projectId: project.id, testCaseId: imported.testCaseId, name: `BUG-0010 ${testCase.id}`
    });
    const assertion = (result.detail?.actions ?? []).at(-1);
    const correct = result.run?.status === testCase.mustEnd;
    attempts.push({
      attempt, case: testCase.id, expectedVerdict: testCase.mustEnd, actualVerdict: result.run?.status,
      correct, why: testCase.why,
      lastAction: assertion && {
        action: assertion.action, status: assertion.status, error: assertion.errorMessage
      }
    });
    console.log(`${correct ? 'ok  ' : 'BUG '} attempt ${attempt} ${testCase.id}: expected ${testCase.mustEnd}, got ${result.run?.status}`
      + (assertion?.errorMessage ? ` — ${assertion.errorMessage.slice(0, 80)}` : ''));
  }
}

const wrong = attempts.filter(record => !record.correct);
await writeFile(resolve(here, 'evidence/reproduction.json'), `${JSON.stringify({
  bug: 'BUG-0010',
  summary: 'An assertion step is evaluated twice: once as an action, whose expected value the '
    + 'execution plan never carries, and once as a planned assertion, which has it. assertValue '
    + 'therefore always fails; assertText and assertUrl pass vacuously at the action level.',
  incorrectVerdicts: wrong.length, of: attempts.length, attempts
}, null, 2)}\n`);
console.log(`\n${wrong.length} of ${attempts.length} verdicts were wrong`);
process.exit(wrong.length === 0 ? 0 : 1);
