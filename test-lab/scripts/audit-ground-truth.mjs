/**
 * Audits a ground-truth file against the application it claims to describe.
 *
 * Ground truth is the yardstick every discovery measurement is taken with, and a yardstick
 * nobody checked is worse than no yardstick: it would turn a correct discovery result into
 * a false negative, or hide a real gap. So every declared page is visited in a real
 * browser and every declared element is looked for, before any scoring happens.
 *
 * Usage: node test-lab/scripts/audit-ground-truth.mjs [path-to-ground-truth.json ...]
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Give at least one ground-truth.json path.');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let failures = 0;

for (const file of files) {
  const truth = JSON.parse(await readFile(resolve(file), 'utf8'));
  console.log(`\n=== ${truth.application} (${truth.baseUrl}) ===`);

  const context = await browser.newContext();
  const page = await context.newPage();

  // Reset first: an application left in a faulted state by an earlier suite would look
  // like a ground-truth error.
  await fetch(`${truth.baseUrl}/__reset`, { method: 'POST' }).catch(() => undefined);

  // Public pages are audited before signing in. A signed-in browser is redirected away
  // from the sign-in page, which would report every element on it as missing.
  const publicPages = truth.pages.filter(candidate => candidate.requiresAuth === false);
  const privatePages = truth.pages.filter(candidate => candidate.requiresAuth !== false);
  failures += await auditPages(page, truth, publicPages);

  if (truth.authentication?.strategy === 'formLogin') {
    await page.goto(`${truth.baseUrl}${truth.authentication.loginPath}`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel(/username|email/i).first().fill(truth.authentication.username);
    await page.getByLabel(/password/i).first().fill(truth.authentication.password);
    await page.getByRole('button', { name: /log in|sign in|continue/i }).first().click();
    await page.waitForURL(`**${truth.authentication.successPath}`, { timeout: 15000 });
    console.log(`signed in as ${truth.authentication.username}`);
  }

  failures += await auditPages(page, truth, privatePages);

  // Declared endpoints must exist. A 404 means the ground truth describes an API the
  // application does not serve; 401/400 are fine — they prove the route is there.
  for (const endpoint of truth.expectedApiCalls ?? []) {
    if (endpoint.path.includes('{')) continue;      // parameterised; covered by the pages above
    const response = await page.request.fetch(`${truth.baseUrl}${endpoint.path}`, { method: endpoint.method, failOnStatusCode: false })
      .catch(() => null);
    const status = response?.status() ?? 0;
    const present = status !== 404 && status !== 0;
    if (!present) { failures++; console.log(`  FAIL  ${endpoint.method} ${endpoint.path} — ${status}`); }
  }

  await context.close();
}

/** Visits each page and looks for every unconditional element it declares. */
async function auditPages(page, truth, pages) {
  let problems = 0;
  for (const declared of pages) {
    await page.goto(`${truth.baseUrl}${declared.path}`, { waitUntil: 'domcontentloaded' });
    // A single-page application paints after its data arrives, so settle before looking.
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);

    const missing = [];
    for (const testId of declared.elements) {
      const element = truth.elements.find(candidate => candidate.testId === testId);
      if (element?.conditional) continue;      // only exists after an interaction
      if (await page.locator(`[data-testid="${testId}"]`).count() === 0) missing.push(testId);
    }

    if (missing.length) problems++;
    console.log(`  ${missing.length === 0 ? 'PASS' : 'FAIL'}  ${declared.path.padEnd(22)} `
      + `${declared.elements.length} declared element(s) — ${missing.length === 0 ? 'ok' : `MISSING ${missing.join(', ')}`}`);
  }
  return problems;
}

await browser.close();
console.log(failures === 0
  ? '\nGround truth matches the applications.'
  : `\n${failures} discrepanc(ies) between ground truth and the applications.`);
process.exit(failures === 0 ? 0 : 1);
