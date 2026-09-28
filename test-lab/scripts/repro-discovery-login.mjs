/**
 * Reproduces the crawler's sign-in against the lab bank, using the worker's own browser
 * pool and authenticator, and reports what the page actually did.
 */
// Resolved from this file rather than from an absolute path, so the script works wherever
// the repository is checked out. It used to hard-code one, which the QA NXT rename rewrote
// into a directory that does not exist.
const worker = new URL('../../apps/browser-worker/dist/browser/', import.meta.url).href;
const { BrowserPool } = await import(`${worker}browser-pool.js`);
const { performLogin } = await import(`${worker}authenticator.js`);

const B = 'http://localhost:4300';
const logger = { info: () => {}, warn: () => {}, error: () => {}, child: () => logger, debug: () => {} };
const pool = new BrowserPool(true, logger);
const context = await pool.createContext('chromium', { defaultTimeoutMs: 15000, navigationTimeoutMs: 30000 });
const page = await context.newPage();

const requests = [];
page.on('request', request => { if (request.url().includes('/api/')) requests.push(`${request.method()} ${request.url()}`); });
page.on('console', message => console.log('[console]', message.type(), message.text().slice(0, 140)));
page.on('pageerror', error => console.log('[pageerror]', String(error).slice(0, 200)));

const result = await performLogin(page, {
  strategy: 'formLogin', loginUrl: `${B}/login`, username: 'alice', password: 'Password123!'
}, { navigationTimeoutMs: 30000, actionTimeoutMs: 15000 });

console.log('login result:', JSON.stringify(result));
console.log('url:', page.url());
console.log('api requests:', requests);
console.log('username field value:', await page.locator('[data-testid="username"]').inputValue().catch(() => 'n/a'));
console.log('password field length:', (await page.locator('[data-testid="password"]').inputValue().catch(() => '')).length);
console.log('error on page:', await page.locator('[data-testid="login-error"]').innerText().catch(() => 'none'));
await context.close();
await pool.closeAll?.();
process.exit(0);
