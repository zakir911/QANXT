import type { Page } from 'playwright';
import { readNumber } from './calculation-oracles.js';
import { normaliseName } from './business-rules.js';

/**
 * Reading the values a business rule talks about off a screen.
 *
 * A rule says `surcharge == net * 0.085`. The screen says "Fuel surcharge £93.50" in a summary
 * table, or carries `<input name="netAmount" value="1100">`, or prints
 * `<span data-field="duty">55.00</span>`. Something has to join the two, and the joining is
 * where a tool like this usually starts lying: match too loosely and a rule about the order
 * total gets checked against the line total, which is a false defect report with arithmetic
 * attached and no way for the reader to tell.
 *
 * So the join is deliberately narrow and completely stated:
 *
 * - A name matches on letters and digits only, folded to lower case. `Fuel surcharge`,
 *   `fuelSurcharge`, `fuel_surcharge` and `FUEL-SURCHARGE` are one name. `surcharge` is a
 *   different one, and does **not** match `Fuel surcharge`.
 * - Where two places on the page offer the same name with different figures, the name is
 *   **dropped**, not guessed at. The rule then comes back "could not tell", naming it. A rule
 *   checked against whichever of two candidates happened to be first is worse than no rule.
 * - A value that `readNumber` will not read is not a value. That function already refuses
 *   "12 of 30", "n/a" and percentages, and this inherits the refusal.
 */

/** One name and figure as the page offered it, before any judging. */
export interface NamedValue {
  name: string;
  text: string;
  /** Where it came from, for the evidence line: 'label', 'field' or 'attribute'. */
  from: string;
}

// The matching rule itself lives with the rule language, so there is one of it: a page reader
// that folded names differently from the evaluator would make rules pass and fail by accident.
export { normaliseName };

/**
 * Turns what the page offered into the values a rule is checked against.
 *
 * Drops any name two places on the page disagree about, and says which in `ambiguous` so the
 * report can name it. Silence there is how a rule ends up checked against the wrong number.
 */
export function namedValuesFrom(raw: readonly NamedValue[]): {
  values: Map<string, number>;
  ambiguous: string[];
  sources: Map<string, string>;
} {
  const seen = new Map<string, { value: number; from: string }[]>();

  for (const candidate of raw) {
    const name = normaliseName(candidate.name);
    if (name === '') continue;
    const value = readNumber(candidate.text);
    if (value === null) continue;
    const already = seen.get(name) ?? [];
    already.push({ value, from: candidate.from });
    seen.set(name, already);
  }

  const values = new Map<string, number>();
  const sources = new Map<string, string>();
  const ambiguous: string[] = [];

  for (const [name, candidates] of seen) {
    const distinct = [...new Set(candidates.map(c => c.value))];
    if (distinct.length > 1) { ambiguous.push(name); continue; }
    values.set(name, distinct[0]!);
    sources.set(name, candidates[0]!.from);
  }

  return { values, ambiguous, sources: sources };
}

/**
 * Collects every name and figure the page offers.
 *
 * Runs in the page, so it sees what a user sees — a figure a script wrote into the DOM counts,
 * and one in markup the browser never rendered does not.
 */
export async function readNamedValues(page: Page): Promise<NamedValue[]> {
  return await page.evaluate(() => {
    const rendered = (element: Element): boolean => {
      if (!(element instanceof HTMLElement)) return true;
      if (element.hidden) return false;
      if (element.getClientRects().length === 0) return false;
      const style = window.getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const textOf = (node: Element): string => (node.textContent ?? '').replace(/\s+/g, ' ').trim();

    const found: Array<{ name: string; text: string; from: string }> = [];

    // 1. Labelled figures: a summary table's rows, a definition list, the "label: amount"
    //    pairs applications build out of divs. This is how an invoice prints its totals.
    document.querySelectorAll('table').forEach(table => {
      if (!rendered(table)) return;
      Array.from(table.querySelectorAll('tr'))
        .filter(row => row.closest('thead') === null && rendered(row))
        .forEach(row => {
          const cells = Array.from(row.children).map(textOf);
          if (cells.length < 2) return;
          found.push({ name: cells[0] ?? '', text: cells[cells.length - 1] ?? '', from: 'label' });
        });
    });

    document.querySelectorAll('dl').forEach(list => {
      if (!rendered(list)) return;
      const terms = Array.from(list.querySelectorAll('dt'));
      const values = Array.from(list.querySelectorAll('dd'));
      terms.forEach((term, index) => {
        const value = values[index];
        if (value === undefined) return;
        found.push({ name: textOf(term), text: textOf(value), from: 'label' });
      });
    });

    // 2. Form fields, by the name the application gave them. A rule about a screen the user
    //    is filling in is about what is in the boxes.
    document.querySelectorAll('input, select, textarea').forEach(field => {
      if (!rendered(field)) return;
      const name = field.getAttribute('name') ?? field.getAttribute('id');
      if (name === null) return;
      const type = (field.getAttribute('type') ?? '').toLowerCase();
      if (type === 'password' || type === 'hidden' || type === 'file') return;
      const value = field instanceof HTMLSelectElement
        ? (field.selectedOptions[0]?.textContent ?? '')
        : (field as HTMLInputElement).value;
      found.push({ name, text: value, from: 'field' });
    });

    // 3. Figures an application marks for exactly this purpose.
    document.querySelectorAll('[data-field], [data-testid], [data-total], [data-amount]')
      .forEach(node => {
        if (!rendered(node)) return;
        const name = node.getAttribute('data-field') ?? node.getAttribute('data-total')
          ?? node.getAttribute('data-amount') ?? node.getAttribute('data-testid');
        if (name === null || name === '') return;
        found.push({ name, text: textOf(node), from: 'attribute' });
      });

    // 4. A labelled field's own label, where the name on the element is opaque.
    document.querySelectorAll('label[for]').forEach(label => {
      if (!rendered(label)) return;
      const target = document.getElementById(label.getAttribute('for') ?? '');
      if (target === null || !rendered(target)) return;
      const value = target instanceof HTMLSelectElement
        ? (target.selectedOptions[0]?.textContent ?? '')
        : (target as HTMLInputElement).value ?? textOf(target);
      found.push({ name: textOf(label).replace(/[:*]\s*$/, ''), text: value, from: 'label' });
    });

    return found;
  });
}
