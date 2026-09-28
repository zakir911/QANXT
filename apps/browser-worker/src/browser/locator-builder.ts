import type { LocatorDescriptor } from '@qa-nxt/shared-types';
import { locatorStability } from '@qa-nxt/shared-types';
import type { RawElement } from '../discovery/page-extractor.js';

/**
 * Chooses how to address an element.
 *
 * The order is deliberate and is the platform's main defence against brittle tests: an
 * explicit test id first, then role plus accessible name, then label, placeholder, alt,
 * title and text — and only then CSS, with XPath as an admission of defeat. Fallbacks are
 * the remaining candidates in the same order, so a broken primary usually resolves without
 * any healing at all.
 */

export interface BuiltLocator {
  preferred: LocatorDescriptor;
  /** Every viable way to address this element, best first, including the preferred one. */
  candidates: LocatorDescriptor[];
  stability: number;
}

export function buildLocatorFor(element: RawElement): BuiltLocator {
  const candidates: LocatorDescriptor[] = [];

  if (element.testId) {
    candidates.push({ strategy: 'testId', value: element.testId });
  }

  if (element.ariaRole && element.accessibleName) {
    candidates.push({
      strategy: 'role',
      value: element.ariaRole,
      name: truncate(element.accessibleName, 120),
      exact: false
    });
  }

  if (element.label && isFormControl(element)) {
    candidates.push({ strategy: 'label', value: truncate(element.label, 120) });
  }

  if (element.placeholder) {
    candidates.push({ strategy: 'placeholder', value: truncate(element.placeholder, 120) });
  }

  if (element.tagName === 'img' && element.attributes['alt']) {
    candidates.push({ strategy: 'altText', value: truncate(element.attributes['alt'], 120) });
  }

  if (element.title) {
    candidates.push({ strategy: 'title', value: truncate(element.title, 120) });
  }

  // Text is only useful when it is short and distinctive; a paragraph is not a locator.
  if (element.text && element.text.length <= 60 && isClickable(element)) {
    candidates.push({ strategy: 'text', value: element.text, exact: true });
  }

  if (element.elementId) {
    candidates.push({ strategy: 'css', value: `#${cssEscape(element.elementId)}` });
  }

  if (element.name && isFormControl(element)) {
    candidates.push({
      strategy: 'css',
      value: `${element.tagName}[name="${cssEscape(element.name)}"]`
    });
  }

  if (element.ariaRole && !element.accessibleName) {
    candidates.push({ strategy: 'role', value: element.ariaRole });
  }

  if (element.cssSelector) {
    candidates.push({ strategy: 'css', value: element.cssSelector });
  }

  if (element.xpath) {
    candidates.push({ strategy: 'xpath', value: element.xpath });
  }

  const unique = dedupe(candidates);
  const preferred = unique[0] ?? { strategy: 'xpath', value: element.xpath ?? '/html' };

  return {
    preferred: {
      ...preferred,
      // At most three fallbacks: enough to survive ordinary change, few enough that a
      // genuinely missing element still fails fast instead of burning the step timeout.
      fallbacks: unique.slice(1, 4)
    },
    candidates: unique,
    stability: locatorStability(preferred)
  };
}

function isFormControl(element: RawElement): boolean {
  return ['input', 'select', 'textarea'].includes(element.tagName);
}

function isClickable(element: RawElement): boolean {
  return ['a', 'button', 'summary'].includes(element.tagName)
    || element.kind === 'button' || element.kind === 'link' || element.kind === 'tab';
}

function dedupe(candidates: LocatorDescriptor[]): LocatorDescriptor[] {
  const seen = new Set<string>();
  const out: LocatorDescriptor[] = [];
  for (const candidate of candidates) {
    if (!candidate.value || candidate.value.trim() === '') continue;
    const key = `${candidate.strategy}::${candidate.value}::${candidate.name ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Mirrors CSS.escape for the subset of characters that appear in ids and names. */
function cssEscape(value: string): string {
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}
