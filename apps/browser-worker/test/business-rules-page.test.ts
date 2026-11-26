import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { BrowserContext, Page } from 'playwright';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { Logger } from '../src/util/logger.js';
import { namedValuesFrom, normaliseName, readNamedValues } from '../src/execution/business-rules-page.js';
import { InconclusiveError, OracleError } from '../src/execution/form-oracles.js';
import { checkRule, parseRules } from '../src/execution/business-rules.js';
import { assertBusinessRule } from '../src/execution/business-rules-page.js';

/**
 * Joining a rule's field names to the figures on a screen.
 *
 * This is where a tool like this usually starts lying. Match too loosely and a rule about the
 * order total is checked against the line total: a false defect report with arithmetic attached
 * and no way for the reader to tell it is wrong. So the join is narrow, and the two things
 * these tests exist to hold are that it does not reach across a name boundary, and that where
 * the page offers one name twice with different figures it refuses rather than picks.
 */

describe('the name matching rule', () => {
  test('letters and digits only, folded', () => {
    expect(normaliseName('Fuel surcharge')).toBe('fuelsurcharge');
    expect(normaliseName('fuel_surcharge')).toBe('fuelsurcharge');
    expect(normaliseName('FUEL-SURCHARGE')).toBe('fuelsurcharge');
    expect(normaliseName('fuelSurcharge')).toBe('fuelsurcharge');
  });

  test('a shorter name is not the same name', () => {
    // The whole risk: 'surcharge' must not match 'Fuel surcharge'.
    expect(normaliseName('surcharge')).not.toBe(normaliseName('Fuel surcharge'));
  });

  test('currency and punctuation in a label do not carry into the name', () => {
    expect(normaliseName('Total (£)')).toBe('total');
    expect(normaliseName('Net amount:')).toBe('netamount');
  });

  test('an empty or symbol-only label normalises to nothing and is dropped', () => {
    expect(normaliseName('—')).toBe('');
    expect(namedValuesFrom([{ name: '—', text: '5', from: 'label' }]).values.size).toBe(0);
  });
});

describe('turning what the page offered into values', () => {
  test('a figure under a label', () => {
    const { values } = namedValuesFrom([{ name: 'Fuel surcharge', text: '£93.50', from: 'label' }]);
    expect(values.get('fuelsurcharge')).toBe(93.5);
  });

  test('a name the page offers twice with the same figure is kept', () => {
    const { values, ambiguous } = namedValuesFrom([
      { name: 'Total', text: '£450.00', from: 'label' },
      { name: 'total', text: '450', from: 'attribute' }
    ]);
    expect(values.get('total')).toBe(450);
    expect(ambiguous).toEqual([]);
  });

  test('a name the page offers twice with different figures is DROPPED, not guessed', () => {
    const { values, ambiguous } = namedValuesFrom([
      { name: 'Total', text: '£450.00', from: 'label' },
      { name: 'total', text: '£1,200.00', from: 'attribute' }
    ]);
    expect(values.has('total')).toBe(false);
    expect(ambiguous).toEqual(['total']);
  });

  test('a dropped name makes its rule could-not-tell, which is the point', () => {
    const { values } = namedValuesFrom([
      { name: 'total', text: '450', from: 'label' },
      { name: 'total', text: '1200', from: 'label' },
      { name: 'net', text: '400', from: 'label' }
    ]);
    const { rules } = parseRules('rule R\n on /a\n expect total >= net\n');
    const outcome = checkRule(rules[0]!, values);
    expect(outcome.outcome).toBe('cannotTell');
    if (outcome.outcome === 'cannotTell') expect(outcome.missing).toEqual(['total']);
  });

  test('a figure readNumber refuses is not a value', () => {
    // '12 of 30', 'n/a' and percentages are already refused there; this inherits it.
    const { values } = namedValuesFrom([
      { name: 'shown', text: '12 of 30', from: 'label' },
      { name: 'status', text: 'n/a', from: 'label' },
      { name: 'margin', text: '14%', from: 'label' }
    ]);
    expect(values.size).toBe(0);
  });

  test('an accounting negative in brackets reads as negative', () => {
    const { values } = namedValuesFrom([{ name: 'adjustment', text: '(£50.00)', from: 'label' }]);
    expect(values.get('adjustment')).toBe(-50);
  });

  test('where a value came from is kept, for the evidence line', () => {
    const { sources } = namedValuesFrom([{ name: 'duty', text: '55', from: 'attribute' }]);
    expect(sources.get('duty')).toBe('attribute');
  });
});

describe('reading the values off a real page', () => {
  let pool: BrowserPool;
  let context: BrowserContext;
  let page: Page;
  let server: Server;
  let base: string;
  let markup = '';
  const logger = new Logger('error', {}, () => {});

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
  const valuesOn = async () => namedValuesFrom(await readNamedValues(page)).values;

  test('an invoice summary table, which is how the real screen prints it', async () => {
    await open(`
      <table id="summary">
        <tbody>
          <tr><td>Net amount</td><td>£1,100.00</td></tr>
          <tr><td>Fuel surcharge</td><td>£93.50</td></tr>
          <tr><td>VAT</td><td>£238.70</td></tr>
        </tbody>
      </table>`);
    const values = await valuesOn();
    expect(values.get('netamount')).toBe(1100);
    expect(values.get('fuelsurcharge')).toBe(93.5);
  });

  test('the surcharge-on-gross defect is caught end to end from the markup', async () => {
    // Freight's FP_D06: 8.5% applied to the gross rather than the net.
    await open(`
      <dl>
        <dt>Net amount</dt><dd>£1,000.00</dd>
        <dt>Gross amount</dt><dd>£1,100.00</dd>
        <dt>Fuel surcharge</dt><dd>£93.50</dd>
      </dl>`);
    const { rules, problems } = parseRules(`
rule SURCHARGE_ON_NET
  on /billing/invoices/new
  means The fuel surcharge applies to the net amount, not the gross.
  expect fuelSurcharge == netAmount * 0.085
  within 0.01
`);
    expect(problems).toEqual([]);
    const outcome = checkRule(rules[0]!, await valuesOn());
    expect(outcome.outcome).toBe('broken');
    if (outcome.outcome !== 'broken') return;
    expect(outcome.by).toBe(8.5);
    expect(outcome.detail).toContain('not the gross');
  });

  test('the same rule holds when the application computes it correctly', async () => {
    await open('<dl><dt>Net amount</dt><dd>£1,000.00</dd><dt>Fuel surcharge</dt><dd>£85.00</dd></dl>');
    const { rules } = parseRules(
      'rule R\n on /a\n expect fuelSurcharge == netAmount * 0.085\n');
    expect((await valuesOn()).get('fuelsurcharge')).toBe(85);
    expect(checkRule(rules[0]!, await valuesOn()).outcome).toBe('held');
  });

  test('a form the user is filling in, read by field name', async () => {
    await open(`
      <form>
        <input name="orderTotal" value="9000">
        <input name="creditLimit" value="5000">
      </form>`);
    const { rules } = parseRules('rule R\n on /a\n expect orderTotal <= creditLimit\n');
    expect(checkRule(rules[0]!, await valuesOn()).outcome).toBe('broken');
  });

  test('a figure the application marks with data-field', async () => {
    await open('<span data-field="duty">55.00</span><span data-field="goods">1000</span>');
    const values = await valuesOn();
    expect(values.get('duty')).toBe(55);
    expect(values.get('goods')).toBe(1000);
  });

  test('a label points at its input, so a rule can use the words on screen', async () => {
    await open('<label for="w">Chargeable weight</label><input id="w" value="500">');
    const values = await valuesOn();
    expect(values.get('chargeableweight')).toBe(500);
  });

  test('a password field is never read, whatever it is named', async () => {
    await open('<input name="pin" type="password" value="4321">');
    expect((await valuesOn()).has('pin')).toBe(false);
  });

  test('a hidden input is not a figure the screen shows', async () => {
    await open('<input name="secretTotal" type="hidden" value="999">');
    expect((await valuesOn()).has('secrettotal')).toBe(false);
  });

  test('a figure in a row the page does not render is not on the screen', async () => {
    await open(`
      <table><tbody>
        <tr><td>Total</td><td>£100.00</td></tr>
        <tr style="display:none"><td>Total</td><td>£999.00</td></tr>
      </tbody></table>`);
    // The hidden row would have made 'total' ambiguous and lost the rule. It is not rendered,
    // so it is not part of the page's claim.
    expect((await valuesOn()).get('total')).toBe(100);
  });

  test('a figure a script wrote into the page counts, because the user sees it', async () => {
    await open(`
      <span data-field="duty">0</span>
      <script>document.querySelector('[data-field=duty]').textContent = '55.00';</script>`);
    expect((await valuesOn()).get('duty')).toBe(55);
  });

  test('a screen with no figures at all yields nothing, and rules say so', async () => {
    await open('<h1>Nothing here</h1><p>No shipments match.</p>');
    const { rules } = parseRules('rule R\n on /a\n expect duty == goods * 0.05\n');
    const outcome = checkRule(rules[0]!, await valuesOn());
    expect(outcome.outcome).toBe('cannotTell');
    if (outcome.outcome === 'cannotTell') expect(outcome.missing).toEqual(['duty', 'goods']);
  });
}, 120_000);

describe('the oracle: which verdict each outcome becomes', () => {
  let pool: BrowserPool;
  let context: BrowserContext;
  let page: Page;
  let server: Server;
  let base: string;
  let markup = '';
  const logger = new Logger('error', {}, () => {});

  beforeAll(async () => {
    server = createServer((request, response) => {
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

  /** Opens the markup at a path, so a rule's `on` line has something real to match. */
  const openAt = async (path: string, html: string) => { markup = html; await page.goto(base + path); };

  /**
   * Runs the oracle and returns what it threw.
   *
   * `.catch(callback)` would make every one of these tests pass when the oracle wrongly
   * returned: the callback simply would not run. A test that passes because nothing happened
   * is the exact failure this product exists to catch.
   */
  const refusalOf = async (rule: string | undefined): Promise<Error> => {
    try {
      await assertBusinessRule(page, rule);
    } catch (error) {
      return error as Error;
    }
    throw new Error('the oracle returned where it was expected to refuse');
  };

  const RULE = (screen: string) => `
rule SURCHARGE_ON_NET
  on      ${screen}
  means   The fuel surcharge applies to the net amount, not the gross.
  expect  fuelSurcharge == netAmount * 0.085
  within  0.01
`;

  const INVOICE = (surcharge: string) =>
    `<dl><dt>Net amount</dt><dd>£1,000.00</dd><dt>Fuel surcharge</dt><dd>${surcharge}</dd></dl>`;

  test('a rule that holds passes, and throws nothing', async () => {
    await openAt('/billing/invoices/new', INVOICE('£85.00'));
    await expect(assertBusinessRule(page, RULE('/billing/invoices/new'))).resolves.toBeUndefined();
  });

  test('the helper these tests lean on fails when the oracle does not refuse', async () => {
    // Every refusal test below is only worth anything if a passing oracle makes it fail. The
    // pattern it replaced — .catch(callback) — passed silently in exactly that case, because
    // the callback never ran.
    await openAt('/billing/invoices/new', INVOICE('£85.00'));
    await expect(refusalOf(RULE('/billing/invoices/new')))
      .rejects.toThrow('the oracle returned where it was expected to refuse');
  });

  test('a rule that is broken fails, with the owner\'s words and the arithmetic', async () => {
    await openAt('/billing/invoices/new', INVOICE('£93.50'));
    const error = await refusalOf(RULE('/billing/invoices/new'));
    expect(error).toBeInstanceOf(OracleError);
    expect(error.message).toContain('not the gross');
    expect(error.message).toContain('out by 8.5');
  });

  test('a field the screen does not show is inconclusive, never a pass', async () => {
    // The house rule: a pass means the expected behaviour was observed. Nothing was observed
    // here, so the step is reported skipped with the reason.
    await openAt('/billing/invoices/new', '<dl><dt>Fuel surcharge</dt><dd>£93.50</dd></dl>');
    const error = await refusalOf(RULE('/billing/invoices/new'));
    expect(error).toBeInstanceOf(InconclusiveError);
    expect(error.message).toContain("'netAmount'");
    expect(error.message).toContain('not a rule that passed');
  });

  test('a rule written for another screen is not checked against this one', async () => {
    // The designer matches rules to pages, so this should not happen. If it ever does — a rule
    // edited after a suite was generated, a redirect landing elsewhere — say so rather than
    // check an invoice rule against a driver record and report whatever turns up.
    await openAt('/fleet/drivers', INVOICE('£93.50'));
    const error = await refusalOf(RULE('/billing/invoices/new'));
    expect(error).toBeInstanceOf(InconclusiveError);
    expect(error.message).toContain('is about /billing/invoices/new');
    expect(error.message).toContain('/fleet/drivers');
  });

  test('a rule that cannot be read is inconclusive and names the line', async () => {
    await openAt('/a', INVOICE('£85.00'));
    const error = await refusalOf('rule BAD\n  on /a\n  expect net +\n');
    expect(error).toBeInstanceOf(InconclusiveError);
    expect(error.message).toContain('line 3');
  });

  test('a step carrying no rule at all is inconclusive, not a pass', async () => {
    await openAt('/a', INVOICE('£85.00'));
    expect(await refusalOf(undefined)).toBeInstanceOf(InconclusiveError);
    expect((await refusalOf(undefined)).message).toContain('carried no rule');
    expect(await refusalOf('   ')).toBeInstanceOf(InconclusiveError);
  });

  test('a name the screen shows twice with two figures is explained, not guessed', async () => {
    await openAt('/billing/invoices/new', `
      <dl><dt>Net amount</dt><dd>£1,000.00</dd><dt>Fuel surcharge</dt><dd>£85.00</dd></dl>
      <span data-field="fuel surcharge">93.50</span>`);
    const error = await refusalOf(RULE('/billing/invoices/new'));
    expect(error).toBeInstanceOf(InconclusiveError);
    expect(error.message).toContain('more than once');
    expect(error.message).toContain('two places disagreeing is not a value');
  });

  test('a route template in the rule reaches the instance the run is on', async () => {
    await openAt('/billing/credit-notes/cn-0004',
      '<dl><dt>Credit amount</dt><dd>£1,500.00</dd><dt>Invoice total</dt><dd>£1,200.00</dd></dl>');
    const error = await refusalOf(`
rule CREDIT_NOTE_CAP
  on      /billing/credit-notes/{id}
  means   A credit note can never exceed the invoice it credits.
  expect  creditAmount <= invoiceTotal
`);
    expect(error).toBeInstanceOf(OracleError);
    expect(error.message).toContain('out by 300');
  });
}, 120_000);

describe('the submission rule, against a server that answers', () => {
  let pool: BrowserPool;
  let context: BrowserContext;
  let page: Page;
  let server: Server;
  let base: string;
  let markup = '';
  /** How the stub answers the next POST, set per test. */
  let answer: { status: number; body?: string; location?: string } = { status: 200 };
  let received: Record<string, string> = {};
  const logger = new Logger('error', {}, () => {});

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === 'POST') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          received = Object.fromEntries(new URLSearchParams(body));
          const headers: Record<string, string> = { 'content-type': 'text/html' };
          if (answer.location !== undefined) headers.location = answer.location;
          response.writeHead(answer.status, headers);
          response.end(answer.body ?? '');
        });
        return;
      }
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
    received = {};
  });

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close().catch(() => undefined);
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const openAt = async (path: string, html: string) => { markup = html; await page.goto(base + path); };

  const refusalOf = async (rule: string): Promise<Error> => {
    try {
      await assertBusinessRule(page, rule);
    } catch (error) {
      return error as Error;
    }
    throw new Error('the oracle returned where it was expected to refuse');
  };

  const CAP = `
rule CREDIT_NOTE_CAP
  on      /billing/credit-notes/new
  means   A credit note can never be raised for more than the invoice it credits.
  submit  amount = 50000
  expect  refused
`;

  const FORM = `
    <form method="post" action="/billing/credit-notes/new">
      <input name="invoice" value="INV-2026-5000">
      <input name="amount" type="number" value="400" max="400">
      <button type="submit">Raise</button>
    </form>`;

  test('a server that refuses passes the rule', async () => {
    await openAt('/billing/credit-notes/new', FORM);
    answer = { status: 422, body: 'Amount exceeds the invoice total' };
    await expect(assertBusinessRule(page, CAP)).resolves.toBeUndefined();
  });

  test('the forced value is what reaches the server, over the form\'s own', async () => {
    await openAt('/billing/credit-notes/new', FORM);
    answer = { status: 422 };
    await assertBusinessRule(page, CAP);
    expect(received.amount).toBe('50000');
    // The rest of the form travels as the application would send it.
    expect(received.invoice).toBe('INV-2026-5000');
  });

  test('a server that accepts fails the rule — this is FP_D05 and FP_D09\'s shape', async () => {
    await openAt('/billing/credit-notes/new', FORM);
    answer = { status: 302, location: '/billing/credit-notes/cn-0009' };
    const error = await refusalOf(CAP);
    expect(error).toBeInstanceOf(OracleError);
    expect(error.message).toContain('never be raised for more than');
    expect(error.message).toContain('amount=50000');
    expect(error.message).toContain('accepted where the rule says it must be refused');
  });

  test('a 200 carrying the form and a complaint is a refusal, not an acceptance', async () => {
    // Plenty of applications answer an invalid form with 200 and the form again.
    await openAt('/billing/credit-notes/new', FORM);
    answer = { status: 200, body: '<div role="alert">Amount exceeds the invoice total</div>' };
    await expect(assertBusinessRule(page, CAP)).resolves.toBeUndefined();
  });

  test('a 302 back to the form it was posted to is a refusal', async () => {
    await openAt('/billing/credit-notes/new', FORM);
    answer = { status: 302, location: '/billing/credit-notes/new' };
    await expect(assertBusinessRule(page, CAP)).resolves.toBeUndefined();
  });

  test('a 500 is neither verdict, and says so', async () => {
    await openAt('/billing/credit-notes/new', FORM);
    answer = { status: 500, body: 'TypeError: cannot read property of undefined' };
    const error = await refusalOf(CAP);
    expect(error).toBeInstanceOf(OracleError);
    expect(error.message).toContain('fail rather than decide');
  });

  test('`expect accepted` is checked in the other direction', async () => {
    const ALLOWED = `
rule SMALL_CREDIT_NOTE_GOES_THROUGH
  on      /billing/credit-notes/new
  means   A credit note within the invoice total is accepted.
  submit  amount = 100
  expect  accepted
`;
    await openAt('/billing/credit-notes/new', FORM);
    answer = { status: 302, location: '/billing/credit-notes/cn-0010' };
    await expect(assertBusinessRule(page, ALLOWED)).resolves.toBeUndefined();

    answer = { status: 422, body: 'Rejected' };
    const error = await refusalOf(ALLOWED);
    expect(error.message).toContain('refused where the rule says it must be accepted');
  });

  test('no form carrying the named field is inconclusive, naming what the screen has', async () => {
    await openAt('/billing/credit-notes/new',
      '<form method="post" action="/x"><input name="query"></form>');
    const error = await refusalOf(CAP);
    expect(error).toBeInstanceOf(InconclusiveError);
    expect(error.message).toContain("'amount'");
    expect(error.message).toContain("'query'");
  });

  test('a screen with no form at all is inconclusive, not a failure', async () => {
    await openAt('/billing/credit-notes/new', '<h1>Nothing to raise</h1>');
    const error = await refusalOf(CAP);
    expect(error).toBeInstanceOf(InconclusiveError);
    expect(error.message).toContain('none at all');
  });

  test('two forms carrying the field is inconclusive rather than a coin toss', async () => {
    // Sending to the wrong one would be refused for the wrong reason, which reads exactly like
    // the rule being enforced.
    await openAt('/billing/credit-notes/new', `
      <form method="post" action="/a"><input name="amount" value="1"></form>
      <form method="post" action="/b"><input name="amount" value="2"></form>`);
    const error = await refusalOf(CAP);
    expect(error).toBeInstanceOf(InconclusiveError);
    expect(error.message).toContain('2 forms');
    expect(error.message).toContain('refused for the wrong');
  });

  test('the form holding the named field is used, not the first form on the page', async () => {
    // A search box above the form that matters is the ordinary case, and submitting it instead
    // would produce a confident wrong answer.
    await openAt('/billing/credit-notes/new', `
      <form method="get" action="/search"><input name="query"></form>
      ${FORM}`);
    answer = { status: 422 };
    await assertBusinessRule(page, CAP);
    expect(received.amount).toBe('50000');
    expect(received.invoice).toBe('INV-2026-5000');
  });

  test('a field named as the screen spells it still reaches the form\'s own name', async () => {
    await openAt('/billing/credit-notes/new',
      '<form method="post" action="/x"><input name="creditAmount" value="400"></form>');
    answer = { status: 422 };
    await assertBusinessRule(page, `
rule R
  on      /billing/credit-notes/new
  means   A credit note is capped.
  submit  credit_amount = 50000
  expect  refused
`);
    // The form is found by the folded name, so the override has to land on the folded name too.
    // Keyed by the exact string instead, the field keeps its own value and an extra key rides
    // along — the submission goes out looking right and carrying nothing the rule asked for.
    expect(received).toEqual({ creditAmount: '50000' });
  });

  test('a submission rule written for another screen is not sent anywhere', async () => {
    await openAt('/fleet/drivers', FORM);
    const error = await refusalOf(CAP);
    expect(error).toBeInstanceOf(InconclusiveError);
    expect(error.message).toContain('is about /billing/credit-notes/new');
    expect(received).toEqual({});
  });
}, 120_000);
