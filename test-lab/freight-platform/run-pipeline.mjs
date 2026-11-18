/**
 * Runs the whole QA NXT pipeline against Meridian Freight and reports what it found.
 *
 * This is the measurement the lab was built for. Not "did discovery reach the screens",
 * which is a ceiling — this drives the product the way a team would:
 *
 *   1. sign up, create a project with AI switched off
 *   2. register the application with credentials
 *   3. run discovery
 *   4. generate tests from the discovered model
 *   5. execute them in a real browser
 *   6. run a security scan against an authorized scope
 *   7. join every failure and finding back to the 32 planted defects
 *
 * AI is off throughout, deliberately: the claim worth testing is the deterministic rules
 * engine, and a hosted model would make the result unreproducible anyway.
 *
 *   node run-pipeline.mjs [--max-pages 160] [--budget 900]
 *
 * Writes pipeline-result.json. Run from the repository root.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { detect } from './detection.mjs';
import {
  request, newTenant, createProject, registerApplication, runDiscovery,
  applicationModel, generateTests, createSuite, startRun, waitForRun
} from '../../verification/golden-tests/platform.mjs';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const LAB_URL = process.env.LAB_URL ?? 'http://127.0.0.1:4400';
const MAX_PAGES = Number(arg('max-pages', 160));
const DISCOVERY_BUDGET = Number(arg('budget', 900));

const groundTruth = JSON.parse(await readFile(new URL('./ground-truth.json', import.meta.url), 'utf8'));

const log = (message) => console.log(message);
const section = (title) => { log(`\n${'─'.repeat(74)}`); log(title); log('─'.repeat(74)); };

const result = {
  ranAt: new Date().toISOString(),
  labUrl: LAB_URL,
  groundTruth: {
    screens: groundTruth.screens.total,
    byShape: groundTruth.screens.byShape,
    defects: groundTruth.defects.total,
    journeys: groundTruth.journeys.total
  },
  stages: {}
};

// ---------------------------------------------------------------------------

const health = await fetch(`${LAB_URL}/health`).then(r => r.json()).catch(() => null);
if (!health) {
  console.error(`The lab is not running at ${LAB_URL}. Start it with:`);
  console.error('  node test-lab/freight-platform/server.js');
  process.exit(1);
}
const activeFaults = Object.entries(health.faults ?? {}).filter(([, on]) => on).length;
log(`\nMeridian Freight at ${LAB_URL}: ${activeFaults} fault(s) active`);

// ---- 1. tenant and project ------------------------------------------------

section('1. Sign up and create a project, with AI switched off');
const tenant = await newTenant('Freight');
log(`  tenant ${tenant.organizationId ?? tenant.tenantId ?? '(created)'}`);

const project = await createProject(tenant, 'Meridian Freight', {
  aiEnabled: false,
  aiProvider: 'local',
  healingPolicy: 'suggest'
});
log(`  project ${project.id} — aiEnabled=false`);
result.stages.project = { id: project.id, aiEnabled: false };

// ---- 2. register the application -----------------------------------------

section('2. Register the application');
const application = await registerApplication(tenant, project.id, {
  name: 'Meridian Freight',
  baseUrl: `${LAB_URL}/dashboard`,
  loginUrl: `${LAB_URL}/auth/sign-in`,
  username: 'admin',
  password: 'Freight!2026',
  maxPages: MAX_PAGES
});
log(`  application ${application.id}`);

// Navigation mode and a real budget: the earlier discovery measurement showed links-only
// reaches 8% of the routed screens, and that navigation mode needs more than the default
// budget on an application this size.
const patched = await request(`/api/v1/applications/${application.id}`, {
  token: tenant.token, method: 'PATCH',
  body: {
    interactionMode: 'navigation',
    maxPages: MAX_PAGES,
    maxCrawlDepth: 6,
    maxActions: 4000,
    explorationTimeoutSeconds: DISCOVERY_BUDGET,
    respectRobotsTxt: false,
    useSitemap: false,
    excludedPaths: '/auth/sign-out,/__faults'
  }
});
log(`  interactionMode=navigation, maxPages=${MAX_PAGES}, budget=${DISCOVERY_BUDGET}s `
  + `(patch ${patched.status})`);
result.stages.application = {
  id: application.id, interactionMode: 'navigation',
  maxPages: MAX_PAGES, budgetSeconds: DISCOVERY_BUDGET
};

// ---- 3. discovery ---------------------------------------------------------

section('3. Discovery');
const discoveryStarted = Date.now();
// timeoutSeconds is the crawl budget; timeoutMs is only how long this script waits. Passing
// the second alone is how a 900s budget became a 240s crawl: the helper had a hard-coded
// default that overrode the application, and the run stopped at 37 of 137 screens.
const discovery = await runDiscovery(tenant, application.id, {
  maxPages: MAX_PAGES, maxDepth: 6,
  timeoutSeconds: DISCOVERY_BUDGET, timeoutMs: (DISCOVERY_BUDGET + 300) * 1000
});
const discoverySeconds = Math.round((Date.now() - discoveryStarted) / 1000);
log(`  status ${discovery.status} in ${discoverySeconds}s`);
log(`  pages ${discovery.pagesDiscovered ?? discovery.pageCount ?? '?'}`);

const model = await applicationModel(tenant, application.id);
const modelPages = model.pages ?? [];
// applicationModel returns a FLAT elements array and an `endpoints` key, not elements
// hanging off each page. Reading page.elements gave 0 and looked like a product fault.
const modelElements = (model.elements ?? []).length;
const modelEndpoints = (model.endpoints ?? []).length;
log(`  model: ${modelPages.length} page(s), ${modelElements} element(s), ${modelEndpoints} endpoint(s)`);

const patternMatches = (pattern, path) => {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+');
  return new RegExp(`^${source}$`).test(path);
};
const discoveredPaths = [...new Set(modelPages.map(page => {
  try { return new URL(page.url ?? page.normalizedUrl).pathname; } catch { return page.route ?? ''; }
}))].filter(Boolean);

const signedInScreens = groundTruth.screens.list.filter(screen => screen.requiresSignIn);
const reachedScreens = signedInScreens.filter(screen =>
  discoveredPaths.some(path => path === screen.sample || patternMatches(screen.path, path)));
const byShape = {};
for (const shape of ['linked', 'routed']) {
  const total = signedInScreens.filter(s => s.shape === shape).length;
  const reached = reachedScreens.filter(s => s.shape === shape).length;
  byShape[shape] = { total, reached, percent: total ? Math.round((reached / total) * 1000) / 10 : null };
}
log(`  declared screens reached: ${reachedScreens.length}/${signedInScreens.length} `
  + `(linked ${byShape.linked.reached}/${byShape.linked.total}, routed ${byShape.routed.reached}/${byShape.routed.total})`);

result.stages.discovery = {
  status: discovery.status, seconds: discoverySeconds,
  modelPages: modelPages.length, modelElements,
  apiEndpoints: modelEndpoints,
  declaredReached: reachedScreens.length, declaredTotal: signedInScreens.length,
  byShape, discoveredPaths: discoveredPaths.sort()
};

if (modelPages.length === 0) {
  log('\n  Discovery mapped nothing. Everything downstream works from the model, so the');
  log('  pipeline stops here rather than reporting a generation figure of zero as a result.');
  await writeFile(new URL('./pipeline-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  process.exit(1);
}

// ---- 4. generation --------------------------------------------------------

section('4. Test generation from the discovered model');
const suite = await createSuite(tenant, project.id, 'Meridian Freight regression');
const generationStarted = Date.now();

/**
 * One generation call per domain, which is how a team would use it: a requirement in plain
 * English per area of the application rather than one sentence for a whole platform.
 */
const REQUIREMENTS = [
  ['shipments', 'An operator can book, track, amend and cancel a consignment, and record a delivery exception against it.'],
  ['orders', 'An operator can raise a sales order, add lines, send it for approval and approve it, and raise a purchase order.'],
  ['warehouse', 'A warehouse user can adjust stock, transfer it between sites, count a bin, and receive goods against a purchase order.'],
  ['billing', 'Finance can raise an invoice, record a payment, raise a credit note and read the aged debt report.'],
  ['customs', 'A customs user can create a declaration, attach documents and release a held consignment.'],
  ['carriers', 'An operator can add a carrier, read its rate card, quote a rate by weight and complete its onboarding.'],
  ['customers', 'An operator can add a customer, maintain contacts and addresses, and change credit terms.'],
  ['claims', 'An operator can raise a claim against a shipment, attach evidence, investigate it and settle it.'],
  ['fleet', 'A fleet user can add a vehicle and a driver, record a daily inspection and read the compliance report.'],
  ['routes', 'A planner can plan a route, optimise it, dispatch it and read the live board.'],
  ['admin', 'An administrator can invite a user, change a role, edit settings and read the audit log.']
];

const generations = [];
for (const [domain, requirement] of REQUIREMENTS) {
  try {
    const response = await generateTests(tenant, {
      applicationId: application.id,
      requirement,
      testSuiteId: suite.id,
      maxScenarios: 0
    });
    if (!response.ok) {
      log(`  ${domain.padEnd(11)} REFUSED ${response.status} — ${response.text.slice(0, 140)}`);
      generations.push({ domain, created: 0, refused: `${response.status} ${response.text.slice(0, 400)}` });
      continue;
    }
    // The helper hands back the whole envelope; the summary is on .json. Reading the
    // envelope directly reported 0 cases for every domain and looked like a dead planner.
    const summary = response.json ?? {};
    const created = summary.casesCreated ?? 0;
    const steps = summary.stepsCreated ?? 0;
    log(`  ${domain.padEnd(11)} ${String(created).padStart(3)} case(s), ${String(steps).padStart(4)} step(s)`
      + (summary.isLocalProvider === false ? '  [HOSTED MODEL]' : '')
      + (summary.warnings?.length ? `  — ${summary.warnings[0].slice(0, 64)}` : ''));
    generations.push({
      domain, created, steps,
      provider: summary.provider ?? null, isLocalProvider: summary.isLocalProvider ?? null,
      planSummary: (summary.planSummary ?? '').slice(0, 200),
      warnings: summary.warnings ?? []
    });
  } catch (error) {
    log(`  ${domain.padEnd(11)} FAILED — ${String(error.message).slice(0, 110)}`);
    generations.push({ domain, created: 0, dropped: 0, error: String(error.message).slice(0, 300) });
  }
}

const generationSeconds = Math.round((Date.now() - generationStarted) / 1000);
const totalCases = generations.reduce((sum, entry) => sum + entry.created, 0);
log(`\n  ${totalCases} test case(s) generated in ${generationSeconds}s, AI disabled`);
result.stages.generation = {
  seconds: generationSeconds, totalCases, suiteId: suite.id, perDomain: generations
};

// What the cases actually contain, since a case that asserts nothing cannot find anything.
const listed = await request(`/api/v1/testcases?projectId=${project.id}&pageSize=500`, { token: tenant.token });
const cases = listed.json?.items ?? listed.json ?? [];
log(`  listed ${cases.length} case(s) from the API`);
const providers = [...new Set(generations.map(g => g.provider).filter(Boolean))];
if (providers.length) log(`  provider(s): ${providers.join(', ')}`);

/**
 * How much of what the eleven requirements produced is actually distinct.
 *
 * On the run before requirement scoping landed this was the headline finding: 2189 cases
 * carrying 192 distinct names, 11.4 copies of each. Every generation call returned the same
 * count, the same step total and the same dropped scenario, because generation planned from
 * the discovered model alone and the requirement text changed nothing.
 *
 * It is still measured rather than asserted, because a measurement that reports its own
 * conclusion cannot tell you when the conclusion stops being true. Whatever the ratio turns
 * out to be, the distinct set is what gets executed: duplicates cost roughly 21.8
 * executions a minute for coverage already counted.
 */
const byName = new Map();
for (const entry of cases) if (!byName.has(entry.name)) byName.set(entry.name, entry);
const distinctCases = [...byName.values()];
const duplication = {
  generated: cases.length,
  distinct: distinctCases.length,
  copiesEach: cases.length && distinctCases.length
    ? Math.round((cases.length / distinctCases.length) * 10) / 10 : null,
  requirementsIssued: REQUIREMENTS.length,
  identicalCountsPerRequirement: new Set(generations.map(g => g.created)).size === 1
};
log(`  ${duplication.distinct} DISTINCT case(s) — ${duplication.copiesEach} copies each `
  + `across ${REQUIREMENTS.length} requirement(s)`);
log(duplication.identicalCountsPerRequirement
  ? `  every requirement produced the same number of cases, so the requirement text did `
    + `not change what was generated`
  : `  case counts differ per requirement (${generations.map(g => g.created).join(', ')}), `
    + `so the requirement text did change what was generated`);

result.stages.generation.listed = cases.length;
result.stages.generation.providers = providers;
result.stages.generation.duplication = duplication;
// Kept so the question "which screens did this suite actually test?" can be answered from
// the result file. Without it only the failures carry names, and a suite is judged on what
// it covered, not only on what it reported.
result.stages.generation.distinctCaseNames = distinctCases.map(entry => entry.name).sort();
result.stages.generation.perRequirement = generations.map(entry => ({
  domain: entry.domain ?? null, created: entry.created ?? null, summary: entry.summary ?? null
}));

if (totalCases === 0) {
  log('\n  Nothing was generated, so there is nothing to execute. Stopping here and');
  log('  reporting that rather than an execution figure of zero.');
  await writeFile(new URL('./pipeline-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  process.exit(1);
}

// ---- 5. execution ---------------------------------------------------------

section('5. Execution in a real browser');
const executionStarted = Date.now();
const caseIds = distinctCases.map(entry => entry.id).filter(Boolean);
const run = await startRun(tenant, {
  projectId: project.id,
  testCaseIds: caseIds,
  name: 'Meridian Freight full regression',
  browser: 'chromium',
  headless: true,
  maxRetries: 0
});
log(`  run ${run.id} with ${caseIds.length} distinct case(s) of ${cases.length} generated`);

// A fixed forty minutes was too short the moment discovery started reaching the whole
// application: 733 cases at the 9.4 executions a minute this run sustained needs 78. The
// driver then reports a timeout while the run carries on in the control plane, and the
// detection analysis is computed on a partial run. So the wait is derived from the work,
// with 5/min as a deliberately pessimistic floor and a half-hour of margin on top.
const executionWaitMs = Math.max(40 * 60 * 1000, (caseIds.length / 5 + 30) * 60 * 1000);
log(`  waiting up to ${Math.round(executionWaitMs / 60000)} min for ${caseIds.length} case(s)`);
const finished = await waitForRun(tenant, run.id, executionWaitMs);
const executionSeconds = Math.round((Date.now() - executionStarted) / 1000);
log(`  status ${finished.status} in ${executionSeconds}s`);
log(`  passed ${finished.passedCount ?? '?'}  failed ${finished.failedCount ?? '?'}  `
  + `blocked ${finished.blockedCount ?? 0}  skipped ${finished.skippedCount ?? 0}`);

const executions = await request(`/api/v1/testruns/${run.id}/executions?pageSize=1000`, { token: tenant.token });
const executionRows = executions.json?.items ?? executions.json ?? [];
const failures = executionRows.filter(row => String(row.status).toLowerCase() === 'failed');
log(`  ${executionRows.length} execution record(s), ${failures.length} failure(s)`);

result.stages.execution = {
  runId: run.id, status: finished.status, seconds: executionSeconds,
  total: executionRows.length,
  passed: finished.passedCount ?? null, failed: finished.failedCount ?? null,
  blocked: finished.blockedCount ?? null, skipped: finished.skippedCount ?? null,
  failures: failures.map(row => ({
    testCaseId: row.testCaseId,
    name: row.testCaseName ?? row.name ?? null,
    message: (row.failureMessage ?? row.errorMessage ?? '').slice(0, 400),
    category: row.failureCategory ?? null
  }))
};

// ---- 6. security scan -----------------------------------------------------

section('6. Security scan');
let security = { attempted: false };
try {
  // PUT /applications/{id}/scope, not POST /scopes — the scope belongs to the application
  // rather than being a collection of its own.
  const scope = await request(`/api/v1/security/applications/${application.id}/scope`, {
    token: tenant.token, method: 'PUT',
    body: {
      enabled: true,
      authorizationNote: 'Synthetic lab application owned by this project and running on '
        + 'loopback, authorized for security testing as part of a platform measurement. '
        + 'Nothing here is a real system and no real data is involved.',
      allowedDomains: '127.0.0.1',
      allowedApiDomains: '127.0.0.1',
      allowedPaths: '',
      blockedPaths: '/auth/sign-out,/__faults',
      environmentId: null,
      maxRequestsPerSecond: 20,
      maxConcurrentRequests: 4,
      maxScanDurationMinutes: 15,
      allowActiveTesting: true,
      allowDestructiveTesting: false,
      allowProduction: false
    }
  });
  log(`  scope ${scope.status} ${scope.ok ? '' : scope.text.slice(0, 160)}`);

  if (scope.ok) {
    // scans/start queues a real scan; POST /scans only records one that already ran.
    const scan = await request('/api/v1/security/scans/start', {
      token: tenant.token, method: 'POST',
      body: { applicationId: application.id, profile: 'Standard' }
    });
    log(`  scan ${scan.status} ${scan.ok ? scan.json.id : scan.text.slice(0, 160)}`);

    if (scan.ok) {
      const deadline = Date.now() + 20 * 60 * 1000;
      let last = scan.json;
      const terminal = new Set(['completed', 'failed', 'cancelled', 'partiallycompleted', 'abandoned']);
      while (Date.now() < deadline) {
        const current = await request(`/api/v1/security/scans/${scan.json.id ?? scan.json.scanId}`, { token: tenant.token });
        last = current.json?.summary ?? current.json ?? last;
        if (terminal.has(String(last.status).toLowerCase())) break;
        await new Promise(resolve => setTimeout(resolve, 4000));
      }
      const findings = await request(`/api/v1/security/scans/${scan.json.id ?? scan.json.scanId}/findings?pageSize=500`, { token: tenant.token });
      const findingRows = findings.json?.items ?? findings.json ?? [];
      log(`  status ${last.status}, ${findingRows.length} finding(s)`);
      const bySeverity = {};
      for (const finding of findingRows) {
        const key = String(finding.severity ?? 'unknown').toLowerCase();
        bySeverity[key] = (bySeverity[key] ?? 0) + 1;
      }
      if (findingRows.length) log(`  by severity: ${JSON.stringify(bySeverity)}`);
      security = {
        attempted: true, scanId: scan.json.id ?? scan.json.scanId, status: last.status,
        findings: findingRows.length, bySeverity,
        list: findingRows.map(finding => ({
          title: finding.title ?? finding.name ?? null,
          severity: finding.severity ?? null,
          cwe: finding.cweId ?? finding.cwe ?? null,
          owasp: finding.owaspCategory ?? null,
          url: finding.affectedUrl ?? finding.url ?? null,
          evidence: (finding.evidenceSummary ?? finding.description ?? '').slice(0, 220)
        }))
      };
    } else {
      security = { attempted: true, refused: `${scan.status} ${scan.text.slice(0, 300)}` };
    }
  } else {
    security = { attempted: true, scopeRefused: `${scope.status} ${scope.text.slice(0, 300)}` };
  }
} catch (error) {
  log(`  security scan failed: ${String(error.message).slice(0, 200)}`);
  security = { attempted: true, error: String(error.message).slice(0, 400) };
}
result.stages.security = security;

// ---- 7. join back to the planted defects ---------------------------------

section('7. What it found, against the 32 planted defects');

const ranAnything = (result.stages.execution?.passed ?? 0) + (result.stages.execution?.failed ?? 0) > 0;
if (!ranAnything) {
  log('  NOT REPORTED. Every execution came back blocked, which means no test ran against');
  log('  the application at all. A detection figure from that would read as "the platform');
  log('  found nothing" when the truth is "the platform executed nothing", and those are');
  log('  different facts. Fix the execution stage and run this again.');
  log(`\n  blocked: ${result.stages.execution?.blocked ?? '?'} of ${result.stages.execution?.total ?? '?'}`);
  const sample = (result.stages.execution?.failures ?? [])[0];
  if (sample) log(`  first message: ${sample.message}`);
  result.stages.detection = { reported: false, reason: 'every execution was blocked; nothing ran' };
  await writeFile(new URL('./pipeline-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  process.exit(1);
}

/**
 * The verdict comes from detection.mjs, which is the only copy of this logic.
 *
 * This stage used to carry its own matcher: a second keyword table, a second screen match,
 * and no classification of what a failure actually was. It drifted from the shared one, as a
 * duplicate always does, and the copy that reported was the worse of the two. On a measured
 * run it claimed FP_D32_PII_IN_QUERY_STRING found, with its evidence field null — a detection
 * with nothing behind it, in a project whose first rule is that a pass means there is
 * evidence. The shared matcher, given the same run, found none.
 *
 * It also lacked the two guards that exist because they were needed: a failure is classified
 * as a tool error or an application failure before it can evidence anything, and keywords are
 * matched as whole tokens — the substring "500" inside "Timeout 15000ms exceeded" once turned
 * a Playwright timeout into a detected crash.
 */
const analysis = detect({
  defects: groundTruth.defects.list,
  failures: result.stages.execution?.failures ?? [],
  findings: security.list ?? [],
  reachedPaths: result.stages.discovery?.discoveredPaths ?? discoveredPaths ?? []
});

const counts = analysis.counts;
const fa = analysis.failureAnalysis;

log(`\n  ${fa.total} failure(s) reported by the run:`);
log(`    ${String(fa.applicationFailures).padStart(3)}  the application behaving wrongly`);
log(`    ${String(fa.toolErrors).padStart(3)}  the test tool unable to drive the page`);
log(`    ${String(fa.unreliableTests ?? 0).padStart(3)}  a test that could not tell a pass from a failure`);

log(`\n  found       ${String(counts.found).padStart(2)}  — a failure or finding named the screen and the symptom`);
log(`  possible    ${String(counts.possible).padStart(2)}  — two independent symptom keywords, screen not named`);
log(`  missed      ${String(counts.missed).padStart(2)}  — the screen was discovered and nothing reported it`);
log(`  unreachable ${String(counts.unreachable).padStart(2)}  — discovery never reached the screen`);

for (const verdict of analysis.verdicts.filter(v => v.verdict === 'found' || v.verdict === 'possible')) {
  log(`    ${verdict.verdict.toUpperCase()}  ${verdict.id}`);
  log(`      evidence: ${verdict.evidence ?? '(none — which is why this is not a claim)'}`);
}

const byCategory = {};
for (const verdict of analysis.verdicts) {
  byCategory[verdict.category] ??= { total: 0, found: 0, reachable: 0 };
  byCategory[verdict.category].total += 1;
  if (verdict.verdict === 'found') byCategory[verdict.category].found += 1;
  if (verdict.screenReached) byCategory[verdict.category].reachable += 1;
}
log('\n  by category (found / on a reached screen / planted):');
for (const [category, figures] of Object.entries(byCategory).sort()) {
  log(`    ${category.padEnd(16)} ${figures.found} / ${figures.reachable} / ${figures.total}`);
}

result.stages.detection = { ...analysis, failureAnalysis: fa };

await writeFile(new URL('./pipeline-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
log(`\nWritten to test-lab/freight-platform/pipeline-result.json\n`);
