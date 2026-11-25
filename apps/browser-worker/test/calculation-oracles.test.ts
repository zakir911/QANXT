import { describe, expect, it } from 'vitest';
import {
  findCountMismatches, findPercentageProblems, findTotalMismatches, readNumber
} from '../src/execution/calculation-oracles.js';
import type { NumbersSnapshot, TableSnapshot } from '../src/execution/calculation-oracles.js';

const row = (...cells: string[]) => ({ cells, inFoot: false });
const foot = (...cells: string[]) => ({ cells, inFoot: true });

const table = (rows: Array<{ cells: string[]; inFoot: boolean }>, headers: string[] = []): TableSnapshot =>
  ({ name: 'invoice-lines', headers, rows });

describe('reading a figure off a page', () => {
  it('reads the shapes an application actually prints', () => {
    expect(readNumber('1,234.56')).toBe(1234.56);
    expect(readNumber('£1,234.56')).toBe(1234.56);
    expect(readNumber('  420 ')).toBe(420);
    expect(readNumber('0.00')).toBe(0);
    expect(readNumber('1 234,56')).toBe(1234.56);     // fr-FR
    expect(readNumber('1.234,56')).toBe(1234.56);     // de-DE
    expect(readNumber('USD 99.95')).toBe(99.95);
    expect(readNumber('99.95 GBP')).toBe(99.95);
  });

  it('reads an accounting negative as a negative', () => {
    expect(readNumber('(1,234.56)')).toBe(-1234.56);
    expect(readNumber('-400')).toBe(-400);
    expect(readNumber('−400')).toBe(-400);       // the real minus sign
  });

  it('refuses anything it cannot account for in full', () => {
    // Each of these read as a number under a looser parser, and each would have made the
    // oracle sum a column it had no business summing.
    expect(readNumber('12 of 30')).toBeNull();
    expect(readNumber('n/a')).toBeNull();
    expect(readNumber('')).toBeNull();
    expect(readNumber('—')).toBeNull();
    expect(readNumber('11.5%')).toBeNull();
    expect(readNumber('2026-04-10')).toBeNull();
    expect(readNumber('INV-2026-5001')).toBeNull();
    expect(readNumber('1,234.56 and 2,000')).toBeNull();
    expect(readNumber(undefined)).toBeNull();
  });

  it('does not read a thousands group as a decimal', () => {
    // "1,234" is one thousand two hundred and thirty-four, not 1.234. Getting this wrong
    // would make almost every total on almost every page look wrong.
    expect(readNumber('1,234')).toBe(1234);
    expect(readNumber('1.234')).toBe(1234);
    expect(readNumber('12,345,678')).toBe(12345678);
  });

  it('reads a fraction of a unit as a fraction, which a thousands group can never be', () => {
    // The one case where three digits after a lone separator cannot be a thousands group:
    // nothing writes seven hundred and fifty as "0.750".
    expect(readNumber('0.750')).toBe(0.75);
    expect(readNumber('0,750')).toBe(0.75);
    expect(readNumber('1.2345')).toBe(1.2345);
  });
});

describe('a total that does not equal its lines', () => {
  it('reports a total that is out', () => {
    const mismatches = findTotalMismatches([table([
      row('Freight', '400.00'), row('Handling', '50.00'), foot('Total', '500.00')
    ], ['Line', 'Amount'])]);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.stated).toBe(500);
    expect(mismatches[0]!.summed).toBe(450);
    expect(mismatches[0]!.column).toBe('Amount');
  });

  it('says nothing when the total is right', () => {
    expect(findTotalMismatches([table([
      row('Freight', '400.00'), row('Handling', '50.00'), foot('Total', '450.00')
    ])])).toEqual([]);
  });

  it('allows a penny a line for rounding and no more', () => {
    const withinRounding = findTotalMismatches([table([
      row('A', '10.00'), row('B', '10.00'), row('C', '10.00'), foot('Total', '30.02')
    ])]);
    expect(withinRounding).toEqual([]);

    const beyondIt = findTotalMismatches([table([
      row('A', '10.00'), row('B', '10.00'), row('C', '10.00'), foot('Total', '30.20')
    ])]);
    expect(beyondIt).toHaveLength(1);
  });

  it('never counts a subtotal twice under a grand total', () => {
    expect(findTotalMismatches([table([
      row('Freight', '400.00'),
      row('Handling', '50.00'),
      row('Subtotal', '450.00'),
      foot('Total', '450.00')
    ])])).toEqual([]);
  });

  it('refuses to judge a column it cannot read in full', () => {
    // One unreadable cell means the sum covers different rows than the total does. Judging
    // anyway is how a correct total gets reported as wrong.
    expect(findTotalMismatches([table([
      row('Freight', '400.00'), row('Handling', 'on application'), foot('Total', '450.00')
    ])])).toEqual([]);
  });

  it('does not treat one line under a total as a sum', () => {
    expect(findTotalMismatches([table([
      row('Freight', '400.00'), foot('Total', '480.00')
    ])])).toEqual([]);
  });

  it('reads a total row by its wording as well as by tfoot', () => {
    expect(findTotalMismatches([table([
      row('Freight', '400.00'), row('Handling', '50.00'), row('Amount due', '500.00')
    ])])).toHaveLength(1);
  });

  it('ignores a column of dates or references beside the one that is wrong', () => {
    const mismatches = findTotalMismatches([table([
      row('2026-04-01', 'Freight', '400.00'),
      row('2026-04-02', 'Handling', '50.00'),
      foot('', 'Total', '500.00')
    ], ['Date', 'Line', 'Amount'])]);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.column).toBe('Amount');
  });
});

const snapshot = (over: Partial<NumbersSnapshot>): NumbersSnapshot => ({
  tables: [], statements: [], lines: [], hasPagination: false, largestTableRows: 0,
  // These snapshots stand for pages that rendered a listing, which is the only kind this
  // oracle judges. A page with no table at all is its own case and has its own test.
  hasTable: true, hasEmptyState: false, pagesClaimed: null, ...over
});

describe('a count the page states but does not show', () => {
  it('reports a range claim that does not match the rows', () => {
    const found = findCountMismatches(snapshot({
      statements: ['Showing 1 to 20 of 134'], largestTableRows: 3
    }));

    expect(found).toHaveLength(1);
    expect(found[0]!.stated).toBe(20);
    expect(found[0]!.shown).toBe(3);
  });

  it('accepts a range claim that matches, including a short last page', () => {
    expect(findCountMismatches(snapshot({
      statements: ['Showing 121 to 134 of 134'], largestTableRows: 14
    }))).toEqual([]);
  });

  it('reports a bare count larger than the rows when there is no pager', () => {
    // The filter defect: the heading counts the whole collection, the rows are filtered.
    expect(findCountMismatches(snapshot({
      statements: ['42 shipments'], largestTableRows: 3
    }))).toHaveLength(1);
  });

  it('leaves a bare count alone when the page is paginated', () => {
    // Not decidable from one page: the other rows are legitimately elsewhere. Saying so
    // beats a rule that is right most of the time.
    expect(findCountMismatches(snapshot({
      statements: ['42 shipments'], largestTableRows: 3, hasPagination: true
    }))).toEqual([]);
  });

  it('does not report a heading that counts something smaller than the table', () => {
    // "3 exceptions" above a table of 42 shipments is a heading about a subset, not a bug.
    expect(findCountMismatches(snapshot({
      statements: ['3 exceptions'], largestTableRows: 42
    }))).toEqual([]);
  });

  it('says nothing about a page that renders no table', () => {
    // Nothing to count. This is what the old "no rows at all" rule was reaching for, and it
    // was written as `largestTableRows === 0`, which also silenced the case below.
    expect(findCountMismatches(snapshot({
      statements: ['42 shipments'], largestTableRows: 0, hasTable: false
    }))).toEqual([]);
  });

  it('reports a positive count stated beside an empty table', () => {
    // This test previously asserted the opposite, under the name "says nothing about a page
    // with no rows at all". That was wrong and it was the most useful case in the file: a
    // filter that matched nothing, next to a heading still advertising the whole
    // population, is the clearest possible form of counting before filtering — which is the
    // defect this oracle's own error message names. The old rule discarded it on the way in.
    const found = findCountMismatches(snapshot({
      statements: ['42 shipments'], largestTableRows: 0
    }));

    expect(found).toHaveLength(1);
    expect(found[0]!.stated).toBe(42);
    expect(found[0]!.shown).toBe(0);
    expect(found[0]!.reason).toMatch(/while its table is empty/);
  });

  it('reports an empty first page under a pager claiming more pages', () => {
    // Independent of any heading: a pager saying "page 1 of 2" is the page asserting its
    // result set does not fit on one page, and an empty first page contradicts that. It
    // needs no knowledge of the page size, which is why it is worth having separately.
    const found = findCountMismatches(snapshot({
      statements: [], largestTableRows: 0, hasPagination: true, pagesClaimed: 2
    }));

    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toMatch(/the first one cannot be empty/);
  });

  it('accepts an empty table on a page that claims nothing', () => {
    // An empty result set with an honest page around it. No claim, no pager promising more:
    // nothing to contradict, so nothing to report.
    expect(findCountMismatches(snapshot({
      statements: ['No shipments match.'], largestTableRows: 0
    }))).toEqual([]);
  });

  it('accepts a page stating zero beside its empty table', () => {
    expect(findCountMismatches(snapshot({
      statements: ['0 shipments'], largestTableRows: 0
    }))).toEqual([]);
  });

  it('reads a range claim under pagination, where the bare rule cannot help', () => {
    expect(findCountMismatches(snapshot({
      statements: ['Showing 1–20 of 134'], largestTableRows: 3, hasPagination: true
    }))).toHaveLength(1);
  });
});

const line = (label: string, value: string, order: number) =>
  ({ group: 'invoice', label, value, order });

describe('a percentage line that does not derive from a figure above it', () => {
  it('accepts a line that is its rate of the subtotal above it', () => {
    expect(findPercentageProblems([
      line('Freight', '400.00', 0),
      line('Fuel surcharge (11.5%)', '46.00', 1)
    ])).toEqual([]);
  });

  it('reports a line computed from a total stated after it', () => {
    // The defect: 11.5% taken on the VAT-inclusive gross rather than on the freight line,
    // which overcharges every invoice and no form test can see.
    const problems = findPercentageProblems([
      line('Freight', '400.00', 0),
      line('Fuel surcharge (11.5%)', '55.20', 1),
      line('VAT (20%)', '80.00', 2),
      line('Gross', '480.00', 3)
    ]);

    const surcharge = problems.find(problem => problem.label.startsWith('Fuel'));
    expect(surcharge).toBeDefined();
    expect(surcharge!.derivedFrom).toBe('Gross');
    expect(surcharge!.derivedValue).toBe(480);
  });

  it('reports a line that is its rate of nothing at all', () => {
    const problems = findPercentageProblems([
      line('Freight', '400.00', 0),
      line('Fuel surcharge (11.5%)', '61.11', 1)
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.derivedFrom).toBeUndefined();
  });

  it('never matches a figure in another group', () => {
    // The rate's own group holds a figure that does not explain it; the figure that would
    // is in another table. Reaching across would silence a real finding, so the group with
    // its own candidate is the one that must still report.
    const problems = findPercentageProblems([
      { group: 'a', label: 'Handling', value: '13.00', order: 0 },
      { group: 'a', label: 'Fuel surcharge (11.5%)', value: '46.00', order: 1 },
      { group: 'b', label: 'Freight', value: '400.00', order: 0 }
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.derivedFrom).toBeUndefined();
  });

  it('says nothing when there is no other figure to derive from', () => {
    expect(findPercentageProblems([
      line('VAT (20%)', '80.00', 0)
    ])).toEqual([]);
  });

  it('allows the rounding a stated rate can legitimately cost', () => {
    expect(findPercentageProblems([
      line('Net', '1000.00', 0),
      line('Duty (3.7%)', '37.01', 1)
    ])).toEqual([]);
  });

  it('accepts a line taken on the running subtotal rather than on one line above it', () => {
    // How almost every invoice computes VAT: twenty per cent of everything above, not of
    // the last line. A rule that only looked at single lines would report every one of them.
    expect(findPercentageProblems([
      line('Freight', '400.00', 0),
      line('Fuel surcharge (11.5%)', '46.00', 1),
      line('VAT (20%)', '89.20', 2)
    ])).toEqual([]);
  });

  it('still reports a line taken on a total printed below it, subtotals and all', () => {
    const problems = findPercentageProblems([
      line('Freight', '400.00', 0),
      line('Fuel surcharge (11.5%)', '55.20', 1),
      line('VAT (20%)', '91.04', 2),
      line('Gross', '480.00', 3)
    ]);

    expect(problems.map(problem => problem.label)).toContain('Fuel surcharge (11.5%)');
    expect(problems.find(problem => problem.label.startsWith('Fuel'))!.derivedFrom).toBe('Gross');
  });

  it('ignores a label with no percentage in it', () => {
    expect(findPercentageProblems([
      line('Freight', '400.00', 0),
      line('Handling', '13.00', 1)
    ])).toEqual([]);
  });
});
