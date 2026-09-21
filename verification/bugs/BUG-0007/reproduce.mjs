/**
 * BUG-0007 — form sign-in fails against a single-page application.
 *
 * Runs discovery against the lab's React bank twice, and after each attempt asks the bank
 * itself what it was sent. The bank's record is the part that matters: it shows the
 * platform did post the correct credentials, milliseconds before declaring that they were
 * probably wrong.
 *
 * Usage: node verification/bugs/BUG-0007/reproduce.mjs
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAB, applicationModel, createProject, lab, newTenant, registerApplication, runDiscovery
} from '../../golden-tests/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const attempts = [];

for (const attempt of [1, 2]) {
  await lab.reset(LAB.banking);
  const tenant = await newTenant(`Bug0007-${attempt}`);
  const project = await createProject(tenant, `BUG-0007 attempt ${attempt}`);
  const application = await registerApplication(tenant, project.id, {
    name: 'AIRA Demo Bank', baseUrl: LAB.banking, loginUrl: `${LAB.banking}/login`,
    username: 'alice', password: 'Password123!'
  });

  const started = Date.now();
  const run = await runDiscovery(tenant, application.id, { timeoutMs: 120_000 });
  const summary = run.summary ?? run;
  const model = await applicationModel(tenant, application.id);
  const seen = await (await fetch(`${LAB.banking}/__attempts`)).json();

  attempts.push({
    attempt,
    durationMs: Date.now() - started,
    discoveryStatus: summary.status,
    errorMessage: summary.errorMessage ?? summary.error ?? null,
    pagesDiscovered: model.pages.length,
    elementsDiscovered: model.elements.length,
    apiEndpointsDiscovered: model.endpoints.map(endpoint => `${endpoint.method} ${endpoint.urlTemplate}`),
    // What the application under test actually received.
    signInAttemptsSeenByTheBank: seen.attempts,
    completedAt: summary.completedAt
  });

  console.log(`attempt ${attempt}: discovery ${summary.status}, `
    + `${model.pages.length} page(s), bank saw ${seen.attempts.length} sign-in attempt(s) `
    + `(${seen.attempts.map(a => `${a.username}/${a.passwordLength} chars`).join(', ') || 'none'})`);
}

const reproduced = attempts.filter(record =>
  record.discoveryStatus === 'failed'
  && record.pagesDiscovered === 0
  && record.signInAttemptsSeenByTheBank.length === 1
  && record.signInAttemptsSeenByTheBank[0].username === 'alice'
  && record.signInAttemptsSeenByTheBank[0].passwordLength === 12).length;

const report = {
  bug: 'BUG-0007',
  summary: 'Discovery cannot sign in to a single-page application: the platform posts the '
    + 'correct credentials and then reports that they are probably wrong, because it checks '
    + 'the outcome before the asynchronous sign-in has completed.',
  reproducedIn: reproduced,
  of: attempts.length,
  attempts
};

await writeFile(resolve(here, 'evidence/reproduction.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nreproduced ${reproduced} of ${attempts.length}`);
process.exit(reproduced === attempts.length ? 0 : 1);
