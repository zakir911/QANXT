/**
 * BUG-0009 — a journey that signs in itself, and one that does not, against the same
 * application. Both must pass.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAB, createProject, execute, importJourney, journey, lab, newTenant, registerApplication, step
} from '../../golden-tests/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BANK = LAB.banking;
await lab.reset(BANK);

const tenant = await newTenant('Bug0009');
const project = await createProject(tenant, 'BUG-0009');
const application = await registerApplication(tenant, project.id, {
  name: 'AIRA Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
  username: 'alice', password: 'Password123!'
});

const cases = [
  {
    name: 'the test signs in itself',
    journey: journey({
      name: 'Recorded sign-in replayed',
      startUrl: `${BANK}/login`,
      steps: [
        step.navigate(`${BANK}/login`),
        step.fill('username', 'alice', `${BANK}/login`),
        step.fill('password', '${secret:app_password}', `${BANK}/login`),
        step.click('login-submit', `${BANK}/login`),
        step.assertVisible('total-balance', `${BANK}/dashboard`)
      ]
    })
  },
  {
    name: 'the test assumes the platform signed in',
    journey: journey({
      name: 'Starts on the dashboard',
      startUrl: `${BANK}/dashboard`,
      steps: [
        step.navigate(`${BANK}/dashboard`),
        step.assertVisible('total-balance', `${BANK}/dashboard`)
      ]
    })
  }
];

const outcomes = [];
for (const testCase of cases) {
  const imported = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id, journey: testCase.journey
  });
  const result = await execute(tenant, {
    projectId: project.id, testCaseId: imported.testCaseId, name: testCase.name
  });
  const failing = (result.detail?.actions ?? []).find(action => action.status !== 'passed') ?? null;
  outcomes.push({
    case: testCase.name,
    status: result.run?.status,
    stepsPassed: result.detail?.stepsPassed,
    stepsTotal: result.detail?.stepsTotal,
    firstFailure: failing && { order: failing.order, action: failing.action, url: failing.url, error: failing.errorMessage }
  });
  console.log(`${result.run?.status === 'passed' ? 'PASS' : 'FAIL'}  ${testCase.name} — `
    + `${result.detail?.stepsPassed}/${result.detail?.stepsTotal} steps`
    + (failing ? `; first failure at step ${failing.order} on ${failing.url}` : ''));
}

await writeFile(resolve(here, 'evidence/reproduction.json'),
  `${JSON.stringify({ bug: 'BUG-0009', outcomes }, null, 2)}\n`);

const bothPass = outcomes.every(outcome => outcome.status === 'passed');
console.log(`\n${bothPass ? 'both journeys pass — the defect is fixed' : 'the defect reproduces'}`);
process.exit(bothPass ? 0 : 1);
