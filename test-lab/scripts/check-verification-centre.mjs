/**
 * Drives the console's Verification page in a real browser.
 *
 * The page has unit tests, but a page that has only ever passed its unit tests has not been
 * seen by anyone. This signs in, opens it, and reports what it actually rendered — then
 * leaves a full-page screenshot behind as the evidence.
 *
 * Lives here because this is the workspace that carries Playwright.
 *
 *   node test-lab/scripts/check-verification-centre.mjs
 */
import { chromium } from 'playwright';
import { newTenant } from '../../verification/golden-tests/platform.mjs';

const CONSOLE = process.env.CONSOLE_URL ?? 'http://127.0.0.1:5173';
const SHOT = new URL('../../verification/demo/verification-centre.png', import.meta.url).pathname;

const tenant = await newTenant('ConsoleCheck');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });

const consoleErrors = [];
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });

try {
  await page.goto(`${CONSOLE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/email/i).fill(tenant.email);
  await page.getByLabel(/password/i).fill(tenant.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 20_000 });

  await page.getByRole('link', { name: 'Verification' }).click();
  await page.waitForURL(/\/verification$/, { timeout: 10_000 });
  await page.getByText(/quality gates/i).first().waitFor({ timeout: 20_000 });

  const banner = (await page.locator('[role="status"]').first().innerText()).split('\n')[0];
  const gateRows = await page.locator('table').first().locator('tbody tr').allInnerTexts();
  const testRows = await page.locator('table').last().locator('tbody tr').count();
  const gates = gateRows.map(row => {
    const [name, verdict] = row.split('\t');
    return { name, verdict };
  });

  await page.screenshot({ path: SHOT, fullPage: true });

  console.log(`banner    : ${banner}`);
  console.log(`gates     : ${gates.map(gate => `${gate.name}=${gate.verdict}`).join(' ')}`);
  console.log(`test rows : ${testRows}`);
  console.log(`console   : ${consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'no errors'}`);
  console.log('screenshot: verification/demo/verification-centre.png');

  // The banner must agree with the gates. A green banner over a red gate is the single
  // failure this page exists to prevent, so it is checked here as well as in the unit test.
  const red = gates.filter(gate => gate.verdict !== 'Pass');
  const claimsGreen = /All quality gates passed/i.test(banner);
  const consistent = claimsGreen === (red.length === 0);

  if (!consistent) {
    console.error(`\nThe banner says "${banner}" while ${red.length} gate(s) are not passing.`);
    process.exit(1);
  }
  if (testRows === 0) { console.error('\nThe page rendered no test rows.'); process.exit(1); }
  if (consoleErrors.length) { console.error('\nThe page logged console errors.'); process.exit(1); }
} finally {
  await browser.close();
}
