import type { Frame, Locator, Page } from 'playwright';
import type { LocatorDescriptor } from '@qa-nxt/shared-types';

/**
 * Turns the platform's locator grammar into a Playwright locator.
 *
 * This is the single place that knows how a descriptor maps onto the browser. Keeping it
 * isolated is what lets the rest of the system — authoring, healing, reporting — talk
 * about locators semantically without any component reaching for a raw selector.
 */

export interface ResolveOptions {
  /** How long to wait for the element to exist before giving up. */
  timeoutMs: number;
}

export class LocatorResolutionError extends Error {
  constructor(
    message: string,
    readonly descriptor: LocatorDescriptor,
    readonly attempted: string[],
    readonly candidateCount: number
  ) {
    super(message);
    this.name = 'LocatorResolutionError';
  }
}

/** Builds a locator without touching the page: pure translation, no waiting. */
export function buildLocator(scope: Page | Frame | Locator, descriptor: LocatorDescriptor): Locator {
  const root: Page | Frame | Locator = descriptor.within
    ? buildLocator(scope, descriptor.within)
    : scope;

  let locator: Locator;
  switch (descriptor.strategy) {
    case 'role':
      locator = root.getByRole(descriptor.value as Parameters<Page['getByRole']>[0], {
        ...(descriptor.name ? { name: descriptor.name } : {}),
        ...(descriptor.exact !== undefined ? { exact: descriptor.exact } : {})
      });
      break;
    case 'testId':
      locator = root.getByTestId(descriptor.value);
      break;
    case 'label':
      locator = root.getByLabel(descriptor.value, { exact: descriptor.exact ?? false });
      break;
    case 'placeholder':
      locator = root.getByPlaceholder(descriptor.value, { exact: descriptor.exact ?? false });
      break;
    case 'text':
      locator = root.getByText(descriptor.value, { exact: descriptor.exact ?? false });
      break;
    case 'altText':
      locator = root.getByAltText(descriptor.value, { exact: descriptor.exact ?? false });
      break;
    case 'title':
      locator = root.getByTitle(descriptor.value, { exact: descriptor.exact ?? false });
      break;
    case 'css':
      locator = root.locator(descriptor.value);
      break;
    case 'xpath':
      locator = root.locator(`xpath=${descriptor.value}`);
      break;
    default: {
      // The strategy set is closed; an unknown value means a contract violation upstream.
      const exhaustive: never = descriptor.strategy;
      throw new Error(`Unsupported locator strategy: ${String(exhaustive)}`);
    }
  }

  return descriptor.nth === undefined ? locator : locator.nth(descriptor.nth);
}

export interface ResolvedLocator {
  locator: Locator;
  descriptor: LocatorDescriptor;
  /** True when the primary failed and a declared fallback was used instead. */
  usedFallback: boolean;
  attempts: string[];
}

/**
 * Resolves a descriptor to exactly one attached element, trying declared fallbacks in
 * order. A locator that matches several elements is a defect in the test, not something
 * to silently pick the first of, so it is reported rather than guessed at.
 */
export async function resolveLocator(
  scope: Page | Frame,
  descriptor: LocatorDescriptor,
  options: ResolveOptions
): Promise<ResolvedLocator> {
  const attempts: string[] = [];
  const candidates = [descriptor, ...(descriptor.fallbacks ?? [])];
  const perCandidateTimeout = Math.max(500, Math.floor(options.timeoutMs / candidates.length));

  for (const [index, candidate] of candidates.entries()) {
    const locator = buildLocator(scope, candidate);
    attempts.push(describeAttempt(candidate));

    try {
      await locator.first().waitFor({ state: 'attached', timeout: perCandidateTimeout });
    } catch {
      continue;
    }

    const count = await locator.count();
    if (count === 0) continue;

    if (count > 1 && candidate.nth === undefined) {
      throw new LocatorResolutionError(
        `${describeAttempt(candidate)} matched ${count} elements. Narrow the locator, or set "nth" to choose one deliberately.`,
        candidate, attempts, count
      );
    }

    return { locator: locator.first(), descriptor: candidate, usedFallback: index > 0, attempts };
  }

  throw new LocatorResolutionError(
    `No element matched ${describeAttempt(descriptor)}${attempts.length > 1 ? ` (or ${attempts.length - 1} declared fallback(s))` : ''}.`,
    descriptor, attempts, 0
  );
}

export function describeAttempt(descriptor: LocatorDescriptor): string {
  const base = (() => {
    switch (descriptor.strategy) {
      case 'role': return `role=${descriptor.value}${descriptor.name ? ` name="${descriptor.name}"` : ''}`;
      case 'testId': return `testId="${descriptor.value}"`;
      case 'label': return `label="${descriptor.value}"`;
      case 'placeholder': return `placeholder="${descriptor.value}"`;
      case 'text': return `text="${descriptor.value}"`;
      case 'altText': return `altText="${descriptor.value}"`;
      case 'title': return `title="${descriptor.value}"`;
      case 'css': return `css=${descriptor.value}`;
      case 'xpath': return `xpath=${descriptor.value}`;
      default: return descriptor.value;
    }
  })();

  const within = descriptor.within ? ` within ${describeAttempt(descriptor.within)}` : '';
  const nth = descriptor.nth === undefined ? '' : ` [nth=${descriptor.nth}]`;
  return `${base}${nth}${within}`;
}
