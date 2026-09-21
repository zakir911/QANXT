/**
 * BUG-0012 — an assertion failure is classified as "unknown".
 *
 * Runs the wrong-value case twice: the application renders 99 where the test expects 42,
 * which is the most ordinary kind of application bug there is.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAB, createProject, execute, importJourney, journey, lab, newTenant, registerApplication, step
} from '../../golden-tests/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FAIL_LAB = LAB.failure;
await lab.reset(FAIL_LAB);

const tenant = await newTenant('Bug0012');
const project = await createProject(tenant, 'BUG-0012');
const application = await registerApplication(tenant, project.id, {
  name: 'AIRA Failure Lab', baseUrl: FAIL_LAB, maxPages: 15
});

const attempts = [];
for (const [attempt, name, expectedCategories] of [
  [1, 'wrong-value', ['applicationDefect', 'dataIssue']],
  [2, 'wrong-value', ['applicationDefect', 'dataIssue']]
]) {
  const imported = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id,
    journey: journey({
      name: `Wrong value ${attempt}`,
      startUrl: `${FAIL_LAB}/case/${name}`,
      steps: [
        step.navigate(`${FAIL_LAB}/case/${name}`),
        step.click('run-case', `${FAIL_LAB}/case/${name}`),
        step.assertText('outcome', 'OK 42', `${FAIL_LAB}/case/${name}`)
      ]
    })
  });
  const result = await execute(tenant, {
    projectId: project.id, testCaseId: imported.testCaseId, name: `BUG-0012 ${attempt}`
  });
  const failure = result.detail?.failure;
  const category = String(failure?.category ?? 'none');
  attempts.push({
    attempt, status: result.run?.status, category,
    confidence: failure?.categoryConfidence,
    message: failure?.rawMessage?.slice(0, 200),
    correct: expectedCategories.includes(category)
  });
  console.log(`attempt ${attempt}: ${result.run?.status}, classified "${category}" `
    + `at ${failure?.categoryConfidence}% — ${expectedCategories.includes(category) ? 'ok' : 'WRONG'}`);
  console.log(`   message: ${failure?.rawMessage?.slice(0, 120)}`);
}

const wrong = attempts.filter(record => !record.correct);
await writeFile(resolve(here, 'evidence/reproduction.json'), `${JSON.stringify({
  bug: 'BUG-0012',
  summary: 'The failure classifier matches on message text that the execution engine no '
    + 'longer produces, so an assertion failure — the commonest real defect — falls through '
    + 'to Unknown.',
  misclassified: wrong.length, of: attempts.length, attempts
}, null, 2)}\n`);
console.log(`\n${wrong.length} of ${attempts.length} misclassified`);
process.exit(wrong.length === 0 ? 0 : 1);
