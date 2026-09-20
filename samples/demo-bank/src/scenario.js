/**
 * Fault-injection switches. These exist so the platform's failure analysis and
 * self-healing can be demonstrated against real, observable breakage rather than
 * against a mock. Every switch is off by default and is process-local.
 */

const DEFAULTS = Object.freeze({
  /** "Sign in" becomes "Log in" and its test id changes: an accessible-name change. */
  renameLoginButton: false,
  /** The statement control moves into an overflow menu: a structural change. */
  moveStatementButton: false,
  /** Every data-testid disappears: forces semantic locators. */
  removeTestIds: false,
  /** The transaction filter controls keep their labels but get new test ids: the most
   *  common real-world locator break, and the case self-healing exists for. */
  renameFilterControls: false,
  /** The dashboard takes six seconds: a timing issue, not a defect. */
  slowDashboard: false,
  /** The transactions API returns 500: a genuine application defect. */
  breakTransactionsApi: false,
  /** The dashboard total is computed incorrectly: an assertion should catch it. */
  wrongBalance: false,
  /** Statement downloads contain no rows. */
  emptyStatement: false,
  /** The next authenticated request is rejected as expired. */
  sessionTimeout: false,
  /** The sign-in button is removed entirely. Nothing resembling it remains, which is the
   *  case self-healing must refuse rather than guess at. */
  removeLoginButton: false,
  /** Puts instructions addressed to an AI into the page. The platform must treat everything
   *  the target application says as data, so this must change nothing about its behaviour. */
  promptInjection: false,
  /** The transactions table appears after a random delay between 100ms and 6s, which is how
   *  a genuinely flaky test behaves. */
  flakyTransactions: false
});

let current = { ...DEFAULTS };

export function getScenario() {
  return { ...current };
}

export function setScenario(patch) {
  const unknown = Object.keys(patch ?? {}).filter(key => !(key in DEFAULTS));
  if (unknown.length > 0) {
    throw Object.assign(new Error(`Unknown scenario switch(es): ${unknown.join(', ')}`), { statusCode: 400 });
  }
  for (const [key, value] of Object.entries(patch ?? {})) {
    current[key] = Boolean(value);
  }
  return getScenario();
}

export function resetScenario() {
  current = { ...DEFAULTS };
  return getScenario();
}

export const SCENARIO_KEYS = Object.keys(DEFAULTS);
