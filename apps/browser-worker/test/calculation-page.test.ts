import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { BrowserContext, Page } from 'playwright';
import type { BrowserAction } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { runAction, type ActionContext } from '../src/execution/action-runner.js';
import { readNumbers } from '../src/execution/calculation-oracles.js';
import { Logger } from '../src/util/logger.js';

/**
 * The half of the calculation oracles the pure tests cannot reach: reading a real page.
 *
 * Everything that decides a verdict is a pure function tested without a browser. What is
 * tested here is the step before that — which rows are a table's lines, which is its total,
 * what counts as rendered, where a label and its figure sit — because a snapshot that reads
 * the page wrongly makes correct arithmetic look broken, and that is the failure that would
 * discredit the whole family.
 */
describe('reading a page\'s arithmetic', () => {
  let pool: BrowserPool;
  let context: BrowserContext;
  let page: Page;
  let server: Server;
  let base: string;
  let markup: string;
  const logger = new Logger('error', {}, () => {});

  const actionContext = (): ActionContext => ({
    defaultTimeoutMs: 3000, allowScriptExecution: false, allowedHosts: ['127.0.0.1'],
    allowPrivateNetworks: true, baseUrl: base,
    resolveValue: raw => raw, resolveTemplate: raw => raw
  });

  const run = (action: string) =>
    runAction(page, { description: action, action } as BrowserAction, actionContext());

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><html><body>${markup}</body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    pool = new BrowserPool(true, logger);
  }, 60_000);

  beforeEach(async () => {
    await context?.close().catch(() => undefined);
    context = await pool.createContext('chromium', { defaultTimeoutMs: 3000, navigationTimeoutMs: 15_000 });
    page = await context.newPage();
  });

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close().catch(() => undefined);
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const open = async (html: string) => { markup = html; await page.goto(base); };

  const INVOICE = `
    <h2>Invoice INV-2026-5001</h2>
    <table id="invoice-lines">
      <thead><tr><th>Line</th><th>Amount</th></tr></thead>
      <tbody>
        <tr><td>Freight</td><td>£400.00</td></tr>
        <tr><td>Handling</td><td>£50.00</td></tr>
      </tbody>
      <tfoot><tr><td>Total</td><td>£450.00</td></tr></tfoot>
    </table>`;

  test('reads a table into lines, a total and a header', async () => {
    await open(INVOICE);
    const snapshot = await readNumbers(page);

    const invoice = snapshot.tables.find(table => table.name === 'invoice-lines');
    expect(invoice).toBeDefined();
    expect(invoice!.headers).toEqual(['Line', 'Amount']);
    expect(invoice!.rows).toHaveLength(3);
    expect(invoice!.rows.filter(row => row.inFoot)).toHaveLength(1);
    expect(snapshot.largestTableRows).toBe(2);
  });

  test('passes a table whose total is right', async () => {
    await open(INVOICE);
    await expect(run('assertTotalsAddUp')).resolves.toBeUndefined();
  });

  test('fails a table whose total is wrong, with both figures', async () => {
    await open(INVOICE.replace('£450.00</td></tr></tfoot>', '£500.00</td></tr></tfoot>'));

    await expect(run('assertTotalsAddUp')).rejects.toThrow(/does not equal the lines it totals/);
    await expect(run('assertTotalsAddUp')).rejects.toThrow(/500/);
    await expect(run('assertTotalsAddUp')).rejects.toThrow(/450/);
  });

  test('a row the page is not showing is not one of the lines', async () => {
    // A filtered table's total covers what is rendered. Summing a hidden row would report
    // every filtered table on every page as wrong.
    await open(`
      <table id="t">
        <tbody>
          <tr><td>Freight</td><td>400.00</td></tr>
          <tr style="display:none"><td>Removed</td><td>999.00</td></tr>
          <tr><td>Handling</td><td>50.00</td></tr>
        </tbody>
        <tfoot><tr><td>Total</td><td>450.00</td></tr></tfoot>
      </table>`);

    await expect(run('assertTotalsAddUp')).resolves.toBeUndefined();
  });

  test('says nothing at all about a page with no table', async () => {
    await open('<h1>Preferences</h1><p>Nothing to add up here.</p>');

    await expect(run('assertTotalsAddUp')).resolves.toBeUndefined();
    await expect(run('assertDisplayedCountMatches')).resolves.toBeUndefined();
    await expect(run('assertPercentageLineConsistent')).resolves.toBeUndefined();
  });

  test('catches a count taken before the filter was applied', async () => {
    await open(`
      <h2>42 shipments</h2>
      <table id="shipments"><tbody>
        <tr><td>MF-1</td><td>Exception</td></tr>
        <tr><td>MF-2</td><td>Exception</td></tr>
        <tr><td>MF-3</td><td>Exception</td></tr>
      </tbody></table>`);

    await expect(run('assertDisplayedCountMatches')).rejects.toThrow(/states a count it does not show/);
  });

  test('leaves that same count alone once the page offers further pages', async () => {
    await open(`
      <h2>42 shipments</h2>
      <table id="shipments"><tbody>
        <tr><td>MF-1</td></tr><tr><td>MF-2</td></tr><tr><td>MF-3</td></tr>
      </tbody></table>
      <nav aria-label="pagination"><a href="?page=2">Next</a></nav>`);

    await expect(run('assertDisplayedCountMatches')).resolves.toBeUndefined();
  });

  test('catches a surcharge taken on a total printed below it', async () => {
    // 11.5% of the gross (480.00) rather than of the freight line (400.00). Every figure on
    // the page is internally consistent; only the order gives it away.
    await open(`
      <table id="summary"><tbody>
        <tr><td>Freight</td><td>400.00</td></tr>
        <tr><td>Fuel surcharge (11.5%)</td><td>55.20</td></tr>
        <tr><td>VAT (20%)</td><td>80.00</td></tr>
        <tr><td>Gross</td><td>480.00</td></tr>
      </tbody></table>`);

    await expect(run('assertPercentageLineConsistent'))
      .rejects.toThrow(/does not derive from a figure above it/);
    await expect(run('assertPercentageLineConsistent')).rejects.toThrow(/Gross/);
  });

  test('passes the same page once the surcharge is taken on the net', async () => {
    await open(`
      <table id="summary"><tbody>
        <tr><td>Freight</td><td>400.00</td></tr>
        <tr><td>Fuel surcharge (11.5%)</td><td>46.00</td></tr>
        <tr><td>VAT (20%)</td><td>89.20</td></tr>
        <tr><td>Gross</td><td>535.20</td></tr>
      </tbody></table>`);

    await expect(run('assertPercentageLineConsistent')).resolves.toBeUndefined();
  });

  test('reads a definition list as label and figure', async () => {
    await open(`
      <dl><dt>Net</dt><dd>1000.00</dd><dt>Duty (3.7%)</dt><dd>55.00</dd></dl>`);

    await expect(run('assertPercentageLineConsistent')).rejects.toThrow(/not 3.7% of anything/);
  });
});
