/**
 * Walks the path a new developer actually takes on a fresh install: open the console,
 * register an organization, land on the dashboard, and register an application.
 *
 * It exists because docs/setup.md tells people to do exactly this, and a setup guide that
 * has never been followed is a guess. Everything it creates is namespaced by a timestamp,
 * so it is safe to run against an environment that already has data.
 */
import { chromium } from 'playwright';

const consoleUrl = (process.env.AIRA_CONSOLE_URL ?? 'http://127.0.0.1:5173').replace(/\/+$/, '');
const bankUrl = process.env.AIRA_DEMO_BANK_URL ?? 'http://localhost:4200';

const fail = (message) => { console.log(`FAIL  ${message}`); process.exitCode = 1; };
const pass = (message) => console.log(`PASS  ${message}`);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

const stamp = Date.now();
const organization = `Setup Check ${stamp}`;
const email = `founder-${stamp}@example.test`;
const password = 'Str0ngPassphrase!2026';

try {
  await page.goto(`${consoleUrl}/login`, { waitUntil: 'domcontentloaded' });

  // A fresh install has no accounts at all, so the first thing the console must offer is a
  // way to create one.
  await page.getByRole('tab', { name: 'Create an organization' }).click();
  await page.getByLabel('Organization name').fill(organization);
  await page.getByLabel('Your name').fill('A Founder');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create organization' }).click();

  await page.getByRole('heading', { name: 'Quality dashboard' }).waitFor({ timeout: 20000 });
  pass('a new organization can be registered from the console');

  // The founder administers it, or nobody can.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'People' }).waitFor({ timeout: 15000 });

  // The heading renders before the people query resolves, so counting rows straight after
  // it counted an empty table and reported a healthy platform as broken. Waiting for the
  // row is the difference between checking the product and checking the network's mood —
  // and a false failure is as much a defect in a check as a false pass.
  const founderRow = page.locator('table tbody tr').filter({ hasText: email });
  await founderRow.first().waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {/* reported as a failure below, with the count it actually saw */});

  const people = await founderRow.count();
  if (people !== 1) fail(`the founder is not listed exactly once (found ${people})`);
  else pass('the founder is listed as a member of the new organization');

  const roleText = await founderRow.innerText();
  if (!/admin/i.test(roleText)) fail(`the founder is not an administrator: ${roleText}`);
  else pass('the founder administers the organization they created');

  // A brand-new organization has no project, so the console has to offer a way to make one
  // rather than showing an empty screen with no route forward.
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Retail Banking');
  await page.getByLabel('Key', { exact: true }).fill(`SET${String(stamp).slice(-5)}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('heading', { name: 'Retail Banking' }).first().waitFor({ timeout: 15000 });
  pass('a project can be created in a brand-new organization');

  // And an application to point it at, which is where the setup guide ends.
  await page.getByRole('link', { name: 'Applications' }).click();
  await page.getByRole('heading', { name: 'Applications', level: 1 }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /^Add an? application$/ }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('Demo Bank');
  await page.getByLabel('Base URL').fill(`${bankUrl}/dashboard`);
  await page.getByRole('button', { name: 'Add application' }).last().click();
  await page.getByRole('heading', { name: 'Demo Bank' }).first().waitFor({ timeout: 15000 });
  pass('an application can be registered against the demo bank');

  await page.screenshot({ path: '/tmp/aira-shots/first-run.png', fullPage: true });
} catch (error) {
  fail(String(error).split('\n')[0]);
  await page.screenshot({ path: '/tmp/aira-shots/first-run-failure.png', fullPage: true }).catch(() => {});
}

if (consoleErrors.length > 0) {
  console.log(`\nConsole errors observed (${consoleErrors.length}):`);
  for (const error of consoleErrors.slice(0, 5)) console.log('  -', error.slice(0, 200));
  process.exitCode = 1;
}

await browser.close();
console.log(process.exitCode
  ? '\nThe documented first run does not work.'
  : '\nThe documented first run works.');
