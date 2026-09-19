import type { BrowserActionType } from './enums.js';
import { ASSERTION_ACTIONS } from './enums.js';
import type { LocatorDescriptor } from './locator.js';

/**
 * The only executable shape. Whether an action came from a human, the recorder or a
 * model, it is validated against this contract before a browser is touched.
 */
export interface BrowserAction {
  action: BrowserActionType;
  description: string;
  target?: LocatorDescriptor;
  /** Literal text, or a `${secret:name}` / `${data:field}` reference. */
  value?: string;
  url?: string;
  timeoutMs?: number;
  /** Expected value for assertion verbs. */
  expected?: string;
  attribute?: string;
  count?: number;
  key?: string;
  filePath?: string;
  /** When false, a failure records but does not stop the test. */
  critical?: boolean;
}

export function isAssertion(action: BrowserAction): boolean {
  return ASSERTION_ACTIONS.includes(action.action);
}

/** A value that resolves at dispatch time rather than being stored literally. */
export const SECRET_REFERENCE = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/;
export const DATA_REFERENCE = /^\$\{data:([A-Za-z0-9_.-]+)\}$/;

export function isReference(value: string | undefined): boolean {
  return !!value && (SECRET_REFERENCE.test(value) || DATA_REFERENCE.test(value));
}
