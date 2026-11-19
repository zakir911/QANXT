import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserAction } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { runAction, type ActionContext } from '../src/execution/action-runner.js';
import { Logger } from '../src/util/logger.js';

/**
 * Information carried by colour alone.
 *
 * axe-core does not report this, and that is not an oversight on its part: it checks that
 * colours contrast well enough, which is a different question from whether a colour is the
 * only thing saying what a row is. A fleet table whose status column is a green, amber or
 * red square passes every contrast rule and tells about one man in twelve nothing at all.
 *
 * The rule that makes this usable is variation down a column. One colour is decoration —
 * a bullet, a rule, a spacer — and flagging it would bury the findings that matter. Two or
 * more colours in the same text-free column is data. These tests hold both halves, because
 * an accessibility check that cries wolf is one a team switches off in a fortnight.
 *
 * The first case is the freight lab's FP_D23 markup verbatim.
 */
describe('information carried by colour alone', () => {
  let pool: BrowserPool;
  let context: BrowserContext;
  let page: Page;
  const logger = new Logger('error', {}, () => {});

  const actionContext = (): ActionContext => ({
    defaultTimeoutMs: 3000, allowScriptExecution: false, allowedHosts: ['127.0.0.1'],
    allowPrivateNetworks: true, baseUrl: 'http://127.0.0.1',
    resolveValue: raw => raw, resolveTemplate: raw => raw
  });

  const check = () =>
    runAction(page, { description: 'colour only', action: 'assertNotColourOnly' } as BrowserAction,
      actionContext());

  /** The lab's own status mark: a coloured square, no text, no accessible name. */
  const square = (colour: string) =>
    `<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${colour}"></span>`;

  beforeAll(async () => { pool = new BrowserPool(true, logger); }, 60_000);

  beforeEach(async () => {
    await context?.close().catch(() => undefined);
    context = await pool.createContext('chromium', { defaultTimeoutMs: 3000, navigationTimeoutMs: 15_000 });
    page = await context.newPage();
  });

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close().catch(() => undefined);
  });

  test('reports a status column that is only ever a coloured square', async () => {
    await page.setContent(`<table>
      <thead><tr><th>Registration</th><th>Status</th></tr></thead>
      <tbody>
        <tr><td>AB12 CDE</td><td>${square('#0f7a52')}</td></tr>
        <tr><td>FG34 HIJ</td><td>${square('#9a6508')}</td></tr>
        <tr><td>KL56 MNO</td><td>${square('#b32020')}</td></tr>
      </tbody></table>`);

    await expect(check()).rejects.toThrow(/Information is carried by colour alone/);
    await expect(check()).rejects.toThrow(/column 2 \("Status"\)/);
    await expect(check()).rejects.toThrow(/3 colours/);
  });

  test('says how to fix it, not just that it is wrong', async () => {
    await page.setContent(`<table><tbody>
      <tr><td>a</td><td>${square('#0f7a52')}</td></tr>
      <tr><td>b</td><td>${square('#b32020')}</td></tr>
    </tbody></table>`);

    await expect(check()).rejects.toThrow(/Add text, an aria-label, a title or visually-hidden content/);
  });

  test('accepts the same column once each mark carries a label', async () => {
    await page.setContent(`<table><tbody>
      <tr><td>a</td><td><span aria-label="Available" style="background:#0f7a52;width:14px;height:14px;display:inline-block"></span></td></tr>
      <tr><td>b</td><td><span aria-label="Off road" style="background:#b32020;width:14px;height:14px;display:inline-block"></span></td></tr>
    </tbody></table>`);

    await check();
  });

  test('accepts a mark that sits beside the word it means', async () => {
    // The ordinary status pill, which is what the lab renders when the defect is off.
    await page.setContent(`<table><tbody>
      <tr><td>a</td><td><span style="background:#0f7a52">Available</span></td></tr>
      <tr><td>b</td><td><span style="background:#b32020">Off road</span></td></tr>
    </tbody></table>`);

    await check();
  });

  test('accepts a title attribute as the label', async () => {
    await page.setContent(`<table><tbody>
      <tr><td>a</td><td><span title="Available" style="background:#0f7a52;width:14px;height:14px;display:inline-block"></span></td></tr>
      <tr><td>b</td><td><span title="Off road" style="background:#b32020;width:14px;height:14px;display:inline-block"></span></td></tr>
    </tbody></table>`);

    await check();
  });

  test('does not report a column whose marks are all the same colour', async () => {
    // One colour is decoration: a bullet, a rule, a spacer. Reporting it would bury the
    // findings that matter, and an accessibility check that cries wolf gets switched off.
    await page.setContent(`<table><tbody>
      <tr><td>a</td><td>${square('#0f7a52')}</td></tr>
      <tr><td>b</td><td>${square('#0f7a52')}</td></tr>
      <tr><td>c</td><td>${square('#0f7a52')}</td></tr>
    </tbody></table>`);

    await check();
  });

  test('does not report genuinely empty cells', async () => {
    await page.setContent(`<table><tbody>
      <tr><td>a</td><td></td></tr>
      <tr><td>b</td><td></td></tr>
    </tbody></table>`);

    await check();
  });

  test('does not report an ordinary table of text', async () => {
    await page.setContent(`<table>
      <thead><tr><th>Registration</th><th>Status</th></tr></thead>
      <tbody>
        <tr><td>AB12 CDE</td><td>Available</td></tr>
        <tr><td>FG34 HIJ</td><td>In maintenance</td></tr>
      </tbody></table>`);

    await check();
  });

  test('accepts an icon that carries its meaning in an SVG title', async () => {
    await page.setContent(`<table><tbody>
      <tr><td>a</td><td><svg style="background:#0f7a52" width="14" height="14"><title>Available</title></svg></td></tr>
      <tr><td>b</td><td><svg style="background:#b32020" width="14" height="14"><title>Off road</title></svg></td></tr>
    </tbody></table>`);

    await check();
  });

  test('names each offending column when a page has more than one', async () => {
    await page.setContent(`<table id="fleet"><tbody>
      <tr><td>a</td><td>${square('#0f7a52')}</td><td>${square('#111111')}</td></tr>
      <tr><td>b</td><td>${square('#b32020')}</td><td>${square('#eeeeee')}</td></tr>
    </tbody></table>`);

    await expect(check()).rejects.toThrow(/column 2/);
    await expect(check()).rejects.toThrow(/column 3/);
    await expect(check()).rejects.toThrow(/fleet/);
  });
});
