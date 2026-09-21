/**
 * BUG-0008 — the sign-in page is never part of the application model.
 *
 * Runs discovery twice and reports whether /login, and the fields on it, appear in the
 * model the platform produced.
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
  const tenant = await newTenant(`Bug0008-${attempt}`);
  const project = await createProject(tenant, `BUG-0008 attempt ${attempt}`);
  const application = await registerApplication(tenant, project.id, {
    name: 'AIRA Demo Bank', baseUrl: LAB.banking, loginUrl: `${LAB.banking}/login`,
    username: 'alice', password: 'Password123!'
  });

  const run = await runDiscovery(tenant, application.id, { timeoutMs: 240_000 });
  const model = await applicationModel(tenant, application.id);
  const routes = model.pages.map(page => page.route);
  const testIds = new Set(model.elements.map(element => element.testId).filter(Boolean));

  attempts.push({
    attempt,
    discoveryStatus: run.status,
    pagesDiscovered: routes.length,
    routes,
    loginPageDiscovered: routes.includes('/login'),
    signInElements: {
      username: testIds.has('username'),
      password: testIds.has('password'),
      loginSubmit: testIds.has('login-submit'),
      rememberMe: testIds.has('remember-me'),
      forgotPassword: testIds.has('forgot-password')
    }
  });

  console.log(`attempt ${attempt}: ${routes.length} page(s); /login discovered: `
    + `${routes.includes('/login')}; sign-in fields in the model: `
    + `${['username', 'password', 'login-submit'].filter(id => testIds.has(id)).length}/3`);
}

const reproduced = attempts.filter(record => !record.loginPageDiscovered).length;
await writeFile(resolve(here, 'evidence/reproduction.json'), `${JSON.stringify({
  bug: 'BUG-0008',
  summary: 'Discovery signs in before crawling and never records the sign-in page, so the '
    + 'application model has no login page and no sign-in fields.',
  reproducedIn: reproduced, of: attempts.length, attempts
}, null, 2)}\n`);

console.log(`\nreproduced ${reproduced} of ${attempts.length}`);
process.exit(reproduced === attempts.length ? 0 : 1);
