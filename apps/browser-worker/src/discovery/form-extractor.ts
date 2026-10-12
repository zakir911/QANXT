/**
 * In-page form extraction.
 *
 * Separate from the element extractor because a form is a unit a tester reasons about, and
 * the element extractor cannot see it as one: it caps at a few hundred elements, skips what
 * is hidden, and records each control on its own. A wizard's later steps and a field that
 * appears only for a business account are hidden at crawl time, and they are exactly the
 * fields a form-level test suite most needs to know about.
 *
 * Everything recorded here is something the page declares — required, minlength, pattern,
 * min, max, step, accept, the options of a select. Nothing is inferred about the server's
 * rules, because a crawler cannot see them, and a test generated from an inferred rule
 * would test the inference rather than the application.
 *
 * Serialised into the browser like extractPage: self-contained, no imports, no closures.
 */

import type {
  DiscoveredForm, DiscoveredFormButton, DiscoveredFormField, DiscoveredFormOption, LocatorDescriptor
} from '@qa-nxt/shared-types';

export type RawFormOption = DiscoveredFormOption;
export type RawFormField = DiscoveredFormField;
export type RawFormButton = DiscoveredFormButton;
export type RawForm = Omit<DiscoveredForm, 'dependencies' | 'probeNote'>;

export function extractForms(maxFields: number): RawForm[] {
  const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
  const CSRF_NAME = /csrf|xsrf|_token|authenticity|requestverification|anti.?forgery/i;

  const textOf = (element: Element | null): string =>
    (element?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

  const testIdOf = (element: Element): string | null => {
    for (const attribute of TEST_ID_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value) return value;
    }
    return null;
  };

  const isVisible = (element: Element): boolean => {
    if ((element as HTMLElement).closest('[hidden]')) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const cssEscape = (value: string) => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&'));

  const labelFor = (element: Element): { text: string | null; associated: boolean } => {
    const labels = (element as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      // A label wrapping a checkbox includes the checkbox's own (empty) text; that is fine.
      const text = Array.from(labels).map(l => textOf(l).replace(/\s*\*\s*$/, '')).filter(Boolean).join(' ');
      return { text: text || null, associated: true };
    }
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => textOf(document.getElementById(id))).filter(Boolean).join(' ');
      if (text) return { text, associated: true };
    }
    const aria = element.getAttribute('aria-label');
    if (aria?.trim()) return { text: aria.trim(), associated: true };
    return { text: null, associated: false };
  };

  const controlTypeOf = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return (element as HTMLSelectElement).multiple ? 'multiselect' : 'select';
    if (element.getAttribute('contenteditable') === 'true') return 'richtext';
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox' && element.getAttribute('role') === 'switch') return 'switch';
    if (type === 'datetime-local') return 'datetime';
    if (type === 'text') {
      const mode = (element.getAttribute('inputmode') ?? '').toLowerCase();
      const auto = (element.getAttribute('autocomplete') ?? '').toLowerCase();
      if (auto === 'one-time-code') return 'otp';
      if (auto.startsWith('cc-number')) return 'cardNumber';
      if (mode === 'decimal') return 'decimal';
      if (mode === 'numeric') return 'numericText';
      if (element.getAttribute('role') === 'combobox' || element.hasAttribute('list')) return 'autocomplete';
    }
    return type;
  };

  /** A locator for the control, best first, with the rest as fallbacks. */
  const locatorOf = (element: Element, label: string | null, labelUnique: boolean): LocatorDescriptor => {
    const candidates: LocatorDescriptor[] = [];
    const testId = testIdOf(element);
    if (testId) candidates.push({ strategy: 'testId', value: testId });
    if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) candidates.push({ strategy: 'css', value: `#${element.id}` });
    if (label && labelUnique) candidates.push({ strategy: 'label', value: label, exact: true });
    const name = element.getAttribute('name');
    const form = element.closest('form');
    if (name) {
      const scope = form?.id && /^[A-Za-z][\w-]*$/.test(form.id) ? `form#${form.id} ` : '';
      const type = element.getAttribute('type');
      const suffix = type === 'radio' ? `[value="${cssEscape((element as HTMLInputElement).value)}"]` : '';
      candidates.push({ strategy: 'css', value: `${scope}[name="${cssEscape(name)}"]${suffix}` });
    }
    if (candidates.length === 0) {
      const path: string[] = [];
      let node: Element | null = element;
      while (node && node !== document.body && path.length < 6) {
        const parent: Element | null = node.parentElement;
        const tag = node.tagName.toLowerCase();
        const siblings = parent ? Array.from(parent.children).filter(c => c.tagName === node!.tagName) : [];
        path.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
        node = parent;
      }
      candidates.push({ strategy: 'css', value: path.join(' > ') });
    }
    const [primary, ...fallbacks] = candidates;
    return fallbacks.length > 0 ? { ...primary!, fallbacks } : primary!;
  };

  const GROUP = '[data-step], [role="tabpanel"], fieldset';
  /** Steps or sections: the outermost fieldsets or marked steps inside the form that hold
   * controls. A radio group's fieldset inside a step belongs to that step. */
  const groupsOf = (root: Element): Element[] =>
    Array.from(root.querySelectorAll(GROUP))
      .filter(group => group.querySelector('input, select, textarea'))
      .filter(group => {
        const outer = group.parentElement?.closest(GROUP);
        return !outer || !root.contains(outer);
      });

  // A submit-type button submits, whatever it says: "Continue" on a one-page form is its
  // submit control. Only a plain button is read as a wizard's Next or Previous by its label.
  const buttonRole = (label: string, type: string): RawFormButton['role'] => {
    const lower = label.toLowerCase();
    if (type !== 'submit' && /^(next|continue|forward)\b/.test(lower)) return 'next';
    if (type !== 'submit' && /^(previous|back|prev)\b/.test(lower)) return 'previous';
    if (type === 'reset' || /^(reset|clear)\b/.test(lower)) return 'reset';
    if (/^(cancel|close)\b/.test(lower)) return 'cancel';
    if (type === 'submit') return 'submit';
    return 'other';
  };

  const describe = (root: Element, index: number, hasFormElement: boolean): RawForm => {
    const form = hasFormElement ? root as HTMLFormElement : null;
    const controls = Array.from(root.querySelectorAll('input, select, textarea, [contenteditable="true"]'))
      .filter(control => {
        const type = (control.getAttribute('type') ?? '').toLowerCase();
        return !['hidden', 'submit', 'button', 'reset', 'image'].includes(type);
      })
      // A control that belongs to another form (form="other") is not this form's.
      .filter(control => !hasFormElement || (control as HTMLInputElement).form === form || control.getAttribute('contenteditable') === 'true')
      .slice(0, maxFields);

    const groups = groupsOf(root);
    const labelTexts = controls.map(c => labelFor(c).text);
    const labelCounts = new Map<string, number>();
    for (const text of labelTexts) if (text) labelCounts.set(text, (labelCounts.get(text) ?? 0) + 1);

    const fields: RawFormField[] = [];
    const radioGroups = new Map<string, RawFormField>();

    controls.forEach((control, i) => {
      const input = control as HTMLInputElement;
      const controlType = controlTypeOf(control);
      const label = labelFor(control);
      const groupElement = groups.find(g => g.contains(control)) ?? null;
      const group = groupElement ? groups.indexOf(groupElement) : 0;
      const groupLegend = groupElement?.querySelector(':scope > legend');
      const nestedFieldset = control.closest('fieldset');
      const legendText = nestedFieldset ? textOf(nestedFieldset.querySelector(':scope > legend')).replace(/\s*\*\s*$/, '') : null;

      if (controlType === 'radio' && input.name) {
        const option = { value: input.value, label: label.text ?? input.value, disabled: input.disabled };
        const existing = radioGroups.get(input.name);
        if (existing) {
          existing.options.push(option);
          existing.required = existing.required || input.required;
          existing.visible = existing.visible || isVisible(control);
          return;
        }
      }

      const constraints: Record<string, string> = {};
      for (const attribute of ['minlength', 'maxlength', 'min', 'max', 'step', 'pattern', 'accept']) {
        const value = control.getAttribute(attribute);
        // maxlength="-1" is what some frameworks render for "no limit".
        if (value !== null && value !== '' && value !== '-1') constraints[attribute] = value.slice(0, 300);
      }
      if (control.hasAttribute('multiple')) constraints.multiple = 'true';

      const options: RawFormOption[] = control.tagName === 'SELECT'
        ? Array.from((control as HTMLSelectElement).options).slice(0, 200).map(o => ({
            value: o.value, label: textOf(o) || o.value, disabled: o.disabled
          }))
        : controlType === 'radio' ? [{ value: input.value, label: label.text ?? input.value, disabled: input.disabled }] : [];

      const describedBy = (control.getAttribute('aria-describedby') ?? '').split(/\s+/)
        .map(id => textOf(document.getElementById(id))).filter(Boolean).join(' ');

      const labelText = controlType === 'radio' ? (legendText || input.name) : label.text;
      const field: RawFormField = {
        key: input.name || control.id || testIdOf(control) || `field-${i}`,
        name: control.getAttribute('name'),
        elementId: control.id || null,
        testId: controlType === 'radio' ? null : testIdOf(control),
        label: labelText,
        hasAssociatedLabel: controlType === 'radio' ? Boolean(legendText) : label.associated,
        accessibleName: labelText ?? control.getAttribute('placeholder') ?? control.getAttribute('title'),
        placeholder: control.getAttribute('placeholder'),
        tagName: control.tagName.toLowerCase(),
        controlType,
        htmlType: control.getAttribute('type'),
        role: control.getAttribute('role'),
        required: input.required || control.getAttribute('aria-required') === 'true',
        readOnly: input.readOnly === true || control.getAttribute('aria-readonly') === 'true',
        disabled: input.disabled === true || control.getAttribute('aria-disabled') === 'true',
        visible: isVisible(control),
        // A password's value is never captured.
        defaultValue: controlType === 'password' ? null : (input.value ?? null)?.toString().slice(0, 200) || null,
        checked: input.checked === true,
        constraints,
        options,
        autocomplete: control.getAttribute('autocomplete'),
        inputMode: control.getAttribute('inputmode'),
        describedByText: describedBy || null,
        ariaInvalid: control.getAttribute('aria-invalid') === 'true',
        group,
        groupLabel: groupLegend ? textOf(groupLegend) : null,
        locator: controlType === 'radio'
          ? { strategy: 'css', value: `${form?.id ? `form#${cssEscape(form.id)} ` : ''}[name="${cssEscape(input.name)}"]` }
          : locatorOf(control, label.text, label.text !== null && labelCounts.get(label.text) === 1)
      };
      if (controlType === 'radio' && input.name) radioGroups.set(input.name, field);
      fields.push(field);
    });

    const buttonElements = Array.from(root.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="reset"], [role="button"]'))
      .filter(button => !hasFormElement || (button as HTMLButtonElement).form === form || button.getAttribute('role') === 'button');
    const buttons: RawFormButton[] = buttonElements.slice(0, 20).map(button => {
      const label = (button.getAttribute('aria-label') ?? (textOf(button) || (button as HTMLInputElement).value || '')).trim();
      const type = (button.getAttribute('type') ?? (button.tagName === 'BUTTON' && hasFormElement ? 'submit' : 'button')).toLowerCase();
      const testId = testIdOf(button);
      const locator: LocatorDescriptor = testId
        ? { strategy: 'testId', value: testId, fallbacks: label ? [{ strategy: 'role', value: 'button', name: label }] : [] }
        : label ? { strategy: 'role', value: 'button', name: label } : { strategy: 'css', value: `${form?.id ? `form#${cssEscape(form.id)} ` : ''}[type="${type}"]` };
      return {
        label, type, testId, role: buttonRole(label, type),
        visible: isVisible(button),
        disabled: (button as HTMLButtonElement).disabled === true || button.getAttribute('aria-disabled') === 'true',
        locator
      };
    });

    const hidden = form ? Array.from(form.querySelectorAll('input[type="hidden"]')) as HTMLInputElement[] : [];
    const hiddenFieldNames = hidden.map(h => h.name).filter(Boolean).slice(0, 20);
    const visibleGroups = groups.filter(g => isVisible(g));
    const hasNext = buttons.some(b => b.role === 'next');
    const isMultiStep = groups.length > 1 && visibleGroups.length < groups.length && hasNext;
    const indicator = root.querySelector('[aria-current="step"], .step-indicator, [data-step-indicator], [class*="stepper"]');

    const heading = (() => {
      const label = root.getAttribute('aria-label') ?? (root.getAttribute('aria-labelledby') ? textOf(document.getElementById(root.getAttribute('aria-labelledby')!)) : '');
      if (label) return label;
      const own = root.querySelector('h1, h2, h3, legend');
      if (own && textOf(own)) return textOf(own);
      return textOf(document.querySelector('h1')) || document.title;
    })();

    const key = (form?.id || form?.getAttribute('name') || testIdOf(root) || `form-${index + 1}`).slice(0, 120);
    const formLocator: LocatorDescriptor = testIdOf(root)
      ? { strategy: 'testId', value: testIdOf(root)!, fallbacks: form?.id ? [{ strategy: 'css', value: `form#${cssEscape(form.id)}` }] : [] }
      : form?.id && /^[A-Za-z][\w-]*$/.test(form.id) ? { strategy: 'css', value: `form#${form.id}` }
      : hasFormElement ? { strategy: 'css', value: 'form', nth: Array.from(document.querySelectorAll('form')).indexOf(form!) }
      : { strategy: 'css', value: 'body' };

    return {
      key,
      name: heading.slice(0, 200),
      hasFormElement,
      domIndex: form ? Array.from(document.querySelectorAll('form')).indexOf(form) : -1,
      action: form ? (form.getAttribute('action') ? form.action : null) : null,
      method: (form?.getAttribute('method') ?? 'get').toLowerCase(),
      enctype: form?.getAttribute('enctype') ?? null,
      noValidate: form?.noValidate ?? true,
      hasCsrfToken: hidden.some(h => CSRF_NAME.test(h.name)) || Boolean(document.querySelector('meta[name*="csrf" i]')),
      hiddenFieldNames,
      locator: formLocator,
      fields,
      buttons,
      groupCount: Math.max(groups.length, 1),
      visibleGroup: Math.max(0, groups.findIndex(g => isVisible(g))),
      isMultiStep,
      stepIndicatorText: indicator ? textOf(indicator) : null
    };
  };

  const forms = Array.from(document.querySelectorAll('form'))
    .map((form, i) => describe(form, i, true))
    .filter(form => form.fields.length > 0);

  // Controls with no form around them: a single-page application's form is often a div.
  // They are gathered into one implicit form per page rather than guessed into several.
  const orphans = Array.from(document.querySelectorAll('input, select, textarea'))
    .filter(control => !control.closest('form'))
    .filter(control => !['hidden', 'submit', 'button', 'reset', 'image'].includes((control.getAttribute('type') ?? '').toLowerCase()));
  if (orphans.length > 0) {
    let container: Element = orphans[0]!.parentElement ?? document.body;
    while (container !== document.body && !orphans.every(o => container.contains(o))) {
      container = container.parentElement ?? document.body;
    }
    const implicit = describe(container, forms.length, false);
    if (implicit.fields.length > 0 && implicit.buttons.length > 0) forms.push({ ...implicit, key: `implicit-${forms.length + 1}` });
  }

  return forms;
}

/** What the visible state of a form's fields and select options looks like right now. */
export function snapshotFormState(domIndex: number): Record<string, { visible: boolean; required: boolean; options: string[] }> {
  const root = domIndex < 0 ? document.body : document.querySelectorAll('form')[domIndex];
  const out: Record<string, { visible: boolean; required: boolean; options: string[] }> = {};
  if (!root) return out;
  for (const control of Array.from(root.querySelectorAll('input, select, textarea'))) {
    const input = control as HTMLInputElement;
    if (['hidden', 'submit', 'button'].includes(input.type)) continue;
    const key = input.name || input.id;
    if (!key) continue;
    const style = window.getComputedStyle(control);
    const rect = control.getBoundingClientRect();
    const visible = !control.closest('[hidden]') && style.display !== 'none' && style.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
    const previous = out[key];
    out[key] = {
      visible: visible || (previous?.visible ?? false),
      required: input.required || control.getAttribute('aria-required') === 'true',
      options: control.tagName === 'SELECT'
        ? Array.from((control as HTMLSelectElement).options).map(o => (o.textContent ?? '').trim()).slice(0, 100)
        : previous?.options ?? []
    };
  }
  return out;
}
