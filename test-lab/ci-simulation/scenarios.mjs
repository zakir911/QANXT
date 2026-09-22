/**
 * The scenarios the local pipeline is put through, and everything needed to run them.
 *
 * Kept separate from the driver so that the golden suite and the standalone runner execute
 * the same definitions rather than two descriptions of the same thing that drift apart. The
 * suite wraps each scenario in the golden harness; `run.mjs` runs them directly and prints
 * a table. Neither owns the scenario.
 *
 * Every scenario runs the real `pipeline.sh` against the real platform and the real lab
 * bank. Nothing here stubs AIRA, with one labelled exception (`aira-internal-error`), which
 * says in its own description what it does and does not prove.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  API, LAB, createEnvironment, createGateRule, createProject, lab, newTenant,
  registerApplication, request, requireApiTest
} from '../../verification/golden-tests/platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');
export const PIPELINE = join(here, 'pipeline.sh');

const BANK = LAB.banking;
const CREDENTIALS = { username: 'alice', password: 'Password123!' };

/** A port nothing is listening on, for the scenarios that need something to be unreachable. */
const CLOSED_PORT = 59_997;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Everything the scenarios run against: a tenant, a project, two environments and the
 * tests. Built once and shared, because building it per scenario would make the suite
 * mostly setup and would not make any scenario more honest.
 */
export async function prepare() {
  await lab.reset(BANK);

  const tenant = await newTenant('CiSimulation');
  const project = await createProject(tenant, 'CI simulation');
  const application = await registerApplication(tenant, project.id, {
    name: 'Lab Bank', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
  });

  // Two environments, because the difference between them is a scenario. QA is ordinary.
  // Production is the one the platform must refuse until somebody authorizes it in writing.
  const qa = await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
  });
  const production = await createEnvironment(tenant, project.id, {
    name: 'Lab Production', key: 'prod', kind: 'production', baseUrl: BANK, apiBaseUrl: BANK
  });

  const shared = { projectId: project.id, applicationId: application.id };

  // Passes whatever the deployment is doing, short of being down. It is what a smoke stage
  // runs, and what the failing scenarios keep in the run so that a report has both.
  const health = await requireApiTest(tenant, {
    ...shared, suiteName: 'Smoke', name: 'The application answers', tags: 'smoke,critical',
    steps: [{
      description: 'Health check',
      request: { method: 'GET', path: '/health', auth: { mode: 'none' } },
      assertions: [{ type: 'httpStatusEquals', expected: '200' }]
    }]
  });

  // Signs in and reads the accounts. Passes against a healthy deployment; fails when
  // FAULT_API_FIELD_REMOVED is injected, because the field it asserts stops being there.
  // The failure is caused by the deployment, not written into the test.
  const accounts = await requireApiTest(tenant, {
    ...shared, suiteName: 'Regression', name: 'An account carries its sort code', tags: 'accounts',
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
        assertions: [
          { type: 'httpStatusEquals', expected: '200' },
          { type: 'responseJsonPathExists', subject: 'accounts[0].sortCode' }
        ]
      }
    ]
  });

  return { tenant, project, application, qa, production, health, accounts };
}

/**
 * A project of its own for the gate scenarios.
 *
 * Gate rules are per project and a run reads all of them, so a rule that exists to block
 * one scenario would block every other scenario in the same project. Separating them is
 * what keeps each scenario measuring one thing.
 */
export async function prepareGateProject(tenant, { name, rule }) {
  const project = await createProject(tenant, name);
  const application = await registerApplication(tenant, project.id, {
    name: `${name} bank`, baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
  });
  const environment = await createEnvironment(tenant, project.id, {
    name: 'QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
  });
  await createGateRule(tenant, project.id, rule);

  const health = await requireApiTest(tenant, {
    projectId: project.id, applicationId: application.id,
    name: 'The application answers', tags: 'smoke',
    steps: [{
      description: 'Health check',
      request: { method: 'GET', path: '/health', auth: { mode: 'none' } },
      assertions: [{ type: 'httpStatusEquals', expected: '200' }]
    }]
  });

  return { project, environment, health };
}

/** Authorizes production testing, with the written reason the platform insists on. */
export async function authorizeProduction(tenant, environmentId, note) {
  const response = await request(`/api/v1/environments/${environmentId}/authorize-production`, {
    token: tenant.token, method: 'POST', body: { authorized: true, note }
  });
  if (!response.ok) {
    throw new Error(`could not authorize production: ${response.status} ${response.text.slice(0, 300)}`);
  }
  return response.json;
}

// ---------------------------------------------------------------------------
// Running one scenario
// ---------------------------------------------------------------------------

/**
 * Runs `pipeline.sh` once and reports what it did.
 *
 * The stage markers are parsed out of the log rather than reported separately, so what the
 * assertions read is exactly what a person reading the build output would see.
 */
export function runPipeline(environment, { timeoutMs = 420_000 } = {}) {
  const artifacts = mkdtempSync(join(tmpdir(), 'aira-cisim-'));

  const result = spawnSync('bash', [PIPELINE], {
    cwd: ROOT, encoding: 'utf8', timeout: timeoutMs,
    env: {
      ...process.env,
      AIRA_API_URL: API,
      ARTIFACTS: artifacts,
      NO_COLOR: '1',
      // Cleared so a scenario's omission is an omission, not an inherited value from
      // whatever the operator happened to have exported.
      AIRA_TOKEN: '', AIRA_PROJECT_ID: '', AIRA_ENVIRONMENT_ID: '',
      TEST_IDS: '', FAULTS: '', APP_URL: '',
      ...environment
    }
  });

  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  const stages = [...log.matchAll(/^::stage::([a-z]+)::(\S+)$/gm)]
    .map(([, name, outcome]) => ({ name, outcome }));
  const verdict = /^::verdict::(\d+)::(.*)$/m.exec(log);

  const files = existsSync(artifacts) ? readdirSync(artifacts).sort() : [];
  const read = name => (files.includes(name) ? readFileSync(join(artifacts, name), 'utf8') : '');
  let report = null;
  try { report = JSON.parse(read('report.json')); } catch { /* left null */ }

  return {
    code: result.status ?? -1,
    log,
    stages,
    stageNames: stages.map(stage => stage.name),
    stageOutcome: name => stages.find(stage => stage.name === name)?.outcome,
    verdict: verdict ? { code: Number(verdict[1]), reason: verdict[2] } : null,
    artifacts, files, read, report,
    summary: read('summary.md')
  };
}

/**
 * Starts the broken-AIRA responder and waits for it to be listening.
 *
 * In its own process on purpose: `runPipeline` uses `spawnSync`, which blocks this
 * process's event loop for the whole pipeline, so a responder here would accept the
 * connection and never answer. See `broken-platform.mjs`.
 */
export async function brokenPlatform() {
  const child = spawn(process.execPath, [join(here, 'broken-platform.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit']
  });

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the broken-platform responder never reported a URL')), 10_000);
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const line = buffer.split('\n')[0];
      if (buffer.includes('\n') && line.startsWith('http://')) {
        clearTimeout(timer);
        resolve(line.trim());
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`the responder exited with ${code}`)); });
  });

  return {
    url,
    stop: () => new Promise(resolve => {
      child.removeAllListeners('exit');
      child.once('exit', resolve);
      child.kill();
    })
  };
}

export const UNREACHABLE = `http://127.0.0.1:${CLOSED_PORT}`;
export { BANK, CREDENTIALS };
