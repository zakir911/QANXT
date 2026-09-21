/**
 * Independent verification: the browser extension recorder.
 *
 * The product ships its own extension check. This suite deliberately does not reuse it,
 * and does not assert the same things. Its questions are the ones an outside tester asks
 * of a recorder:
 *
 *   - does it capture every action, including actions that arrive in the same tick;
 *   - can a fresh browser find the elements it recorded, or are the locators decorative;
 *   - does the page it is recording behave as it would with the recorder absent;
 *   - does a typed password survive anywhere it can be read back — the export, the
 *     extension's own storage, the popup, or the platform's database after import.
 *
 * Everything here runs against the real extension loaded into a real Chromium and the real
 * demo bank. Nothing is stubbed.
 */
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BANK, ROOT, check, newTenant, request, resetScenario, saveEvidence, sleep, suite } from './harness.mjs';

const EXTENSION = resolve(ROOT, 'apps/browser-extension');
const PASSWORD = 'Password123!';           // the demo bank's password for "alice"
const USERNAME = 'alice';

suite('Browser extension recorder');
await resetScenario();

const userDataDir = await mkdtemp(join(tmpdir(), 'aira-verify-ext-'));
// Extensions load only in Chrome's newer headless mode, not the headless shell.
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: 'chromium',
  args: ['--no-sandbox', `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`]
});

let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
const extensionId = new URL(worker.url()).host;

const page = await context.newPage();
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup.html`);

/** Talks to the service worker from the popup's own origin, as the popup itself does. */
const call = (message) => popup.evaluate(
  msg => new Promise(done => chrome.runtime.sendMessage(msg, done)), message);

// ---------------------------------------------------------------------------
// The recording. Performed once; the checks below interrogate what it produced.
// ---------------------------------------------------------------------------

await page.goto(`${BANK}/login`, { waitUntil: 'domcontentloaded' });

// A structural fingerprint of the page as the recorder sees it, compared later against the
// same page in a browser with no extension at all.
const fingerprint = (target) => target.evaluate(() =>
  [...document.body.querySelectorAll('*')]
    .map(el => `${el.tagName.toLowerCase()}#${el.id || '-'}@${el.getAttribute('data-testid') ?? '-'}`)
    .join('\n'));

await popup.bringToFront();
await popup.getByPlaceholder('Customer downloads a statement').fill('Independent verification journey');
await popup.getByRole('button', { name: 'Start recording' }).click();
await popup.waitForTimeout(400);
const startedState = await call({ kind: 'getState' });

await page.bringToFront();
await page.getByTestId('username').fill(USERNAME);
await page.getByTestId('password').fill(PASSWORD);

const recordedFingerprint = await fingerprint(page);
const overlaysWhileRecording = await page.evaluate(() =>
  document.querySelectorAll('div[style*="2147483647"]').length);

await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL('**/dashboard', { timeout: 15_000 });
const urlAfterSignIn = page.url();

await page.getByTestId('nav-payments').click();
await page.waitForURL('**/payments', { timeout: 15_000 });

// After a navigation the content script is injected afresh and only starts recording once
// it has announced itself to the service worker and been told to. Until then the page is
// live but unrecorded. Rather than assume that window is short, it is measured: a probe
// event is repeated until it lands, and how long that took becomes evidence. Repeated
// probes into the same field collapse into a single step, so this costs one step.
const armingStarted = Date.now();
let armingDelayMs = null;
for (let attempt = 0; attempt < 40 && armingDelayMs === null; attempt++) {
  await page.evaluate(() => {
    const field = document.querySelector('[data-testid="payment-amount"]');
    field.value = 'arming-probe';
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  const state = await call({ kind: 'getState' });
  if ((state?.steps ?? []).some(step => step.value === 'arming-probe')) armingDelayMs = Date.now() - armingStarted;
}

// The burst. Eight change events dispatched synchronously in one tick: the service worker
// receives eight messages before it can persist any of them, which is precisely the
// read-modify-write collision that silently dropped steps before. Real typing rarely
// collides this hard, which is why this is done deliberately rather than hoped for.
//
// The events alternate between two fields on purpose. The recorder collapses consecutive
// edits to the *same* field into one step, so a burst into a single field could not
// distinguish a step that was lost from a step that was correctly merged.
const BURST = 8;
const BURST_FIELDS = ['payment-reference', 'payment-amount'];
const burst = Array.from({ length: BURST }, (_, i) => ({
  field: BURST_FIELDS[i % BURST_FIELDS.length],
  value: `burst-${i + 1}`
}));
const burstValues = burst.map(entry => entry.value);
await page.evaluate(entries => {
  for (const { field, value } of entries) {
    const element = document.querySelector(`[data-testid="${field}"]`);
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, burst);
await page.waitForTimeout(1500);

// A person correcting a typo: the same field, edited three times, seconds apart. The
// recorder says consecutive edits to one field are one step, so this must arrive as one.
const CORRECTIONS = ['corrected-1', 'corrected-2', 'corrected-3'];
for (const value of CORRECTIONS) {
  await page.evaluate(v => {
    const field = document.querySelector('[data-testid="payment-reference"]');
    field.value = v;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await page.waitForTimeout(600);
}

await popup.bringToFront();
await popup.getByRole('button', { name: 'Stop' }).click();
await popup.waitForTimeout(400);

const journey = await call({ kind: 'export' });
const journeyPath = saveEvidence('evidence/extension/recorded-journey.json', journey ?? { error: 'no journey' });

// What the extension itself kept, read from its own storage rather than from the export.
const storedState = await worker.evaluate(() => chrome.storage.session.get(null));
const storagePath = saveEvidence('evidence/extension/session-storage.json', storedState);
const popupText = await popup.locator('body').innerText();

// ---------------------------------------------------------------------------
// EXT-001  It records what was done
// ---------------------------------------------------------------------------
await check('EXT-001', 'The real extension records a real journey through a real browser', async () => {
  if (!journey) return { pass: false, detail: 'the extension exported no journey' };
  const orders = journey.steps.map(s => s.order);
  const contiguous = orders.every((value, index) => value === index + 1);
  const performed = ['fill', 'fill', 'click', 'click'];   // username, password, sign in, nav
  const actions = journey.steps.map(s => s.action);
  const missing = performed.filter(a => !actions.includes(a));
  return {
    pass: Boolean(startedState?.recording) && journey.schemaVersion === 1
      && contiguous && missing.length === 0 && journey.steps.length >= 4,
    detail: `${journey.steps.length} step(s), orders ${contiguous ? 'contiguous' : `broken: ${orders.join(',')}`}`
      + `, recording started: ${Boolean(startedState?.recording)}`
      + `, recorder armed ${armingDelayMs === null ? 'NOT WITHIN 10s' : `within ${armingDelayMs}ms`} of the navigation`,
    evidence: [journeyPath]
  };
});

// ---------------------------------------------------------------------------
// EXT-002  It loses nothing when events collide
// ---------------------------------------------------------------------------
await check('EXT-002', 'No step is lost when events arrive in the same tick', async () => {
  const captured = (journey?.steps ?? [])
    .filter(s => typeof s.value === 'string' && s.value.startsWith('burst-'))
    .map(s => s.value);
  if (armingDelayMs === null) {
    return { pass: false, detail: 'the recorder never armed after the navigation, so nothing could be measured' };
  }
  const missing = burstValues.filter(value => !captured.includes(value));
  const duplicated = captured.length !== new Set(captured).size;
  return {
    pass: missing.length === 0 && !duplicated,
    detail: `${captured.length} of ${BURST} captured`
      + (missing.length ? `; lost ${missing.join(', ')}` : '')
      + (duplicated ? '; duplicate values recorded' : ''),
    evidence: [journeyPath]
  };
});

// ---------------------------------------------------------------------------
// EXT-007  It records the journey, not every event
// ---------------------------------------------------------------------------
await check('EXT-007', 'Consecutive edits to one field are recorded as the one step the user performed', async () => {
  const corrections = (journey?.steps ?? []).filter(s => typeof s.value === 'string' && s.value.startsWith('corrected-'));
  const final = corrections.at(-1)?.value;
  return {
    pass: corrections.length === 1 && final === CORRECTIONS.at(-1),
    detail: `${CORRECTIONS.length} edit(s) to one field recorded as ${corrections.length} step(s)`
      + ` holding ${corrections.map(s => s.value).join(', ') || 'nothing'}`
      + (corrections.length === 1 ? '' : ` — expected 1 holding ${CORRECTIONS.at(-1)}`),
    evidence: [journeyPath]
  };
});

// ---------------------------------------------------------------------------
// EXT-003  The password is nowhere
// ---------------------------------------------------------------------------
await check('EXT-003', 'A typed password is not readable from the export, the extension storage or the popup', async () => {
  const places = [
    ['exported journey', JSON.stringify(journey ?? {})],
    ['extension session storage', JSON.stringify(storedState ?? {})],
    ['popup window', popupText]
  ];
  const leaks = places.filter(([, text]) => text.includes(PASSWORD)).map(([where]) => where);
  const reference = (journey?.steps ?? []).find(s => s.value === '${secret:app_password}');
  return {
    pass: leaks.length === 0 && Boolean(reference),
    detail: leaks.length
      ? `the password appears in: ${leaks.join(', ')}`
      : `absent from all ${places.length} readable surfaces; recorded as ${reference ? reference.value : 'NO secret reference'}`,
    evidence: [journeyPath, storagePath]
  };
});

// ---------------------------------------------------------------------------
// EXT-004  The locators it wrote are usable
// ---------------------------------------------------------------------------
/** Resolves a recorded descriptor independently of the platform's own resolver. */
function resolveLocator(target, descriptor) {
  const { strategy, value, name, exact } = descriptor;
  switch (strategy) {
    case 'testId': return target.getByTestId(value);
    case 'role': return target.getByRole(value, name ? { name, exact: exact ?? false } : {});
    case 'label': return target.getByLabel(value, { exact: exact ?? false });
    case 'placeholder': return target.getByPlaceholder(value, { exact: exact ?? false });
    case 'altText': return target.getByAltText(value);
    case 'title': return target.getByTitle(value);
    case 'text': return target.getByText(value, { exact: exact ?? false });
    case 'css': return target.locator(value);
    case 'xpath': return target.locator(`xpath=${value}`);
    default: return null;
  }
}

await check('EXT-004', 'Every recorded locator resolves to exactly one element in a fresh browser', async () => {
  const fresh = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const freshPage = await (await fresh.newContext()).newPage();
  const rows = [];
  try {
    // A separate session: the recorded locators must work for someone who was not there.
    await freshPage.goto(`${BANK}/login`, { waitUntil: 'domcontentloaded' });
    await freshPage.getByTestId('username').fill(USERNAME);
    await freshPage.getByTestId('password').fill(PASSWORD);
    await freshPage.getByRole('button', { name: 'Sign in' }).click();
    await freshPage.waitForURL('**/dashboard', { timeout: 15_000 });

    for (const step of journey?.steps ?? []) {
      if (!step.target || !step.url) continue;
      await freshPage.goto(step.url, { waitUntil: 'domcontentloaded' });
      const locator = resolveLocator(freshPage, step.target);
      const count = locator ? await locator.count() : -1;
      const expected = typeof step.target.nth === 'number' ? step.target.nth + 1 : 1;
      rows.push({
        order: step.order,
        action: step.action,
        strategy: step.target.strategy,
        value: step.target.value,
        name: step.target.name ?? null,
        url: step.url,
        matched: count,
        ok: count === expected || (typeof step.target.nth === 'number' && count > step.target.nth)
      });
    }
  } finally {
    await fresh.close();
  }
  const path = saveEvidence('evidence/extension/locator-resolution.json', rows);
  const bad = rows.filter(row => !row.ok);
  return {
    pass: rows.length > 0 && bad.length === 0,
    detail: `${rows.length - bad.length} of ${rows.length} recorded locator(s) resolved uniquely`
      + (bad.length ? `; failed: ${bad.map(b => `#${b.order} ${b.strategy}=${b.value} matched ${b.matched}`).join('; ')}` : ''),
    evidence: [path]
  };
});

// ---------------------------------------------------------------------------
// EXT-005  It does not change what it records
// ---------------------------------------------------------------------------
await check('EXT-005', 'The recorder neither alters the page nor swallows the interaction', async () => {
  const clean = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let cleanFingerprint;
  try {
    const cleanPage = await (await clean.newContext()).newPage();
    await cleanPage.goto(`${BANK}/login`, { waitUntil: 'domcontentloaded' });
    cleanFingerprint = await fingerprint(cleanPage);
  } finally {
    await clean.close();
  }

  const identical = cleanFingerprint === recordedFingerprint;
  // The sign-in click must still have signed in: a recorder that consumed the click would
  // have left the browser on /login with a recording that can never be replayed.
  const navigated = urlAfterSignIn.includes('/dashboard');
  const path = saveEvidence('evidence/extension/page-fingerprints.json', {
    note: 'Element skeleton of /login with the recorder attached vs. a browser with no extension.',
    withRecorder: recordedFingerprint.split('\n'),
    withoutExtension: cleanFingerprint.split('\n'),
    identical,
    overlayElementsWhileRecording: overlaysWhileRecording,
    urlAfterSignIn
  });
  return {
    pass: identical && navigated && overlaysWhileRecording === 0,
    detail: `page skeleton ${identical ? 'identical' : 'DIFFERS'} with and without the recorder; `
      + `${overlaysWhileRecording} overlay element(s) while recording; sign-in ${navigated ? 'proceeded' : 'was swallowed'}`,
    evidence: [path]
  };
});

await context.close();
await rm(userDataDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// EXT-006  What the platform stores from the recording
// ---------------------------------------------------------------------------
await check('EXT-006', 'The imported recording is stored with a secret reference, never the password', async () => {
  if (!journey) return { pass: false, detail: 'no journey to import' };
  const tenant = await newTenant('ExtVerify');
  const project = await request('/api/v1/projects', {
    token: tenant.token, method: 'POST',
    body: { name: 'Extension verification', key: `EXTV${Date.now() % 100000}`, description: 'Independent recorder check' }
  });
  if (!project.ok) return { pass: false, detail: `project creation failed: ${project.status} ${project.text.slice(0, 200)}` };

  const bankHost = new URL(BANK);
  const application = await request('/api/v1/applications', {
    token: tenant.token, method: 'POST',
    body: {
      projectId: project.json.id, name: 'Demo bank', baseUrl: BANK,
      description: 'Recorded by the browser extension',
      allowedDomains: bankHost.hostname, authStrategy: 'formLogin', loginUrl: `${BANK}/login`
    }
  });
  if (!application.ok) return { pass: false, detail: `application creation failed: ${application.status} ${application.text.slice(0, 200)}` };

  const imported = await request('/api/v1/journeys/import', {
    token: tenant.token, method: 'POST',
    body: { projectId: project.json.id, applicationId: application.json.id, journey }
  });
  if (!imported.ok) return { pass: false, detail: `import failed: ${imported.status} ${imported.text.slice(0, 300)}` };

  const testCase = await request(`/api/v1/testcases/${imported.json.testCaseId}`, { token: tenant.token });
  const stored = JSON.stringify(testCase.json ?? {});
  const path = saveEvidence('evidence/extension/imported-test-case.json', {
    import: imported.json,
    testCase: testCase.json
  });

  const leaked = stored.includes(PASSWORD);
  const keptEveryStep = imported.json.stepCount === journey.steps.length;
  const hasReference = stored.includes('${secret:');
  return {
    pass: !leaked && keptEveryStep && hasReference && testCase.ok,
    detail: `${imported.json.stepCount} of ${journey.steps.length} step(s) imported as ${imported.json.testCaseReference}; `
      + `password ${leaked ? 'PRESENT in the stored test case' : 'absent'}; `
      + `secret reference ${hasReference ? 'stored' : 'MISSING'}`,
    evidence: [path]
  };
});

await sleep(50);
