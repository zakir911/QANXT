import type { Locator, Page } from 'playwright';
import type { BrowserAction, LocatorDescriptor, PlannedAssertion } from '@aira/shared-types';
import { buildLocator, resolveLocator } from '../browser/locator-resolver.js';
import { isUrlAllowed } from '../security/url-guard.js';

/**
 * Executes one validated action against a page.
 *
 * Deliberately mechanical: no interpretation, no retries of its own, no fallbacks beyond
 * the ones declared on the locator. Everything clever — planning, healing, deciding what a
 * failure means — happens elsewhere, so that what actually touched the browser is exactly
 * what the plan said and can be replayed from the record.
 */

export interface ActionContext {
  defaultTimeoutMs: number;
  allowScriptExecution: boolean;
  allowedHosts: string[];
  allowPrivateNetworks: boolean;
  baseUrl: string;
  /** Resolves ${secret:...} and ${data:...} references to their values. */
  resolveValue(raw: string | undefined): string | undefined;
}

export class ActionError extends Error {
  constructor(message: string, readonly isLocatorFailure: boolean, readonly locator?: LocatorDescriptor) {
    super(message);
    this.name = 'ActionError';
  }
}

/** Runs an action, optionally against a locator that replaced the planned one (healing). */
export async function runAction(
  page: Page,
  action: BrowserAction,
  context: ActionContext,
  overrideLocator?: LocatorDescriptor
): Promise<void> {
  const timeout = action.timeoutMs ?? context.defaultTimeoutMs;
  const target = overrideLocator ?? action.target;

  switch (action.action) {
    case 'navigate': {
      const url = absolute(action.url ?? '', context.baseUrl);
      const guard = isUrlAllowed(url, {
        allowedHosts: context.allowedHosts,
        excludedPathPrefixes: [],
        allowPrivateNetworks: context.allowPrivateNetworks
      });
      // Re-checked here, not only at planning time: a redirect can take a permitted URL
      // somewhere that is not.
      if (!guard.allowed) throw new ActionError(`Navigation to ${url} was refused: ${guard.reason}`, false);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    }

    case 'click':
      await locate(page, target, timeout).then(l => l.click({ timeout }));
      return;

    case 'doubleClick':
      await locate(page, target, timeout).then(l => l.dblclick({ timeout }));
      return;

    case 'fill': {
      const value = context.resolveValue(action.value) ?? '';
      await locate(page, target, timeout).then(l => l.fill(value, { timeout }));
      return;
    }

    case 'select': {
      const value = context.resolveValue(action.value) ?? '';
      await locate(page, target, timeout).then(l => l.selectOption(value, { timeout }));
      return;
    }

    case 'check':
      await locate(page, target, timeout).then(l => l.check({ timeout }));
      return;

    case 'uncheck':
      await locate(page, target, timeout).then(l => l.uncheck({ timeout }));
      return;

    case 'hover':
      await locate(page, target, timeout).then(l => l.hover({ timeout }));
      return;

    case 'press': {
      const key = action.key ?? action.value ?? 'Enter';
      if (target) await locate(page, target, timeout).then(l => l.press(key, { timeout }));
      else await page.keyboard.press(key);
      return;
    }

    case 'upload': {
      if (!action.filePath) throw new ActionError('upload requires a file path.', false);
      await locate(page, target, timeout).then(l => l.setInputFiles(action.filePath!, { timeout }));
      return;
    }

    case 'download': {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout }),
        target ? locate(page, target, timeout).then(l => l.click({ timeout })) : Promise.resolve()
      ]);
      // Failure is surfaced rather than swallowed: a download that never arrives is a
      // genuine result, not a detail to hide.
      const failure = await download.failure();
      if (failure) throw new ActionError(`The download failed: ${failure}`, false);
      return;
    }

    case 'wait': {
      const ms = Math.min(action.timeoutMs ?? 1000, 30_000);
      if (target) {
        await locate(page, target, timeout).then(l => l.waitFor({ state: 'visible', timeout }));
      } else {
        await page.waitForTimeout(ms);
      }
      return;
    }

    case 'scroll':
      await locate(page, target, timeout).then(l => l.scrollIntoViewIfNeeded({ timeout }));
      return;

    case 'screenshot':
      // Capture is handled by the evidence collector; the verb exists so a plan can ask
      // for a screenshot at a specific point.
      return;

    case 'executeScript': {
      if (!context.allowScriptExecution) {
        throw new ActionError('Script execution is not permitted for this project.', false);
      }
      if (!action.value) throw new ActionError('executeScript requires a script body.', false);
      await page.evaluate(action.value);
      return;
    }

    default:
      if (isAssertionVerb(action.action)) {
        await runAssertionAction(page, action, context, target, timeout);
        return;
      }
      throw new ActionError(`Unsupported action: ${action.action}`, false);
  }
}

function isAssertionVerb(action: string): boolean {
  return action.startsWith('assert');
}

async function runAssertionAction(
  page: Page, action: BrowserAction, context: ActionContext,
  target: LocatorDescriptor | undefined, timeout: number
): Promise<void> {
  const expected = context.resolveValue(action.expected) ?? action.expected ?? '';

  switch (action.action) {
    case 'assertUrl': {
      await page.waitForFunction(
        (substring: string) => location.href.includes(substring),
        expected,
        { timeout }
      ).catch(() => {
        throw new ActionError(`Expected the URL to contain "${expected}" but it was "${page.url()}".`, false);
      });
      return;
    }

    case 'assertVisible': {
      // Resolution is deliberately outside the catch below: an element that is absent
      // entirely is a locator failure, and healing should be given a chance at it. Only a
      // resolved-but-invisible element is an assertion failure.
      const locator = await locate(page, target, timeout);
      try {
        await locator.waitFor({ state: 'visible', timeout });
      } catch {
        throw new ActionError('The element was found but was not visible.', false);
      }
      return;
    }

    case 'assertHidden': {
      // An absent element satisfies "hidden", so resolution failing here is a pass rather
      // than something to heal.
      if (!target) throw new ActionError('assertHidden requires a target locator.', false);
      const count = await countOf(page, target);
      if (count === 0) return;

      const locator = buildLocator(page, target).first();
      try {
        await locator.waitFor({ state: 'hidden', timeout });
      } catch {
        throw new ActionError('The element was expected to be hidden but was visible.', false);
      }
      return;
    }

    case 'assertText': {
      const locator = await locate(page, target, timeout);
      const actual = (await locator.textContent({ timeout }))?.replace(/\s+/g, ' ').trim() ?? '';
      if (!actual.includes(expected.trim())) {
        throw new ActionError(`Expected the element to contain "${expected}" but it read "${actual}".`, false);
      }
      return;
    }

    case 'assertValue': {
      const locator = await locate(page, target, timeout);
      const actual = await locator.inputValue({ timeout });
      if (actual !== expected) {
        throw new ActionError(`Expected the value "${expected}" but found "${actual}".`, false);
      }
      return;
    }

    case 'assertCount': {
      if (!target) throw new ActionError('assertCount requires a target.', false);
      // Counted from the descriptor rather than a resolved locator: resolution narrows to
      // a single element, which would make every count assertion read 1.
      const actual = await countOf(page, target);
      if (actual !== action.count) {
        throw new ActionError(`Expected ${action.count} matching elements but found ${actual}.`, false);
      }
      return;
    }

    case 'assertAttribute': {
      const locator = await locate(page, target, timeout);
      const actual = await locator.getAttribute(action.attribute!, { timeout });
      if (actual !== expected) {
        throw new ActionError(`Expected attribute "${action.attribute}" to be "${expected}" but it was "${actual ?? '(absent)'}".`, false);
      }
      return;
    }

    case 'assertEnabled': {
      const locator = await locate(page, target, timeout);
      if (!await locator.isEnabled({ timeout })) throw new ActionError('The element was expected to be enabled but was disabled.', false);
      return;
    }

    case 'assertDisabled': {
      const locator = await locate(page, target, timeout);
      if (await locator.isEnabled({ timeout })) throw new ActionError('The element was expected to be disabled but was enabled.', false);
      return;
    }

    default:
      throw new ActionError(`Unsupported assertion: ${action.action}`, false);
  }
}

export interface AssertionOutcome {
  /** null when the assertion held. */
  failure: string | null;
  /** True when the assertion failed because its locator resolved to nothing — which is
   *  healable, unlike an assertion that resolved and then disagreed about a value. */
  isLocatorFailure: boolean;
}

/**
 * Evaluates a standalone assertion attached to a step.
 *
 * An assertion's locator breaks exactly like an action's does, so the outcome distinguishes
 * "I could not find the element" from "I found it and it was wrong". Only the first is
 * something healing can help with; treating the second as healable would let a test quietly
 * re-point at whatever element happens to satisfy it.
 */
export async function evaluateAssertion(
  page: Page, assertion: PlannedAssertion, context: ActionContext,
  overrideTarget?: LocatorDescriptor
): Promise<AssertionOutcome> {
  const timeout = context.defaultTimeoutMs;
  const expected = context.resolveValue(assertion.expected) ?? assertion.expected ?? '';
  const target = overrideTarget ?? assertion.target;

  const check = async (): Promise<string | null> => {
    switch (assertion.type) {
      case 'urlEquals':
        return page.url() === expected ? null : `Expected the URL to be "${expected}" but it was "${page.url()}".`;
      case 'urlContains':
        return page.url().includes(expected) ? null : `Expected the URL to contain "${expected}" but it was "${page.url()}".`;
      case 'visible': {
        const locator = await locate(page, target, timeout);
        return await locator.isVisible() ? null : 'The element was expected to be visible but was not.';
      }
      case 'hidden': {
        const count = target ? await countOf(page, target) : 0;
        return count === 0 ? null : 'The element was expected to be hidden but was present and visible.';
      }
      case 'textEquals': {
        const locator = await locate(page, target, timeout);
        const actual = (await locator.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
        return actual === expected.trim() ? null : `Expected the text "${expected}" but found "${actual}".`;
      }
      case 'textContains': {
        const locator = await locate(page, target, timeout);
        const actual = (await locator.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
        return actual.includes(expected.trim()) ? null : `Expected the text to contain "${expected}" but it read "${actual}".`;
      }
      case 'valueEquals': {
        const locator = await locate(page, target, timeout);
        const actual = await locator.inputValue();
        return actual === expected ? null : `Expected the value "${expected}" but found "${actual}".`;
      }
      case 'countEquals': {
        const actual = target ? await countOf(page, target) : 0;
        return String(actual) === expected ? null : `Expected ${expected} matching elements but found ${actual}.`;
      }
      case 'attributeEquals': {
        const locator = await locate(page, target, timeout);
        const actual = await locator.getAttribute(assertion.attribute ?? '');
        return actual === expected ? null : `Expected attribute "${assertion.attribute}" to be "${expected}" but it was "${actual ?? '(absent)'}".`;
      }
      case 'enabled': {
        const locator = await locate(page, target, timeout);
        return await locator.isEnabled() ? null : 'The element was expected to be enabled but was disabled.';
      }
      case 'disabled': {
        const locator = await locate(page, target, timeout);
        return await locator.isEnabled() ? 'The element was expected to be disabled but was enabled.' : null;
      }
      default:
        return `Unsupported assertion type: ${assertion.type}`;
    }
  };

  try {
    const failure = await check();
    if (failure === null) return { failure: null, isLocatorFailure: false };
    return { failure: assertion.negate ? null : failure, isLocatorFailure: false };
  } catch (error) {
    const isLocatorFailure = error instanceof ActionError && error.isLocatorFailure;
    const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
    return { failure: assertion.negate ? null : message, isLocatorFailure };
  }
}

async function locate(page: Page, descriptor: LocatorDescriptor | undefined, timeoutMs: number): Promise<Locator> {
  if (!descriptor) throw new ActionError('This action requires a target locator but none was supplied.', false);
  try {
    const resolved = await resolveLocator(page, descriptor, { timeoutMs });
    return resolved.locator;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Flagged as a locator failure so the caller knows healing is worth attempting;
    // an assertion that merely read the wrong text is not.
    throw new ActionError(message, true, descriptor);
  }
}

async function countOf(page: Page, descriptor: LocatorDescriptor): Promise<number> {
  return buildLocator(page, descriptor).count();
}

function absolute(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}
