import type { Page } from 'playwright';
import { OracleError } from './form-oracles.js';

/**
 * The calculation oracles: whether the arithmetic a page prints about itself is true.
 *
 * Almost no generated suite asks this. A suite built from a page's controls tests what the
 * controls do; it does not notice that the page is also making claims — this total is the
 * sum of those lines, this heading counts those rows, this line is eleven and a half per
 * cent of that one. Those claims are checkable without knowing anything about the business,
 * and when one is false it is false for every user of every record.
 *
 * The shape here is deliberate: the browser does nothing but read the page into data, and
 * every judgement is made in this process by a pure function. That is what makes the
 * arithmetic testable without a browser at all, which matters more here than anywhere else
 * in the engine — the failure that would discredit the whole family is reporting a correct
 * total as wrong, and that failure lives entirely in the parsing and the tolerances.
 *
 * All three refuse to judge what they cannot read cleanly. A calculation finding sends
 * somebody to read the ledger code; a false one spends that trip for nothing.
 */

// ---------------------------------------------------------------------------
// What the browser hands back. Text only: no judgement happens in the page.
// ---------------------------------------------------------------------------

export interface RowSnapshot {
  cells: string[];
  /** In <tfoot>, which marks a summary row whatever its wording. */
  inFoot: boolean;
}

export interface TableSnapshot {
  name: string;
  headers: string[];
  /** Rendered body rows in document order. Hidden rows are not here: a total covers what
   *  the page shows, and a filtered-out row is not part of the claim. */
  rows: RowSnapshot[];
}

/** A label and a figure that belong together: a table row, a definition pair, a list item. */
export interface LineSnapshot {
  /** Which table, list or section this line sits in. Candidates never cross a group. */
  group: string;
  label: string;
  value: string;
  /** Document order within the group. */
  order: number;
}

export interface NumbersSnapshot {
  tables: TableSnapshot[];
  /** Rendered text of short block elements, for a page's claims about its own size. */
  statements: string[];
  /** How many rows the page's largest rendered table shows. */
  largestTableRows: number;
  /** Whether the page rendered a table at all, which is not the same as one with rows in
   *  it. A page with no table has nothing to count; a table with no rows is a result set
   *  with nothing in it, and a page still claiming a positive count beside it is wrong. */
  hasTable: boolean;
  /** Whether the page says, in so many words, that it is a listing with nothing in it.
   *
   *  Many applications render an empty state *instead of* an empty table, so "no table" and
   *  "not a listing" are not the same thing. Without this, a page reading "No shipments
   *  match" beside a heading advertising forty of them looked exactly like a page that was
   *  never a listing at all — and the clearest instance of counting before filtering went
   *  unjudged for want of a `<table>` element. */
  hasEmptyState: boolean;
  hasPagination: boolean;
  /** The number of pages the pager says exist, from "page 1 of 3". Null when the pager does
   *  not say. A pager claiming a second page is the page asserting its result set is bigger
   *  than one page, which an empty first page contradicts. */
  pagesClaimed: number | null;
  lines: LineSnapshot[];
}

// ---------------------------------------------------------------------------
// Reading numbers. Pure, and the most load-bearing function in the file.
// ---------------------------------------------------------------------------

/**
 * Reads a figure out of a cell, or returns null when the cell is not one.
 *
 * Returning null is the important half. Every oracle here treats an unreadable cell as a
 * reason not to judge the column at all, so this function being too eager is how a correct
 * total gets reported as wrong — "1,234" read as 1.234, "12 of 30" read as 12, "n/a" read
 * as 0. It therefore refuses anything it cannot account for in full.
 */
export function readNumber(text: string | undefined): number | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;

  // A percentage is not an amount, and a column of them does not sum to anything.
  if (trimmed.includes('%')) return null;

  const bracketed = /^\(.*\)$/.test(trimmed);
  const body = bracketed ? trimmed.slice(1, -1) : trimmed;

  // Everything that is not a digit, separator or leading sign must be currency decoration.
  // Anything else — a word, a second number, a range — means this is not a single figure.
  const match = /^[^\d\-+]*([-+]?[\d][\d.,   ]*)[^\d]*$/.exec(
    body.replace(/[−‒–—]/g, '-'));
  if (match === null) return null;

  let digits = match[1]!.replace(/[   ]/g, '');
  const negative = bracketed || digits.startsWith('-');
  digits = digits.replace(/^[-+]/, '');
  if (digits === '') return null;

  // Which separator is the decimal point.
  //
  // "1,234" and "1.234" are the same figure written in two places and the cell cannot say
  // which is meant, so the rule has to be stated rather than guessed at each call. A lone
  // separator followed by exactly three digits is read as a thousands group, because that
  // is overwhelmingly what it is on a page of money — except after a bare zero, where it
  // cannot be: "0.750" is three quarters of a unit, never seven hundred and fifty.
  const dots = (digits.match(/\./g) ?? []).length;
  const commas = (digits.match(/,/g) ?? []).length;
  let whole = digits;
  let fraction = '';

  if (dots + commas > 0) {
    const at = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','));
    const tail = digits.slice(at + 1);
    const head = digits.slice(0, at);
    if (!/^\d+$/.test(tail)) return null;

    const isDecimalPoint =
      (dots > 0 && commas > 0) ? true          // both kinds present: the rightmost is the point
      : tail.length <= 2 ? true                // no thousands group is one or two digits
      : tail.length >= 4 ? true                // nor four or more
      : dots + commas > 1 ? false              // 1,234,567: every separator groups thousands
      : head === '0';                          // 0.750 is a fraction; 1.234 is a thousand

    if (isDecimalPoint) {
      whole = head;
      fraction = tail;
    }
  }

  const cleanedWhole = whole.replace(/[.,]/g, '');
  if (!/^\d*$/.test(cleanedWhole) || !/^\d*$/.test(fraction)) return null;
  if (cleanedWhole === '' && fraction === '') return null;

  const parsed = Number.parseFloat(`${cleanedWhole || '0'}.${fraction || '0'}`);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

/** Wording that marks a row as summarising the rows above it rather than being one of them. */
const TOTAL_ROW =
  /^(grand\s+)?total\b|^sub\s*-?\s*total\b|^amount\s+(due|payable)\b|^balance\b|^net\s+total\b|\btotals?$/i;

function isTotalRow(row: RowSnapshot): boolean {
  if (row.inFoot) return true;
  const first = row.cells.find(cell => cell.trim() !== '');
  return first !== undefined && TOTAL_ROW.test(first.trim());
}

// ---------------------------------------------------------------------------
// 1. A total equals the lines it totals
// ---------------------------------------------------------------------------

export interface TotalMismatch {
  table: string;
  column: string;
  lines: number;
  stated: number;
  summed: number;
}

/**
 * Totals that do not equal the lines above them.
 *
 * A column is only summed when every line in it parses, because one unreadable cell means
 * the sum covers a different set of rows than the total does, and a total reported wrong
 * for that reason is the oracle's fault rather than the application's. Rows that are
 * themselves totals are never summands, so a subtotal is not counted twice under a grand
 * total. The tolerance is a penny a line — what rounding each line can legitimately cost —
 * and never a proportion of the total, which would excuse exactly the percentage errors
 * this family exists to find.
 */
export function findTotalMismatches(tables: TableSnapshot[]): TotalMismatch[] {
  const found: TotalMismatch[] = [];

  for (const table of tables) {
    const totals = table.rows.filter(isTotalRow);
    const lines = table.rows.filter(row => !isTotalRow(row));

    // One line under a total is not a sum, it is the same figure written twice.
    if (totals.length === 0 || lines.length < 2) continue;

    const width = Math.max(...table.rows.map(row => row.cells.length), 0);

    for (const total of totals) {
      for (let column = 0; column < width; column++) {
        const stated = readNumber(total.cells[column]);
        if (stated === null) continue;

        let summed = 0;
        let readable = true;
        for (const line of lines) {
          const value = readNumber(line.cells[column]);
          if (value === null) { readable = false; break; }
          summed += value;
        }
        if (!readable) continue;

        const tolerance = Math.max(0.01, 0.01 * lines.length);
        if (Math.abs(summed - stated) <= tolerance) continue;

        found.push({
          table: table.name,
          column: table.headers[column] ?? `column ${column + 1}`,
          lines: lines.length,
          stated: round(stated),
          summed: round(summed)
        });
      }
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// 2. A stated count equals the rows shown
// ---------------------------------------------------------------------------

export interface CountMismatch {
  claim: string;
  stated: number;
  shown: number;
  reason: string;
}

/** "Showing 1 to 20 of 134", in the spellings applications actually use. */
const RANGE_CLAIM = /\b(?:showing|displaying|results?)\D{0,12}(\d[\d,.  ]*)\s*(?:[-–—]|to|through|of)\s*(\d[\d,.  ]*)\s*(?:of|from|\/)\s*(\d[\d,.  ]*)/i;

/** "42 shipments", "42 results", "42 records found". */
const BARE_CLAIM = /\b(\d[\d,.  ]*)\s+([a-z][a-z ]{2,30}?)\b(?:\s+(?:found|matched|returned))?\s*$/i;

/**
 * Counts a page states that do not match the rows it shows.
 *
 * Two forms, both decidable from one page and neither inferred:
 *
 * A range claim — "showing 1 to 20 of 134" — says exactly how many rows this page holds,
 * so the page either holds them or it does not. This is the strong one and it works under
 * pagination.
 *
 * A bare claim — "42 shipments" over a table — is only checkable when the page offers no
 * pagination, because with a pager the other rows are legitimately elsewhere. The common
 * defect it catches is a count taken before the filter: the heading counts the whole
 * collection while the rows come from the filtered one.
 *
 * A bare claim on a paginated page is not decidable from one page and is deliberately left
 * alone. Saying so is better than a rule that is right most of the time.
 */
export function findCountMismatches(snapshot: NumbersSnapshot): CountMismatch[] {
  const found: CountMismatch[] = [];
  const shown = snapshot.largestTableRows;

  // Nothing to count only when the page renders no table. This used to return on
  // `shown === 0`, which threw away the most informative case there is: a filter that
  // matched nothing, beside a heading still advertising the whole population. The oracle's
  // own error message names that defect — "the usual cause is counting before filtering" —
  // and this line is why it could never report it.
  if (!snapshot.hasTable && !snapshot.hasEmptyState) return found;

  // A pager claiming a second page is the page asserting its result set does not fit on one
  // page. An empty first page contradicts that outright, whatever the heading says, and
  // needs no knowledge of the page size to judge.
  if (shown === 0 && snapshot.pagesClaimed !== null && snapshot.pagesClaimed > 1) {
    found.push({
      claim: `page 1 of ${snapshot.pagesClaimed}`,
      stated: snapshot.pagesClaimed,
      shown,
      reason: `the pager says there are ${snapshot.pagesClaimed} pages, so the first one cannot be empty`
    });
  }

  for (const statement of snapshot.statements) {
    // A positive count stated beside an empty table. The pagination escape below does not
    // apply here: no pager, however many pages it offers, makes the first page of a
    // non-empty result set empty.
    if (shown === 0) {
      const bareOnEmpty = BARE_CLAIM.exec(statement.trim());
      if (bareOnEmpty === null) continue;
      const claimed = readNumber(bareOnEmpty[1]);
      if (claimed === null || !Number.isInteger(claimed) || claimed === 0) continue;
      found.push({
        claim: statement.trim().slice(0, 120),
        stated: claimed,
        shown,
        reason: `the page states ${claimed} ${bareOnEmpty[2]!.trim()} while its table is empty`
      });
      continue;
    }

    const range = RANGE_CLAIM.exec(statement);
    if (range !== null) {
      const first = readNumber(range[1]);
      const last = readNumber(range[2]);
      const total = readNumber(range[3]);
      if (first === null || last === null || total === null) continue;
      if (!Number.isInteger(first) || !Number.isInteger(last)) continue;
      if (last < first || first < 1) continue;

      const expected = last - first + 1;
      if (expected === shown) continue;
      // A page may legitimately say "of 0" and show nothing.
      if (total === 0 && shown === 0) continue;

      found.push({
        claim: statement.trim().slice(0, 120),
        stated: expected,
        shown,
        reason: `the page says it is showing rows ${first} to ${last}, which is ${expected} row(s)`
      });
      continue;
    }

    if (snapshot.hasPagination) continue;

    const bare = BARE_CLAIM.exec(statement.trim());
    if (bare === null) continue;
    const stated = readNumber(bare[1]);
    if (stated === null || !Number.isInteger(stated) || stated === shown) continue;
    // A heading counting something other than the table is the obvious false positive, so
    // only a claim larger than what is rendered is reported: that is the filter defect's
    // direction, and a smaller claim is usually a heading about a subset.
    if (stated < shown) continue;

    found.push({
      claim: statement.trim().slice(0, 120),
      stated,
      shown,
      reason: `the page states ${stated} ${bare[2]!.trim()} and offers no further pages`
    });
  }

  return found;
}

// ---------------------------------------------------------------------------
// 3. A percentage line derives from a figure stated before it
// ---------------------------------------------------------------------------

export interface PercentageProblem {
  label: string;
  rate: number;
  amount: number;
  /** The figure it does match, when it matches one stated after it. */
  derivedFrom?: string;
  derivedValue?: number;
}

const RATE_IN_LABEL = /(\d+(?:[.,]\d+)?)\s*%/;

/**
 * Lines labelled with a percentage that do not derive from any figure stated before them.
 *
 * A line that says "VAT (20%)" or "Fuel surcharge (11.5%)" is making a claim about another
 * figure on the page. The claim is checkable without knowing which figure was meant,
 * because a document states its figures in an order: a line can only be derived from
 * something already said. So an amount that is its rate of nothing above it is wrong, and
 * an amount that is its rate of something *below* it was computed from a total that does
 * not exist yet at that point — a surcharge taken on the gross rather than the net, which
 * overcharges every row and is invisible to every test that only checks the form submits.
 *
 * Candidates never cross a group, so a rate in one table is not matched against a figure in
 * another. A line with no other figures in its group is not judged at all.
 */
export function findPercentageProblems(lines: LineSnapshot[]): PercentageProblem[] {
  const found: PercentageProblem[] = [];

  const byGroup = new Map<string, LineSnapshot[]>();
  for (const line of lines) {
    if (!byGroup.has(line.group)) byGroup.set(line.group, []);
    byGroup.get(line.group)!.push(line);
  }

  for (const group of byGroup.values()) {
    const amounts: Amount[] = group
      .map(line => ({ label: line.label, value: readNumber(line.value), order: line.order }))
      .filter((amount): amount is Amount => amount.value !== null);

    for (const line of group) {
      const rateMatch = RATE_IN_LABEL.exec(line.label);
      if (rateMatch === null) continue;

      const rate = readNumber(rateMatch[1]);
      const amount = readNumber(line.value);
      if (rate === null || amount === null || rate <= 0 || amount === 0) continue;

      // Nothing to derive from, so nothing to say.
      const others = amounts.filter(candidate => candidate.order !== line.order && candidate.value !== 0);
      if (others.length === 0) continue;

      const matches = (base: Amount) => {
        const expected = Math.abs(base.value) * rate / 100;
        // A penny, or half a basis point of the amount for figures large enough that
        // rounding the rate itself moves the answer.
        const tolerance = Math.max(0.01, Math.abs(amount) * 0.00005);
        return Math.abs(expected - Math.abs(amount)) <= tolerance;
      };

      // A percentage line is as often taken on the running subtotal as on a single line:
      // VAT is twenty per cent of everything above it, not of the last line. Both are
      // candidates, and a page that prints the subtotal is covered either way. Including
      // the running sums can only silence findings, never invent them, which is the safe
      // direction for a check whose cost is sending somebody to read the ledger code.
      const above = others.filter(base => base.order < line.order);
      const runningSums: Amount[] = [];
      let running = 0;
      for (const base of above) {
        running += base.value;
        runningSums.push({ label: `everything above "${line.label.trim()}"`, value: running, order: base.order });
      }

      if ([...above, ...runningSums].some(matches)) continue;

      const below = others.find(base => base.order > line.order && matches(base));
      found.push({
        label: line.label.trim().slice(0, 80),
        rate,
        amount,
        ...(below ? { derivedFrom: below.label.trim().slice(0, 80), derivedValue: below.value } : {})
      });
    }
  }

  return found;
}

interface Amount { label: string; value: number; order: number }

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Reading the page. The only part that touches a browser, and it only reads text.
// ---------------------------------------------------------------------------

export async function readNumbers(page: Page): Promise<NumbersSnapshot> {
  return await page.evaluate(() => {
    const rendered = (element: Element): boolean => {
      if (!(element instanceof HTMLElement)) return true;
      if (element.hidden) return false;
      if (element.getClientRects().length === 0) return false;
      const style = window.getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };

    const textOf = (node: Element): string => (node.textContent ?? '').replace(/\s+/g, ' ').trim();

    const tables: Array<{ name: string; headers: string[]; rows: Array<{ cells: string[]; inFoot: boolean }> }> = [];
    const lines: Array<{ group: string; label: string; value: string; order: number }> = [];

    document.querySelectorAll('table').forEach((table, index) => {
      if (!rendered(table)) return;
      const name = table.getAttribute('id') ?? table.getAttribute('data-testid')
        ?? table.querySelector('caption')?.textContent?.trim() ?? `table ${index + 1}`;

      const headers = Array.from(table.querySelectorAll('thead th')).map(textOf);
      const rows = Array.from(table.querySelectorAll('tr'))
        .filter(row => row.closest('thead') === null && rendered(row))
        .map(row => ({
          cells: Array.from(row.children).map(textOf),
          inFoot: row.closest('tfoot') !== null
        }));

      tables.push({ name, headers, rows });

      // A two-column table is also a list of label/figure pairs, which is how most
      // invoices print their summary.
      rows.forEach((row, order) => {
        if (row.cells.length < 2) return;
        lines.push({
          group: name,
          label: row.cells[0] ?? '',
          value: row.cells[row.cells.length - 1] ?? '',
          order
        });
      });
    });

    // Definition lists and the "label: amount" rows applications build out of divs.
    document.querySelectorAll('dl').forEach((list, index) => {
      if (!rendered(list)) return;
      const terms = Array.from(list.querySelectorAll('dt'));
      const values = Array.from(list.querySelectorAll('dd'));
      terms.forEach((term, order) => {
        const value = values[order];
        if (value === undefined) return;
        lines.push({ group: `list ${index + 1}`, label: textOf(term), value: textOf(value), order });
      });
    });

    const statements: string[] = [];
    document.querySelectorAll('h1, h2, h3, h4, p, caption, [class*="count"], [class*="result"], [class*="summar"]')
      .forEach(node => {
        if (!rendered(node)) return;
        const text = textOf(node);
        if (text.length > 0 && text.length <= 160) statements.push(text);
      });

    const pagers = Array.from(document.querySelectorAll(
      'nav, [role="navigation"], [class*="pagin"], [class*="pager"], [aria-label*="pagination" i]'))
      .filter(node => rendered(node));
    const pagerText = pagers.map(node => textOf(node)).join(' ');
    const hasPagination = /\b(next|previous|page\s*\d|\d\s*of\s*\d)\b/i.test(pagerText);

    const ofPages = /\bpage\s*\d+\s*of\s*(\d+)\b/i.exec(pagerText);
    const pagesClaimed = ofPages === null ? null : Number(ofPages[1]);

    const largestTableRows = tables.reduce(
      (most, table) => Math.max(most, table.rows.filter(row => !row.inFoot).length), 0);

    // An explicit empty state: the page's own statement that it is a listing holding
    // nothing. Matched on the marker or the wording, because applications spell it both
    // ways and a listing is worth judging either way.
    const hasEmptyState = Array.from(document.querySelectorAll(
      '[class*="empty" i], [data-testid*="empty" i], [class*="no-result" i], [class*="noresult" i]'))
      .some(node => rendered(node))
      || Array.from(document.querySelectorAll('p, div, td, th, h1, h2, h3, h4'))
        .some(node => rendered(node)
          && /\b(no\s+\w+\s+(match|found|yet)|nothing\s+to\s+show|no\s+results?)\b/i
            .test(textOf(node)));

    return { tables, statements, lines, hasPagination, largestTableRows,
             hasTable: tables.length > 0, hasEmptyState, pagesClaimed };
  });
}

// ---------------------------------------------------------------------------
// The three oracles
// ---------------------------------------------------------------------------

export async function assertTotalsAddUp(page: Page): Promise<void> {
  const mismatches = findTotalMismatches((await readNumbers(page)).tables);
  if (mismatches.length === 0) return;

  const described = mismatches.slice(0, 4).map(m =>
    `${m.table}, "${m.column}" shows ${m.stated} but its ${m.lines} lines add up to `
    + `${m.summed} (out by ${round(m.stated - m.summed)})`).join('; ');

  throw new OracleError(
    `A total does not equal the lines it totals: ${described}. The page is stating an `
    + 'equation about its own contents that does not hold, so either the total is computed '
    + 'from a different collection than the rows shown, or a line is left out of the sum '
    + 'but not out of the table.'
  );
}

export async function assertDisplayedCountMatches(page: Page): Promise<void> {
  const mismatches = findCountMismatches(await readNumbers(page));
  if (mismatches.length === 0) return;

  const described = mismatches.slice(0, 3).map(m =>
    `"${m.claim}" — ${m.reason}, but ${m.shown} row(s) are shown`).join('; ');

  throw new OracleError(
    `The page states a count it does not show: ${described}. A count and a list that `
    + 'disagree mean one of them is built from the wrong collection; the usual cause is '
    + 'counting before filtering, which leaves the heading and the pager advertising rows '
    + 'the filter has already removed.'
  );
}

export async function assertPercentageLineConsistent(page: Page): Promise<void> {
  const problems = findPercentageProblems((await readNumbers(page)).lines);
  if (problems.length === 0) return;

  const described = problems.slice(0, 4).map(problem => problem.derivedFrom
    ? `"${problem.label}" is ${problem.amount}, which is ${problem.rate}% of "${problem.derivedFrom}" `
      + `(${problem.derivedValue}) — a figure the page states after it, not before`
    : `"${problem.label}" is ${problem.amount}, which is not ${problem.rate}% of anything `
      + 'stated before it').join('; ');

  throw new OracleError(
    `A percentage line does not derive from a figure above it: ${described}. A line can `
    + 'only be computed from something the document has already stated; one computed from '
    + 'a total printed below it was taken on a figure that does not exist yet at that '
    + 'point, which is how a surcharge ends up charged on the gross instead of the net.'
  );
}
