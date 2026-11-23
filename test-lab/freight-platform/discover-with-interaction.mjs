#!/usr/bin/env node
/**
 * Freight, mapped with interaction authorised, and nothing else.
 *
 * Four of the thirty-two planted defects sit on a screen the navigation-mode crawl never
 * reached: /claims/:id/settle, /shipments/:id/cancel, /customs/declarations/:id/release and
 * the claims evidence upload. Every one is behind a control the crawl correctly declines to
 * press, and clinic-spa showed what pressing them costs and buys — its CS_D04 went from
 * undetected to found the moment the control was pressed and the endpoint it calls was
 * observed.
 *
 * This maps only. Designing and running freight's suite is 7,774 browser tests, which is
 * seven hours on four cores, and the question here needs none of it: either pressing the
 * controls reaches those four screens or it does not, and discovery answers that on its own.
 *
 * Pressing them changes the application, which is why it is not the default and why this
 * script exists separately rather than as a flag on the measurement run. The freight lab is
 * synthetic, on loopback, and resets.
 */
import { request, newTenant, createProject, registerApplication, runDiscovery, applicationModel }
  from '../../verification/golden-tests/platform.mjs';

const FREIGHT = process.env.FREIGHT_URL ?? 'http://127.0.0.1:4400';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BUDGET = Number(arg('budget', 1200));
const MAX_PAGES = Number(arg('max-pages', 230));
const MAX_ACTIONS = Number(arg('max-actions', 10000));
// Which account the crawl signs in as, because that is what decides which controls exist to
// be clicked. Measured: ops.lead holds role-operations, which has shipment:cancel and not
// claim:settle or customs:release — and the interactive crawl reached /shipments/:id/cancel
// three times over and neither of the other two. The screens a crawl cannot reach are the
// ones its identity's role does not hold, and the one it reached is the one permission that
// role happens to have. Default stays ops.lead so the measurement is comparable.
const USERNAME = String(arg('username', 'ops.lead'));
// Seeds, because the four screens in question hang off three detail pages and a whole-site
// interactive crawl spends its budget long before it walks to them: an unseeded run reached
// 89 pages in 13 minutes and none of them was a claim. Seeding the detail pages asks the
// question directly instead of hoping the crawl arrives.
const SEED_URLS = String(arg('seed-urls', '')).split(',').map(v => v.trim()).filter(Boolean);

const reset = await fetch(`${FREIGHT}/__reset`, { method: 'POST' }).catch(() => null);
console.log(`reset ${reset?.status ?? 'unreachable'}`);

const tenant = await newTenant('FreightInteraction');
const project = await createProject(tenant, 'Meridian Freight — interaction authorised',
  { aiEnabled: false, aiProvider: 'local' });
const application = await registerApplication(tenant, project.id, {
  name: 'Meridian Freight', baseUrl: FREIGHT,
  loginUrl: `${FREIGHT}/auth/sign-in`,
  username: USERNAME, password: 'Freight!2026', maxPages: MAX_PAGES
});

const patched = await request(`/api/v1/applications/${application.id}`, {
  token: tenant.token, method: 'PATCH',
  body: {
    maxPages: MAX_PAGES, maxCrawlDepth: 6, explorationTimeoutSeconds: BUDGET,
    maxActions: MAX_ACTIONS, respectRobotsTxt: false, useSitemap: false,
    // Both, together. The click decision consults the state-changing flag for a form submit
    // before the mode gate and consults the mode afterwards for everything else, so the flag
    // on its own is close to inert for a plain button — which is exactly how clinic-spa's
    // cancel control went unpressed through a run that had authorised pressing it.
    interactionMode: 'interactive', allowStateChangingClicks: true,
    ...(SEED_URLS.length > 0 ? { seedUrls: SEED_URLS.join(',') } : {})
  }
});
// A refused configuration that carries on silently is worse than a failure: the run looks
// configured and is not. This cost a measurement earlier in the project.
if (!patched.ok) throw new Error(`configuration refused ${patched.status}: ${patched.text.slice(0, 300)}`);

console.log(`application ${application.id}: signed in as ${USERNAME}, interactive, `
  + `state-changing clicks authorised, `
  + `${MAX_PAGES} pages, ${BUDGET}s, ${MAX_ACTIONS} actions`
  + (SEED_URLS.length ? `, seeded at ${SEED_URLS.join(' ')}` : ''));

const started = Date.now();
const discovery = await runDiscovery(tenant, application.id,
  { maxPages: MAX_PAGES, maxDepth: 6, timeoutSeconds: BUDGET, timeoutMs: (BUDGET + 300) * 1000 });
console.log(`discovery ${discovery.status} in ${Math.round((Date.now() - started) / 1000)}s`);

// There is no /model route; asking for one returned nothing and this printed "0 page(s)"
// after a crawl that had mapped 137. A reporting line that is wrong in the reassuring
// direction is worse than no line.
const model = await applicationModel(tenant, application.id);
const pages = model.pages ?? [];
const endpoints = model.endpoints ?? [];
console.log(`${pages.length} page(s), ${endpoints.length} endpoint(s)`);
console.log(`\napplication id for the reachability check:\n  ${application.id}`);
