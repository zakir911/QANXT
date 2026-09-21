import { chromium } from 'playwright';
const B = 'http://127.0.0.1:4330';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 100)));
const ok = (label, value) => console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`);

await page.goto(`${B}/`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('page-title').waitFor({ timeout: 10000 });
ok('home renders', true);

await page.getByTestId('nav-feed').click();
await page.getByTestId('feed-list').waitFor({ timeout: 10000 });
const first = await page.locator('[data-testid^="feed-item-"]').count();
await page.mouse.wheel(0, 20000);
await page.waitForTimeout(1200);
await page.mouse.wheel(0, 20000);
await page.waitForTimeout(1200);
const after = await page.locator('[data-testid^="feed-item-"]').count();
ok(`infinite scroll loads more (${first} → ${after})`, after > first);

await page.getByTestId('nav-widgets').click();
await page.getByTestId('tab-list').waitFor({ timeout: 10000 });
await page.getByTestId('tab-details').click();
await page.getByTestId('panel-details').waitFor({ timeout: 10000 });
ok('tabs render panels lazily', true);
await page.getByTestId('counter-value').waitFor({ timeout: 15000 });
ok('late counter arrives', true);
await page.waitForTimeout(3200);
ok('the temporary banner removes itself', await page.getByTestId('temporary-banner').count() === 0);

await page.getByTestId('nav-dialog').click();
await page.getByTestId('open-dialog').click();
await page.getByTestId('confirm-action').click();
ok('dialog confirms', (await page.getByTestId('dialog-outcome').innerText()) === 'Confirmed');

await page.getByTestId('nav-shuffle').click();
const before = await page.getByTestId('shuffle-target').evaluate(node => { let d = 0, p = node; while ((p = p.parentElement)) d++; return d; });
await page.getByTestId('shuffle-rerender').click();
await page.getByTestId('shuffle-target').waitFor();
let changed = false;
for (let i = 0; i < 6 && !changed; i++) {
  await page.getByTestId('shuffle-rerender').click();
  await page.getByTestId('shuffle-target').waitFor();
  const depth = await page.getByTestId('shuffle-target').evaluate(node => { let d = 0, p = node; while ((p = p.parentElement)) d++; return d; });
  changed = depth !== before;
}
ok('the DOM hierarchy changes between renders', changed);

const ids = await page.locator('[data-testid="page-title"]').evaluate(node => node.id);
await page.getByTestId('shuffle-rerender').click();
await page.waitForTimeout(200);
const ids2 = await page.locator('[data-testid="page-title"]').evaluate(node => node.id);
ok(`element ids are regenerated (${ids} → ${ids2})`, ids !== ids2);
ok(`no uncaught errors`, errors.length === 0);
await browser.close();
