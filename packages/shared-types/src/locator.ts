import type { LocatorStrategy } from './enums.js';

/**
 * How the execution engine finds an element. A locator is never a bare CSS string:
 * it carries a strategy, optional scoping and an ordered list of fallbacks that are
 * tried before any healing is attempted.
 */
export interface LocatorDescriptor {
  strategy: LocatorStrategy;
  /** Role name for `role`, test id for `testId`, selector for `css`, and so on. */
  value: string;
  /** Accessible name, used together with `strategy: 'role'`. */
  name?: string;
  /** Require an exact rather than a substring match on the name or text. */
  exact?: boolean;
  /** Zero-based disambiguator when several elements match. */
  nth?: number;
  /** Scopes the search, e.g. inside a dialog or a table row. */
  within?: LocatorDescriptor;
  /** Tried in order when the primary does not resolve. */
  fallbacks?: LocatorDescriptor[];
}

/** 0-100 estimate of how well a locator survives UI change. Mirrors the server's scoring. */
export function locatorStability(locator: LocatorDescriptor): number {
  switch (locator.strategy) {
    case 'testId': return 95;
    case 'role': return locator.name ? 90 : 65;
    case 'label': return 85;
    case 'placeholder': return 70;
    case 'altText': return 70;
    case 'title': return 60;
    case 'text': return 55;
    case 'css': return 30;
    case 'xpath': return 15;
    default: return 20;
  }
}

/** Human-readable form used in logs, reports and healing explanations. */
export function describeLocator(locator: LocatorDescriptor): string {
  switch (locator.strategy) {
    case 'role': return `role=${locator.value}${locator.name ? ` name="${locator.name}"` : ''}`;
    case 'testId': return `testId="${locator.value}"`;
    case 'label': return `label="${locator.value}"`;
    case 'placeholder': return `placeholder="${locator.value}"`;
    case 'text': return `text="${locator.value}"`;
    case 'altText': return `altText="${locator.value}"`;
    case 'title': return `title="${locator.value}"`;
    case 'css': return `css=${locator.value}`;
    case 'xpath': return `xpath=${locator.value}`;
    default: return locator.value;
  }
}

/**
 * A snapshot of what the target element looked like when the step was authored.
 *
 * Healing needs something to compare against: a locator alone says how we used to find
 * the element, not what it was. With a fingerprint, a renamed button can be recognised by
 * its role, position, neighbours and ancestry even though its accessible name changed.
 */
export interface ElementFingerprint {
  tagName?: string;
  ariaRole?: string;
  accessibleName?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  elementId?: string;
  name?: string;
  type?: string;
  domPath?: string;
  parentSignature?: string;
  neighbourText?: string;
  bounding?: { x: number; y: number; width: number; height: number };
  /** Locators that resolved to this element in the past, newest first. */
  history?: LocatorDescriptor[];
}
