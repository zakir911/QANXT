import { chromium } from 'playwright';
const B = 'http://localhost:4300';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
page.on('console', m => console.log('[console]', m.type(), m.text().slice(0, 120)));
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));

await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
console.log('url after goto:', page.url());

// Exactly what the worker's authenticator does.
const username = page.getByLabel('Username');
await username.fill('alice');
const password = page.locator('input[type="password"]');
await password.fill('Password123!');
let submit = page.getByRole('button', { name: 'Sign in' });
let count = await submit.count();
console.log('buttons named "Sign in":', count);
if (count === 0) { submit = page.getByRole('button', { name: 'Log in' }); console.log('buttons named "Log in":', await submit.count()); }

await Promise.all([
  page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => undefined),
  submit.first().click({ timeout: 15000 })
]);
await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => console.log('networkidle timed out'));
console.log('url after click:', page.url());
console.log('password fields visible:', await page.locator('input[type="password"]:visible').count());
await page.waitForTimeout(1500);
console.log('url 1.5s later:', page.url());
await browser.close();
