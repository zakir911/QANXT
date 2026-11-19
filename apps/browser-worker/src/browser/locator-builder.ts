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

export function buildLocatorFor(element: RawElement, page?: readonly RawElement[]): BuiltLocator {
  const candidates: LocatorDescriptor[] = [];

  if (element.testId) {
    candidates.push({ strategy: 'testId', value: element.testId });
  }

  if (element.ariaRole && element.accessibleName) {
    // A substring name match is friendlier to copy changes, but "Shipment" also matches
    // "Shipment Details". Tighten to an exact name only when the loose one is ambiguous.
    const loose: LocatorDescriptor = {
      strategy: 'role',
      value: element.ariaRole,
      name: truncate(element.accessibleName, 120),
      exact: false
    };
    candidates.push(page && matchCount(loose, page) > 1 ? { ...loose, exact: true } : loose);
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
  const usable = page ? unique.filter(candidate => matchCount(candidate, page) <= 1) : unique;

  // Every candidate ambiguous: keep the best one and say which match is meant. Guessing
  // the first silently is what the execution-time resolver exists to refuse.
  const ordered = usable.length > 0
    ? usable
    : unique.length > 0
      ? [{ ...unique[0]!, nth: indexAmongMatches(unique[0]!, element, page ?? []) }, ...unique.slice(1)]
      : [];

  const preferred = ordered[0] ?? { strategy: 'xpath', value: element.xpath ?? '/html' };

  return {
    preferred: {
      ...preferred,
      // At most three fallbacks: enough to survive ordinary change, few enough that a
      // genuinely missing element still fails fast instead of burning the step timeout.
      fallbacks: ordered.slice(1, 4)
    },
    candidates: ordered,
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

/**
 * How many elements on the page a descriptor would address.
 *
 * This mirrors Playwright's matching rules closely enough to spot an ambiguous locator
 * before it ships, using only what discovery already captured. It is deliberately
 * conservative: a strategy whose semantics cannot be reproduced from the captured fields
 * reports a single match, so an unrecognised case leaves the locator exactly as it would
 * have been. Undercounting keeps today's behaviour; overcounting would discard a locator
 * that works.
 */
export function matchCount(descriptor: LocatorDescriptor, page: readonly RawElement[]): number {
  return page.reduce((total, element) => total + (matchesElement(descriptor, element) ? 1 : 0), 0);
}

/** The index of `element` among the page elements a descriptor matches, or 0. */
function indexAmongMatches(
  descriptor: LocatorDescriptor,
  element: RawElement,
  page: readonly RawElement[]
): number {
  const matches = page.filter(candidate => matchesElement(descriptor, candidate));
  const index = matches.indexOf(element);
  return index < 0 ? 0 : index;
}

function matchesElement(descriptor: LocatorDescriptor, element: RawElement): boolean {
  const contains = (haystack: string | null, needle: string, exact: boolean | undefined): boolean => {
    if (haystack === null) return false;
    const a = haystack.trim();
    const b = needle.trim();
    return exact ? a === b : a.toLowerCase().includes(b.toLowerCase());
  };

  switch (descriptor.strategy) {
    case 'testId':
      return element.testId === descriptor.value;

    case 'role':
      if (element.ariaRole !== descriptor.value) return false;
      // No name on the descriptor means every element in that role matches.
      return descriptor.name === undefined
        || contains(element.accessibleName, descriptor.name, descriptor.exact);

    case 'label':
      return contains(element.label, descriptor.value, descriptor.exact);

    case 'placeholder':
      return contains(element.placeholder, descriptor.value, descriptor.exact);

    case 'altText':
      return contains(element.attributes['alt'] ?? null, descriptor.value, descriptor.exact);

    case 'title':
      return contains(element.title, descriptor.value, descriptor.exact);

    case 'text':
      return contains(element.text, descriptor.value, descriptor.exact);

    case 'css': {
      // Only the two shapes this builder emits are counted; anything else is left alone.
      const byId = /^#(.+)$/.exec(descriptor.value);
      if (byId) return element.elementId === unescapeCss(byId[1]!);

      const byName = /^([a-z]+)\[name="(.+)"\]$/.exec(descriptor.value);
      if (byName) {
        return element.tagName === byName[1] && element.name === unescapeCss(byName[2]!);
      }
      return matchesOnlyItself(descriptor, element);
    }

    case 'xpath':
      // An absolute XPath addresses one node by construction.
      return element.xpath === descriptor.value;

    default:
      return matchesOnlyItself(descriptor, element);
  }
}

/**
 * The conservative answer for a strategy this mirror does not model: report one match, so
 * `matchCount` returns 1 and the candidate is kept.
 */
function matchesOnlyItself(descriptor: LocatorDescriptor, element: RawElement): boolean {
  return element.cssSelector === descriptor.value || element.xpath === descriptor.value;
}

function unescapeCss(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}
