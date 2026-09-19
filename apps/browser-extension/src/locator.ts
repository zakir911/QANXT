/**
 * Chooses how to address an element, from inside the page.
 *
 * This deliberately mirrors the platform's own locator preference order — test id, then
 * role with accessible name, then label, placeholder, alt, title, text, and only then a
 * structural selector. A recorder that emitted CSS paths would produce tests that break on
 * the first redesign, which is exactly the problem the platform exists to avoid.
 *
 * It has no imports: the content script is injected into arbitrary pages, so everything it
 * needs must be self-contained.
 */

export type LocatorStrategy =
  | 'role' | 'testId' | 'label' | 'placeholder' | 'text' | 'altText' | 'title' | 'css' | 'xpath';

export interface LocatorDescriptor {
  strategy: LocatorStrategy;
  value: string;
  name?: string;
  exact?: boolean;
  nth?: number;
  fallbacks?: LocatorDescriptor[];
}

const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

export function testIdOf(element: Element): string | null {
  for (const attribute of TEST_ID_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value) return value;
  }
  return null;
}

export function textOf(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Implicit ARIA role for the elements a recording actually targets. */
export function roleOf(element: Element): string | null {
  const explicit = element.getAttribute('role');
  if (explicit?.trim()) return explicit.trim();

  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') ?? '').toLowerCase();

  switch (tag) {
    case 'a': return element.hasAttribute('href') ? 'link' : null;
    case 'button': return 'button';
    case 'select': return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
    case 'textarea': return 'textbox';
    case 'summary': return 'button';
    case 'input':
      switch (type) {
        case 'button': case 'submit': case 'reset': return 'button';
        case 'checkbox': return 'checkbox';
        case 'radio': return 'radio';
        case 'range': return 'slider';
        case 'number': return 'spinbutton';
        case 'search': return 'searchbox';
        case 'password': return null;
        default: return 'textbox';
      }
    default: return null;
  }
}

export function accessibleNameOf(element: Element): string | null {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const names = labelledBy.split(/\s+/)
      .map(id => element.ownerDocument.getElementById(id))
      .filter((node): node is HTMLElement => node !== null)
      .map(textOf)
      .filter(Boolean);
    if (names.length > 0) return names.join(' ');
  }

  const labelText = labelTextOf(element);
  if (labelText) return labelText;

  const own = textOf(element);
  if (own && own.length <= 200) return own;

  for (const attribute of ['alt', 'placeholder', 'title']) {
    const value = element.getAttribute(attribute);
    if (value?.trim()) return value.trim();
  }

  return null;
}

export function labelTextOf(element: Element): string | null {
  if (element.id) {
    const label = element.ownerDocument.querySelector(`label[for="${cssEscape(element.id)}"]`);
    if (label) return textOf(label) || null;
  }
  const wrapping = element.closest('label');
  return wrapping ? textOf(wrapping) || null : null;
}

/**
 * Builds the candidate locators for an element, best first.
 *
 * Every candidate is checked for uniqueness on the page as it is built: a locator that
 * matches three elements is not a locator, and offering one would produce a test that
 * fails the first time it runs.
 */
export function buildCandidates(element: Element): LocatorDescriptor[] {
  const document = element.ownerDocument;
  const candidates: LocatorDescriptor[] = [];

  const add = (candidate: LocatorDescriptor, matches: (root: Document) => Element[]) => {
    const found = matches(document);
    if (found.length === 0) return;
    if (found[0] !== element) {
      const index = found.indexOf(element);
      // An element that is the nth match can still be addressed, but only deliberately.
      if (index < 0) return;
      candidates.push({ ...candidate, nth: index });
      return;
    }
    candidates.push(found.length === 1 ? candidate : { ...candidate, nth: 0 });
  };

  const testId = testIdOf(element);
  if (testId) {
    add({ strategy: 'testId', value: testId }, doc =>
      TEST_ID_ATTRIBUTES.flatMap(attribute =>
        Array.from(doc.querySelectorAll(`[${attribute}="${cssEscape(testId)}"]`))));
  }

  const role = roleOf(element);
  const accessibleName = accessibleNameOf(element);
  if (role && accessibleName) {
    add({ strategy: 'role', value: role, name: accessibleName }, doc =>
      Array.from(doc.querySelectorAll('*')).filter(node =>
        roleOf(node) === role && accessibleNameOf(node) === accessibleName));
  }

  const label = labelTextOf(element);
  if (label && isFormControl(element)) {
    add({ strategy: 'label', value: label }, doc =>
      Array.from(doc.querySelectorAll('input, select, textarea')).filter(node => labelTextOf(node) === label));
  }

  const placeholder = element.getAttribute('placeholder');
  if (placeholder?.trim()) {
    add({ strategy: 'placeholder', value: placeholder.trim() }, doc =>
      Array.from(doc.querySelectorAll(`[placeholder="${cssEscape(placeholder.trim())}"]`)));
  }

  const alt = element.getAttribute('alt');
  if (alt?.trim()) {
    add({ strategy: 'altText', value: alt.trim() }, doc =>
      Array.from(doc.querySelectorAll(`[alt="${cssEscape(alt.trim())}"]`)));
  }

  const title = element.getAttribute('title');
  if (title?.trim()) {
    add({ strategy: 'title', value: title.trim() }, doc =>
      Array.from(doc.querySelectorAll(`[title="${cssEscape(title.trim())}"]`)));
  }

  const text = textOf(element);
  if (text && text.length <= 60 && isClickable(element)) {
    add({ strategy: 'text', value: text, exact: true }, doc =>
      Array.from(doc.querySelectorAll('a, button, summary, [role="button"], [role="link"], [role="tab"]'))
        .filter(node => textOf(node) === text));
  }

  if (element.id) {
    add({ strategy: 'css', value: `#${cssEscape(element.id)}` }, doc =>
      Array.from(doc.querySelectorAll(`#${cssEscape(element.id)}`)));
  }

  const name = element.getAttribute('name');
  if (name && isFormControl(element)) {
    const selector = `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
    add({ strategy: 'css', value: selector }, doc => Array.from(doc.querySelectorAll(selector)));
  }

  // A structural path always exists, so the recorder never produces a step with no locator.
  candidates.push({ strategy: 'css', value: cssPathOf(element) });
  return dedupe(candidates);
}

export function preferredLocator(element: Element): LocatorDescriptor {
  const candidates = buildCandidates(element);
  const preferred = candidates[0] ?? { strategy: 'css', value: cssPathOf(element) };
  return { ...preferred, fallbacks: candidates.slice(1, 4) };
}

export function cssPathOf(element: Element): string {
  if (element.id) return `#${cssEscape(element.id)}`;

  const parts: string[] = [];
  let current: Element | null = element;
  let depth = 0;

  while (current && current.nodeType === Node.ELEMENT_NODE && depth < 6) {
    if (current.id) { parts.unshift(`#${cssEscape(current.id)}`); break; }

    let part = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(child => child.tagName === current!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
    depth++;
  }

  return parts.join(' > ');
}

function isFormControl(element: Element): boolean {
  return ['input', 'select', 'textarea'].includes(element.tagName.toLowerCase());
}

function isClickable(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (['a', 'button', 'summary'].includes(tag)) return true;
  const role = element.getAttribute('role');
  return role === 'button' || role === 'link' || role === 'tab';
}

function dedupe(candidates: LocatorDescriptor[]): LocatorDescriptor[] {
  const seen = new Set<string>();
  const out: LocatorDescriptor[] = [];
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const key = `${candidate.strategy}|${candidate.value}|${candidate.name ?? ''}|${candidate.nth ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/** CSS.escape is not available in every context the content script runs in. */
export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

export function describeLocator(locator: LocatorDescriptor): string {
  const base = (() => {
    switch (locator.strategy) {
      case 'role': return `role=${locator.value}${locator.name ? ` name="${locator.name}"` : ''}`;
      case 'testId': return `testId="${locator.value}"`;
      case 'label': return `label="${locator.value}"`;
      case 'placeholder': return `placeholder="${locator.value}"`;
      case 'text': return `text="${locator.value}"`;
      case 'altText': return `altText="${locator.value}"`;
      case 'title': return `title="${locator.value}"`;
      case 'css': return `css=${locator.value}`;
      default: return locator.value;
    }
  })();
  return locator.nth === undefined ? base : `${base} [nth=${locator.nth}]`;
}
