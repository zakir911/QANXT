import type { Page } from 'playwright';
import type { AuthConfig, LocatorDescriptor } from '@aira/shared-types';
import { buildLocator, resolveLocator } from './locator-resolver.js';

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
