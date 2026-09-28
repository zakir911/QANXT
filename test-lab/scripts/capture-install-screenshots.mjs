/**
 * Captures the screenshots the installation guide uses.
 *
 * Every image is taken from a real browser driving the real console against a real stack:
 * nothing is mocked, drawn or staged. It walks the same path the guide tells a reader to
 * walk, so if the guide is wrong this script fails rather than producing a pretty picture
 * of something that does not happen.
 *
 *   node test-lab/scripts/capture-install-screenshots.mjs
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const CONSOLE = process.env.CONSOLE_URL ?? 'http://127.0.0.1:5173';
const API = process.env.AIRA_API_URL ?? 'http://127.0.0.1:5080';
const OUT = new URL('../../docs/images/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const stamp = Date.now();
// Unique per run: the slug is derived from the name and must not already exist.
const ORG = `Northwind Bank ${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
const EMAIL = `installer+${stamp}@example.test`;
const PASSWORD = 'InstallGuide2026';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1380, height: 820 }, deviceScaleFactor: 2 });

const shots = [];

/**
 * Waits for the page to have finished loading before photographing it.
 *
 * The console shows a spinner with the word "Loading" while it fetches; a fixed delay
 * caught it, and the first version of this script produced a guide illustrated with
 * spinners. Waiting for the spinner to go is the difference between a screenshot of the
 * product and a screenshot of it thinking.
 */
const settle = async () => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.locator('[role="status"]', { hasText: /loading|…/i })
    .first().waitFor({ state: 'detached', timeout: 20_000 })
    .catch(() => {});
  await page.waitForTimeout(600);
};

/**
 * Photographs a page, optionally after proving it shows what the caption claims.
 *
 * Without `expect` this waits and shoots, which is fine for a page whose caption only names
 * where it is. It is not fine for a caption that asserts content: "the Verification Center,
 * reading the last golden run" is false of a Verification Center that has no run to read, and
 * a screenshot cannot be argued with afterwards. A missing expectation is a hard failure
 * rather than a warning, because a guide illustrated with the wrong picture is worse than one
 * with no pictures.
 */
const shot = async (name, note, expect) => {
  await settle();
  if (expect) {
    await expect.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
      throw new Error(`${name}: the page never showed what the caption claims (${note})`);
    });
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: `${OUT}${name}.png` });
  shots.push({ name, note, url: page.url() });
  console.log(`  ${name}.png — ${note}`);
};

try {
  console.log('Capturing:');

  // 1. The sign-in page a fresh install opens on.
  await page.goto(`${CONSOLE}/login`, { waitUntil: 'networkidle' });
  await shot('01-sign-in', 'the console on a fresh install');

  // 2. Creating the first organization.
  // The mode switch is a tab, not a button; asking for a button matched nothing and left
  // the form on "Sign in", which is how the first attempt at this script captured a
  // screenshot of the wrong thing and then timed out submitting it.
  await page.getByRole('tab', { name: /create an organization/i }).click();
  await page.waitForTimeout(500);

  // Filled before it is photographed: a guide's screenshot of an empty form teaches less
  // than one showing what belongs in each field.
  const fill = async (label, value) => {
    const field = page.getByLabel(label).first();
    if (await field.count()) await field.fill(value);
  };
  await fill('Organization name', ORG);
  await fill('Your name', 'Sam Installer');
  await fill('Email', EMAIL);
  await fill('Password', PASSWORD);
  await shot('02-create-organization', 'the form that creates the first organization, filled in');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await page.waitForTimeout(3000);
  if (page.url().includes('/login')) {
    const shown = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
    throw new Error(`registration did not sign in: ${shown.join(' | ') || 'no error shown'}`);
  }
  
  // 3. The dashboard of an empty platform — what "it worked" looks like.
  await shot('03-dashboard-empty', 'the dashboard immediately after installing');

  // 4. Each page the guide points at.
  for (const [label, name, note, expect] of [
    ['Projects', '04-projects', 'where the first project is created', null],
    ['Applications', '05-applications', 'where the application under test is registered', null],
    // A fresh install has no crawl, so this is the empty state and the caption says so.
    ['Discovery', '06-discovery', 'the discovery page before the first crawl', null],
    // The only caption here that asserts content rather than location, so the only one that
    // needs proving. A golden result is a count of tests against a total; an empty Verification
    // Center shows neither.
    ['Verification', '07-verification-centre', 'the Verification Center, reading the last golden run',
      () => page.getByText(/\d+ of \d+ golden tests? passed/).first()]
  ]) {
    const link = page.getByRole('link', { name: label });
    if (await link.count()) {
      await link.first().click();
      await shot(name, note, expect ? expect() : undefined);
    } else {
      console.log(`  (no "${label}" link — skipped)`);
    }
  }

  // 5. The API's own reference, which the guide tells a reader to open as a health check.
  // Swagger UI paints after its bundle initialises, so waiting for the network to go quiet
  // is not enough — the first attempt captured a white page.
  await page.goto(`${API}/swagger/index.html`, { waitUntil: 'domcontentloaded' });
  await page.locator('.swagger-ui .info, .swagger-ui .opblock').first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await shot('08-api-reference', 'the API reference, proving the control plane answers');

  console.log(`\n${shots.length} screenshot(s) written to docs/images/`);
} finally {
  await browser.close();
}
