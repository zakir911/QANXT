/**
 * BUG-0015 — a missing control is blamed on the session.
 *
 * Removes the bank's sign-in button, then runs a journey that signs in. The step fails
 * because nothing on the page submits the form; the platform reports an authentication
 * problem, because the signed-out application answered its own session probe with 401
 * while the page was still loading.
 *
 * Run twice, because a classification that depends on network traffic could plausibly
 * differ between runs.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAB, createProject, execute, importJourney, journey, lab, newTenant, registerApplication, step
} from '../../golden-tests/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BANK = LAB.banking;

const tenant = await newTenant('Bug0015');
const project = await createProject(tenant, 'BUG-0015');
const application = await registerApplication(tenant, project.id, {
  name: 'AIRA Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
  username: 'alice', password: 'Password123!'
});

const attempts = [];
for (const attempt of [1, 2]) {
  await lab.reset(BANK);
  await lab.set(BANK, { FAULT_LOGIN_BUTTON_REMOVED: true });

  const imported = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id,
    journey: journey({
      name: `Sign in ${attempt}`,
      startUrl: `${BANK}/login`,
      steps: [
        step.navigate(`${BANK}/login`),
        step.fill('username', 'alice', `${BANK}/login`),
        step.fill('password', '${secret:app_password}', `${BANK}/login`),
        step.click('login-submit', `${BANK}/login`),
        step.assertVisible('total-balance', `${BANK}/dashboard`)
      ]
    })
  });

  const result = await execute(tenant, {
    projectId: project.id, testCaseId: imported.testCaseId, name: `BUG-0015 ${attempt}`
  });
  const failure = result.detail?.failure;
  const category = String(failure?.category ?? 'none');
  const failingStep = (result.detail?.actions ?? []).find(action => action.status !== 'passed');

  // The correct verdict names the element. Anything that sends a reader to check account
  // permissions is wrong, however confidently it is said.
  const correct = category === 'locatorChange';
  attempts.push({
    attempt, status: result.run?.status, category,
    confidence: failure?.categoryConfidence,
    failingStep: failingStep && { order: failingStep.order, action: failingStep.action, error: failingStep.errorMessage },
    summary: failure?.analysis?.summary,
    suggestedAction: failure?.analysis?.suggestedAction,
    correct
  });
  console.log(`attempt ${attempt}: ${result.run?.status}, classified "${category}" at `
    + `${failure?.categoryConfidence}% — ${correct ? 'ok' : 'WRONG'}`);
  console.log(`   step ${failingStep?.order} (${failingStep?.action}): ${failingStep?.errorMessage}`);
  console.log(`   says: ${failure?.analysis?.suggestedAction}`);
}

await lab.reset(BANK);

const wrong = attempts.filter(record => !record.correct);
await writeFile(resolve(here, 'evidence/reproduction.json'), `${JSON.stringify({
  bug: 'BUG-0015',
  summary: 'A 401 the application returns on its own sign-in page — the ordinary answer to '
    + '"is anyone signed in?" — outranks the engine\'s own statement that the step found no '
    + 'element, so a removed button is reported as an authentication problem.',
  misclassified: wrong.length, of: attempts.length, attempts
}, null, 2)}\n`);
console.log(`\n${wrong.length} of ${attempts.length} misclassified`);
process.exit(wrong.length === 0 ? 0 : 1);
