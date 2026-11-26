import { describe, expect, test } from 'vitest';
import {
  checkRule, fieldsIn, parseExpression, parseRules, rulesFor, tokenise,
  type BusinessRule
} from '../src/execution/business-rules.js';

/**
 * Rules the application's owner states, and the product checks.
 *
 * The capability exists because of a class of defect nothing else reaches. An invoice adds a
 * fuel surcharge to the gross amount; the company's rule is that it goes on the net. No field
 * is invalid, no error appears, the total really is the sum of its lines. The only way to know
 * is to have been told.
 *
 * Two properties matter more than any individual rule, and most of these tests are about them:
 *
 * 1. **A missing field is never a pass.** If the screen does not show what the rule names, the
 *    answer is "could not tell", naming what was missing. A rule that passes because its field
 *    was absent is a rule somebody is relying on and nobody is checking.
 * 2. **No eval.** The expression is tokenised and parsed. Customer text never becomes code in
 *    a product whose job is finding exactly that hole.
 */

const rule = (expression: string, over: Partial<BusinessRule> = {}): BusinessRule => {
  const parsed = parseExpression(expression);
  if ('problem' in parsed) throw new Error(`fixture does not parse: ${parsed.problem}`);
  return { id: 'R', screen: '/x', means: '', within: 0.01, line: 1, expression, ...parsed, ...over };
};

const values = (pairs: Record<string, number>) => new Map(Object.entries(pairs));

describe('reading an expression', () => {
  test('a plain comparison of two fields', () => {
    const parsed = parseExpression('total == net');
    expect(parsed).toMatchObject({
      comparison: '==',
      left: { kind: 'field', name: 'total' },
      right: { kind: 'field', name: 'net' }
    });
  });

  test('multiplication binds tighter than addition', () => {
    // net + tax * rate must be net + (tax * rate), or every tax rule in the file is wrong.
    const parsed = parseExpression('gross == net + tax * 2');
    if ('problem' in parsed) throw new Error(parsed.problem);
    expect(parsed.right).toMatchObject({
      operator: '+',
      left: { kind: 'field', name: 'net' },
      right: { operator: '*', left: { kind: 'field', name: 'tax' }, right: { kind: 'number', value: 2 } }
    });
  });

  test('brackets override precedence', () => {
    const parsed = parseExpression('duty == (goods + freight) * 0.05');
    if ('problem' in parsed) throw new Error(parsed.problem);
    expect(parsed.right).toMatchObject({
      operator: '*',
      left: { operator: '+' }
    });
  });

  test('subtraction is left-associative, so a - b - c is (a - b) - c', () => {
    const parsed = parseExpression('x == 10 - 3 - 2');
    if ('problem' in parsed) throw new Error(parsed.problem);
    expect(checkRule(rule('x == 10 - 3 - 2'), values({ x: 5 })).outcome).toBe('held');
  });

  test('every comparison the language offers', () => {
    for (const operator of ['==', '!=', '<=', '>=', '<', '>']) {
      const parsed = parseExpression(`a ${operator} b`);
      expect(parsed).toMatchObject({ comparison: operator });
    }
  });

  test('a decimal rate', () => {
    expect(parseExpression('surcharge == net * 0.085')).toMatchObject({
      right: { operator: '*', right: { kind: 'number', value: 0.085 } }
    });
  });

  test('a negative number', () => {
    expect(checkRule(rule('balance == -50'), values({ balance: -50 })).outcome).toBe('held');
  });

  test('field names may carry dots and dashes, as page fields do', () => {
    const parsed = parseExpression('invoice.total == line-amount');
    if ('problem' in parsed) throw new Error(parsed.problem);
    expect(fieldsIn(parsed.left)).toEqual(['invoice.total']);
    expect(fieldsIn(parsed.right)).toEqual(['line-amount']);
  });

  test('fieldsIn does not repeat a field used twice', () => {
    const parsed = parseExpression('a == a + a');
    if ('problem' in parsed) throw new Error(parsed.problem);
    expect(fieldsIn(parsed.right)).toEqual(['a']);
  });
});

describe('refusing an expression it cannot read', () => {
  test('no comparison at all', () => {
    expect(parseExpression('net + tax')).toMatchObject({
      problem: expect.stringContaining('compare two things')
    });
  });

  test('an unclosed bracket', () => {
    expect(parseExpression('a == (b + c')).toMatchObject({
      problem: expect.stringContaining('never closed')
    });
  });

  test('a character the language does not have', () => {
    expect(parseExpression('a == b % c')).toMatchObject({ problem: expect.stringContaining("'%'") });
  });

  test('two comparisons chained', () => {
    // a < b < c reads naturally and means nothing here. Refuse it rather than guess.
    expect(parseExpression('a < b < c')).toMatchObject({
      problem: expect.stringContaining('more after the comparison')
    });
  });

  test('an operator with nothing after it', () => {
    expect(parseExpression('a == b +')).toMatchObject({
      problem: expect.stringContaining('stops in the middle')
    });
  });

  test('an empty expression', () => {
    expect(parseExpression('   ')).toMatchObject({ problem: 'the rule is empty' });
  });

  test('a lone operator cannot start a calculation', () => {
    expect(parseExpression('* a == b')).toMatchObject({ problem: expect.stringContaining('cannot start') });
  });

  test('nothing in the language reaches a function call, so eval has no surface', () => {
    // The whole point: there is no path from customer text to executed code.
    for (const attack of [
      'a == process.exit(1)',
      'a == require("fs")',
      'a == `${x}`',
      'a == b; drop table invoices',
      'a == constructor'
    ]) {
      const parsed = parseExpression(attack);
      if ('problem' in parsed) continue;
      // Where it does parse (bare names are legal fields) it can only ever be a field read.
      expect(fieldsIn(parsed.right).every(name => typeof name === 'string')).toBe(true);
      expect(checkRule(rule(attack), new Map()).outcome).toBe('cannotTell');
    }
  });

  test('tokenise reports where the trouble is', () => {
    const { problem } = tokenise('a == b @ c');
    expect(problem).toContain('character 8');
  });
});

describe('reading a rules file', () => {
  const file = `
# Meridian Freight business rules

rule SURCHARGE_ON_NET
  on      /billing/invoices/new
  means   The fuel surcharge applies to the net amount, not the gross.
  expect  surcharge == net * 0.085
  within  0.01

rule CREDIT_NOTE_CAP
  on: /billing/credit-notes/new
  means: A credit note can never exceed the invoice it credits.
  expect: creditAmount <= invoiceTotal
`;

  test('both rules are read', () => {
    const { rules, problems } = parseRules(file);
    expect(problems).toEqual([]);
    expect(rules.map(r => r.id)).toEqual(['SURCHARGE_ON_NET', 'CREDIT_NOTE_CAP']);
  });

  test('colons are optional, because people write both ways', () => {
    const { rules } = parseRules(file);
    expect(rules[1]!.screen).toBe('/billing/credit-notes/new');
    expect(rules[1]!.comparison).toBe('<=');
  });

  test('the owner\'s words are kept for the report and never parsed', () => {
    const { rules } = parseRules(file);
    expect(rules[0]!.means).toBe('The fuel surcharge applies to the net amount, not the gross.');
  });

  test('a rule without `within` gets a penny, which is what money needs', () => {
    const { rules } = parseRules(file);
    expect(rules[1]!.within).toBe(0.01);
  });

  test('comments and blank lines are ignored', () => {
    expect(parseRules('# nothing but a comment\n\n   \n').rules).toEqual([]);
  });

  test('a rule missing its screen is a problem, not a rule', () => {
    const { rules, problems } = parseRules('rule X\n  expect a == b\n');
    expect(rules).toEqual([]);
    expect(problems[0]!.problem).toContain('which screen');
  });

  test('a rule missing its expectation is a problem, not a rule', () => {
    const { rules, problems } = parseRules('rule X\n  on /a\n');
    expect(rules).toEqual([]);
    expect(problems[0]!.problem).toContain('what to expect');
  });

  test('a line before any rule is reported with its number', () => {
    const { problems } = parseRules('on /a\nrule X\n  on /a\n  expect a == b\n');
    expect(problems[0]).toMatchObject({ line: 1, problem: expect.stringContaining('before any') });
  });

  test('a line in no recognised shape names what was expected', () => {
    const { problems } = parseRules('rule X\n  on /a\n  banana\n  expect a == b\n');
    expect(problems[0]).toMatchObject({ line: 3, text: 'banana' });
    expect(problems[0]!.problem).toContain("'expect'");
  });

  test('an unreadable expression is reported against its own line, and the rule is dropped', () => {
    const { rules, problems } = parseRules('rule X\n  on /a\n  expect a + b\n');
    expect(rules).toEqual([]);
    expect(problems[0]).toMatchObject({ line: 3 });
    expect(problems[0]!.problem).toContain('rule X cannot be read');
  });

  test('a nonsense `within` is reported and the default kept', () => {
    const { rules, problems } = parseRules('rule X\n  on /a\n  expect a == b\n  within soon\n');
    expect(problems[0]!.problem).toContain("'within' needs a number");
    expect(rules[0]!.within).toBe(0.01);
  });

  test('a negative `within` is refused, since it would make == unsatisfiable', () => {
    const { problems } = parseRules('rule X\n  on /a\n  expect a == b\n  within -1\n');
    expect(problems[0]!.problem).toContain('not negative');
  });

  test('`within 0` is honoured, for a rule about a count', () => {
    const { rules } = parseRules('rule X\n  on /a\n  expect a == b\n  within 0\n');
    expect(rules[0]!.within).toBe(0);
  });

  test('two rules with one name is reported, because one would hide the other', () => {
    const { problems } = parseRules(
      'rule X\n on /a\n expect a == b\nrule X\n on /c\n expect c == d\n');
    expect(problems[0]!.problem).toContain('both called X');
  });

  test('one bad rule does not cost the good ones', () => {
    const { rules, problems } = parseRules(
      'rule GOOD\n on /a\n expect a == b\nrule BAD\n on /c\n expect c +\n');
    expect(rules.map(r => r.id)).toEqual(['GOOD']);
    expect(problems).toHaveLength(1);
  });

  test('empty input is not an error', () => {
    expect(parseRules('')).toEqual({ rules: [], problems: [] });
  });

  test('a trailing comment on a rule line does not become part of it', () => {
    const { rules } = parseRules('rule X\n on /a   # the new invoice screen\n expect a == b\n');
    expect(rules[0]!.screen).toBe('/a');
  });
});

describe('checking a rule against a screen', () => {
  test('it holds', () => {
    const outcome = checkRule(rule('surcharge == net * 0.085'), values({ surcharge: 85, net: 1000 }));
    expect(outcome.outcome).toBe('held');
    expect(outcome.detail).toContain('85');
  });

  test('it is broken, and the report says by how much', () => {
    // The surcharge on gross rather than net: freight's FP_D06 exactly.
    const outcome = checkRule(
      rule('surcharge == net * 0.085', { means: 'The surcharge applies to the net amount' }),
      values({ surcharge: 93.5, net: 1000, gross: 1100 }));
    expect(outcome.outcome).toBe('broken');
    if (outcome.outcome !== 'broken') return;
    expect(outcome.by).toBe(8.5);
    expect(outcome.detail).toContain('The surcharge applies to the net amount');
    expect(outcome.detail).toContain('does not hold');
  });

  test('a missing field is could-not-tell, never a pass', () => {
    const outcome = checkRule(rule('surcharge == net * 0.085'), values({ surcharge: 85 }));
    expect(outcome.outcome).toBe('cannotTell');
    if (outcome.outcome !== 'cannotTell') return;
    expect(outcome.missing).toEqual(['net']);
    expect(outcome.detail).toContain("'net'");
    expect(outcome.detail).toContain('not a rule that passed');
  });

  test('could-not-tell names what the screen did show, so the rule can be fixed', () => {
    const outcome = checkRule(rule('a == b'), values({ total: 5, vat: 1 }));
    if (outcome.outcome !== 'cannotTell') throw new Error('expected cannotTell');
    expect(outcome.found).toEqual(['total', 'vat']);
    expect(outcome.detail).toContain("'total'");
  });

  test('a screen with no numbers at all says so in words', () => {
    const outcome = checkRule(rule('a == b'), new Map());
    expect(outcome.detail).toContain('no numbered values at all');
  });

  test('a field present but not a number is missing, not zero', () => {
    const outcome = checkRule(rule('a == 5'), values({ a: Number.NaN }));
    expect(outcome.outcome).toBe('cannotTell');
  });

  test('rounding inside `within` holds', () => {
    expect(checkRule(rule('a == b'), values({ a: 100.004, b: 100 })).outcome).toBe('held');
  });

  test('rounding outside `within` breaks', () => {
    expect(checkRule(rule('a == b'), values({ a: 100.02, b: 100 })).outcome).toBe('broken');
  });

  test('a count rule with `within 0` catches an off-by-one', () => {
    const exact = rule('shown == total', { within: 0 });
    expect(checkRule(exact, values({ shown: 24, total: 25 })).outcome).toBe('broken');
  });

  test('floating point does not produce a false failure', () => {
    // 0.1 + 0.2 is 0.30000000000000004. A tool that reports that as a defect is useless.
    expect(checkRule(rule('a == 0.1 + 0.2'), values({ a: 0.3 })).outcome).toBe('held');
  });

  test('a boundary rule at the band edge: the rate band defect', () => {
    // FP_D07's shape: the band is "up to and including 500kg", and the code uses <.
    const atMost = rule('rateApplied <= 500', { within: 0 });
    expect(checkRule(atMost, values({ rateApplied: 500 })).outcome).toBe('held');
    expect(checkRule(atMost, values({ rateApplied: 501 })).outcome).toBe('broken');
  });

  test('a cap rule: a credit note that exceeds its invoice', () => {
    // FP_D09's shape.
    const cap = rule('creditAmount <= invoiceTotal');
    expect(checkRule(cap, values({ creditAmount: 400, invoiceTotal: 1200 })).outcome).toBe('held');
    expect(checkRule(cap, values({ creditAmount: 1500, invoiceTotal: 1200 })).outcome).toBe('broken');
  });

  test('duty computed without freight: the base is wrong, not the rate', () => {
    // FP_D08's shape. Duty should be 5% of goods plus freight.
    const duty = rule('duty == (goods + freight) * 0.05');
    expect(checkRule(duty, values({ duty: 55, goods: 1000, freight: 100 })).outcome).toBe('held');
    const wrong = checkRule(duty, values({ duty: 50, goods: 1000, freight: 100 }));
    expect(wrong.outcome).toBe('broken');
    if (wrong.outcome === 'broken') expect(wrong.by).toBe(5);
  });

  test('a credit limit that does not hold', () => {
    // FP_D05's shape: an order accepted past the customer's limit.
    const limit = rule('orderTotal <= creditLimit');
    expect(checkRule(limit, values({ orderTotal: 9000, creditLimit: 5000 })).outcome).toBe('broken');
  });

  test('a division by zero on this screen is could-not-tell, not a failure', () => {
    const outcome = checkRule(rule('a == b / c'), values({ a: 1, b: 10, c: 0 }));
    expect(outcome.outcome).toBe('cannotTell');
    expect(outcome.detail).toContain('division by zero');
  });

  test('!= holds when the two differ by more than the tolerance', () => {
    expect(checkRule(rule('a != b'), values({ a: 5, b: 9 })).outcome).toBe('held');
    expect(checkRule(rule('a != b'), values({ a: 5, b: 5 })).outcome).toBe('broken');
  });

  test('>= and > at the boundary differ only by the tolerance', () => {
    expect(checkRule(rule('a >= 10', { within: 0 }), values({ a: 10 })).outcome).toBe('held');
    expect(checkRule(rule('a > 10', { within: 0 }), values({ a: 10 })).outcome).toBe('broken');
  });

  test('the detail shows the arithmetic, so a report can be checked by hand', () => {
    const outcome = checkRule(rule('duty == (goods + freight) * 0.05'),
      values({ duty: 50, goods: 1000, freight: 100 }));
    expect(outcome.detail).toContain('(goods + freight) * 0.05');
    expect(outcome.detail).toContain('50 == 55');
  });

  test('with no `means`, the rule id stands in', () => {
    const outcome = checkRule(rule('a == b', { id: 'CAP_01' }), values({ a: 1, b: 2 }));
    expect(outcome.detail).toContain('CAP_01');
  });
});

describe('matching rules to a screen', () => {
  const rules = parseRules(`
rule A
  on /billing/invoices/new
  expect a == b
rule B
  on /billing/invoices/{id}
  expect c == d
rule C
  on /orders/:orderId/lines
  expect e == f
`).rules;

  test('an exact path', () => {
    expect(rulesFor(rules, '/billing/invoices/new').map(r => r.id)).toEqual(['A']);
  });

  test('a trailing slash and a different case still match', () => {
    expect(rulesFor(rules, '/Billing/Invoices/New/').map(r => r.id)).toEqual(['A']);
  });

  test('a full URL matches on its path', () => {
    expect(rulesFor(rules, 'http://localhost:4400/billing/invoices/new').map(r => r.id)).toEqual(['A']);
  });

  test('a query string is ignored', () => {
    expect(rulesFor(rules, '/billing/invoices/new?from=list').map(r => r.id)).toEqual(['A']);
  });

  test('a {id} template matches the address a scan actually visits', () => {
    expect(rulesFor(rules, '/billing/invoices/inv-0004').map(r => r.id)).toEqual(['B']);
  });

  test('a :param template works too, for people who write routes that way', () => {
    expect(rulesFor(rules, '/orders/ord-99/lines').map(r => r.id)).toEqual(['C']);
  });

  test('a template does not match across a slash', () => {
    expect(rulesFor(rules, '/billing/invoices/inv-0004/lines')).toEqual([]);
  });

  test('an unrelated screen gets no rules', () => {
    expect(rulesFor(rules, '/fleet/drivers')).toEqual([]);
  });

  test('"/" is matched, not treated as empty', () => {
    const home = parseRules('rule H\n on /\n expect a == b\n').rules;
    expect(rulesFor(home, 'http://localhost:4400/').map(r => r.id)).toEqual(['H']);
  });
});

describe('the contract between the page reader and the evaluator', () => {
  test('names fold on the way in, so a caller cannot lose a rule by spelling', () => {
    // A map keyed the way the page named things, a rule written the way the code names them.
    const screen = new Map([['Order total', 9000], ['credit_limit', 5000]]);
    const { rules } = parseRules('rule R\n on /a\n expect orderTotal <= creditLimit\n');
    expect(checkRule(rules[0]!, screen).outcome).toBe('broken');
  });

  test('could-not-tell reports the page\'s own names, not the folded ones', () => {
    const outcome = checkRule(rule('a == b'), new Map([['Fuel surcharge', 93.5]]));
    if (outcome.outcome !== 'cannotTell') throw new Error('expected cannotTell');
    expect(outcome.found).toEqual(['Fuel surcharge']);
  });

  test('a template rule stands aside where another rule names the screen outright', () => {
    // /billing/invoices/{id} is about one invoice; /billing/invoices/new is the blank form.
    const { rules } = parseRules(`
rule DETAIL
  on /billing/invoices/{id}
  expect total >= net
rule BLANK
  on /billing/invoices/new
  expect total == 0
`);
    expect(rulesFor(rules, '/billing/invoices/new').map(r => r.id)).toEqual(['BLANK']);
    expect(rulesFor(rules, '/billing/invoices/inv-0004').map(r => r.id)).toEqual(['DETAIL']);
  });

  test('one unreadable expect line draws one complaint, not two', () => {
    const { problems } = parseRules('rule X\n on /a\n expect c +\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain('cannot be read');
  });
});
