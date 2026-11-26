import type { Page } from 'playwright';
import { readNumber } from './calculation-oracles.js';
import {
  checkRule, normaliseName, parseRules, rulesFor, type SubmissionRule
} from './business-rules.js';
import { InconclusiveError, OracleError, submitDirectly } from './form-oracles.js';

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
  /** The text of everything the screen shows by name, number or not, for a `when` line. A
   *  precondition is usually about a word: an incoterm, a status, a yes or no. */
  texts: Map<string, string>;
} {
  const seen = new Map<string, { value: number; from: string }[]>();
  const spelled = new Map<string, Set<string>>();

  for (const candidate of raw) {
    const name = normaliseName(candidate.name);
    if (name === '') continue;

    const text = String(candidate.text ?? '').trim();
    if (text !== '') {
      const already = spelled.get(name) ?? new Set<string>();
      already.add(text);
      spelled.set(name, already);
    }

    const value = readNumber(candidate.text);
    if (value === null) continue;
    const already = seen.get(name) ?? [];
    already.push({ value, from: candidate.from });
    seen.set(name, already);
  }

  // Same refusal as for figures: where the screen gives one name two different texts, it is not
  // a value, and a precondition resting on it must not be decided by whichever came first.
  const texts = new Map<string, string>();
  for (const [name, variants] of spelled) {
    if (variants.size === 1) texts.set(name, [...variants][0]!);
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

  return { values, ambiguous, sources, texts };
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

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

/**
 * Checks one stated business rule against the screen the browser is on.
 *
 * The rule arrives as the owner wrote it, in the step's value, and is parsed here. Three
 * outcomes, and each goes to the verdict that is actually true:
 *
 * - it holds → the step passes;
 * - it is broken → `OracleError`, so the step fails with the arithmetic in the message;
 * - a field it names is not on the screen → `InconclusiveError`, so the step is reported
 *   skipped with the reason. Never a pass. A rule that passes because its field was absent is
 *   a rule somebody is relying on and nobody is checking, and this product's own house rule is
 *   that a pass means the expected behaviour was observed.
 *
 * A step whose rule was written for another screen is also inconclusive rather than evaluated.
 * The designer matches rules to pages, so that should not happen; if it ever does — a rule
 * edited after a suite was generated, a redirect landing somewhere else — the run says so
 * rather than checking an invoice rule against a driver record and reporting whatever it finds.
 */
export async function assertBusinessRule(page: Page, ruleText: string | undefined): Promise<void> {
  const { rules, problems } = parseRules(ruleText ?? '');

  if (rules.length === 0) {
    const why = problems.length > 0
      ? problems.map(p => `line ${p.line}: ${p.problem}`).join('; ')
      : 'the step carried no rule';
    throw new InconclusiveError(`Not evaluated: this rule could not be read — ${why}.`);
  }

  const rule = rules[0]!;
  if (problems.length > 0) {
    throw new InconclusiveError(
      `Not evaluated: ${rule.id} could not be read — `
      + `${problems.map(p => `line ${p.line}: ${p.problem}`).join('; ')}.`);
  }

  const here = page.url();
  if (rulesFor([rule], here).length === 0) {
    throw new InconclusiveError(
      `Not evaluated: ${rule.id} is about ${rule.screen} and this step ran on ${here}. `
      + 'A rule is not checked against a screen it was not written for.');
  }

  if (rule.kind === 'submission') return await checkSubmissionRule(page, rule);

  const { values, ambiguous, texts } = namedValuesFrom(await readNamedValues(page));
  const outcome = checkRule(rule, values, texts);

  if (outcome.outcome === 'held') return;

  // The rule's own `when` line says it is not about this instance of the screen. Not a pass —
  // nothing was checked — and emphatically not a failure.
  if (outcome.outcome === 'notApplicable') throw new InconclusiveError(outcome.detail);

  // A name the screen offered twice with two figures was dropped rather than guessed at. Say
  // so, because otherwise "this screen does not show 'total'" is baffling on a screen that
  // plainly shows one.
  const dropped = ambiguous.length === 0 ? ''
    : ` This screen shows ${ambiguous.map(n => `'${n}'`).join(', ')} more than once with`
      + ' different figures, so it was not used: two places disagreeing is not a value.';

  if (outcome.outcome === 'cannotTell') throw new InconclusiveError(outcome.detail + dropped);
  throw new OracleError(outcome.detail);
}


/**
 * Checks a rule about what a submission must be refused.
 *
 * The commonest serious defect there is: a form disables its own submit button when a value
 * breaks a rule, and the handler behind it has no equivalent check, so anything that is not a
 * browser is accepted. Nothing on the screen is wrong — the screen is doing its job — and no
 * amount of reading figures finds it.
 *
 * Which form is used is decided by the fields the rule names, not by taking the first form on
 * the page. A page with a search box above the form that matters would otherwise have its
 * search submitted instead, and a wrong submission gets refused, which this check would then
 * report as the server enforcing a rule it has never heard of. Where no form holds the named
 * fields, or more than one does, the result is inconclusive naming them.
 *
 * It sends a request. That makes it the one rule kind that changes the application when the
 * application is wrong, which is exactly the case it exists to detect, so it runs only where
 * the run is authorised to interact.
 */
export async function checkSubmissionRule(page: Page, rule: SubmissionRule): Promise<void> {
  const wanted = rule.submit.map(([field]) => field);

  const forms = await page.evaluate((names: string[]) => {
    const folded = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = names.map(folded);
    return Array.from(document.querySelectorAll('form')).map((form, index) => {
      // Folded name → the name the form itself declares. The override has to be keyed by the
      // form's own spelling, or the field keeps its value and the forced one rides along as an
      // extra key: a submission that goes out looking right and carries nothing the rule asked
      // for, which the endpoint then accepts or refuses for reasons of its own.
      const held = new Map<string, string>();
      for (const control of Array.from(form.elements)) {
        const name = (control as HTMLInputElement).name;
        if (name && !held.has(folded(name))) held.set(folded(name), name);
      }
      return { index, holdsAll: target.every(name => held.has(name)),
               declared: [...held], names: [...held.values()] };
    });
  }, wanted);

  const candidates = forms.filter(form => form.holdsAll);

  if (candidates.length === 0) {
    const offered = [...new Set(forms.flatMap(form => form.names))].sort();
    throw new InconclusiveError(
      `Not evaluated: no form on this screen carries ${wanted.map(f => `'${f}'`).join(', ')}, `
      + `which ${rule.id} submits. The fields this screen's forms do carry: `
      + `${offered.length === 0 ? 'none at all' : offered.map(f => `'${f}'`).join(', ')}. `
      + 'A submission cannot be sent to a form that would not accept it.'
    );
  }

  if (candidates.length > 1) {
    throw new InconclusiveError(
      `Not evaluated: ${candidates.length} forms on this screen carry every field `
      + `${rule.id} submits, and sending to the wrong one would be refused for the wrong `
      + 'reason — which would read exactly like the rule being enforced. Name the fields more '
      + 'precisely, or state the rule against a screen with one such form.'
    );
  }

  const declared = new Map(candidates[0]!.declared);
  const overrides: Record<string, string> = {};
  for (const [field, value] of rule.submit) {
    // Keyed by the form's own spelling, which is how the form was matched in the first place.
    overrides[declared.get(normaliseName(field)) ?? field] = value;
  }

  const outcome = await submitDirectly(page, {
    form: { strategy: 'css', value: 'form', nth: candidates[0]!.index },
    overrides,
    rule: rule.means || rule.id
  });

  const submitted = rule.submit.map(([field, value]) => `${field}=${value}`).join(', ');

  if (outcome.verdict === 'failed') {
    // Neither verdict is true: the application did not accept the value and did not reject it.
    throw new OracleError(
      `${rule.means || rule.id} — submitting ${submitted} made the application fail rather than `
      + `decide. ${outcome.detail}`
    );
  }

  if (outcome.verdict === rule.mustBe) return;

  throw new OracleError(
    `${rule.means || rule.id} — submitting ${submitted} was ${outcome.verdict} where the rule `
    + `says it must be ${rule.mustBe}. ${outcome.detail}`
  );
}
