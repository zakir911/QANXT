import { chromium } from 'playwright';

/** Drives the console the way a person would, to confirm it actually works. */
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}: ${String(error).split('\n')[0]}`);
    await page.screenshot({ path: `/tmp/aira-shots/fail-${name.replace(/\W+/g, '-')}.png`, fullPage: true });
    process.exitCode = 1;
  }
};

await step('sign in', async () => {
  await page.goto('http://127.0.0.1:5173/login', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email', { exact: true }).fill('qa.lead@northwind.test');
  await page.getByLabel('Password', { exact: true }).fill('Str0ngPassphrase!2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/', { timeout: 15000 });
  await page.getByRole('heading', { name: 'Quality dashboard' }).waitFor({ timeout: 15000 });
});

await step('dashboard shows real metrics', async () => {
  const tile = page.locator('div').filter({ hasText: /^Pass rate/ }).first();
  const text = await tile.innerText();
  if (!/\d/.test(text)) throw new Error(`no numeric pass rate: ${text}`);
  const executions = await page.getByText('Executions', { exact: true }).first().isVisible();
  if (!executions) throw new Error('execution count tile missing');
  await page.screenshot({ path: '/tmp/aira-shots/dashboard.png', fullPage: true });
});

await step('applications page lists the demo bank', async () => {
  await page.getByRole('link', { name: 'Applications' }).click();
  await page.getByRole('heading', { name: 'Demo Bank' }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: '/tmp/aira-shots/applications.png', fullPage: true });
});

await step('application map renders the knowledge graph', async () => {
  await page.getByRole('link', { name: 'View application map' }).first().click();
  await page.getByRole('heading', { name: 'Application map' }).waitFor({ timeout: 10000 });
  await page.getByText('/dashboard', { exact: false }).first().waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /\/payments/ }).first().click();
  await page.getByText('payment-submit', { exact: false }).first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: '/tmp/aira-shots/graph.png', fullPage: true });
});

await step('test cases list the generated suite', async () => {
  await page.getByRole('link', { name: 'Test cases' }).click();
  await page.getByRole('heading', { name: 'Test cases' }).waitFor({ timeout: 10000 });
  // The list loads once a project is selected, which the header does automatically when
  // the organization has exactly one.
  await page.locator('tbody tr').first().waitFor({ timeout: 15000 });
  const rows = await page.locator('tbody tr').count();
  if (rows < 5) throw new Error(`expected generated tests, found ${rows} rows`);
  await page.screenshot({ path: '/tmp/aira-shots/testcases.png', fullPage: true });
});

await step('a test case shows its steps and assertions', async () => {
  await page.locator('tbody tr a').first().click();
  await page.getByRole('heading', { name: 'Steps' }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: '/tmp/aira-shots/testcase.png', fullPage: true });
});

await step('runs list shows completed runs', async () => {
  await page.getByRole('link', { name: 'Test runs' }).click();
  await page.getByRole('heading', { name: 'Test runs' }).waitFor({ timeout: 10000 });
  const rows = await page.locator('tbody tr').count();
  if (rows < 1) throw new Error('no runs listed');
  await page.screenshot({ path: '/tmp/aira-shots/runs.png', fullPage: true });
});

await step('run detail shows executions and the quality gate', async () => {
  await page.locator('tbody tr a').first().click();
  await page.getByText('Quality gate').first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: '/tmp/aira-shots/run.png', fullPage: true });
});

await step('execution detail shows evidence', async () => {
  await page.locator('tbody tr a').first().click();
  await page.getByRole('tab', { name: /Evidence/ }).waitFor({ timeout: 10000 });
  await page.getByRole('tab', { name: /Evidence/ }).click();
  await page.getByText('All artifacts').waitFor({ timeout: 10000 });

  // Screenshots are fetched with the caller's credentials and rendered from a blob, so a
  // rendered image proves both the authorization path and the artifact store.
  const image = page.locator('figure img').first();
  await image.waitFor({ timeout: 15000 });
  const width = await image.evaluate(node => node.naturalWidth);
  if (!width || width < 10) throw new Error(`the screenshot did not render (naturalWidth=${width})`);

  await page.screenshot({ path: '/tmp/aira-shots/execution.png', fullPage: true });
});

await step('healing page shows proposals with confidence', async () => {
  await page.getByRole('link', { name: 'Healing' }).click();
  await page.getByRole('heading', { name: 'Self-healing' }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: '/tmp/aira-shots/healing.png', fullPage: true });
});

await step('AI insights answers a question', async () => {
  await page.getByRole('link', { name: 'AI insights' }).click();
  await page.getByRole('button', { name: 'Which tests are most unstable?' }).click();
  await page.getByRole('heading', { name: 'Answer' }).waitFor({ timeout: 20000 });
  await page.screenshot({ path: '/tmp/aira-shots/insights.png', fullPage: true });
});

await step('settings shows the role matrix', async () => {
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Roles and permissions' }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: '/tmp/aira-shots/settings.png', fullPage: true });
});

await step('quality gates can be configured from the console', async () => {
  // The gate engine is only real if a person can reach it: the rules the evaluator uses
  // must be listed here, and an editor must be able to change one.
  await page.getByRole('heading', { name: 'Quality gates' }).waitFor({ timeout: 10000 });

  const rules = page.locator('li').filter({ hasText: 'Block when' });
  const count = await rules.count();
  if (count === 0) throw new Error('no quality gate rules were listed');

  // Stating the rule in the evaluator's words is what stops a gate being misconfigured.
  const described = await rules.first().innerText();
  if (!/Block when .+ is .+/.test(described)) {
    throw new Error(`the rule is not explained in words: ${described}`);
  }

  // Toggling proves the change reached the server and came back: the button only relabels
  // once the refetched rule says so.
  const toggle = rules.first().getByRole('button', { name: /Disable|Enable/ });
  const before = await toggle.innerText();
  const after = before === 'Disable' ? 'Enable' : 'Disable';

  await toggle.click();
  await toggle.filter({ hasText: after }).waitFor({ timeout: 10000 });
  await toggle.click();                       // Leave the gate as it was found.
  await toggle.filter({ hasText: before }).waitFor({ timeout: 10000 });

  await page.screenshot({ path: '/tmp/aira-shots/quality-gates.png', fullPage: true });
});

if (consoleErrors.length > 0) {
  console.log(`\nConsole errors observed (${consoleErrors.length}):`);
  for (const error of consoleErrors.slice(0, 8)) console.log('  -', error.slice(0, 200));
  process.exitCode = 1;
} else {
  console.log('\nNo console errors.');
}

await browser.close();
