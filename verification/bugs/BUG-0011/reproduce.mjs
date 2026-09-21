/**
 * BUG-0011 — the scenario budget is ignored.
 *
 * Asks for at most two scenarios, twice, and counts what was created.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAB, createProject, generateTests, lab, newTenant, registerApplication, runDiscovery
} from '../../golden-tests/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
await lab.reset(LAB.banking);

const tenant = await newTenant('Bug0011');
const project = await createProject(tenant, 'BUG-0011');
const application = await registerApplication(tenant, project.id, {
  name: 'AIRA Demo Bank', baseUrl: LAB.banking, loginUrl: `${LAB.banking}/login`,
  username: 'alice', password: 'Password123!'
});
await runDiscovery(tenant, application.id, { timeoutMs: 300_000 });

const attempts = [];
for (const [attempt, asked] of [[1, 2], [2, 3]]) {
  const response = await generateTests(tenant, {
    applicationId: application.id, requirement: 'Customer can use every page of the bank.',
    suiteName: `Budget ${attempt}`, maxScenarios: asked
  });
  const created = response.json?.casesCreated ?? null;
  attempts.push({ attempt, asked, created, withinBudget: created !== null && created <= asked,
    warnings: response.json?.warnings ?? [] });
  console.log(`attempt ${attempt}: asked for at most ${asked}, created ${created}`
    + (created > asked ? '  ← over budget' : ''));
}

const over = attempts.filter(record => !record.withinBudget);
await writeFile(resolve(here, 'evidence/reproduction.json'), `${JSON.stringify({
  bug: 'BUG-0011',
  summary: 'maxScenarios is passed to the generator as context and never enforced, so the '
    + 'number of test cases created bears no relation to the budget the caller asked for.',
  overBudget: over.length, of: attempts.length, attempts
}, null, 2)}\n`);
console.log(`\n${over.length} of ${attempts.length} generations exceeded the budget`);
process.exit(over.length === 0 ? 0 : 1);
