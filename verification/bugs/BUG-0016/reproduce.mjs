/**
 * BUG-0016 — the generator emits an assertion that cannot fail.
 *
 * The rules engine produces a "Reject an invalid filter range" scenario whose final
 * assertion is that the *filter control* is visible. The filter control was visible before
 * the click and is visible after it, whatever the application does with the range. The
 * generated step's own description admits the assertion is a placeholder.
 *
 * This script generates against the bank twice and reports, for each filter scenario, the
 * element its closing assertion targets and whether that element was already on the page
 * before the action the scenario is about.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAB, applicationModel, createProject, generateTests, lab, newTenant, registerApplication,
  request, runDiscovery, testCase
} from '../../golden-tests/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BANK = LAB.banking;
await lab.reset(BANK);

const tenant = await newTenant('Bug0016');
const attempts = [];

for (const attempt of [1, 2]) {
  const project = await createProject(tenant, `BUG-0016 ${attempt}`);
  const application = await registerApplication(tenant, project.id, {
    name: 'AIRA Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
    username: 'alice', password: 'Password123!'
  });
  await runDiscovery(tenant, application.id, { timeoutMs: 300_000 });
  await applicationModel(tenant, application.id);

  await generateTests(tenant, {
    applicationId: application.id, requirement: 'Customer can filter their transactions.',
    suiteName: `Filters ${attempt}`
  });

  const list = await request(`/api/v1/testcases?projectId=${project.id}`, { token: tenant.token });
  const findings = [];
  for (const summary of list.json ?? []) {
    const detail = await testCase(tenant, summary.id);
    const steps = detail.steps ?? [];

    // A closing assertion that targets an element an earlier step in the same test already
    // acted on is an assertion about something that has not changed.
    const asserting = steps.filter(entry => String(entry.action).startsWith('assert'));
    for (const assertion of asserting) {
      const target = JSON.stringify(assertion.target ?? null);
      const actedOnEarlier = steps.some(entry =>
        entry.order < assertion.order
        && !String(entry.action).startsWith('assert')
        && JSON.stringify(entry.target ?? null) === target
        && target !== 'null');
      if (actedOnEarlier) {
        findings.push({
          testCase: detail.name, step: assertion.order,
          description: assertion.description, target: assertion.target
        });
      }
    }
  }
  attempts.push({ attempt, cases: (list.json ?? []).length, vacuous: findings });
  console.log(`attempt ${attempt}: ${findings.length} assertion(s) target an element the same test had already acted on`);
  for (const finding of findings) {
    console.log(`   ${finding.testCase} step ${finding.step}: ${finding.description}`);
  }
}

const total = attempts.reduce((sum, entry) => sum + entry.vacuous.length, 0);
await writeFile(resolve(here, 'evidence/reproduction.json'), `${JSON.stringify({
  bug: 'BUG-0016',
  summary: 'A generated scenario closes by asserting that the control it just clicked is '
    + 'still visible, which holds whatever the application does. The generated test cannot fail.',
  vacuousAssertions: total, attempts
}, null, 2)}\n`);
console.log(`\n${total} assertion(s) that cannot fail, across ${attempts.length} generations`);
process.exit(total === 0 ? 0 : 1);
