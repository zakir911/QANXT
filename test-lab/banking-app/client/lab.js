/**
 * The lab's runtime configuration, injected into the page by the server.
 *
 * Kept in one place because two of the faults — dynamic locators and the renamed sign-in
 * control — are about how elements are *addressed*, and an application that scatters that
 * decision across twenty components cannot switch it cleanly.
 */
const config = globalThis.__LAB__ ?? {
  version: 'dev', salt: 'dev', dynamicLocators: false, renamedSignIn: false,
  removedSignIn: false, slowElement: 0, jsError: false, invalidValidation: false
};

export const lab = config;

/**
 * Spreads a test id onto an element.
 *
 * Under FAULT_DYNAMIC_LOCATOR the id carries a per-session suffix, so automation that
 * memorised `transaction-row-txn-1001-004` finds nothing on the next session while
 * automation that asked for a row by its role and text still works.
 */
export function testId(name) {
  return { 'data-testid': config.dynamicLocators ? `${name}--${config.salt}` : name };
}

/** Element ids are always per-session, the way a hashing framework would emit them. */
export function domId(name) {
  return `${name}-${config.salt}`;
}

export const money = (value, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value ?? 0);
