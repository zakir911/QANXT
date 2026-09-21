/**
 * BUG-0006 — consecutive edits to one field are recorded as separate steps.
 *
 * Runs the same scenario twice against the real extension in a real Chromium, and then
 * probes the root cause directly: whether chrome.storage.session hands back an object with
 * its keys in the order they were written.
 *
 * Usage: node verification/failures/BUG-0006/reproduce.mjs
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Resolved from the verification suite's own dependencies: this directory holds evidence,
// not a package, and a repro script should not need one installed to run.
const { chromium } = createRequire(resolve(here, '../../tests/package.json'))('playwright');
const EXTENSION = resolve(here, '../../../apps/browser-extension');
const BANK = process.env.AIRA_DEMO_BANK_URL ?? 'http://localhost:4200';
const EDITS = ['one', 'two', 'three'];

async function withExtension(work) {
  const dir = await mkdtemp(join(tmpdir(), 'aira-bug0006-'));
  const context = await chromium.launchPersistentContext(dir, {
    headless: true, channel: 'chromium',
    args: ['--no-sandbox', `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`]
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 30_000 });
    return await work(context, worker);
  } finally {
    await context.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function attempt(run) {
  return withExtension(async (context, worker) => {
    const page = await context.newPage();
    await page.goto(`${BANK}/login`, { waitUntil: 'domcontentloaded' });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    const call = (message) => popup.evaluate(m => new Promise(r => chrome.runtime.sendMessage(m, r)), message);

    await popup.getByPlaceholder('Customer downloads a statement').fill(`BUG-0006 run ${run}`);
    await popup.getByRole('button', { name: 'Start recording' }).click();
    await popup.waitForTimeout(400);
    await page.bringToFront();

    // A person correcting a typo: the same field, edited three times, well apart.
    for (const value of EDITS) {
      await page.evaluate(v => {
        const field = document.querySelector('[data-testid="username"]');
        field.value = v;
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      await page.waitForTimeout(700);
    }

    const state = await call({ kind: 'getState' });
    const fills = state.steps.filter(s => s.action === 'fill');
    return {
      run,
      totalSteps: state.steps.length,
      fillSteps: fills.length,
      values: fills.map(s => s.value),
      targetsIdentical: fills.length > 1
        && new Set(fills.map(s => JSON.stringify(s.target))).size === 1
    };
  });
}

const attempts = [await attempt(1), await attempt(2)];

// Root cause, measured rather than argued.
const keyOrder = await withExtension((_, worker) => worker.evaluate(async () => {
  const written = { strategy: 'testId', value: 'username', fallbacks: [{ strategy: 'role', value: 'textbox', name: 'Username' }] };
  await chrome.storage.session.set({ 'bug0006.probe': written });
  const read = (await chrome.storage.session.get('bug0006.probe'))['bug0006.probe'];
  return {
    written: JSON.stringify(written),
    readBack: JSON.stringify(read),
    stringifyEqual: JSON.stringify(written) === JSON.stringify(read)
  };
}));

const report = {
  bug: 'BUG-0006',
  summary: 'Consecutive edits to the same field are recorded as one step per change event; '
    + 'the de-duplication in the service worker never matches.',
  expected: `${EDITS.length} edits to one field → 1 fill step holding "${EDITS.at(-1)}"`,
  attempts,
  reproducedIn: attempts.filter(a => a.fillSteps === EDITS.length).length,
  of: attempts.length,
  rootCause: keyOrder
};

await writeFile(resolve(here, 'logs/reproduction.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
