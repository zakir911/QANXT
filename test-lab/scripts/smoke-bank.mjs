import { chromium } from 'playwright';

const BASE = process.env.BANK_URL ?? 'http://127.0.0.1:4300';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
// Only uncaught exceptions count. This walk deliberately triggers a 401 and two 400s, and
// the browser logs every non-2xx response as a console error — treating those as faults
// would make the application's correct error handling look like a defect.
const errors = [];
page.on('pageerror', error => errors.push(String(error).slice(0, 160)));
page.on('console', message => {
  if (message.type() !== 'error') return;
  if (/Failed to load resource/i.test(message.text())) return;
  errors.push(`console: ${message.text().slice(0, 160)}`);
});

const step = async (label, fn) => {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (error) { console.log(`FAIL  ${label} — ${String(error).split('\n')[0].slice(0, 160)}`); process.exitCode = 1; }
};

await step('the sign-in page renders', async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-form').waitFor({ timeout: 10000 });
});

await step('signing in reaches the dashboard', async () => {
  await page.getByTestId('username').fill('alice');
  await page.getByTestId('password').fill('Password123!');
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/dashboard', { timeout: 10000 });
  await page.getByTestId('total-balance').waitFor({ timeout: 10000 });
});

await step('the balance shown matches the accounts listed', async () => {
  const total = await page.getByTestId('total-balance').innerText();
  const parse = (text) => Number(text.replace(/[^0-9.-]/g, ''));
  const cards = await page.locator('[data-testid^="account-balance-"]').allInnerTexts();
  const sum = cards.reduce((running, value) => running + parse(value), 0);
  if (Math.abs(sum - parse(total)) > 0.05) throw new Error(`total ${total} but cards sum to ${sum.toFixed(2)}`);
});

await step('client-side routing works across every page', async () => {
  for (const [id, path] of [['nav-accounts', '/accounts'], ['nav-transactions', '/transactions'],
    ['nav-statements', '/statements'], ['nav-payments', '/payments'],
    ['nav-beneficiaries', '/beneficiaries'], ['nav-profile', '/profile']]) {
    await page.getByTestId(id).click();
    await page.waitForURL(`**${path}`, { timeout: 10000 });
    await page.getByTestId('page-title').waitFor({ timeout: 10000 });
  }
});

await step('a statement can be generated and downloaded', async () => {
  await page.getByTestId('nav-statements').click();
  await page.waitForURL('**/statements');
  await page.getByTestId('generate-statement').click();
  await page.getByTestId('statement-result').waitFor({ timeout: 10000 });
  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.getByTestId('download-statement').click()
  ]);
  const path = await download[0].path();
  if (!path) throw new Error('no file was downloaded');
});

await step('an invalid date range is rejected by the form', async () => {
  await page.getByTestId('statement-from').fill('2026-09-10');
  await page.getByTestId('statement-to').fill('2026-09-01');
  await page.getByTestId('generate-statement').click();
  await page.getByTestId('statement-error-to').waitFor({ timeout: 10000 });
});

await step('a payment validates and then confirms', async () => {
  await page.getByTestId('nav-payments').click();
  await page.waitForURL('**/payments');
  await page.getByTestId('payment-amount').fill('-5');
  await page.getByTestId('payment-submit').click();
  await page.getByTestId('payment-error-amount').waitFor({ timeout: 10000 });
  await page.getByTestId('payment-amount').fill('42.50');
  await page.getByTestId('payment-submit').click();
  await page.getByTestId('payment-confirmation').waitFor({ timeout: 10000 });
  await page.getByTestId('payments-table').waitFor({ timeout: 10000 });
});

await step('a payee can be added through the modal', async () => {
  await page.getByTestId('nav-beneficiaries').click();
  await page.waitForURL('**/beneficiaries');
  await page.getByTestId('add-beneficiary').click();
  await page.getByTestId('beneficiary-modal').waitFor({ timeout: 10000 });
  await page.getByTestId('beneficiary-save').click();
  await page.getByTestId('beneficiary-error-name').waitFor({ timeout: 10000 });
  await page.getByTestId('beneficiary-name').fill('Test Payee');
  await page.getByTestId('beneficiary-account').fill('12345678');
  await page.getByTestId('beneficiary-sort').fill('11-22-33');
  await page.getByTestId('beneficiary-save').click();
  await page.getByTestId('beneficiary-added').waitFor({ timeout: 10000 });
});

await step('the transaction filters narrow the result set', async () => {
  await page.getByTestId('nav-transactions').click();
  await page.waitForURL('**/transactions');
  await page.getByTestId('result-count').waitFor({ timeout: 10000 });
  const before = await page.getByTestId('result-count').innerText();
  await page.getByTestId('filter-category').selectOption('Salary');
  await page.getByTestId('apply-filters').click();
  await page.waitForFunction(
    text => document.querySelector('[data-testid="result-count"]')?.textContent !== text,
    before, { timeout: 10000 });
});

await step('signing out returns to the sign-in page', async () => {
  await page.getByTestId('logout').click();
  await page.waitForURL('**/login', { timeout: 10000 });
});

if (errors.length) {
  console.log(`FAIL  the page raised ${errors.length} uncaught error(s): ${errors.slice(0, 3).join(' | ')}`);
  process.exitCode = 1;
} else {
  console.log('PASS  no uncaught JavaScript errors');
}

await browser.close();
