import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserAction, LocatorDescriptor } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { runAction, type ActionContext } from '../src/execution/action-runner.js';
import { Logger } from '../src/util/logger.js';

/**
 * What a failing `select` step says.
 *
 * Playwright waits the whole timeout for an option that is never going to arrive and then
 * reports only that it waited. A run against a 152-page application produced 29 such
 * failures; from the message alone a missing option, an empty dependent select and a
 * disabled control are the same event, and none of them is distinguishable from a slow
 * page. These tests hold each cause to a message that names it, against a real browser —
 * a diagnosis that has only been reasoned about has not been shown to be true.
 */
describe('a select step that cannot be satisfied says why', () => {
  let pool: BrowserPool;
  let context: BrowserContext;
  let page: Page;
  const logger = new Logger('error', {}, () => {});

  const css = (value: string): LocatorDescriptor => ({ strategy: 'css', value });

  const actionContext = (): ActionContext => ({
    defaultTimeoutMs: 1500, allowScriptExecution: false, allowedHosts: ['127.0.0.1'],
    allowPrivateNetworks: true, baseUrl: 'http://127.0.0.1',
    resolveValue: raw => raw, resolveTemplate: raw => raw
  });

  const selectOn = (target: string, value: string) =>
    runAction(
      page,
      { description: 'select', action: 'select', target: css(target), value } as BrowserAction,
      actionContext()
    );

  const select = (value: string) => selectOn('select', value);

  beforeAll(async () => { pool = new BrowserPool(true, logger); }, 60_000);

  beforeEach(async () => {
    await context?.close().catch(() => undefined);
    context = await pool.createContext('chromium', { defaultTimeoutMs: 1500, navigationTimeoutMs: 15_000 });
    page = await context.newPage();
  });

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close().catch(() => undefined);
  });

  test('names the options the select actually offers', async () => {
    await page.setContent(`
      <select name="site">
        <option value="">Choose a site</option>
        <option value="wh-ams">Amsterdam</option>
        <option value="wh-rtm">Rotterdam</option>
      </select>`);

    await expect(select('wh-fxt')).rejects.toThrow(
      /cannot select "wh-fxt" because that option is not offered\. The select has 2 option\(s\)/
    );
    await expect(select('wh-fxt')).rejects.toThrow(/"wh-ams" \(Amsterdam\)/);
    await expect(select('wh-fxt')).rejects.toThrow(/"wh-rtm" \(Rotterdam\)/);
  });

  test('reaches no conclusion when the select is populated without the wanted value', async () => {
    // The contended-data shape: the plan names a record another test in the same run has
    // acted on. Measured on the freight lab as 59 of 971 reported failures, every one
    // filed against the application. The engine cannot tell that from the application
    // losing an option, and only one of the two readings is a fact: this test did not run.
    await page.setContent(`
      <select name="invoice">
        <option value="">Choose an invoice</option>
        <option value="inv-0043">INV-0043</option>
      </select>`);

    const error = await select('inv-0042').then(() => null, (thrown: unknown) => thrown);

    expect((error as Error).name).toBe('InconclusiveError');
    expect((error as Error).message).toMatch(/a record another test in this run acted on/);
  });

  test('an empty select is still a failure, whoever emptied it', async () => {
    // The counterpart. A required select with nothing in it is a problem to report, and
    // softening the case above must not soften this one with it.
    await page.setContent(`
      <select name="toSite"><option value="">Choose an origin first</option></select>`);

    const error = await select('wh-rtm').then(() => null, (thrown: unknown) => thrown);

    expect((error as Error).name).not.toBe('InconclusiveError');
    expect((error as Error).message).toMatch(/no selectable options/);
  });

  test('calls an empty select empty, and points at the field it depends on', async () => {
    // The dependent-dropdown shape: "To site" carries only its placeholder until a
    // "From site" is chosen. Waiting 30s and reporting a timeout hides that entirely.
    await page.setContent(`
      <select name="toSite"><option value="">Choose an origin first</option></select>`);

    await expect(select('wh-rtm')).rejects.toThrow(
      /the select has no selectable options/
    );
    await expect(select('wh-rtm')).rejects.toThrow(/Choose an origin first/);
    await expect(select('wh-rtm')).rejects.toThrow(/populated by another field/);
  });

  test('calls a disabled select disabled rather than slow', async () => {
    await page.setContent(`
      <select name="site" disabled>
        <option value="wh-ams">Amsterdam</option>
      </select>`);

    await expect(select('wh-ams')).rejects.toThrow(/the select is disabled/);
  });

  test('says so when the target is not a select at all', async () => {
    // The locator has to resolve for this branch to be reached: pointing at `select` on a
    // page without one is the resolver's business, and its own message is the better one.
    await page.setContent(`<input name="site" value="" />`);

    await expect(selectOn('input', 'wh-ams')).rejects.toThrow(/the target is not a <select>/);
  });

  test('still selects normally when the option is there', async () => {
    await page.setContent(`
      <select name="site">
        <option value="">Choose a site</option>
        <option value="wh-ams">Amsterdam</option>
      </select>`);

    await select('wh-ams');

    expect(await page.locator('select').inputValue()).toBe('wh-ams');
  });

  test('matches an option by its visible label as well as its value', async () => {
    // Playwright accepts a label; the diagnosis must not claim a present option is absent.
    await page.setContent(`
      <select name="site">
        <option value="">Choose a site</option>
        <option value="wh-ams">Amsterdam</option>
      </select>`);

    await select('Amsterdam');

    expect(await page.locator('select').inputValue()).toBe('wh-ams');
  });
});
