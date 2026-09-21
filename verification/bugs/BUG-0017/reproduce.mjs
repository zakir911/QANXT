/**
 * BUG-0017 — two assertion types the engine implements cannot be authored.
 *
 * `assertCount` and `assertAttribute` are executed by the browser worker, carried by
 * `BrowserAction`, and validated by `BrowserActionValidator`. But the recorded-journey
 * payload — the only way to author an exact test, since there is no manual authoring
 * endpoint (BUG-0002) — has no field for a count or an attribute name. The values are
 * dropped during deserialization and the validator then refuses the step for lacking the
 * very thing the contract cannot carry.
 *
 * The refusal is at least loud: the import returns a warning per dropped step and a third
 * saying the test now has no assertions. Nothing is silently passed. But the capability is
 * unreachable, and a test that was meant to check a row count arrives with the check gone.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAB, createProject, execute, importJourney, journey, lab, newTenant, registerApplication,
  step, testCase
} from '../../golden-tests/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BANK = LAB.banking;
await lab.reset(BANK);

const tenant = await newTenant('Bug0017');
const project = await createProject(tenant, 'BUG-0017');
const application = await registerApplication(tenant, project.id, {
  name: 'AIRA Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
  username: 'alice', password: 'Password123!'
});

const signIn = () => [
  step.navigate(`${BANK}/login`),
  step.fill('username', 'alice', `${BANK}/login`),
  step.fill('password', '${secret:app_password}', `${BANK}/login`),
  step.click('login-submit', `${BANK}/login`)
];

// Each case is deliberately WRONG about the application, so a working assertion must fail.
// The bank renders three account cards and a text username field.
const CASES = [
  {
    kind: 'assertCount',
    steps: () => [...signIn(), {
      action: 'assertCount', description: 'ten account cards',
      target: { strategy: 'testId', value: 'account-card', exact: false, fallbacks: [] },
      count: 10, url: `${BANK}/dashboard`
    }]
  },
  {
    kind: 'assertAttribute',
    steps: () => [step.navigate(`${BANK}/login`), {
      action: 'assertAttribute', description: 'the username field is numeric',
      target: { strategy: 'testId', value: 'username', exact: false, fallbacks: [] },
      attribute: 'type', expected: 'number', url: `${BANK}/login`
    }]
  }
];

const findings = [];
for (const testCaseSpec of CASES) {
  const steps = testCaseSpec.steps();
  const imported = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id,
    journey: journey({ name: `${testCaseSpec.kind} that must fail`, startUrl: `${BANK}/login`, steps })
  });
  const stored = await testCase(tenant, imported.testCaseId);
  const storedActions = (stored.steps ?? []).map(entry => entry.action);
  const survived = storedActions.includes(testCaseSpec.kind);

  const result = await execute(tenant, {
    projectId: project.id, testCaseId: imported.testCaseId, name: `BUG-0017 ${testCaseSpec.kind}`
  });

  // The assertion is wrong about the application, so a run that passes means the check is
  // not there. That is the defect, stated as an outcome rather than as a reading of code.
  const reachable = survived && result.run?.status !== 'passed';
  findings.push({
    kind: testCaseSpec.kind, sentSteps: steps.length,
    storedActions, survived, runStatus: result.run?.status,
    warnings: imported.warnings ?? [], reachable
  });
  console.log(`${testCaseSpec.kind.padEnd(16)} sent ${steps.length} step(s), stored [${storedActions.join(', ')}], `
    + `run ${result.run?.status} — ${reachable ? 'reachable' : 'UNREACHABLE'}`);
  for (const warning of imported.warnings ?? []) console.log(`    warning: ${warning}`);
}

await lab.reset(BANK);

const unreachable = findings.filter(entry => !entry.reachable);
await writeFile(resolve(here, 'evidence/reproduction.json'), `${JSON.stringify({
  bug: 'BUG-0017',
  summary: 'assertCount and assertAttribute are executed by the engine but cannot be '
    + 'authored: the recorded-journey payload carries neither a count nor an attribute name, '
    + 'so the step is dropped at import and a test written to check a row count arrives '
    + 'without the check.',
  unreachable: unreachable.length, of: findings.length, findings
}, null, 2)}\n`);
console.log(`\n${unreachable.length} of ${findings.length} assertion type(s) unreachable`);
process.exit(unreachable.length === 0 ? 0 : 1);
