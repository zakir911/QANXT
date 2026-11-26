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

export interface BusinessRule {
  id: string;
  /** The screen the rule is about, as the owner wrote it. */
  screen: string;
  /** What the rule means, in the owner's words. Printed in reports, never parsed. */
  means: string;
  comparison: Comparison;
  left: Expression;
  right: Expression;
  /** Rounding this rule tolerates. Money needs it; a count does not. */
  within: number;
  /** The line the rule started on, so a problem can be pointed at. */
  line: number;
  /** The expression as written, for the report. */
  expression: string;
}

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
  let current: Partial<BusinessRule> & { line?: number; sawExpect?: boolean } | null = null;

  const finish = () => {
    if (current === null) return;
    const { id, screen, expression, line } = current;
    if (!screen) {
      problems.push({ line: line ?? 0, problem: `rule ${id} does not say which screen it is about (expected an 'on' line)`, text: '' });
    } else if (!expression) {
      if (!current.sawExpect) {
        problems.push({ line: line ?? 0, text: '',
          problem: `rule ${id} does not say what to expect (expected an 'expect' line)` });
      }
    } else {
      rules.push(current as BusinessRule);
    }
    current = null;
  };

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') return;

    const ruleStart = /^rule\s+(\S+)$/i.exec(line);
    if (ruleStart) {
      finish();
      current = { id: ruleStart[1]!, means: '', within: DEFAULT_WITHIN, line: lineNumber };
      return;
    }

    const keyed = /^(on|means|expect|within)\s*:?\s+(.+)$/i.exec(line);
    if (!keyed) {
      problems.push({ line: lineNumber, text: raw.trim(),
        problem: "expected 'rule <name>', or an 'on', 'means', 'expect' or 'within' line" });
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
    else if (key === 'within') {
      const within = Number(value);
      if (!Number.isFinite(within) || within < 0) {
        problems.push({ line: lineNumber, text: raw.trim(),
          problem: `'within' needs a number that is not negative, and '${value}' is not one` });
      } else current.within = within;
    } else {
      current.sawExpect = true;
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
  | { outcome: 'cannotTell'; detail: string; missing: string[]; found: string[] };

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
export function checkRule(rule: BusinessRule, supplied: Map<string, number>): RuleOutcome {
  const values = new Map<string, number>();
  for (const [name, value] of supplied) values.set(normaliseName(name), value);

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
