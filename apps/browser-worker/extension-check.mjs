import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Loads the real extension into a real Chromium and records a real journey through the
 * demo bank, then checks the recording it produced. An extension that only builds proves
 * nothing; this proves it captures the right steps with the right locators.
 */
const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, '../browser-extension');
const userDataDir = await mkdtemp(join(tmpdir(), 'aira-ext-'));

// Extensions need Chrome's newer headless mode; the headless shell does not load them.
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: 'chromium',
  args: [
    '--no-sandbox',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`
  ]
});

const fail = (message) => { console.log(`FAIL  ${message}`); process.exitCode = 1; };
const pass = (message) => console.log(`PASS  ${message}`);

// The service worker is the extension's identity; without it nothing else can be addressed.
let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
if (!worker) { fail('the extension service worker did not start'); await context.close(); process.exit(1); }
pass('the extension service worker started');

const extensionId = new URL(worker.url()).host;

const page = await context.newPage();
await page.goto('http://localhost:4200/login', { waitUntil: 'domcontentloaded' });

// The popup is driven as a real user drives it, through its own UI, which exercises the
// popup, the service worker and the content script together rather than only the last.
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup.html`);

const call = (message) => popup.evaluate(
  msg => new Promise(resolve => chrome.runtime.sendMessage(msg, resolve)),
  message);

await popup.getByPlaceholder('Customer downloads a statement').fill('Customer signs in and opens an account');
await popup.getByRole('button', { name: 'Start recording' }).click();
await popup.waitForTimeout(500);

const afterStart = await call({ kind: 'getState' });
if (!afterStart?.recording) fail(`recording did not start: ${JSON.stringify(afterStart)}`);
else pass('recording started from the popup');

await page.bringToFront();

// A genuine journey: sign in, then open an account.
await page.getByLabel('Username').fill('alice');
await page.getByLabel('Password').fill('Password123!');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL('**/dashboard', { timeout: 15000 });
await page.getByTestId('open-account-acc-1001').click();
await page.waitForURL('**/accounts/acc-1001', { timeout: 15000 });
await page.waitForTimeout(800);

await popup.bringToFront();
await popup.getByRole('button', { name: 'Stop' }).click();
await popup.waitForTimeout(300);

const journey = await call({ kind: 'export' });
if (!journey) { fail('the popup returned no journey'); await context.close(); process.exit(1); }

// The popup must show what was captured, not just hold it.
const listed = await popup.locator('#steps li').count();
if (listed < 3) fail(`the popup listed only ${listed} step(s)`);
else pass(`the popup listed ${listed} recorded step(s)`);

console.log(`\nRecorded ${journey.steps.length} step(s):`);
for (const step of journey.steps) {
  const target = step.target
    ? ` [${step.target.strategy}=${step.target.value}${step.target.name ? ` name="${step.target.name}"` : ''}]`
    : '';
  console.log(`  ${step.order}. ${step.action}${target} — ${step.description}`);
}

// ---- Assertions about the recording -------------------------------------
if (journey.schemaVersion !== 1) fail('the journey is not schema version 1');
else pass('the journey declares its schema version');

if (journey.steps.length < 4) fail(`expected at least 4 steps, recorded ${journey.steps.length}`);
else pass('the journey captured the actions performed');

const fills = journey.steps.filter(s => s.action === 'fill');
if (fills.length < 2) fail(`expected two fill steps, got ${fills.length}`);
else pass('typing into fields was captured');

const serialized = JSON.stringify(journey);
if (serialized.includes('Password123!')) fail('the recorded journey contains the real password');
else pass('the password was never captured — it is a secret reference');

const secretStep = fills.find(s => s.value === '${secret:app_password}');
if (!secretStep) fail('the password field was not recorded as a secret reference');
else pass('the password field recorded a ${secret:...} reference');

const click = journey.steps.find(s => s.action === 'click' && s.target?.strategy === 'testId');
if (!click) fail('the account link was not recorded with its test id');
else pass('the click preferred the test id over a structural selector');

const signIn = journey.steps.find(s => s.action === 'click' && s.target?.strategy === 'role');
if (signIn && signIn.target.name !== 'Sign in') fail(`role locator captured the wrong name: ${signIn.target.name}`);
else pass('role locators carry the accessible name');

const withFallbacks = journey.steps.filter(s => (s.target?.fallbacks?.length ?? 0) > 0);
if (withFallbacks.length === 0) fail('no step recorded fallback locators');
else pass(`${withFallbacks.length} step(s) recorded fallback locators`);

await context.close();

// Hand the recording to the next stage of the check.
const { writeFile } = await import('node:fs/promises');
await writeFile('/tmp/aira-journey.json', JSON.stringify(journey, null, 2));
console.log('\nRecording written to /tmp/aira-journey.json');
