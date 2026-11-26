/**
 * Business rules an application's owner states, so the product can check them.
 *
 * ## The gap this closes
 *
 * An invoice adds a fuel surcharge to the gross amount. The company's rule is that it goes on
 * the net. Nothing on the page is broken, no error appears, every field validates, and the
 * arithmetic is internally consistent — the total really is the sum of its lines. The only
 * way to know it is wrong is to have been told the rule.
 *
 * Five of the defects planted in the freight lab are that shape: a surcharge on gross rather
 * than net, a rate band boundary off by one, duty computed without freight, a credit note
 * exceeding the invoice it credits, a credit limit that does not hold. No testing tool finds
 * any of them unaided, and the product's own measurement has carried them as misses for weeks
 * without being able to say why in one sentence.
 *
 * So the owner writes them down, and this reads what they wrote.
 *
 * ## What a rule looks like
 *
 *     rule SURCHARGE_ON_NET
 *       on      /billing/invoices/new
 *       means   The fuel surcharge applies to the net amount, not the gross.
 *       expect  surcharge == net * 0.085
 *       within  0.01
 *
 * `on` is the screen. `means` is for the person reading the report, never parsed. `expect` is
 * the rule itself, and `within` is the rounding it tolerates.
 *
 * ## Three outcomes, not two
 *
 * A rule holds, or it is broken, or **it could not be told** — and the third is the one that
 * makes this honest. If the page does not show a field the rule names, the answer is not a
 * pass and not a failure: it is "I could not find `net` on this screen", with the names it
 * did find. A rule that quietly passes because its field was missing is worse than no rule,
 * because somebody is relying on it.
 *
 * ## No eval
 *
 * The expression is tokenised and parsed into a tree, and the tree is walked. Running a
 * customer's text through `eval` would be a remote code execution hole in a product whose job
 * is finding them, and there is no version of that trade that is worth making.
 */

// ---------------------------------------------------------------------------
// The parsed shape
// ---------------------------------------------------------------------------

export type Comparison = '==' | '!=' | '<=' | '>=' | '<' | '>';

/**
 * How a field name in a rule is matched to a name on a screen: letters and digits only, folded
 * to lower case.
 *
 * `Fuel surcharge`, `fuelSurcharge`, `fuel_surcharge` and `FUEL-SURCHARGE` are one name, so the
 * owner can write the rule the way the screen reads or the way the code reads and get the same
 * answer. `surcharge` is a **different** name and does not match `Fuel surcharge`: matching on
 * a fragment is how a rule about the order total silently gets checked against the line total.
 */
export const normaliseName = (name: string): string =>
  String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export type Expression =
  | { kind: 'number'; value: number }
  | { kind: 'field'; name: string }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/'; left: Expression; right: Expression }
  | { kind: 'negate'; of: Expression };

/** A condition that decides whether a rule applies to the screen in front of it. */
export interface RulePrecondition {
  /** The name of something the screen shows, as the owner wrote it. */
  field: string;
  /** The text it must read, compared without case. */
  is: string;
  /** True for `is not`. */
  negated: boolean;
}

/** What every rule carries, whatever kind it is. */
export interface RuleIdentity {
  id: string;
  /** The screen the rule is about, as the owner wrote it. */
  screen: string;
  /** What the rule means, in the owner's words. Printed in reports, never parsed. */
  means: string;
  /**
   * What has to be true of the screen for the rule to apply at all. Null when the rule applies
   * to every instance of its screen.
   *
   * Customs duty is the case that forced this. On a shipment whose incoterm includes freight,
   * the value for duty is goods plus freight; on one where it does not, goods alone is correct.
   * The same screen renders both, so a rule without a precondition would report every FOB
   * declaration as a defect — a false failure, which is the one outcome this product cannot
   * afford.
   */
  when: RulePrecondition | null;
  /** The line the rule started on, so a problem can be pointed at. */
  line: number;
  /** The rule as written, for the report. */
  expression: string;
}

/**
 * A rule about the figures a screen shows: `expect fuelSurcharge == invoiceNet * 0.115`.
 *
 * Checked by reading the screen, with no submission and nothing changed. The great majority of
 * stated rules are this kind.
 */
export interface CalculationRule extends RuleIdentity {
  kind: 'calculation';
  comparison: Comparison;
  left: Expression;
  right: Expression;
  /** Rounding this rule tolerates. Money needs it; a count does not. */
  within: number;
}

/**
 * A rule about what a submission must be refused:
 *
 *     rule CREDIT_NOTE_CAP
 *       on      /billing/credit-notes/new
 *       means   A credit note can never be raised for more than the invoice it credits.
 *       submit  amount = 50000
 *       expect  refused
 *
 * A different shape entirely, and the one that reaches the commonest serious defect there is:
 * the form disables its own submit button and the handler behind it has no equivalent check, so
 * anything that does not go through the browser is accepted. Nothing on the screen is wrong —
 * the screen is doing its job — and no amount of reading figures finds it.
 *
 * This kind **sends a request**, so it only runs where the run is authorised to interact.
 */
export interface SubmissionRule extends RuleIdentity {
  kind: 'submission';
  /** Field name → the value to force, in the order written. */
  submit: Array<[string, string]>;
  /** What the application must do with it. */
  mustBe: 'refused' | 'accepted';
}

export type BusinessRule = CalculationRule | SubmissionRule;

export interface RuleProblem {
  line: number;
  /** What was wrong, in terms the person who wrote the file can act on. */
  problem: string;
  /** The text that could not be read. */
  text: string;
}

/** The default rounding for a money comparison: a penny. */
const DEFAULT_WITHIN = 0.01;

// ---------------------------------------------------------------------------
// The expression language
// ---------------------------------------------------------------------------

type Token =
  | { type: 'number'; value: number; at: number }
  | { type: 'field'; name: string; at: number }
  | { type: 'operator'; value: string; at: number };

const OPERATORS = ['==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '(', ')'];

/** Splits an expression into tokens, refusing anything it does not recognise. */
export function tokenise(text: string): { tokens: Token[]; problem: string | null } {
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    const char = text[i]!;
    if (/\s/.test(char)) { i += 1; continue; }

    // Two-character operators first, so '<=' is not read as '<' then '='.
    const two = text.slice(i, i + 2);
    if (OPERATORS.includes(two)) { tokens.push({ type: 'operator', value: two, at: i }); i += 2; continue; }
    if (OPERATORS.includes(char)) { tokens.push({ type: 'operator', value: char, at: i }); i += 1; continue; }

    const number = /^\d+(\.\d+)?/.exec(text.slice(i));
    if (number) {
      tokens.push({ type: 'number', value: Number(number[0]), at: i });
      i += number[0].length;
      continue;
    }

    // A field name: a letter, then letters, digits, underscores, dashes or dots.
    const name = /^[A-Za-z][A-Za-z0-9_.-]*/.exec(text.slice(i));
    if (name) {
      tokens.push({ type: 'field', name: name[0], at: i });
      i += name[0].length;
      continue;
    }

    return { tokens, problem: `'${char}' is not something a rule can contain (at character ${i + 1})` };
  }

  return { tokens, problem: null };
}

/**
 * Parses `left <comparison> right` into two trees.
 *
 * Recursive descent, so multiplication binds tighter than addition and parentheses work. No
 * `eval`, no `new Function`, nothing that turns the customer's text into code.
 */
export function parseExpression(text: string):
  { comparison: Comparison; left: Expression; right: Expression } | { problem: string } {
  const { tokens, problem } = tokenise(text);
  if (problem !== null) return { problem };
  if (tokens.length === 0) return { problem: 'the rule is empty' };

  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];

  const parsePrimary = (): Expression | { problem: string } => {
    const token = peek();
    if (token === undefined) return { problem: 'the rule stops in the middle of a calculation' };

    if (token.type === 'number') { take(); return { kind: 'number', value: token.value }; }
    if (token.type === 'field') { take(); return { kind: 'field', name: token.name }; }

    if (token.value === '-') {
      take();
      const of = parsePrimary();
      if ('problem' in of) return of;
      return { kind: 'negate', of };
    }
    if (token.value === '(') {
      take();
      const inner = parseSum();
      if ('problem' in inner) return inner;
      const closing = peek();
      if (closing === undefined || closing.type !== 'operator' || closing.value !== ')') {
        return { problem: 'a bracket was opened and never closed' };
      }
      take();
      return inner;
    }
    return { problem: `'${token.type === 'operator' ? token.value : ''}' cannot start a calculation` };
  };

  const parseProduct = (): Expression | { problem: string } => {
    let left = parsePrimary();
    if ('problem' in left) return left;
    for (;;) {
      const token = peek();
      if (token === undefined || token.type !== 'operator') break;
      if (token.value !== '*' && token.value !== '/') break;
      take();
      const right = parsePrimary();
      if ('problem' in right) return right;
      left = { kind: 'binary', operator: token.value as '*' | '/', left, right };
    }
    return left;
  };

  const parseSum = (): Expression | { problem: string } => {
    let left = parseProduct();
    if ('problem' in left) return left;
    for (;;) {
      const token = peek();
      if (token === undefined || token.type !== 'operator') break;
      if (token.value !== '+' && token.value !== '-') break;
      take();
      const right = parseProduct();
      if ('problem' in right) return right;
      left = { kind: 'binary', operator: token.value as '+' | '-', left, right };
    }
    return left;
  };

  const left = parseSum();
  if ('problem' in left) return left;

  const operator = peek();
  if (operator === undefined || operator.type !== 'operator'
      || !['==', '!=', '<=', '>=', '<', '>'].includes(operator.value)) {
    return { problem: 'a rule has to compare two things, with ==, !=, <=, >=, < or >' };
  }
  take();

  const right = parseSum();
  if ('problem' in right) return right;

  if (at !== tokens.length) {
    return { problem: 'there is more after the comparison than the rule can read' };
  }

  return { comparison: operator.value as Comparison, left, right };
}

/** Every field name a rule depends on, so a caller knows what to read off the page. */
export function fieldsIn(expression: Expression): string[] {
  switch (expression.kind) {
    case 'field': return [expression.name];
    case 'number': return [];
    case 'negate': return fieldsIn(expression.of);
    case 'binary': return [...new Set([...fieldsIn(expression.left), ...fieldsIn(expression.right)])];
  }
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/**
 * Reads a rules file.
 *
 * Forgiving about layout and strict about mistakes: every problem names the line and says what
 * was expected, because a rule nobody noticed was malformed is a rule nobody is checking.
 */
export function parseRules(text: string): { rules: BusinessRule[]; problems: RuleProblem[] } {
  const rules: BusinessRule[] = [];
  const problems: RuleProblem[] = [];

  const lines = String(text ?? '').split(/\r?\n/);
  // `sawExpect` is separate from `expression` so that an unreadable expect line draws one
  // complaint (what was wrong with it) and not a second saying the rule has no expectation.
  /**
   * A rule being read, before its kind is known.
   *
   * The kind is decided by what follows `expect`: a comparison makes a calculation rule, the
   * words `refused` or `accepted` make a submission rule. Reading into one loose draft and
   * deciding at the end beats guessing from the first line, because the lines may come in any
   * order and an owner who writes `expect` before `submit` means the same thing.
   *
   * `sawExpect` is separate from the expectation so that an unreadable `expect` line draws one
   * complaint — what was wrong with it — and not a second saying the rule has no expectation.
   */
  interface Draft {
    id: string;
    screen: string;
    means: string;
    within: number;
    when: RulePrecondition | null;
    line: number;
    sawExpect: boolean;
    expression: string;
    comparison?: Comparison;
    left?: Expression;
    right?: Expression;
    submit: Array<[string, string]>;
    mustBe?: 'refused' | 'accepted';
  }

  let current: Draft | null = null;

  const finish = () => {
    if (current === null) return;
    const draft = current;
    current = null;

    const { id, screen, line } = draft;
    const identity = { id, screen, means: draft.means, when: draft.when, line,
                       expression: draft.expression };

    if (!screen) {
      problems.push({ line, text: '',
        problem: `rule ${id} does not say which screen it is about (expected an 'on' line)` });
      return;
    }

    if (draft.mustBe !== undefined) {
      if (draft.submit.length === 0) {
        problems.push({ line, text: '',
          problem: `rule ${id} says a submission must be ${draft.mustBe} but does not say what to `
            + "submit (expected a 'submit <field> = <value>' line)" });
        return;
      }
      rules.push({ ...identity, kind: 'submission', submit: draft.submit, mustBe: draft.mustBe });
      return;
    }

    if (draft.submit.length > 0 && !draft.sawExpect) {
      problems.push({ line, text: '',
        problem: `rule ${id} says what to submit but not what must happen to it `
          + "(expected 'expect refused' or 'expect accepted')" });
      return;
    }

    if (draft.comparison === undefined) {
      // An `expect` line that could not be read has already been reported against its own line.
      if (!draft.sawExpect) {
        problems.push({ line, text: '',
          problem: `rule ${id} does not say what to expect (expected an 'expect' line)` });
      }
      return;
    }

    rules.push({ ...identity, kind: 'calculation', within: draft.within,
                 comparison: draft.comparison, left: draft.left!, right: draft.right! });
  };

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') return;

    const ruleStart = /^rule\s+(\S+)$/i.exec(line);
    if (ruleStart) {
      finish();
      current = { id: ruleStart[1]!, screen: '', means: '', within: DEFAULT_WITHIN, when: null,
                  line: lineNumber, sawExpect: false, expression: '', submit: [] };
      return;
    }

    const keyed = /^(on|means|expect|within|when|submit)\s*:?\s+(.+)$/i.exec(line);
    if (!keyed) {
      problems.push({ line: lineNumber, text: raw.trim(),
        problem: "expected 'rule <name>', or an 'on', 'means', 'when', 'submit', 'expect' or "
          + "'within' line" });
      return;
    }
    if (current === null) {
      problems.push({ line: lineNumber, text: raw.trim(),
        problem: `'${keyed[1]}' appears before any 'rule <name>' line` });
      return;
    }

    const key = keyed[1]!.toLowerCase();
    const value = keyed[2]!.trim();

    if (key === 'on') current.screen = value;
    else if (key === 'means') current.means = value;
    else if (key === 'when') {
      // `when <something the screen shows> is <text>`, or `is not <text>`.
      const condition = /^(.+?)\s+is\s+(not\s+)?(.+)$/i.exec(value);
      if (!condition) {
        problems.push({ line: lineNumber, text: raw.trim(),
          problem: `rule ${current.id}: a 'when' line reads '<what the screen shows> is <text>', `
            + `and '${value}' is not that shape` });
      } else {
        current.when = {
          field: condition[1]!.trim(),
          is: condition[3]!.trim(),
          negated: condition[2] !== undefined
        };
      }
    }
    else if (key === 'within') {
      const within = Number(value);
      if (!Number.isFinite(within) || within < 0) {
        problems.push({ line: lineNumber, text: raw.trim(),
          problem: `'within' needs a number that is not negative, and '${value}' is not one` });
      } else current.within = within;
    }
    else if (key === 'submit') {
      // `submit amount = 50000, invoice = INV-2026-5000`. Values are text, sent as the form
      // would send them; nothing here is evaluated.
      for (const pair of value.split(',')) {
        const assignment = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(pair);
        if (!assignment) {
          problems.push({ line: lineNumber, text: raw.trim(),
            problem: `rule ${current.id}: a 'submit' line reads `
              + `'<field> = <value>, <field> = <value>', and '${pair.trim()}' is not that shape` });
          continue;
        }
        current.submit.push([assignment[1]!, assignment[2]!]);
      }
      current.expression = current.expression === ''
        ? `submit ${value}` : `${current.expression}; submit ${value}`;
    }
    else {
      current.sawExpect = true;

      // `expect refused` and `expect accepted` make this a rule about a submission rather than
      // about the figures on a screen.
      const verdict = /^(refused|rejected|accepted|allowed)$/i.exec(value);
      if (verdict) {
        const word = verdict[1]!.toLowerCase();
        current.mustBe = word === 'refused' || word === 'rejected' ? 'refused' : 'accepted';
        current.expression = current.expression === ''
          ? `must be ${current.mustBe}` : `${current.expression} — must be ${current.mustBe}`;
        return;
      }

      const parsed = parseExpression(value);
      if ('problem' in parsed) {
        problems.push({ line: lineNumber, text: raw.trim(),
          problem: `rule ${current.id} cannot be read: ${parsed.problem}` });
      } else {
        current.comparison = parsed.comparison;
        current.left = parsed.left;
        current.right = parsed.right;
        current.expression = value;
      }
    }
  });

  finish();

  // A duplicate id means one rule's result overwrites another's in any report keyed by it.
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      problems.push({ line: rule.line, text: `rule ${rule.id}`,
        problem: `two rules are both called ${rule.id}, so one would hide the other` });
    }
    seen.add(rule.id);
  }

  return { rules, problems };
}

// ---------------------------------------------------------------------------
// Checking one
// ---------------------------------------------------------------------------

export type RuleOutcome =
  | { outcome: 'held'; detail: string; left: number; right: number }
  | { outcome: 'broken'; detail: string; left: number; right: number; by: number }
  | { outcome: 'cannotTell'; detail: string; missing: string[]; found: string[] }
  /** The rule's `when` line says it is not about this instance of the screen. */
  | { outcome: 'notApplicable'; detail: string };

const evaluate = (expression: Expression, values: Map<string, number>): number => {
  switch (expression.kind) {
    case 'number': return expression.value;
    case 'field': return values.get(normaliseName(expression.name))!;
    case 'negate': return -evaluate(expression.of, values);
    case 'binary': {
      const left = evaluate(expression.left, values);
      const right = evaluate(expression.right, values);
      switch (expression.operator) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return right === 0 ? Number.NaN : left / right;
      }
    }
  }
};

const holds = (comparison: Comparison, left: number, right: number, within: number): boolean => {
  switch (comparison) {
    case '==': return Math.abs(left - right) <= within;
    case '!=': return Math.abs(left - right) > within;
    case '<=': return left <= right + within;
    case '>=': return left >= right - within;
    case '<': return left < right + within;
    case '>': return left > right - within;
  }
};

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Checks one rule against the values read off a screen.
 *
 * Returns `cannotTell` rather than a verdict whenever a field the rule names is not among the
 * values, naming what was missing and what was there. That is the whole reason this is
 * trustworthy: a rule that passes because its field was absent is a rule somebody is relying
 * on and nobody is checking.
 *
 * The incoming names are folded here rather than assumed to be folded already. A caller that
 * passed `{ orderTotal: 9000 }` against a rule reading `orderTotal <= creditLimit` would
 * otherwise get a confident "could not tell" for a screen that plainly showed both figures —
 * silence that looks exactly like honesty and is not.
 */
export function checkRule(
  rule: CalculationRule,
  supplied: Map<string, number>,
  /** The text of everything the screen shows by name, for a `when` line. Numbers are in
   *  `supplied`; a precondition is usually about a word — an incoterm, a status, a flag. */
  texts: Map<string, string> = new Map()
): RuleOutcome {
  const values = new Map<string, number>();
  for (const [name, value] of supplied) values.set(normaliseName(name), value);

  // `?? null` rather than `!== null`: a rule built by hand, or read from an older stored test,
  // may carry no precondition field at all, and that must mean "applies always" rather than
  // throwing halfway through a run.
  const when = rule.when ?? null;
  if (when !== null) {
    const folded = new Map<string, string>();
    for (const [name, text] of texts) folded.set(normaliseName(name), text.trim());
    // A number the screen shows is also a text for this purpose, so `when status is 0` works.
    for (const [name, value] of values) if (!folded.has(name)) folded.set(name, String(value));

    const key = normaliseName(when.field);
    const actual = folded.get(key);
    if (actual === undefined) {
      return {
        outcome: 'cannotTell', missing: [when.field], found: [...texts.keys()].sort(),
        detail: `Not evaluated: ${rule.id} applies only when '${when.field}' reads `
          + `'${when.is}', and this screen does not show '${when.field}' at all. `
          + 'A precondition that cannot be read is not a precondition that was met.'
      };
    }

    const same = actual.toLowerCase() === when.is.trim().toLowerCase();
    if (same === when.negated) {
      return {
        outcome: 'notApplicable',
        detail: `Not applicable: ${rule.id} applies when '${when.field}' is `
          + `${when.negated ? 'not ' : ''}'${when.is}', and here it reads '${actual}'.`
      };
    }
  }

  const needed = [...new Set([...fieldsIn(rule.left), ...fieldsIn(rule.right)])];
  // Reported as the owner wrote them, matched as names fold.
  const missing = needed.filter(name => {
    const key = normaliseName(name);
    return !values.has(key) || !Number.isFinite(values.get(key)!);
  });

  if (missing.length > 0) {
    const found = [...supplied.keys()].sort();
    return {
      outcome: 'cannotTell',
      missing,
      found,
      detail: `Not evaluated: this screen does not show ${missing.map(m => `'${m}'`).join(', ')}, `
        + `which ${rule.id} is about. What the screen does show: `
        + `${found.length === 0 ? 'no numbered values at all' : found.map(f => `'${f}'`).join(', ')}. `
        + 'A rule whose fields cannot be found is not a rule that passed.'
    };
  }

  const left = round(evaluate(rule.left, values));
  const right = round(evaluate(rule.right, values));

  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return {
      outcome: 'cannotTell', missing: [], found: [...supplied.keys()].sort(),
      detail: `Not evaluated: ${rule.id} works out to something that is not a number — `
        + 'most often a division by zero on this screen\'s values.'
    };
  }

  const shape = `${rule.expression} → ${left} ${rule.comparison} ${right}`;

  if (holds(rule.comparison, left, right, rule.within)) {
    return { outcome: 'held', left, right,
             detail: `${rule.means || rule.id} holds: ${shape}.` };
  }

  const by = round(Math.abs(left - right));
  return {
    outcome: 'broken', left, right, by,
    detail: `${rule.means || rule.id} does not hold: ${shape}, which is out by ${by}`
      + `${rule.within > 0 ? ` and the rule allows ${rule.within}` : ''}.`
  };
}

/** The rules that apply to one screen, matched on the address the owner wrote. */
export function rulesFor(rules: readonly BusinessRule[], route: string): BusinessRule[] {
  const normalise = (value: string) => {
    let path = String(value ?? '').trim();
    try { path = new URL(path).pathname; } catch { /* already a path */ }
    return (path.split('?')[0] ?? '').replace(/\/+$/, '').toLowerCase() || '/';
  };
  const wanted = normalise(route);
  const templated = (screen: string) => /\{[^}]+\}|\/:[a-z0-9_]+/i.test(screen);

  // A template must not swallow a segment another rule names outright. /billing/invoices/{id}
  // is about one invoice; /billing/invoices/new is the blank form, and a rule about the one is
  // not a rule about the other. Where some rule claims this exact address, the templates stand
  // aside — the owner has already said what this screen is.
  const claimedByName = rules.some(rule => normalise(rule.screen) === wanted);

  return rules.filter(rule => {
    const screen = normalise(rule.screen);
    if (screen === wanted) return true;
    if (!templated(screen) || claimedByName) return false;
    const pattern = screen.replace(/\{[^}]+\}|:[a-z0-9_]+/gi, '[^/]+');
    return new RegExp(`^${pattern}$`).test(wanted);
  });
}
