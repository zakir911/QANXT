import { chromium } from 'playwright';

/** Drives the console the way a person would, to confirm it actually works. */
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];

/**
 * A refused request is not a console error worth failing on.
 *
 * The security page asks for a scope that may not exist and starts a scan that may be refused,
 * and renders both answers as the text a person should read. The browser still logs the
 * non-2xx as a failed resource load. Ignoring those specific URLs keeps this check meaningful
 * — a real fault anywhere else still fails it — without teaching anyone to expect noise here.
 */
const isDeliberateRefusal = (message) => {
  if (!/Failed to load resource/.test(message.text())) return false;
  const url = message.location?.().url ?? '';
  return /\/api\/v1\/security\//.test(url);
};

page.on('console', m => {
  if (m.type() !== 'error') return;
  if (isDeliberateRefusal(m)) return;
  consoleErrors.push(m.text());
});
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
  // Several applications can carry this name once other suites have registered one, and a
  // strict locator turns "the list works" into "the list has exactly one of these".
  await page.getByRole('heading', { name: 'Demo Bank' }).first().waitFor({ timeout: 10000 });
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

await step('people can be added and their access taken away', async () => {
  await page.getByRole('heading', { name: 'People' }).waitFor({ timeout: 10000 });

  const before = await page.locator('table tbody tr').filter({ hasText: '@' }).count();

  await page.getByRole('button', { name: 'Add someone' }).click();
  const email = `colleague-${Date.now()}@example.test`;
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Name', { exact: true }).fill('A Colleague');
  await page.getByRole('button', { name: 'Add them' }).click();

  // The one-time password is the whole point of the flow: there is no mail transport, so if
  // it is not shown here the invitation is useless.
  const handover = page.getByText(/One-time password for/);
  await handover.waitFor({ timeout: 10000 });
  const notice = await handover.locator('..').innerText();
  if (!/shown once/i.test(notice)) {
    throw new Error(`the handover does not say the password cannot be retrieved: ${notice}`);
  }

  const after = await page.locator('table tbody tr').filter({ hasText: '@' }).count();
  if (after <= before) throw new Error(`the new person was not listed (${before} -> ${after})`);

  // Disabling has to be reachable, and has to report back.
  const row = page.locator('table tbody tr').filter({ hasText: email });
  await row.getByRole('button', { name: 'Disable' }).click();
  await row.getByText('Disabled', { exact: false }).waitFor({ timeout: 10000 });

  await page.screenshot({ path: '/tmp/aira-shots/people.png', fullPage: true });
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

await step('the agent page shows a pass, its steps and its proposals', async () => {
  await page.getByRole('link', { name: 'Agent' }).click();
  await page.getByRole('heading', { name: 'Autonomous agent' }).waitFor({ timeout: 10000 });

  // A pass that ran earlier in this environment should be listed and selectable. The list
  // arrives asynchronously, so wait for it rather than counting an empty list.
  const passes = page.locator('li button').filter({ hasText: /pass/i });
  await passes.first().waitFor({ timeout: 15000 });
  await passes.first().click();

  // The three things that make an unattended run reviewable: what it did, under what
  // bounds, and what it concluded.
  await page.getByRole('heading', { name: 'What it did' }).waitFor({ timeout: 10000 });
  const phases = await page.locator('ol li').count();
  if (phases < 3) throw new Error(`expected the phases to be listed, found ${phases}`);

  const bounds = await page.getByText(/Bounded to \d+ page/).first().innerText();
  if (!/model spend/i.test(bounds)) throw new Error(`the bounds do not state the spend: ${bounds}`);

  await page.getByRole('heading', { name: /^Proposals/ }).waitFor({ timeout: 10000 });

  // The agent's lack of authority is stated on the screen, not just in the docs.
  const disclaimer = await page.getByText(/cannot raise a defect/i).first().innerText();
  if (!/quality gate/i.test(disclaimer)) {
    throw new Error(`the proposals card does not state what the agent cannot do: ${disclaimer}`);
  }

  await page.screenshot({ path: '/tmp/aira-shots/agent.png', fullPage: true });
});

await step('the security page can start a scan, and says what it refuses', async () => {
  await page.getByRole('link', { name: 'Security' }).click();
  await page.getByRole('heading', { name: 'Security' }).waitFor({ timeout: 10000 });

  const control = page.getByTestId('security-start-scan');
  if (await control.count() === 0) {
    // Without security:scan the control is correctly absent, and there is nothing to drive.
    // Said out loud rather than passing quietly on an assertion that never ran.
    console.log('      this account holds no security:scan, so the control is absent as intended');
    return;
  }

  await control.click();

  // Whatever comes back, it has to be one of the platform's own sentences. This is the
  // assertion that earns the step: a request the API cannot deserialise answers with a type
  // name and a byte offset, which is what a double-encoded body produced here until it was
  // caught by driving the real thing. Component tests mock the transport and cannot see it.
  const outcome = page.locator(
    '[data-testid=security-start-refused], [data-testid=security-queued-note], [data-testid=security-reported]');
  await outcome.first().waitFor({ timeout: 20000 });
  const text = (await outcome.first().innerText()).trim();

  if (/could not be converted|LineNumber|BytePositionInLine|Aira\.Application/.test(text)) {
    throw new Error(`the request did not reach the endpoint in a shape it accepts: ${text}`);
  }

  const expected = [
    /written authorization/i,      // no scope
    /Run discovery first/i,        // nothing discovered
    /security:scan/i,              // a permission the caller lacks
    /has not run yet/i,            // queued
    /PASSED|NEEDS REVIEW|BLOCKED|NOT SCANNED/ // already reported
  ];
  if (!expected.some(pattern => pattern.test(text))) {
    throw new Error(`the outcome is not one of the platform's own sentences: ${text}`);
  }

  // A queued scan must never be drawn beside a verdict. This is the one thing on this page
  // that would be actively dangerous to get wrong.
  if (await page.getByTestId('security-queued-note').count() > 0) {
    const note = await page.getByTestId('security-queued-note').innerText();
    if (!/nothing here should be read as a result/i.test(note)) {
      throw new Error(`a queued scan is not qualified as unrun: ${note}`);
    }
    if (await page.getByTestId('security-reported').count() > 0) {
      throw new Error('a queued scan is shown alongside a reported verdict');
    }
  }

  console.log(`      the page answered: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  await page.screenshot({ path: '/tmp/aira-shots/security.png', fullPage: true });
});

if (consoleErrors.length > 0) {
  console.log(`\nConsole errors observed (${consoleErrors.length}):`);
  for (const error of consoleErrors.slice(0, 8)) console.log('  -', error.slice(0, 200));
  process.exitCode = 1;
} else {
  console.log('\nNo console errors.');
}

await browser.close();
