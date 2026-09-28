import { chromium } from 'playwright';
// Resolved from this file, not from an absolute path — see repro-discovery-login.mjs.
const { performLogin } = await import(
  new URL('../../apps/browser-worker/dist/browser/authenticator.js', import.meta.url).href);
const B = 'http://localhost:4300';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
page.on('request', r => { if (r.url().includes('/api/')) console.log('[req]', r.method(), r.url()); });
const result = await performLogin(page, {
  strategy: 'formLogin', loginUrl: `${B}/login`, username: 'alice', password: 'Password123!'
}, { navigationTimeoutMs: 30000, actionTimeoutMs: 15000 });
console.log('result:', JSON.stringify(result));
console.log('url:', page.url());
await browser.close();
