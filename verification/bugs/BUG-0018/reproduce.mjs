/**
 * BUG-0018 — the API reference renders blank.
 *
 * The documentation tells a reader to open http://localhost:5080/swagger as the API
 * reference and as a check that the control plane is answering. The API sets
 * `Content-Security-Policy: default-src 'none'` on every response — correct for an
 * endpoint that only ever returns JSON, and fatal for the one page it serves as HTML.
 *
 * Loads the page in a real browser and reports what the browser refused.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));

// Playwright belongs to the test-lab workspace, and Node resolves a package from the
// importing file's directory upward — which from here finds nothing. Resolved explicitly
// rather than by copying this script somewhere more convenient.
const { chromium } = createRequire(resolve(here, '../../../test-lab/package.json'))('playwright');
const API = process.env.AIRA_API_URL ?? 'http://127.0.0.1:5080';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();

const refusals = [];
page.on('console', message => {
  if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
    refusals.push(message.text().split('\n')[0]);
  }
});

const attempts = [];
for (const attempt of [1, 2]) {
  refusals.length = 0;
  await page.goto(`${API}/swagger/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  const rendered = await page.locator('.swagger-ui').count();
  const csp = await page.evaluate(async url => {
    const response = await fetch(url, { method: 'GET' });
    return response.headers.get('content-security-policy');
  }, `${API}/swagger/index.html`).catch(() => null);

  attempts.push({
    attempt, renderedSwaggerUi: rendered > 0,
    contentSecurityPolicy: csp,
    refusals: [...refusals]
  });
  console.log(`attempt ${attempt}: .swagger-ui present: ${rendered > 0}; `
    + `${refusals.length} resource(s) refused by the policy`);
  for (const refusal of refusals.slice(0, 2)) console.log(`    ${refusal.slice(0, 120)}`);
}
await browser.close();

const broken = attempts.filter(entry => !entry.renderedSwaggerUi);
await writeFile(resolve(here, 'evidence/reproduction.json'), `${JSON.stringify({
  bug: 'BUG-0018',
  summary: "The API's Content-Security-Policy of default-src 'none' blocks the stylesheet, "
    + 'script and images of its own API reference, so the page the documentation points at '
    + 'renders blank.',
  broken: broken.length, of: attempts.length, attempts
}, null, 2)}\n`);
console.log(`\n${broken.length} of ${attempts.length} loads rendered nothing`);
process.exit(broken.length === 0 ? 0 : 1);
