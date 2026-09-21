/**
 * Proves each declared fault actually changes the application.
 *
 * A fault catalogue that does not bite is worse than none: every later measurement would
 * be taken against an application that was never broken. Each case below enables one
 * fault, observes the difference in a real browser or over HTTP, and turns it off again.
 */
import { chromium } from 'playwright';

const BASE = process.env.BANK_URL ?? 'http://127.0.0.1:4300';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

const setFault = (patch) => fetch(`${BASE}/__faults`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch)
}).then(response => response.json());
const reset = () => fetch(`${BASE}/__reset`, { method: 'POST' }).then(response => response.json());

const results = [];
async function fault(id, patch, expectation) {
  await reset();
  await setFault(patch ?? { [id]: true });

  // A context per case. Sharing one carries the session cookie forward, and a signed-in
  // browser is redirected away from the sign-in page — which looks exactly like a fault
  // that failed to bite.
  const context = await browser.newContext();
  const page = await context.newPage();
  let outcome;
  try {
    outcome = await expectation(page);
  } catch (error) {
    outcome = { ok: false, detail: String(error).split('\n')[0].slice(0, 140) };
  } finally {
    await context.close();
    await reset();
  }
  results.push({ id, ...outcome });
  console.log(`${outcome.ok ? 'PASS' : 'FAIL'}  ${id} — ${outcome.detail}`);
  if (!outcome.ok) process.exitCode = 1;
}

// Signs in by label and role rather than by test id, because one of the faults below
// rewrites every test id on the page and this helper has to survive it.
const signIn = async (page) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Password').fill('Password123!');
  await page.getByRole('button', { name: /log in|sign in/i }).click();
  await page.waitForURL('**/dashboard', { timeout: 15000 });
};

await fault('FAULT_LOGIN_BUTTON_RENAMED', null, async (page) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const renamed = await page.getByTestId('signin-submit').isVisible().catch(() => false);
  const original = await page.getByTestId('login-submit').count();
  const label = renamed ? await page.getByTestId('signin-submit').innerText() : '';
  return { ok: renamed && original === 0 && label.trim() === 'Sign In', detail: `control is "${label.trim()}", old test id present: ${original > 0}` };
});

await fault('FAULT_LOGIN_BUTTON_REMOVED', null, async (page) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const buttons = await page.locator('button[type="submit"]').count();
  const notice = await page.getByTestId('signin-unavailable').isVisible().catch(() => false);
  return { ok: buttons === 0 && notice, detail: `${buttons} submit control(s) on the page` };
});

await fault('FAULT_API_500', null, async (page) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('username').fill('alice');
  await page.getByTestId('password').fill('Password123!');
  await page.getByTestId('login-submit').click();
  const message = await page.getByTestId('login-error').innerText({ timeout: 10000 });
  return { ok: /unavailable/i.test(message) && page.url().includes('/login'), detail: `the page reported: ${message}` };
});

await fault('FAULT_API_TIMEOUT', { FAULT_API_TIMEOUT: true, apiTimeoutMs: 4000 }, async () => {
  const started = Date.now();
  const response = await fetch(`${BASE}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'Password123!' })
  });
  const elapsed = Date.now() - started;
  return { ok: elapsed >= 3800 && response.ok, detail: `the sign-in API answered after ${elapsed}ms` };
});

await fault('FAULT_NETWORK_ERROR', null, async () => {
  const failed = await fetch(`${BASE}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'Password123!' })
  }).then(() => null).catch(error => String(error.cause?.code ?? error.message));
  return { ok: failed !== null, detail: `the connection failed with ${failed}` };
});

await fault('FAULT_WRONG_BALANCE', null, async (page) => {
  await signIn(page);
  const parse = (text) => Number(text.replace(/[^0-9.-]/g, ''));
  const total = parse(await page.getByTestId('total-balance').innerText());
  const cards = await page.locator('[data-testid^="account-balance-"]').allInnerTexts();
  const sum = cards.reduce((running, value) => running + parse(value), 0);
  return { ok: Math.abs(total - sum) > 0.05, detail: `displayed ${total.toFixed(2)} against an actual ${sum.toFixed(2)}` };
});

await fault('FAULT_STATEMENT_FAILURE', null, async (page) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Statements' }).click();
  await page.getByTestId('generate-statement').click();
  const message = await page.getByTestId('statement-error').innerText({ timeout: 10000 });
  return { ok: message.length > 0, detail: `statements reported: ${message}` };
});

await fault('FAULT_INVALID_VALIDATION', null, async (page) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-submit').click();
  const message = await page.getByTestId('login-error').innerText({ timeout: 10000 });
  return { ok: /12 characters/.test(message), detail: `the form stated a rule it does not apply: "${message}"` };
});

await fault('FAULT_DYNAMIC_LOCATOR', null, async (page) => {
  await signIn(page);
  await page.locator('[data-testid^="total-balance--"]').first().waitFor({ timeout: 15000 });
  const stable = await page.locator('[data-testid="total-balance"]').count();
  const dynamic = await page.locator('[data-testid^="total-balance--"]').count();
  return { ok: stable === 0 && dynamic === 1, detail: `stable test id present: ${stable > 0}, session-suffixed present: ${dynamic > 0}` };
});

await fault('FAULT_SLOW_ELEMENT', { FAULT_SLOW_ELEMENT: true, slowElementMs: 3000 }, async (page) => {
  await signIn(page);
  const immediately = await page.locator('[data-testid="total-balance"]').count();
  await page.getByTestId('total-balance').waitFor({ timeout: 15000 });
  return { ok: immediately === 0, detail: `the balance was absent on arrival and appeared after the delay` };
});

await fault('FAULT_JS_ERROR', null, async (page) => {
  const raised = [];
  page.on('pageerror', error => raised.push(String(error)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  return { ok: raised.some(text => text.includes('LAB_FAULT_JS_ERROR')), detail: `${raised.length} uncaught error(s) raised` };
});

await fault('FAULT_SESSION_TIMEOUT', null, async (page) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const response = await fetch(`${BASE}/api/dashboard`, { headers: { cookie: 'lab_session=nonexistent' } });
  const body = await response.json();
  return { ok: response.status === 401, detail: `an authenticated call answered ${response.status} ${body.error}` };
});

await fault('FAULT_PAYMENT_SILENT_FAILURE', null, async (page) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Payments' }).click();
  await page.getByTestId('payment-amount').fill('15.00');
  await page.getByTestId('payment-submit').click();
  await page.getByTestId('payment-confirmation').waitFor({ timeout: 10000 });
  const recorded = await page.getByTestId('payments-empty').isVisible().catch(() => false);
  return { ok: recorded, detail: 'the payment was confirmed on screen but never recorded' };
});

await fault('FAULT_EMPTY_TRANSACTIONS', null, async (page) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Transactions' }).click();
  const count = await page.getByTestId('result-count').innerText({ timeout: 10000 });
  return { ok: count.startsWith('0 '), detail: `the transaction search reported "${count}"` };
});

await browser.close();
console.log(`\n${results.filter(r => r.ok).length} of ${results.length} faults changed the application as declared.`);
