/**
 * In-page element extraction.
 *
 * The function below is serialised into the browser, so it must be self-contained: no
 * imports, no closures over worker state. It gathers exactly the signals the locator
 * engine later scores against, which is what makes a healing decision explainable in
 * terms of something that was actually observed on the page.
 */

export interface RawElement {
  kind: string;
  tagName: string;
  ariaRole: string | null;
  accessibleName: string | null;
  text: string | null;
  label: string | null;
  placeholder: string | null;
  testId: string | null;
  elementId: string | null;
  name: string | null;
  type: string | null;
  title: string | null;
  value: string | null;
  cssSelector: string | null;
  xpath: string | null;
  domPath: string | null;
  parentSignature: string | null;
  neighbourText: string | null;
  bounding: { x: number; y: number; width: number; height: number };
  isVisible: boolean;
  isEnabled: boolean;
  isRequired: boolean;
  attributes: Record<string, string>;
}

export interface RawPageCapture {
  title: string;
  url: string;
  visibleTextExcerpt: string;
  elements: RawElement[];
  links: string[];
  formCount: number;
  hasPasswordField: boolean;
  headings: string[];
  errorMessages: string[];
  successMessages: string[];
}

/**
 * Serialised into the page by the crawler. Kept as one function because Playwright
 * evaluates a single callable; helpers are declared inside it for the same reason.
 */
export function extractPage(maxElements: number): RawPageCapture {
  const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

  const isVisible = (element: Element): boolean => {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const textOf = (element: Element): string =>
    (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

  const testIdOf = (element: Element): string | null => {
    for (const attribute of TEST_ID_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value) return value;
    }
    return null;
  };

  /**
   * Approximates the accessible name the way assistive technology computes it:
   * aria-label, then aria-labelledby, then an associated <label>, then the element's
   * own text, then placeholder/title/alt.
   */
  const accessibleNameOf = (element: Element): string | null => {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel?.trim()) return ariaLabel.trim();

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const names = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id))
        .filter((node): node is HTMLElement => node !== null)
        .map(node => textOf(node))
        .filter(Boolean);
      if (names.length > 0) return names.join(' ');
    }

    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) {
        const labelText = textOf(label);
        if (labelText) return labelText;
      }
    }

    const wrappingLabel = element.closest('label');
    if (wrappingLabel) {
      const labelText = textOf(wrappingLabel);
      if (labelText) return labelText;
    }

    const own = textOf(element);
    if (own) return own;

    const alt = element.getAttribute('alt');
    if (alt?.trim()) return alt.trim();
    const placeholder = element.getAttribute('placeholder');
    if (placeholder?.trim()) return placeholder.trim();
    const title = element.getAttribute('title');
    if (title?.trim()) return title.trim();
    const value = (element as HTMLInputElement).value;
    if (element.tagName === 'INPUT' && value) return String(value).slice(0, 100);

    return null;
  };

  const labelTextOf = (element: Element): string | null => {
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) return textOf(label) || null;
    }
    const wrapping = element.closest('label');
    return wrapping ? textOf(wrapping) || null : null;
  };

  /** Implicit ARIA role, good enough for the roles the engine actually targets. */
  const roleOf = (element: Element): string | null => {
    const explicit = element.getAttribute('role');
    if (explicit?.trim()) return explicit.trim();

    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') ?? '').toLowerCase();

    switch (tag) {
      case 'a': return element.hasAttribute('href') ? 'link' : null;
      case 'button': return 'button';
      case 'select': return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'table': return 'table';
      case 'dialog': return 'dialog';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'form': return 'form';
      case 'img': return 'img';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'input':
        switch (type) {
          case 'button': case 'submit': case 'reset': return 'button';
          case 'checkbox': return 'checkbox';
          case 'radio': return 'radio';
          case 'range': return 'slider';
          case 'number': return 'spinbutton';
          case 'search': return 'searchbox';
          case 'email': case 'tel': case 'url': case 'text': case '': return 'textbox';
          case 'password': return null;     // password inputs have no implicit ARIA role
          default: return null;
        }
      default: return null;
    }
  };

  const kindOf = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(type))) return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textArea';
    if (tag === 'form') return 'form';
    if (tag === 'table') return 'table';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'nav') return 'navigation';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'image';
    if (element.getAttribute('role') === 'alert') return 'alert';
    if (element.getAttribute('role') === 'tab') return 'tab';
    if (element.getAttribute('role') === 'menu' || tag === 'menu') return 'menu';
    if (tag === 'input') {
      switch (type) {
        case 'password': return 'passwordInput';
        case 'number': return 'numberInput';
        case 'date': case 'datetime-local': case 'month': case 'week': case 'time': return 'dateInput';
        case 'file': return 'fileInput';
        case 'checkbox': return 'checkbox';
        case 'radio': return 'radio';
        default: return 'textInput';
      }
    }
    return 'unknown';
  };

  /** Shortest stable CSS path; a last-resort locator, never the preferred one. */
  const cssPathOf = (element: Element): string => {
    if (element.id) return `#${CSS.escape(element.id)}`;

    const parts: string[] = [];
    let current: Element | null = element;
    let depth = 0;

    while (current && current.nodeType === Node.ELEMENT_NODE && depth < 6) {
      let part = current.tagName.toLowerCase();
      if (current.id) { parts.unshift(`#${CSS.escape(current.id)}`); break; }

      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
      depth++;
    }
    return parts.join(' > ');
  };

  const xpathOf = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  };

  /** Tag chain from the root: the ancestry signal used for structural similarity. */
  const domPathOf = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 12) {
      parts.unshift(current.tagName.toLowerCase());
      current = current.parentElement;
    }
    return parts.join('/');
  };

  const parentSignatureOf = (element: Element): string | null => {
    const parent = element.parentElement;
    if (!parent) return null;
    const role = parent.getAttribute('role') ?? '';
    const testId = testIdOf(parent) ?? '';
    const classes = (parent.className && typeof parent.className === 'string')
      ? parent.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')
      : '';
    return [parent.tagName.toLowerCase(), role, testId, classes].filter(Boolean).join('|');
  };

  /** Accessible text of the nearest siblings: the neighbourhood signal for healing. */
  const neighbourTextOf = (element: Element): string | null => {
    const parent = element.parentElement;
    if (!parent) return null;
    const siblings = Array.from(parent.children).filter(child => child !== element).slice(0, 4);
    const text = siblings.map(sibling => textOf(sibling)).filter(Boolean).join(' | ');
    return text ? text.slice(0, 300) : null;
  };

  const interestingAttributes = (element: Element): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      // Stable, semantic attributes only: class and style churn with every redesign.
      if (name.startsWith('data-') || name.startsWith('aria-')
        || ['role', 'type', 'name', 'href', 'for', 'placeholder', 'title', 'alt', 'required', 'disabled'].includes(name)) {
        out[name] = attribute.value.slice(0, 200);
      }
    }
    return out;
  };

  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'form', 'table', 'dialog', 'nav',
    '[role]', '[onclick]', '[data-testid]', '[data-test-id]', '[data-test]', '[data-qa]', '[data-cy]',
    'h1', 'h2', 'h3', 'summary', '[contenteditable="true"]'
  ].join(',');

  const seen = new Set<Element>();
  const elements: RawElement[] = [];

  for (const element of Array.from(document.querySelectorAll(SELECTOR))) {
    if (elements.length >= maxElements) break;
    if (seen.has(element)) continue;
    seen.add(element);

    const rect = element.getBoundingClientRect();
    const visible = isVisible(element);
    // Invisible elements are still captured when they carry a test id or a role: a
    // hidden dialog today is a visible dialog after the next click.
    if (!visible && !testIdOf(element) && !element.getAttribute('role')) continue;

    elements.push({
      kind: kindOf(element),
      tagName: element.tagName.toLowerCase(),
      ariaRole: roleOf(element),
      accessibleName: accessibleNameOf(element),
      text: textOf(element) || null,
      label: labelTextOf(element),
      placeholder: element.getAttribute('placeholder'),
      testId: testIdOf(element),
      elementId: element.id || null,
      name: element.getAttribute('name'),
      type: element.getAttribute('type'),
      title: element.getAttribute('title'),
      value: element instanceof HTMLInputElement && element.type !== 'password'
        ? (element.value || null) : null,
      cssSelector: cssPathOf(element),
      xpath: xpathOf(element),
      domPath: domPathOf(element),
      parentSignature: parentSignatureOf(element),
      neighbourText: neighbourTextOf(element),
      bounding: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height)
      },
      isVisible: visible,
      isEnabled: !(element as HTMLInputElement).disabled,
      isRequired: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
      attributes: interestingAttributes(element)
    });
  }

  const links = Array.from(document.querySelectorAll('a[href]'))
    .map(anchor => (anchor as HTMLAnchorElement).href)
    .filter(href => href && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:'));

  const messagesFrom = (selector: string): string[] =>
    Array.from(document.querySelectorAll(selector))
      .map(node => textOf(node))
      .filter(text => text.length > 0 && text.length < 500)
      .slice(0, 10);

  return {
    title: document.title,
    url: location.href,
    visibleTextExcerpt: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000),
    elements,
    links: Array.from(new Set(links)),
    formCount: document.querySelectorAll('form').length,
    hasPasswordField: document.querySelectorAll('input[type="password"]').length > 0,
    headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(h => textOf(h)).filter(Boolean).slice(0, 20),
    errorMessages: messagesFrom('[role="alert"], .error, .alert-danger, .invalid-feedback, [data-testid*="error"]'),
    successMessages: messagesFrom('[role="status"], .success, .alert-success, [data-testid*="success"]')
  };
}
