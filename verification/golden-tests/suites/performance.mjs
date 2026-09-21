/**
 * Performance: what the platform actually costs, on this machine, measured.
 *
 * Nothing here is a target and nothing is a promise. Each figure is a wall-clock
 * measurement taken n times on the hardware recorded in `verification/environment.md`,
 * reported as median and spread, and written to evidence so the next run can be compared
 * with it. A baseline whose numbers were chosen rather than measured would be worse than
 * no baseline, because it would look like evidence.
 *
 * These tests are `low` severity on purpose: a slow run is information, not a broken
 * product, and a performance figure must never be able to fail a release gate on a machine
 * whose speed nobody promised. They fail only when a measurement could not be taken at all.
 */
import { golden, suite } from '../harness.mjs';
import {
  LAB, applicationModel, createProject, execute, generateTests, importJourney, journey,
  lab, newTenant, registerApplication, runDiscovery, step
} from '../platform.mjs';

const BANK = LAB.banking;

/** Median, minimum, maximum and p95 of a set of measurements. */
function spread(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = share => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
  return {
    runs: sorted.length,
    min: sorted[0],
    median: sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2),
    p95: at(0.95),
    max: sorted.at(-1)
  };
}

const ms = (value) => (value === null ? '—' : `${value}ms`);
const describe = (label, stats) => stats === null
  ? `${label}: not measured`
  : `${label}: median ${ms(stats.median)} (min ${ms(stats.min)}, p95 ${ms(stats.p95)}, max ${ms(stats.max)}, n=${stats.runs})`;

export default async function run() {
  suite('Performance baseline');
  await lab.reset(BANK);

  const tenant = await newTenant('Performance');
  const project = await createProject(tenant, 'Golden performance');
  const application = await registerApplication(tenant, project.id, {
    name: 'AIRA Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
    username: 'alice', password: 'Password123!'
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  // ---- PERF-001: discovery ------------------------------------------------
  await golden({
    id: 'PERF-001',
    objective: 'How long discovery of a nine-page single-page application takes',
    preconditions: ['the lab bank is running with no faults'],
    input: 'Three crawls of the same application, each from an empty model',
    expected: 'Three completed crawls, with their durations recorded',
    evidence: ['discovery-timings.json'],
    severity: 'low',
    run: async () => {
      const timings = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        // A fresh application each time: a crawl that starts from an existing model is a
        // different measurement, and mixing the two would make the median meaningless.
        const target = await registerApplication(tenant, project.id, {
          name: `Perf crawl ${attempt + 1}`, baseUrl: BANK, loginUrl: `${BANK}/login`,
          username: 'alice', password: 'Password123!'
        });
        const started = Date.now();
        const discovery = await runDiscovery(tenant, target.id, { timeoutMs: 300_000 });
        const elapsed = Date.now() - started;
        const model = await applicationModel(tenant, target.id);
        timings.push({
          attempt: attempt + 1, status: discovery.status, wallClockMs: elapsed,
          pages: model.pages.length, elements: model.elements.length
        });
      }

      const completed = timings.filter(entry => entry.status === 'completed');
      const stats = spread(completed.map(entry => entry.wallClockMs));
      const perPage = stats && completed[0].pages
        ? Math.round(stats.median / completed[0].pages) : null;

      return {
        pass: completed.length === timings.length && stats !== null,
        detail: `${describe('crawl', stats)}; ${completed[0]?.pages ?? 0} pages, `
          + `${completed[0]?.elements ?? 0} elements; about ${ms(perPage)} per page`,
        metrics: { discoveryMs: stats?.median ?? null, discoveryP95Ms: stats?.p95 ?? null, perPageMs: perPage },
        evidence: { 'discovery-timings.json': { timings, stats } }
      };
    }
  }, context);

  // ---- PERF-002: a journey, end to end ------------------------------------
  const twentyStep = journey({
    name: 'Performance baseline journey',
    startUrl: `${BANK}/login`,
    steps: [
      step.navigate(`${BANK}/login`),
      step.fill('username', 'alice', `${BANK}/login`),
      step.fill('password', '${secret:app_password}', `${BANK}/login`),
      step.click('login-submit', `${BANK}/login`),
      step.assertVisible('total-balance', `${BANK}/dashboard`),
      step.click('nav-accounts', `${BANK}/dashboard`),
      step.assertVisible('accounts-table', `${BANK}/accounts`),
      step.click('nav-transactions', `${BANK}/accounts`),
      step.assertVisible('transaction-filters', `${BANK}/transactions`),
      step.click('nav-statements', `${BANK}/transactions`),
      step.assertText('page-title', 'Statements', `${BANK}/statements`),
      step.click('nav-dashboard', `${BANK}/statements`)
    ]
  });

  const imported = await importJourney(tenant, {
    projectId: project.id, applicationId: application.id, journey: twentyStep
  });

  await golden({
    id: 'PERF-002',
    objective: 'How long a twelve-step journey takes from queued to verdict',
    preconditions: ['the journey above is imported', 'the bank is healthy'],
    input: 'Ten executions of the same unedited test',
    expected: 'Ten passing runs, with their durations recorded',
    evidence: ['execution-timings.json'],
    severity: 'low',
    run: async () => {
      const runs = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const queued = Date.now();
        const result = await execute(tenant, {
          projectId: project.id, testCaseId: imported.testCaseId, name: `Perf run ${attempt + 1}`
        });
        runs.push({
          attempt: attempt + 1,
          status: result.run?.status,
          // Wall clock covers the queue, the worker claiming the job and the browser; the
          // engine's own figure covers only the steps. The gap between them is the
          // platform's overhead, which is the number worth watching.
          wallClockMs: Date.now() - queued,
          engineMs: result.detail?.durationMs ?? null,
          steps: result.detail?.stepsTotal ?? 0
        });
      }

      const passed = runs.filter(entry => entry.status === 'passed');
      const wall = spread(runs.map(entry => entry.wallClockMs));
      const engine = spread(runs.map(entry => entry.engineMs).filter(value => value !== null));
      const overhead = wall && engine ? wall.median - engine.median : null;
      const perStep = engine && runs[0].steps ? Math.round(engine.median / runs[0].steps) : null;

      return {
        pass: passed.length === runs.length && wall !== null,
        detail: `${describe('queued to verdict', wall)}; ${describe('in the browser', engine)}; `
          + `platform overhead about ${ms(overhead)}; about ${ms(perStep)} per step`,
        metrics: {
          runWallClockMs: wall?.median ?? null, runWallClockP95Ms: wall?.p95 ?? null,
          runEngineMs: engine?.median ?? null, platformOverheadMs: overhead, perStepMs: perStep
        },
        evidence: { 'execution-timings.json': { runs, wall, engine } }
      };
    }
  }, context);

  // ---- PERF-003: generation -----------------------------------------------
  await golden({
    id: 'PERF-003',
    objective: 'How long generating a suite from one requirement takes',
    preconditions: ['the application has been discovered'],
    input: 'Three generations from the same requirement, each into its own suite',
    expected: 'Three generations that produce cases, with their durations recorded',
    evidence: ['generation-timings.json'],
    severity: 'low',
    run: async () => {
      // This application has not been crawled yet — PERF-001 used throwaway ones — and
      // generating against an empty model is refused in milliseconds. An earlier version
      // of this test measured that refusal and reported it as a generation time.
      await runDiscovery(tenant, application.id, { timeoutMs: 300_000 });

      const timings = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = Date.now();
        const generated = await generateTests(tenant, {
          applicationId: application.id,
          requirement: 'Customer can login and view account balance.',
          suiteName: `Perf generation ${attempt + 1}`, maxScenarios: 5
        });
        timings.push({
          attempt: attempt + 1, wallClockMs: Date.now() - started,
          ok: generated.ok === true,
          status: generated.status ?? null,
          cases: generated.json?.casesCreated ?? 0,
          provider: `${generated.json?.provider}/${generated.json?.model}`,
          isLocalProvider: generated.json?.isLocalProvider ?? null
        });
      }
      const stats = spread(timings.map(entry => entry.wallClockMs));
      // The first generation must have produced cases. Later ones may produce none, because
      // the project already holds the same scenarios and the generator de-duplicates — that
      // is a real generation and a real measurement. A refusal is neither.
      const generated = timings.filter(entry => entry.ok);
      return {
        pass: stats !== null && generated.length === timings.length && timings[0].cases > 0,
        detail: `${describe('generation', stats)}; `
          + `${timings.map(entry => entry.cases).join('/')} case(s) per attempt; `
          + `provider ${timings[0]?.provider}`
          + `${timings[0]?.isLocalProvider ? ' — the built-in rules, not a hosted model' : ''}`,
        metrics: { generationMs: stats?.median ?? null, generationP95Ms: stats?.p95 ?? null },
        evidence: { 'generation-timings.json': { timings, stats } }
      };
    }
  }, context);

  await lab.reset(BANK);
  return context;
}
