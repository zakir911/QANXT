/**
 * Meridian Freight — an enterprise logistics platform, synthetic.
 *
 * Thirteen domains, well over a hundred screens, six end-to-end journeys that cross them,
 * and thirty-two planted defects written from what actually goes wrong in freight software
 * rather than from what a test tool happens to look for.
 *
 * It exists for one measurement: what a testing platform reaches, and misses, on an
 * application of realistic size and shape. The existing labs in this repository are small
 * and uniformly navigable, which makes them good detector tests and poor predictors. This
 * one carries all three navigation shapes at once — linked, routed and enclosed — because
 * that is what a product looks like after four teams and eight years.
 *
 *   node test-lab/freight-platform/server.js            # port 4400, defects on
 *   PORT=4401 node test-lab/freight-platform/server.js  # somewhere else
 *
 * Defects are on by default. `POST /__faults` with every id false produces the corrected
 * application, which is what a false-positive measurement runs against.
 */
import { createLabApp } from '../shared/http.js';
import { createFaultEngine } from '../shared/faults.js';
import { createSessionStore } from '../shared/sessions.js';
import { ALL_FAULTS, DEFECTS, defectSummary } from './defects.js';
import { createCore, registry } from './core.js';
import { seed } from './data/seed.js';
import { NAV_SHAPE } from './ui/chrome.js';

import registerAuth, { SCREENS as authScreens } from './domains/auth.js';
import registerDashboard, { SCREENS as dashboardScreens } from './domains/dashboard.js';
import registerShipments, { SCREENS as shipmentScreens } from './domains/shipments.js';
import registerOrders, { SCREENS as orderScreens } from './domains/orders.js';
import registerWarehouse, { SCREENS as warehouseScreens } from './domains/warehouse.js';
import registerCarriers, { SCREENS as carrierScreens } from './domains/carriers.js';
import registerCustomers, { SCREENS as customerScreens } from './domains/customers.js';
import registerBilling, { SCREENS as billingScreens } from './domains/billing.js';
import registerCustoms, { SCREENS as customsScreens } from './domains/customs.js';
import registerReports, { SCREENS as reportScreens } from './domains/reports.js';
import registerFleet, { SCREENS as fleetScreens } from './domains/fleet.js';
import registerRoutes, { SCREENS as routeScreens } from './domains/routes.js';
import registerClaims, { SCREENS as claimScreens } from './domains/claims.js';
import registerAdmin, { SCREENS as adminScreens } from './domains/admin.js';

const faults = createFaultEngine(ALL_FAULTS, { parameters: { slowElementMs: 6000, auditLogDelayMs: 3400 } });
const sessions = createSessionStore({ idleTimeoutMs: 30 * 60 * 1000, maxFailedAttempts: 5 });

/**
 * Mutable application state, cloned from the seed so a run can change things without the
 * seed drifting. Structured clone keeps it deterministic: the same start every boot.
 */
const state = structuredClone(seed);

const app = createLabApp({ name: 'Meridian Freight', faults, version: '4.2.0' });

const core = createCore({ app, sessions, faults, state });

// Every JSON API route is wrapped so FAULT_API_500 and friends apply uniformly, and so
// FP_D31 has one place to leak from.
app.use(async (ctx) => {
  if (!ctx.url.pathname.startsWith('/api/')) return false;
  if (faults.on('FAULT_API_500')) { ctx.json(500, { error: 'internal_error' }); return true; }
  if (faults.on('FAULT_API_TIMEOUT')) { await new Promise(() => {}); return true; }
  if (faults.on('FAULT_NETWORK_ERROR')) { ctx.destroy(); return true; }
  return false;
});

const context = { app, core, state, faults, sessions };

registerAuth(context);
registerDashboard(context);
registerShipments(context);
registerOrders(context);
registerWarehouse(context);
registerCarriers(context);
registerCustomers(context);
registerBilling(context);
registerCustoms(context);
registerReports(context);
registerFleet(context);
registerRoutes(context);
registerClaims(context);
registerAdmin(context);

// Every screen is queued by definePage and registered here, literal paths first, so a
// parameterised pattern cannot shadow a sibling that happens to be a word.
core.flush();

/**
 * Each domain resolves its own `:id` patterns to a real identifier from the seed, on its
 * exported SCREENS array. Those samples are merged into the registry here, in one place,
 * so the inventory every measurement reads carries a path that actually resolves.
 *
 * Without this the inventory advertises `/shipments/:id`, and anything walking it asks the
 * application for a shipment literally called ":id" and records a 404 as a missing screen.
 */
const declaredScreens = [
  authScreens, dashboardScreens, shipmentScreens, orderScreens, warehouseScreens,
  carrierScreens, customerScreens, billingScreens, customsScreens, reportScreens,
  fleetScreens, routeScreens, claimScreens, adminScreens
].flat();

for (const screen of registry) {
  const declared = declaredScreens.find(candidate => candidate.path === screen.path);
  if (declared?.sample) screen.sample = declared.sample;
}

const unresolved = registry.filter(screen => screen.sample.includes(':'));
if (unresolved.length) {
  console.warn(`  WARNING: ${unresolved.length} screen(s) have no resolvable sample path:`);
  for (const screen of unresolved) console.warn(`    ${screen.path}`);
}

app.get('/', ctx => ctx.redirect('/dashboard'));

/**
 * The screen inventory, served so the ground truth and the self-test read it from the
 * running application rather than from a list somebody keeps up to date by hand.
 */
app.get('/__screens', ctx => ctx.json(200, {
  application: 'Meridian Freight',
  total: registry.length,
  byShape: registry.reduce((acc, screen) => {
    acc[screen.shape] = (acc[screen.shape] ?? 0) + 1;
    return acc;
  }, {}),
  byDomain: registry.reduce((acc, screen) => {
    acc[screen.domain] = (acc[screen.domain] ?? 0) + 1;
    return acc;
  }, {}),
  navShape: NAV_SHAPE,
  screens: registry
}));

/** The planted defects, so a measurement reads ground truth from the application. */
app.get('/__defects', ctx => ctx.json(200, {
  summary: defectSummary(),
  active: faults.list().filter(entry => entry.enabled).map(entry => entry.id),
  defects: DEFECTS
}));

const port = Number(process.env.PORT ?? 4400);
await app.listen(port);

const shapes = registry.reduce((acc, s) => { acc[s.shape] = (acc[s.shape] ?? 0) + 1; return acc; }, {});
console.log(`  screens: ${registry.length} (${Object.entries(shapes).map(([k, v]) => `${v} ${k}`).join(', ')})`);
console.log(`  defects: ${DEFECTS.length} planted, ${faults.list().filter(f => f.enabled).length} active`);
console.log(`  sign in: ops.lead / Freight!2026`);
