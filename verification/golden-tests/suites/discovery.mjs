/**
 * Discovery: does the platform find what is actually there?
 *
 * Everything here is scored against each application's ground-truth.json, which was written by
 * hand before any discovery ran. Precision and recall are computed and recorded, not
 * asserted vaguely: a test that says "discovery worked" without a number cannot be
 * disagreed with, which makes it useless as evidence.
 *
 * Route comparison is normalised (`/accounts/acc-1002` → `/accounts/:id`) because an
 * application with three accounts is not three pages, and counting it as such would
 * flatter recall and punish precision for no reason.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, golden, suite } from '../harness.mjs';
import {
  LAB, applicationModel, createProject, lab, newTenant, registerApplication, runDiscovery
} from '../platform.mjs';

const truth = (app) => JSON.parse(readFileSync(resolve(ROOT, `test-lab/${app}/ground-truth.json`), 'utf8'));

/** `/accounts/acc-1002` and `/accounts/acc-1001` are the same page of an application. */
export function normaliseRoute(route) {
  return (route ?? '')
    .replace(/\/(acc|ord|p|ben|sub|txn|item)-[A-Za-z0-9-]+/g, '/:id')
    .replace(/\/\d+/g, '/:id')
    .replace(/\/$/, '') || '/';
}

export function score(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const found = [...expectedSet].filter(item => actualSet.has(item));
  const extra = [...actualSet].filter(item => !expectedSet.has(item));
  const missing = [...expectedSet].filter(item => !actualSet.has(item));
  return {
    expected: expectedSet.size,
    actual: actualSet.size,
    found: found.length,
    missing,
    extra,
    recall: expectedSet.size === 0 ? 1 : Number((found.length / expectedSet.size).toFixed(4)),
    precision: actualSet.size === 0 ? 0 : Number((found.length / actualSet.size).toFixed(4))
  };
}

export default async function run() {
  suite('Discovery');

  const bank = truth('banking-app');
  await lab.resetAll();

  const tenant = await newTenant('Discovery');
  const project = await createProject(tenant, 'Golden discovery');
  const application = await registerApplication(tenant, project.id, {
    name: bank.application, baseUrl: LAB.banking, loginUrl: `${LAB.banking}/login`,
    username: bank.authentication.username, password: bank.authentication.password, maxPages: 25
  });

  const started = Date.now();
  const discovery = await runDiscovery(tenant, application.id, { timeoutMs: 300_000 });
  const discoveryMs = Date.now() - started;
  const model = await applicationModel(tenant, application.id);

  const expectedRoutes = bank.pages.map(page => normaliseRoute(page.path));
  const actualRoutes = model.pages.map(page => normaliseRoute(page.route ?? new URL(page.url).pathname));
  const pageScore = score(expectedRoutes, actualRoutes);

  const context = { tenant, project, application, discovery, model, applicationVersion: bank.version };
  const elementTestIds = new Set(model.elements.filter(element => element.testId).map(element => element.testId));

  // ---- DISC-001 -----------------------------------------------------------
  await golden({
    id: 'DISC-001',
    objective: 'Discovery completes against a real single-page application',
    preconditions: ['the lab banking application is running', 'no faults are enabled'],
    input: `POST /api/v1/discovery/runs for ${LAB.banking}`,
    expected: 'The run reaches completed or partiallyCompleted and reports pages',
    evidence: ['discovery-run.json'],
    severity: 'critical',
    run: async () => ({
      pass: ['completed', 'partiallycompleted'].includes(String(discovery.status).toLowerCase())
        && model.pages.length > 0,
      detail: `status ${discovery.status}, ${model.pages.length} page(s) in ${Math.round(discoveryMs / 1000)}s`,
      metrics: { discoveryMs, pages: model.pages.length, elements: model.elements.length },
      evidence: { 'discovery-run.json': { status: discovery.status, durationMs: discoveryMs, summary: discovery } }
    })
  }, context);

  // ---- DISC-002 recall ----------------------------------------------------
  await golden({
    id: 'DISC-002',
    objective: 'Every page the application has is discovered',
    preconditions: ['discovery has completed'],
    input: 'The discovered page list against the hand-written ground truth',
    expected: 'Recall is 1.0 — no declared page is missing',
    evidence: ['page-score.json'],
    severity: 'critical',
    run: async () => ({
      pass: pageScore.recall === 1,
      detail: `recall ${(pageScore.recall * 100).toFixed(1)}% (${pageScore.found}/${pageScore.expected})`
        + (pageScore.missing.length ? `; missing ${pageScore.missing.join(', ')}` : ''),
      metrics: { recall: pageScore.recall, expected: pageScore.expected, found: pageScore.found },
      evidence: { 'page-score.json': { expectedRoutes, actualRoutes, ...pageScore } }
    })
  }, context);

  // ---- DISC-003 precision -------------------------------------------------
  await golden({
    id: 'DISC-003',
    objective: 'Nothing is discovered that the application does not have',
    preconditions: ['discovery has completed'],
    input: 'The discovered page list against the hand-written ground truth',
    expected: 'Precision is 1.0 — every discovered route exists in the application',
    evidence: ['page-precision.json'],
    severity: 'high',
    run: async () => ({
      pass: pageScore.precision === 1,
      detail: `precision ${(pageScore.precision * 100).toFixed(1)}%`
        + (pageScore.extra.length ? `; not in the ground truth: ${pageScore.extra.join(', ')}` : ''),
      metrics: { precision: pageScore.precision, extra: pageScore.extra.length },
      evidence: { 'page-precision.json': { extra: pageScore.extra, actualRoutes } }
    })
  }, context);

  // ---- DISC-004 the login page --------------------------------------------
  await golden({
    id: 'DISC-004',
    objective: 'The sign-in page is discovered and recognised as public',
    preconditions: ['discovery has completed'],
    input: 'The discovered page for /login',
    expected: 'A page at /login exists and is not marked as requiring authentication',
    evidence: ['login-page.json'],
    severity: 'high',
    run: async () => {
      const login = model.pages.find(page => normaliseRoute(page.route) === '/login');
      return {
        pass: Boolean(login) && login.requiresAuthentication === false,
        detail: login ? `found, requiresAuthentication=${login.requiresAuthentication}` : 'no /login page was discovered',
        evidence: { 'login-page.json': login ?? { missing: true, routes: model.pages.map(p => p.route) } }
      };
    }
  }, context);

  // ---- DISC-005 authenticated pages ---------------------------------------
  await golden({
    id: 'DISC-005',
    objective: 'Pages behind the sign-in are marked as requiring authentication',
    preconditions: ['discovery has completed'],
    input: 'Every page the ground truth marks requiresAuth',
    expected: 'Each is marked requiresAuthentication by the platform',
    evidence: ['auth-flags.json'],
    severity: 'medium',
    run: async () => {
      const expectedPrivate = bank.pages.filter(page => page.requiresAuth).map(page => normaliseRoute(page.path));
      const flags = expectedPrivate.map(route => {
        const page = model.pages.find(candidate => normaliseRoute(candidate.route) === route);
        return { route, discovered: Boolean(page), requiresAuthentication: page?.requiresAuthentication ?? null };
      });
      const wrong = flags.filter(flag => flag.discovered && flag.requiresAuthentication !== true);
      return {
        pass: wrong.length === 0 && flags.every(flag => flag.discovered),
        detail: `${flags.filter(f => f.requiresAuthentication).length}/${flags.length} marked private`
          + (wrong.length ? `; wrong: ${wrong.map(f => f.route).join(', ')}` : ''),
        evidence: { 'auth-flags.json': flags }
      };
    }
  }, context);

  // ---- DISC-006 … DISC-009 elements by kind -------------------------------
  const elementChecks = [
    ['DISC-006', 'form fields', 'input', ['username', 'password', 'payment-amount', 'filter-search', 'profile-email']],
    ['DISC-007', 'buttons', 'button', ['login-submit', 'payment-submit', 'apply-filters', 'generate-statement', 'add-beneficiary']],
    ['DISC-008', 'links', 'link', ['nav-accounts', 'nav-transactions', 'nav-payments', 'open-account-acc-1001']],
    ['DISC-009', 'select controls', 'select', ['filter-category', 'payment-payee', 'statement-account']]
  ];

  for (const [id, label, kind, expectedIds] of elementChecks) {
    await golden({
      id,
      objective: `Discovery finds the application's ${label}`,
      preconditions: ['discovery has completed'],
      input: `Ground-truth ${label} on the discovered pages`,
      expected: `Every declared ${label.replace(/s$/, '')} appears in the model`,
      evidence: [`${id}-elements.json`],
      severity: 'high',
      run: async () => {
        const missing = expectedIds.filter(testId => !elementTestIds.has(testId));
        // The platform's own vocabulary for element kinds is reported rather than assumed:
        // counting a guessed kind name would print "0 inputs" next to five found fields.
        const found = model.elements.filter(element => expectedIds.includes(element.testId));
        const kinds = [...new Set(found.map(element => element.kind))];
        const ofKind = model.elements.filter(element => kinds.includes(element.kind));
        return {
          pass: missing.length === 0,
          detail: `${expectedIds.length - missing.length}/${expectedIds.length} found; `
            + `classified as ${kinds.join('/') || kind}; ${ofKind.length} element(s) of that kind`
            + (missing.length ? `; missing ${missing.join(', ')}` : ''),
          metrics: { expected: expectedIds.length, found: expectedIds.length - missing.length, kinds, ofKind: ofKind.length },
          evidence: { [`${id}-elements.json`]: { expectedIds, missing, sample: ofKind.slice(0, 10) } }
        };
      }
    }, context);
  }

  // ---- DISC-010 tables ----------------------------------------------------
  await golden({
    id: 'DISC-010',
    objective: 'Tabular content is discovered on the pages that have it',
    preconditions: ['discovery has completed'],
    input: 'Pages the ground truth says contain a table',
    expected: 'Each is discovered with elements captured',
    evidence: ['tables.json'],
    severity: 'medium',
    run: async () => {
      const withTables = ['/accounts', '/transactions', '/dashboard', '/beneficiaries'];
      const rows = withTables.map(route => {
        const page = model.pages.find(candidate => normaliseRoute(candidate.route) === route);
        return { route, discovered: Boolean(page), elementCount: page?.elementCount ?? 0 };
      });
      const thin = rows.filter(row => !row.discovered || row.elementCount < 5);
      return {
        pass: thin.length === 0,
        detail: rows.map(row => `${row.route}:${row.elementCount}`).join(' '),
        evidence: { 'tables.json': rows }
      };
    }
  }, context);

  // ---- DISC-011 API endpoints ---------------------------------------------
  await golden({
    id: 'DISC-011',
    objective: 'The application\'s own API calls are observed while the UI is driven',
    preconditions: ['discovery has completed'],
    input: 'Ground-truth expectedApiCalls against the discovered endpoint list',
    expected: 'Recall over the endpoints reachable by browsing is at least 0.6, including the sign-in POST',
    evidence: ['api-score.json'],
    severity: 'high',
    run: async () => {
      const observed = model.endpoints.map(endpoint => `${endpoint.method} ${normaliseRoute(new URL(endpoint.urlTemplate).pathname)}`);
      // Only the calls a crawl can trigger: the crawler never submits a payment or asks
      // for a statement, so those endpoints are not expected here.
      const browsable = bank.expectedApiCalls
        .filter(call => call.method === 'GET' || call.path === '/api/session')
        .map(call => `${call.method} ${normaliseRoute(call.path.replace('{id}', ':id'))}`);
      const apiScore = score(browsable, observed);
      const sawSignIn = observed.includes('POST /api/session');
      return {
        pass: apiScore.recall >= 0.6 && sawSignIn,
        detail: `recall ${(apiScore.recall * 100).toFixed(0)}% of ${apiScore.expected} browsable endpoint(s); `
          + `sign-in POST observed: ${sawSignIn}`
          + (apiScore.missing.length ? `; missing ${apiScore.missing.join(', ')}` : ''),
        metrics: { apiRecall: apiScore.recall, observed: observed.length },
        evidence: { 'api-score.json': { browsable, observed, ...apiScore } }
      };
    }
  }, context);

  // ---- DISC-012 navigation -------------------------------------------------
  await golden({
    id: 'DISC-012',
    objective: 'Navigation between pages is recorded as transitions',
    preconditions: ['discovery has completed'],
    input: 'The knowledge graph\'s transition list',
    expected: 'At least six transitions, each between two discovered pages',
    evidence: ['transitions.json'],
    severity: 'medium',
    run: async () => {
      const transitions = model.graph?.transitions ?? [];
      const pageIds = new Set(model.pages.map(page => page.id));
      // The graph answers { from, to, action, timesObserved }. An earlier version of this
      // check read fromPageId/toPageId, found undefined, and called every transition
      // dangling — a failure in the check, not in the product.
      const dangling = transitions.filter(transition =>
        !pageIds.has(transition.from) || (transition.to && !pageIds.has(transition.to)));
      return {
        pass: transitions.length >= 6 && dangling.length === 0,
        detail: `${transitions.length} transition(s), ${dangling.length} dangling`,
        metrics: { transitions: transitions.length },
        evidence: { 'transitions.json': transitions.slice(0, 40) }
      };
    }
  }, context);

  // ---- DISC-013 locator quality -------------------------------------------
  await golden({
    id: 'DISC-013',
    objective: 'Discovered elements carry a stable preferred locator, not a structural path',
    preconditions: ['discovery has completed'],
    input: 'The preferred locator of every discovered element',
    expected: 'At least 80% prefer a test id, role or label over css or xpath',
    evidence: ['locator-strategies.json'],
    severity: 'high',
    run: async () => {
      const strategies = {};
      for (const element of model.elements) {
        let strategy = 'none';
        try { strategy = JSON.parse(element.preferredLocator ?? '{}').strategy ?? 'none'; } catch { /* counted as none */ }
        strategies[strategy] = (strategies[strategy] ?? 0) + 1;
      }
      const total = model.elements.length;
      const stable = ['testId', 'role', 'label', 'placeholder', 'text', 'altText', 'title']
        .reduce((sum, key) => sum + (strategies[key] ?? 0), 0);
      const share = total === 0 ? 0 : stable / total;
      return {
        pass: share >= 0.8,
        detail: `${(share * 100).toFixed(1)}% stable of ${total} element(s): `
          + Object.entries(strategies).map(([key, count]) => `${key}=${count}`).join(' '),
        metrics: { stableLocatorShare: Number(share.toFixed(4)), strategies },
        evidence: { 'locator-strategies.json': { total, strategies, share } }
      };
    }
  }, context);

  // ---- DISC-014 screenshots ------------------------------------------------
  await golden({
    id: 'DISC-014',
    objective: 'Discovery captures a screenshot of each page it maps',
    preconditions: ['discovery has completed'],
    input: 'The hasScreenshot flag on every discovered page',
    expected: 'Every discovered page has a screenshot artifact',
    evidence: ['screenshots.json'],
    severity: 'medium',
    run: async () => {
      const without = model.pages.filter(page => page.hasScreenshot === false);
      return {
        pass: without.length === 0 && model.pages.length > 0,
        detail: `${model.pages.length - without.length}/${model.pages.length} page(s) have a screenshot`,
        evidence: { 'screenshots.json': model.pages.map(page => ({ route: page.route, hasScreenshot: page.hasScreenshot })) }
      };
    }
  }, context);

  // ---- DISC-015 the dynamic application ------------------------------------
  await golden({
    id: 'DISC-015',
    objective: 'Discovery copes with an application whose ids change on every render',
    preconditions: ['the dynamic lab application is running'],
    input: `A crawl of ${LAB.dynamic}, whose element ids and class names are regenerated per render`,
    expected: 'Pages are discovered and their elements prefer stable locators over generated ids',
    evidence: ['dynamic-model.json'],
    severity: 'high',
    run: async () => {
      const dynamicTruth = truth('dynamic-app');
      const dynamicApp = await registerApplication(tenant, project.id, {
        name: dynamicTruth.application, baseUrl: LAB.dynamic, maxPages: 12
      });
      const dynamicRun = await runDiscovery(tenant, dynamicApp.id, { maxPages: 12, timeoutMs: 240_000 });
      const dynamicModel = await applicationModel(tenant, dynamicApp.id);

      const routes = dynamicModel.pages.map(page => normaliseRoute(page.route));
      const expectedDynamic = dynamicTruth.pages.map(page => normaliseRoute(page.path));
      const dynamicScore = score(expectedDynamic, routes);

      // The interesting part: no locator may lean on an id that will not exist next time.
      const generated = dynamicModel.elements.filter(element => {
        try {
          const locator = JSON.parse(element.preferredLocator ?? '{}');
          return (locator.strategy === 'css' && /#e[a-z0-9]{5}/.test(locator.value ?? ''))
            || (locator.strategy === 'xpath');
        } catch { return false; }
      });

      return {
        pass: dynamicModel.pages.length >= 4 && generated.length === 0,
        detail: `${dynamicModel.pages.length} page(s) (recall ${(dynamicScore.recall * 100).toFixed(0)}%), `
          + `${dynamicModel.elements.length} element(s), ${generated.length} locator(s) bound to a generated id`,
        metrics: { dynamicRecall: dynamicScore.recall, generatedIdLocators: generated.length },
        evidence: {
          'dynamic-model.json': {
            status: dynamicRun.status, routes, ...dynamicScore,
            generatedIdLocators: generated.slice(0, 10)
          }
        }
      };
    }
  }, context);

  return context;
}
