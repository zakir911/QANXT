/**
 * BUG-0014 — text and value assertions do not wait for the value they expect.
 *
 * Two cases of the same page: one where the answer is immediate, one where it arrives
 * three seconds later. Both should pass; the second fails in about 20 milliseconds.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAB, createProject, execute, importJourney, journey, lab, newTenant, registerApplication, step
} from '../../golden-tests/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FAIL_LAB = LAB.failure;
const attempts = [];

for (const attempt of [1, 2]) {
  await lab.reset(FAIL_LAB);
  const tenant = await newTenant(`Bug0014-${attempt}`);
  const project = await createProject(tenant, `BUG-0014 attempt ${attempt}`);
  const application = await registerApplication(tenant, project.id, {
    name: 'AIRA Failure Lab', baseUrl: FAIL_LAB, maxPages: 5
  });

  for (const testCase of ['healthy', 'slow']) {
    const imported = await importJourney(tenant, {
      projectId: project.id, applicationId: application.id,
      journey: journey({
        name: `${testCase} ${attempt}`,
        startUrl: `${FAIL_LAB}/case/${testCase}`,
        steps: [
          step.navigate(`${FAIL_LAB}/case/${testCase}`),
          step.click('run-case', `${FAIL_LAB}/case/${testCase}`),
          step.assertText('outcome', 'OK 42', `${FAIL_LAB}/case/${testCase}`)
        ]
      })
    });
    const result = await execute(tenant, {
      projectId: project.id, testCaseId: imported.testCaseId, name: `BUG-0014 ${testCase} ${attempt}`,
      timeoutMs: 200_000
    });
    const assertion = (result.detail?.actions ?? []).at(-1);
    attempts.push({
      attempt, case: testCase, expected: 'passed', status: result.run?.status,
      assertionStatus: assertion?.status, assertionMs: assertion?.durationMs,
      message: assertion?.errorMessage ?? null,
      correct: result.run?.status === 'passed'
    });
    console.log(`attempt ${attempt} ${testCase.padEnd(8)}: run ${result.run?.status}, `
      + `assertion ${assertion?.status} after ${assertion?.durationMs}ms`
      + (assertion?.errorMessage ? ` — ${assertion.errorMessage.slice(0, 70)}` : ''));
  }
}

const wrong = attempts.filter(record => !record.correct);
await writeFile(resolve(here, 'evidence/reproduction.json'), `${JSON.stringify({
  bug: 'BUG-0014',
  summary: 'assertText and assertValue read the element once instead of waiting for the '
    + 'expected value, so any asynchronously rendered content fails.',
  incorrect: wrong.length, of: attempts.length, attempts
}, null, 2)}\n`);
console.log(`\n${wrong.length} of ${attempts.length} runs gave the wrong verdict`);
process.exit(wrong.length === 0 ? 0 : 1);
