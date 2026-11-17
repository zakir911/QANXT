/**
 * The part of the self-test that needs a real browser.
 *
 * `selftest.mjs` drives the application over HTTP, which is fast and covers almost
 * everything — but it cannot tell whether a button *works*. It asserted that every routed
 * domain had a `data-route` button and passed, while clicking that button did nothing at
 * all, because the router script was only loaded on routed pages. A person could not reach
 * Fleet, Routes, Claims or Admin from any linked page, and the first navigation-mode
 * discovery measurement scored 0 of 37 routed screens for that reason rather than any
 * fault of the crawler.
 *
 * So: the claims that rest on client-side behaviour get asserted in a browser, by clicking.
 *
 *   node selftest-browser.mjs            # needs a server on 4400
 *
 * Run from apps/browser-worker so that playwright resolves:
 *   node ../../test-lab/freight-platform/selftest-browser.mjs
 */
import { chromium } from 'playwright';

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || Number(process.env.PORT) || 4400;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];
const check = (condition, name, detail = '') => {
  if (condition) { passed += 1; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name} — ${detail}`); }
};

const health = await fetch(`${BASE}/health`).then(r => r.json()).catch(() => null);
if (!health) {
  console.error(`Nothing is listening on ${BASE}. Start it with: node test-lab/freight-platform/server.js`);
  process.exit(1);
}

console.log(`\nMeridian Freight browser self-test against ${BASE}\n`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

try {
  // ---- sign in, for real ---------------------------------------------------
  await page.goto(`${BASE}/auth/sign-in`);
  await page.fill('[data-testid="username"]', 'admin');
  await page.fill('[data-testid="password"]', 'Freight!2026');
  await page.click('[data-testid="sign-in-submit"]');
  await page.waitForURL('**/dashboard', { timeout: 10_000 });
  check(page.url().endsWith('/dashboard'), 'a person can sign in and lands on the dashboard', page.url());

  // ---- the claim this file exists for -------------------------------------
  console.log('\nClicking a routed domain from a linked page');
  const routedDomains = ['fleet', 'routes', 'claims', 'admin'];
  for (const domain of routedDomains) {
    await page.goto(`${BASE}/dashboard`);
    await page.click(`[data-testid="nav-${domain}"]`);
    await page.waitForFunction(
      expected => window.location.pathname === expected,
      `/${domain}`,
      { timeout: 8000 }
    ).catch(() => undefined);
    const landed = new URL(page.url()).pathname === `/${domain}`;
    const rendered = await page.locator('#view-root h1').first().textContent().catch(() => '');
    check(landed && (rendered ?? '').trim().length > 0,
      `clicking "${domain}" from the dashboard navigates and renders`,
      `url ${new URL(page.url()).pathname}, heading "${(rendered ?? '').trim()}"`);
  }

  // ---- and the routed sub-navigation -------------------------------------
  console.log('\nClicking within a routed domain');
  await page.goto(`${BASE}/fleet`);
  await page.click('[data-testid="subnav-fleet-vehicles"]');
  await page.waitForFunction(() => window.location.pathname === '/fleet/vehicles', null, { timeout: 8000 }).catch(() => undefined);
  const onVehicles = new URL(page.url()).pathname === '/fleet/vehicles';
  const hasTable = await page.locator('[data-testid="vehicles-table"]').count() > 0;
  check(onVehicles && hasTable, 'the routed sub-navigation reaches a routed list screen',
    `url ${new URL(page.url()).pathname}, table present=${hasTable}`);

  // ---- a deep link into a routed screen renders client-side ---------------
  await page.goto(`${BASE}/claims/analysis`);
  await page.waitForSelector('[data-testid="claims-by-type"]', { timeout: 8000 }).catch(() => undefined);
  const deepLinked = await page.locator('[data-testid="claims-by-type"]').count() > 0;
  check(deepLinked, 'a deep link into a routed screen renders', 'claims analysis table present');

  // ---- no anchor leads to a routed domain --------------------------------
  console.log('\nThe navigation shapes, as the DOM actually has them');
  await page.goto(`${BASE}/dashboard`);
  const routedAnchors = await page.evaluate(domains =>
    domains.filter(domain => document.querySelector(`a[href="/${domain}"]`) !== null), routedDomains);
  check(routedAnchors.length === 0, 'no anchor anywhere points at a routed domain',
    routedAnchors.length ? `anchors found for ${routedAnchors.join(', ')}` : 'none of the four');

  const linkedAnchors = await page.evaluate(() =>
    ['shipments', 'orders', 'warehouse', 'carriers', 'customers', 'billing', 'customs', 'reports']
      .filter(domain => document.querySelector(`a[href="/${domain}"]`) !== null));
  check(linkedAnchors.length === 8, 'every linked domain has a real anchor',
    `${linkedAnchors.length} of 8`);

  // ---- enclosed surfaces open and have content ---------------------------
  console.log('\nEnclosed surfaces open on a click');
  await page.click('[data-testid="open-notifications"]');
  const drawerVisible = await page.locator('[data-testid="notification-drawer"]').isVisible();
  const drawerItems = await page.locator('[data-testid="notification-drawer"] li').count();
  check(drawerVisible && drawerItems === 4, 'the notification drawer opens with its content',
    `visible=${drawerVisible}, ${drawerItems} items`);

  await page.goto(`${BASE}/dashboard/today`);
  const firstPanel = await page.locator('[data-testid="today-panel-collections"]').isVisible();
  await page.click('[data-testid="today-tab-transit"]');
  const secondPanel = await page.locator('[data-testid="today-panel-transit"]').isVisible();
  const firstHidden = !(await page.locator('[data-testid="today-panel-collections"]').isVisible());
  check(firstPanel && secondPanel && firstHidden, 'a tab panel swaps on a click with no URL change',
    `url stayed ${new URL(page.url()).pathname}`);

  const shipmentsPage = await context.newPage();
  await shipmentsPage.goto(`${BASE}/shipments`);
  const firstShipment = await shipmentsPage.locator('[data-testid^="shipment-MF"]').first().getAttribute('href');
  await shipmentsPage.goto(`${BASE}${firstShipment}`);
  await shipmentsPage.click('[data-testid="open-exception-modal"]');
  const modalVisible = await shipmentsPage.locator('[data-testid="record-exception-modal"]').isVisible();
  const modalHasForm = await shipmentsPage.locator('[data-testid="exception-form"]').count() > 0;
  check(modalVisible && modalHasForm, 'a modal opens with a real form inside it',
    `visible=${modalVisible}, form present=${modalHasForm}`);
  await shipmentsPage.close();

  // ---- the two responsive defects are observable in a real viewport ------
  console.log('\nThe responsive defects, measured in a viewport');
  await fetch(`${BASE}/__faults/reset`, { method: 'POST' });

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  const carriers = await fetch(`${BASE}/__screens`).then(r => r.json());
  const carrierSample = carriers.screens.find(s => s.path === '/carriers/:id').sample;
  await phone.goto(`${BASE}${carrierSample}/rates`);
  const overflow = await phone.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  check(overflow.scrollWidth > overflow.clientWidth + 20,
    'FP_D25 the rate card makes the page scroll sideways on a phone',
    `scrollWidth ${overflow.scrollWidth} against a ${overflow.clientWidth} viewport`);

  const tablet = await context.newPage();
  await tablet.setViewportSize({ width: 768, height: 1024 });
  await tablet.goto(`${BASE}/routes/planner`);
  await tablet.waitForSelector('[data-testid="planner-grid"]', { timeout: 8000 }).catch(() => undefined);
  const plannerOverflow = await tablet.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  check(plannerOverflow.scrollWidth > plannerOverflow.clientWidth + 20,
    'FP_D26 the route planner overflows a tablet viewport',
    `scrollWidth ${plannerOverflow.scrollWidth} against a ${plannerOverflow.clientWidth} viewport`);

  // And that both are clean once the defects are off.
  const { faults } = await fetch(`${BASE}/__faults`).then(r => r.json());
  await fetch(`${BASE}/__faults`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(faults.map(entry => [entry.id, false])))
  });

  await phone.goto(`${BASE}${carrierSample}/rates`);
  const fixedOverflow = await phone.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  check(fixedOverflow.scrollWidth <= fixedOverflow.clientWidth + 20,
    'with the defects off the rate card does not overflow a phone',
    `scrollWidth ${fixedOverflow.scrollWidth} against a ${fixedOverflow.clientWidth} viewport`);

  await tablet.goto(`${BASE}/routes/planner`);
  await tablet.waitForSelector('[data-testid="planner-grid"]', { timeout: 8000 }).catch(() => undefined);
  const fixedPlanner = await tablet.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  check(fixedPlanner.scrollWidth <= fixedPlanner.clientWidth + 20,
    'with the defects off the planner fits a tablet',
    `scrollWidth ${fixedPlanner.scrollWidth} against a ${fixedPlanner.clientWidth} viewport`);

  await phone.close();
  await tablet.close();
  await fetch(`${BASE}/__faults/reset`, { method: 'POST' });

  // ---- no page throws on load -------------------------------------------
  console.log('\nNo console errors on the main screens');
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(`${new URL(page.url()).pathname}: ${message.text().slice(0, 90)}`);
  });
  page.on('pageerror', error => consoleErrors.push(`${new URL(page.url()).pathname}: ${error.message.slice(0, 90)}`));
  for (const path of ['/dashboard', '/shipments', '/orders', '/warehouse', '/carriers',
                      '/customers', '/billing', '/customs', '/reports',
                      '/fleet', '/routes', '/claims', '/admin']) {
    await page.goto(`${BASE}${path}`);
    await page.waitForTimeout(350);
  }
  check(consoleErrors.length === 0, 'the thirteen domain roots load without a console error',
    consoleErrors.length ? consoleErrors.slice(0, 4).join(' | ') : 'clean');
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  console.log('Failures:');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
