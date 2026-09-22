/**
 * BUG-0020 — are stored network events attributed to the step that produced them?
 *
 * Runs a two-request API test and reads the run's network log back through the API. The
 * question is not whether the exchanges were recorded — they always were — but whether
 * each one knows which step made it.
 */
import {
  LAB, createEnvironment, createProject, execute, lab, networkLog, newTenant,
  registerApplication, requireApiTest
} from '../../golden-tests/platform.mjs';

const BANK = LAB.banking;
const CREDENTIALS = { username: 'alice', password: 'Password123!' };

const tenant = await newTenant('Bug0020');
const project = await createProject(tenant, 'BUG-0020');
const application = await registerApplication(tenant, project.id, {
  name: 'Lab Bank API', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
});
await createEnvironment(tenant, project.id, {
  name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
});

const test = await requireApiTest(tenant, {
  projectId: project.id,
  applicationId: application.id,
  name: 'Two requests, so there are two steps to attribute to',
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

await lab.reset(BANK);
const { run, executions } = await execute(tenant, {
  projectId: project.id, testCaseId: test.testCaseId, name: 'BUG-0020', timeoutMs: 180_000
});

const events = await networkLog(tenant, executions[0]?.id);
const exchanges = events.filter(event => event.resourceType === 'apiTest');
const attributed = exchanges.filter(event => typeof event.actionOrder === 'number');

console.log(`run ${run?.status}; ${exchanges.length} exchange(s) recorded`);
for (const exchange of exchanges) {
  const step = typeof exchange.actionOrder === 'number' ? `step ${exchange.actionOrder}` : 'step UNKNOWN';
  console.log(`  ${step}  ${exchange.method} ${new URL(exchange.url).pathname} → ${exchange.statusCode}`);
}
console.log(`\n${attributed.length} of ${exchanges.length} attributed to a step.`);

process.exitCode = attributed.length === exchanges.length && exchanges.length === 2 ? 0 : 1;
