import { beforeEach, describe, expect, test } from 'vitest';
import { buildCandidates, cssPathOf, describeLocator, preferredLocator, roleOf } from '../src/locator';

/**
 * The recorder's locator choice decides whether a recorded journey becomes a durable test
 * or one that breaks on the next redesign, so the preference order is asserted directly.
 */
function mount(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('locator preference', () => {
  test('prefers a test id above everything else', () => {
    mount(`<button id="save" data-testid="save-button" aria-label="Save">Save</button>`);
    const locator = preferredLocator(document.querySelector('button')!);
    expect(locator.strategy).toBe('testId');
    expect(locator.value).toBe('save-button');
  });

  test('falls back to role and accessible name when there is no test id', () => {
    mount(`<button>Send payment</button>`);
    const locator = preferredLocator(document.querySelector('button')!);
    expect(locator.strategy).toBe('role');
    expect(locator.value).toBe('button');
    expect(locator.name).toBe('Send payment');
  });

  test('uses the associated label for a form control', () => {
    mount(`<label for="amount">Amount</label><input id="amount" type="number">`);
    const candidates = buildCandidates(document.querySelector('input')!);
    expect(candidates.some(c => c.strategy === 'label' && c.value === 'Amount')).toBe(true);
  });

  test('records fallbacks so a broken primary can resolve without healing', () => {
    mount(`<button data-testid="submit" aria-label="Submit the form">Submit</button>`);
    const locator = preferredLocator(document.querySelector('button')!);
    expect(locator.fallbacks?.length ?? 0).toBeGreaterThan(0);
  });

  test('always produces a locator, even for an anonymous element', () => {
    mount(`<div><span></span></div>`);
    const locator = preferredLocator(document.querySelector('span')!);
    expect(locator.value).not.toBe('');
  });
});

describe('ambiguity', () => {
  test('disambiguates with an index when several elements match', () => {
    mount(`
      <a href="/a">View account</a>
      <a href="/b">View account</a>
      <a href="/c">View account</a>
    `);
    const second = document.querySelectorAll('a')[1]!;
    const candidates = buildCandidates(second);
    const role = candidates.find(c => c.strategy === 'role');
    expect(role?.nth).toBe(1);
  });

  test('omits the index when the match is already unique', () => {
    mount(`<a href="/a">Only link</a>`);
    const candidates = buildCandidates(document.querySelector('a')!);
    const role = candidates.find(c => c.strategy === 'role');
    expect(role?.nth).toBeUndefined();
  });
});

describe('implicit roles', () => {
  test.each([
    ['<button></button>', 'button'],
    ['<a href="/x"></a>', 'link'],
    ['<input type="checkbox">', 'checkbox'],
    ['<input type="text">', 'textbox'],
    ['<select></select>', 'combobox'],
    ['<textarea></textarea>', 'textbox']
  ])('derives the role of %s', (html, expected) => {
    mount(html);
    expect(roleOf(document.body.firstElementChild!)).toBe(expected);
  });

  test('a password field has no implicit role, matching the accessibility tree', () => {
    mount('<input type="password">');
    expect(roleOf(document.querySelector('input')!)).toBeNull();
  });

  test('an explicit role wins over the implicit one', () => {
    mount('<div role="tab">Accounts</div>');
    expect(roleOf(document.querySelector('div')!)).toBe('tab');
  });
});

describe('structural fallback', () => {
  test('uses an id when one exists', () => {
    mount('<div id="root"><span>x</span></div>');
    expect(cssPathOf(document.querySelector('#root')!)).toBe('#root');
  });

  test('builds a path with positional selectors for repeated siblings', () => {
    mount('<ul><li>one</li><li>two</li></ul>');
    const path = cssPathOf(document.querySelectorAll('li')[1]!);
    expect(path).toContain('li:nth-of-type(2)');
  });
});

describe('describeLocator', () => {
  test('renders the forms shown in the popup and in reports', () => {
    expect(describeLocator({ strategy: 'role', value: 'button', name: 'Save' })).toBe('role=button name="Save"');
    expect(describeLocator({ strategy: 'testId', value: 'save' })).toBe('testId="save"');
    expect(describeLocator({ strategy: 'text', value: 'Save', nth: 2 })).toBe('text="Save" [nth=2]');
  });
});
