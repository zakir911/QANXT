import { describe, expect, it } from 'vitest';
import { buildLocatorFor, matchCount } from '../src/browser/locator-builder.js';
import type { RawElement } from '../src/discovery/page-extractor.js';

/**
 * A locator that matches two elements is not a locator. The execution-time resolver
 * refuses it, which is correct, but by then a test has been authored, queued, dispatched
 * and run, and the failure it reports is the platform's own, not the application's. These
 * tests hold the line at authoring time, where it is cheap.
 *
 * The measured case: a run against a 152-page application produced 18 failures reading
 * `role=heading name="X" matched N elements`. Every one was a page carrying a heading
 * twice, or a heading whose name was a prefix of another.
 */
const element = (overrides: Partial<RawElement> = {}): RawElement => ({
  kind: 'heading', tagName: 'h3', ariaRole: 'heading', accessibleName: null, text: null,
  label: null, placeholder: null, testId: null, elementId: null, name: null, type: null,
  title: null, value: null, cssSelector: null, xpath: null, domPath: null,
  parentSignature: null, neighbourText: null,
  bounding: { x: 0, y: 0, width: 10, height: 10 },
  isVisible: true, isEnabled: true, isReadOnly: false, isRequired: false,
  attributes: {}, ...overrides
});

describe('a locator must address one element', () => {
  it('does not emit a role+name locator that matches two headings', () => {
    const first = element({ accessibleName: 'Shipment', xpath: '/html/body/h3[1]' });
    const second = element({ accessibleName: 'Shipment', xpath: '/html/body/h3[2]' });
    const page = [first, second];

    const built = buildLocatorFor(first, page);

    // Whatever it chooses, it must not be the ambiguous one left unqualified.
    const ambiguous = built.preferred.strategy === 'role'
      && built.preferred.name === 'Shipment'
      && built.preferred.nth === undefined;
    expect(ambiguous).toBe(false);
  });

  it('tightens to an exact name when the substring match is the ambiguous part', () => {
    // "Shipment" is a prefix of "Shipment Details", so exact:false matches both.
    const target = element({ accessibleName: 'Shipment', xpath: '/html/body/h3[1]' });
    const longer = element({ accessibleName: 'Shipment Details', xpath: '/html/body/h3[2]' });

    const built = buildLocatorFor(target, [target, longer]);

    expect(built.preferred.strategy).toBe('role');
    expect(built.preferred.name).toBe('Shipment');
    expect(built.preferred.exact).toBe(true);
    expect(built.preferred.nth).toBeUndefined();
  });

  it('keeps the loose name match when nothing else on the page collides', () => {
    const only = element({ accessibleName: 'Shipment', xpath: '/html/body/h3[1]' });
    const other = element({ accessibleName: 'Invoices', xpath: '/html/body/h3[2]' });

    const built = buildLocatorFor(only, [only, other]);

    expect(built.preferred.exact).toBe(false);
  });

  it('prefers an unambiguous candidate over pinning an index', () => {
    const first = element({
      accessibleName: 'Shipment', elementId: 'shipment-heading', xpath: '/html/body/h3[1]'
    });
    const second = element({ accessibleName: 'Shipment', xpath: '/html/body/h3[2]' });

    const built = buildLocatorFor(first, [first, second]);

    // The id is unique, so it should be used rather than role+nth.
    expect(built.preferred.nth).toBeUndefined();
    expect(built.preferred.strategy).toBe('css');
    expect(built.preferred.value).toBe('#shipment-heading');
  });

  it('pins nth only when every candidate is ambiguous, and pins the right one', () => {
    // Two identical headings with no id, no test id and no distinguishing text. The exact
    // name does not help either: both names are the same string.
    const first = element({ accessibleName: 'Shipment' });
    const second = element({ accessibleName: 'Shipment' });

    const forFirst = buildLocatorFor(first, [first, second]);
    const forSecond = buildLocatorFor(second, [first, second]);

    expect(forFirst.preferred.nth).toBe(0);
    expect(forSecond.preferred.nth).toBe(1);
  });

  it('behaves exactly as before when no page context is supplied', () => {
    // The healing scorer scores a candidate in isolation and has no page to compare with.
    const lone = element({ accessibleName: 'Shipment' });

    const built = buildLocatorFor(lone);

    expect(built.preferred.strategy).toBe('role');
    expect(built.preferred.exact).toBe(false);
    expect(built.preferred.nth).toBeUndefined();
  });
});

describe('the match mirror', () => {
  it('counts a test id as addressing one element', () => {
    const target = element({ testId: 'row-1' });
    const other = element({ testId: 'row-2' });
    expect(matchCount({ strategy: 'testId', value: 'row-1' }, [target, other])).toBe(1);
  });

  it('counts a role with no name as every element in that role', () => {
    const page = [element({ accessibleName: 'A' }), element({ accessibleName: 'B' })];
    expect(matchCount({ strategy: 'role', value: 'heading' }, page)).toBe(2);
  });

  it('reports one match for a strategy it cannot model, so the locator is kept', () => {
    // An arbitrary CSS selector cannot be evaluated against captured fields. Reporting
    // one keeps today's behaviour rather than discarding a locator that may be fine.
    const target = element({ cssSelector: 'div > h3:nth-of-type(1)' });
    const other = element({ cssSelector: 'div > h3:nth-of-type(2)' });
    expect(matchCount({ strategy: 'css', value: 'div > h3:nth-of-type(1)' }, [target, other]))
      .toBe(1);
  });

  it('matches a name-attribute selector back to its field', () => {
    const target = element({ tagName: 'input', kind: 'textInput', name: 'origin' });
    const other = element({ tagName: 'input', kind: 'textInput', name: 'destination' });
    expect(matchCount({ strategy: 'css', value: 'input[name="origin"]' }, [target, other]))
      .toBe(1);
  });
});
