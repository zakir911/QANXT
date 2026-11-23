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
import { request, newTenant, createProject, registerApplication, runDiscovery }
  from '../../verification/golden-tests/platform.mjs';

const FREIGHT = process.env.FREIGHT_URL ?? 'http://127.0.0.1:4400';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BUDGET = Number(arg('budget', 1200));
const MAX_PAGES = Number(arg('max-pages', 230));
const MAX_ACTIONS = Number(arg('max-actions', 10000));

const reset = await fetch(`${FREIGHT}/__reset`, { method: 'POST' }).catch(() => null);
console.log(`reset ${reset?.status ?? 'unreachable'}`);

const tenant = await newTenant('FreightInteraction');
const project = await createProject(tenant, 'Meridian Freight — interaction authorised',
  { aiEnabled: false, aiProvider: 'local' });
const application = await registerApplication(tenant, project.id, {
  name: 'Meridian Freight', baseUrl: FREIGHT,
  loginUrl: `${FREIGHT}/auth/sign-in`,
  username: 'ops.lead', password: 'Freight!2026', maxPages: MAX_PAGES
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
    interactionMode: 'interactive', allowStateChangingClicks: true
  }
});
// A refused configuration that carries on silently is worse than a failure: the run looks
// configured and is not. This cost a measurement earlier in the project.
if (!patched.ok) throw new Error(`configuration refused ${patched.status}: ${patched.text.slice(0, 300)}`);

console.log(`application ${application.id}: interactive, state-changing clicks authorised, `
  + `${MAX_PAGES} pages, ${BUDGET}s, ${MAX_ACTIONS} actions`);

const started = Date.now();
const discovery = await runDiscovery(tenant, application.id,
  { maxPages: MAX_PAGES, maxDepth: 6, timeoutSeconds: BUDGET, timeoutMs: (BUDGET + 300) * 1000 });
console.log(`discovery ${discovery.status} in ${Math.round((Date.now() - started) / 1000)}s`);

const model = await request(`/api/v1/applications/${application.id}/model`, { token: tenant.token });
const pages = model.json?.pages ?? [];
const endpoints = model.json?.endpoints ?? [];
console.log(`${pages.length} page(s), ${endpoints.length} endpoint(s)`);
console.log(`\napplication id for the reachability check:\n  ${application.id}`);
