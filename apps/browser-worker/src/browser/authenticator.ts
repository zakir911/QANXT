import type { Page } from 'playwright';
import type { AuthConfig, LocatorDescriptor } from '@qa-nxt/shared-types';
import { buildLocator, resolveLocator } from './locator-resolver.js';
import { totp, totpSecondsRemaining } from './totp.js';

/**
 * Signs into the application under test.
 *
 * Login is described declaratively by the application's configuration rather than being
 * a recorded script, because it is the one flow every run depends on: when it is
 * data, a change to the login page is a configuration edit, not a rewrite of every test.
 * Credentials arrive already decrypted for this job and are never written anywhere.
 */

export interface LoginOptions {
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
}

export interface LoginResult {
  succeeded: boolean;
  message: string;
  actionsUsed: number;
}

export async function performLogin(page: Page, auth: AuthConfig, options: LoginOptions): Promise<LoginResult> {
  switch (auth.strategy) {
    case 'none':
      return { succeeded: true, message: 'No authentication required.', actionsUsed: 0 };

    case 'storageState':
      // The context was already created with the storage state; nothing to do here.
      return { succeeded: true, message: 'Using the supplied storage state.', actionsUsed: 0 };

    case 'bearerToken':
    case 'basicAuth':
      // Both are applied as context-level headers/credentials at context creation.
      return { succeeded: true, message: 'Using header-based authentication.', actionsUsed: 0 };

    case 'formLogin':
      return performFormLogin(page, auth, options);

    default: {
      const exhaustive: never = auth.strategy;
      return { succeeded: false, message: `Unsupported authentication strategy: ${String(exhaustive)}`, actionsUsed: 0 };
    }
  }
}

async function performFormLogin(page: Page, auth: AuthConfig, options: LoginOptions): Promise<LoginResult> {
  let actions = 0;

  if (!auth.loginUrl) return fail('No login URL is configured for this application.', actions);
  if (!auth.username) return fail('No username was supplied for form login.', actions);
  if (!auth.password) return fail('No password was supplied for form login.', actions);

  try {
    await page.goto(auth.loginUrl, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs });
    actions++;
  } catch (error) {
    return fail(`The login page could not be loaded: ${messageOf(error)}`, actions);
  }

  // Sensible defaults so an application with a conventional login form needs no
  // configuration beyond a URL and credentials.
  const usernameLocator = auth.usernameLocator ?? defaultUsernameLocator();
  const passwordLocator = auth.passwordLocator ?? defaultPasswordLocator();
  const submitLocator = auth.submitLocator ?? defaultSubmitLocator();

  try {
    const username = await resolveLocator(page, usernameLocator, { timeoutMs: options.actionTimeoutMs });
    await username.locator.fill(auth.username);
    actions++;

    const password = await resolveLocator(page, passwordLocator, { timeoutMs: options.actionTimeoutMs });
    await password.locator.fill(auth.password);
    actions++;

    const submit = await resolveLocator(page, submitLocator, { timeoutMs: options.actionTimeoutMs });
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: options.navigationTimeoutMs }).catch(() => undefined),
      submit.locator.click({ timeout: options.actionTimeoutMs })
    ]);
    actions++;
  } catch (error) {
    return fail(`The login form could not be completed: ${messageOf(error)}`, actions);
  }

  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);

  // Neither wait above observes a single-page application signing in.
  //
  // `domcontentloaded` resolves at once because no navigation is coming, and
  // `waitForLoadState('networkidle')` resolves at once too: Playwright returns as soon as
  // the page is *currently* idle, and it is — the click's fetch has not been issued yet.
  // Verifying here would judge the attempt while the request is still in flight, which is
  // exactly what BUG-0007 was: correct credentials posted, then reported as wrong five
  // milliseconds before the application answered.
  await waitForSignInOutcome(page, auth, options);

  // Many applications ask for a one-time code once the password is accepted. Answering it
  // here is what lets every page behind it be explored and tested.
  const otp = await completeOneTimeCode(page, auth, options);
  actions += otp.actionsUsed;
  if (!otp.succeeded) return fail(otp.message, actions);

  // Verify rather than assume. A login form that re-renders with an error message is the
  // most common cause of a "successful" run that maps nothing but the login page.
  if (auth.successLocator) {
    try {
      await buildLocator(page, auth.successLocator).first()
        .waitFor({ state: 'visible', timeout: options.actionTimeoutMs });
    } catch {
      return fail('The configured post-login element did not appear; the credentials are probably wrong.', actions);
    }
  } else if (auth.successUrlContains) {
    if (!page.url().includes(auth.successUrlContains)) {
      return fail(`After signing in the browser was at ${page.url()}, which does not contain "${auth.successUrlContains}".`, actions);
    }
  } else if (page.url().startsWith(auth.loginUrl) && await hasVisiblePasswordField(page)) {
    return fail('The browser is still on the login page with a password field visible; the credentials are probably wrong.', actions);
  }

  return { succeeded: true, message: 'Signed in.', actionsUsed: actions };
}

/**
 * Waits for the sign-in to finish, whichever way this application finishes it.
 *
 * Returns as soon as the outcome is knowable rather than sleeping for a fixed time: a
 * server-rendered application navigates, a single-page application swaps the view, and
 * either may instead render an error. Waiting for a *failure* signal as well as a success
 * one is what keeps a genuinely wrong password fast — and still a failure.
 */
async function waitForSignInOutcome(page: Page, auth: AuthConfig, options: LoginOptions): Promise<void> {
  const deadline = Date.now() + options.actionTimeoutMs;

  while (Date.now() < deadline) {
    if (page.isClosed()) return;

    try {
      if (auth.successLocator) {
        if (await buildLocator(page, auth.successLocator).first().isVisible().catch(() => false)) return;
      }
      if (auth.successUrlContains && page.url().includes(auth.successUrlContains)) return;

      const leftTheLoginPage = auth.loginUrl !== undefined && !page.url().startsWith(auth.loginUrl);
      if (leftTheLoginPage) return;

      // The password field going away is what a client-rendered application does instead
      // of navigating.
      if (!await hasVisiblePasswordField(page)) return;

      // An error the application has already rendered means the answer has arrived and it
      // is "no". Waiting out the rest of the timeout would only slow the report down.
      if (await hasVisibleError(page)) return;
    } catch {
      // A navigation can tear down the execution context mid-check; the next iteration
      // asks again rather than treating that as an answer.
    }

    await page.waitForTimeout(100);
  }
}

/** Selectors for an input that asks for a one-time code, most specific first. */
const OTP_FIELD_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]', 'input[id*="otp" i]',
  'input[name*="totp" i]', 'input[name*="mfa" i]', 'input[name*="2fa" i]',
  'input[name*="verification" i]', 'input[id*="verification" i]',
  'input[name*="passcode" i]', 'input[id*="passcode" i]',
  'input[name="code" i]', 'input[id="code" i]',
  'input[aria-label*="one-time" i]', 'input[aria-label*="verification code" i]',
  'input[placeholder*="code" i][inputmode="numeric"]'
].map(selector => `${selector}:visible`);

/** Separate one-character boxes, one per digit. */
const OTP_DIGIT_BOXES = 'input[maxlength="1"]:visible';

interface OtpField { kind: 'single' | 'digits'; count: number; selector: string }

async function findOtpField(page: Page): Promise<OtpField | undefined> {
  for (const selector of OTP_FIELD_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count === 1) return { kind: 'single', count, selector };
    if (count >= 4 && count <= 8) return { kind: 'digits', count, selector };
  }
  // A label naming the code, for forms that give the input no telling name.
  for (const label of [/one[- ]time/i, /verification code/i, /security code/i, /authenticat(ion|or) code/i, /\b(otp|2fa|mfa)\b/i]) {
    const field = page.getByLabel(label);
    if (await field.count().catch(() => 0) === 1 && await field.isVisible().catch(() => false)
      && await field.evaluate(element => element instanceof HTMLInputElement).catch(() => false)) {
      const id = await field.evaluate(element => (element as HTMLInputElement).id).catch(() => '');
      if (id) return { kind: 'single', count: 1, selector: `[id="${id}"]` };
    }
  }
  const digits = await page.locator(OTP_DIGIT_BOXES).count().catch(() => 0);
  if (digits >= 4 && digits <= 8) return { kind: 'digits', count: digits, selector: OTP_DIGIT_BOXES };
  return undefined;
}

/**
 * Answers a one-time-code prompt if the application shows one after the password.
 *
 * An application that asks for no code passes straight through. One that asks when no code
 * is configured fails with a message that says what to configure, rather than going on to
 * explore a sign-in page and calling it the application.
 */
async function completeOneTimeCode(page: Page, auth: AuthConfig, options: LoginOptions): Promise<LoginResult> {
  const field = await findOtpField(page);
  if (!field) return { succeeded: true, message: 'No one-time code was asked for.', actionsUsed: 0 };

  const mode = auth.otpMode ?? 'none';
  if (mode === 'none' || !auth.otpValue) {
    return fail('After the password the application asked for a one-time code, and none is configured. '
      + 'Edit the application and set "Second step after sign-in" to a fixed test code or an authenticator secret.', 0);
  }

  let code: string;
  if (mode === 'totp') {
    // A code about to expire may be refused by the time it arrives; wait for a fresh one.
    if (totpSecondsRemaining() < 4) await page.waitForTimeout(totpSecondsRemaining() * 1000 + 200);
    try {
      code = totp(auth.otpValue);
    } catch (error) {
      return fail(messageOf(error), 0);
    }
  } else {
    code = auth.otpValue.trim();
  }

  let actions = 0;
  try {
    if (field.kind === 'single') {
      await page.locator(field.selector).first().fill(code, { timeout: options.actionTimeoutMs });
      actions++;
    } else {
      const boxes = page.locator(field.selector);
      // Typing into the first box suits applications that move focus themselves; filling
      // each box covers the ones that do not.
      for (let index = 0; index < Math.min(field.count, code.length); index++) {
        await boxes.nth(index).fill(code[index]!, { timeout: options.actionTimeoutMs });
        actions++;
      }
    }

    const submit = await resolveLocator(page, defaultOtpSubmitLocator(), { timeoutMs: 1500 }).catch(() => undefined);
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: options.navigationTimeoutMs }).catch(() => undefined),
      submit
        ? submit.locator.click({ timeout: options.actionTimeoutMs })
        : page.keyboard.press('Enter')
    ]);
    actions++;
  } catch (error) {
    return fail(`The one-time code could not be entered: ${messageOf(error)}`, actions);
  }

  // Wait for the prompt to go away, or for the application to say no.
  const deadline = Date.now() + options.actionTimeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    try {
      if (!await findOtpField(page)) {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
        return { succeeded: true, message: 'One-time code accepted.', actionsUsed: actions };
      }
      if (await hasVisibleError(page)) break;
    } catch {
      // Navigation in progress; ask again.
    }
    await page.waitForTimeout(100);
  }

  return fail(mode === 'totp'
    ? 'The application did not accept the authenticator code. Check that the secret belongs to this test account and that the worker clock is correct.'
    : 'The application did not accept the fixed one-time code. Check the code configured for this application.', actions);
}

function defaultOtpSubmitLocator(): LocatorDescriptor {
  return {
    strategy: 'role', value: 'button', name: 'Verify',
    fallbacks: [
      { strategy: 'role', value: 'button', name: 'Continue' },
      { strategy: 'role', value: 'button', name: 'Submit' },
      { strategy: 'role', value: 'button', name: 'Confirm' },
      { strategy: 'role', value: 'button', name: 'Sign in' },
      { strategy: 'role', value: 'button', name: 'Log in' },
      { strategy: 'css', value: 'button[type="submit"]:visible' },
      { strategy: 'css', value: 'input[type="submit"]:visible' }
    ]
  };
}

/** An alert or an error region the application rendered in response to the attempt. */
async function hasVisibleError(page: Page): Promise<boolean> {
  return page.locator('[role="alert"]:visible, [data-testid*="error"]:visible, .error:visible')
    .count().then(count => count > 0).catch(() => false);
}

async function hasVisiblePasswordField(page: Page): Promise<boolean> {
  return page.locator('input[type="password"]:visible').count().then(count => count > 0).catch(() => false);
}

function defaultUsernameLocator(): LocatorDescriptor {
  return {
    strategy: 'label', value: 'Username',
    fallbacks: [
      { strategy: 'css', value: 'input[name="username"]' },
      { strategy: 'css', value: 'input[name="email"]' },
      { strategy: 'placeholder', value: 'Username' },
      { strategy: 'role', value: 'textbox' }
    ]
  };
}

function defaultPasswordLocator(): LocatorDescriptor {
  return {
    strategy: 'css', value: 'input[type="password"]',
    fallbacks: [
      { strategy: 'label', value: 'Password' },
      { strategy: 'placeholder', value: 'Password' }
    ]
  };
}

function defaultSubmitLocator(): LocatorDescriptor {
  return {
    strategy: 'role', value: 'button', name: 'Sign in',
    fallbacks: [
      { strategy: 'role', value: 'button', name: 'Log in' },
      { strategy: 'role', value: 'button', name: 'Login' },
      { strategy: 'css', value: 'button[type="submit"]' },
      { strategy: 'css', value: 'input[type="submit"]' }
    ]
  };
}

function fail(message: string, actionsUsed: number): LoginResult {
  return { succeeded: false, message, actionsUsed };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
}
