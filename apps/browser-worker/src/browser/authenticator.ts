import type { Frame, Page } from 'playwright';
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
  // No password is checked for here: some sign-ins ask only for a user id and a one-time
  // code. A password field with no password configured fails when it is reached.

  try {
    await page.goto(auth.loginUrl, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs });
    actions++;
  } catch (error) {
    return fail(`The login page could not be loaded: ${messageOf(error)}`, actions);
  }

  // Locators configured for this application win; without them the form is found the way a
  // person finds it, wherever and however late it renders.
  try {
    const filled = await fillSignInForm(page, auth, options);
    actions += filled.actionsUsed;
    if (!filled.succeeded) return fail(filled.message, actions);
  } catch (error) {
    return fail(`The login form could not be completed: ${messageOf(error)}${await describeVisibleForm(page)}`, actions);
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

type Scope = Page | Frame;

const TEXT_INPUT = 'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="number"]';
const PASSWORD_INPUT = 'input[type="password"]:visible';
const PRIMARY_BUTTON = /\b(sign ?in|log ?in|login|continue|next|proceed|submit|verify|send otp|get otp|request otp|generate otp)\b/i;
const NOT_PRIMARY = /forgot|register|sign ?up|create|reset|cancel|back|help|google|facebook|apple|microsoft/i;

/**
 * The frame that holds the sign-in form, waiting for it to render.
 *
 * A single-page application renders its login form after `domcontentloaded`, sometimes
 * seconds after, and some banks and identity providers put it inside an iframe. Looking
 * once, in the top frame, is what reported a perfectly good login page as having no
 * password field.
 */
async function waitForLoginFrame(page: Page, timeoutMs: number): Promise<Scope | undefined> {
  const deadline = Date.now() + timeoutMs;
  let firstWithText: Scope | undefined;
  let textOnlySince: number | undefined;
  while (Date.now() < deadline) {
    firstWithText = undefined;
    for (const frame of page.frames()) {
      if (await frame.locator(PASSWORD_INPUT).count().catch(() => 0) > 0) return frame === page.mainFrame() ? page : frame;
      if (!firstWithText && await visibleTextInputs(frame).count().catch(() => 0) > 0) {
        firstWithText = frame === page.mainFrame() ? page : frame;
      }
    }
    // A form with only a user id is the first step of a two-step sign-in; give a password
    // field a moment to render beside it before treating it as one.
    textOnlySince = firstWithText ? textOnlySince ?? Date.now() : undefined;
    if (textOnlySince !== undefined && Date.now() - textOnlySince > 1500) return firstWithText;
    await page.waitForTimeout(250);
  }
  return firstWithText;
}

function visibleTextInputs(scope: Scope) {
  return scope.locator(TEXT_INPUT).filter({ visible: true });
}

/** The input a person would type the user name into: scored on its name, label and place. */
async function findUsernameField(scope: Scope) {
  const index = await scope.evaluate(selector => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(selector));
    const password = document.querySelector('input[type="password"]');
    let best = -1;
    let bestScore = -Infinity;
    inputs.forEach((input, i) => {
      const style = getComputedStyle(input);
      const box = input.getBoundingClientRect();
      if (input.disabled || input.readOnly || style.visibility === 'hidden' || style.display === 'none'
        || box.width === 0 || box.height === 0) return;
      const label = [input.name, input.id, input.placeholder, input.getAttribute('aria-label') ?? '',
        input.autocomplete, ...Array.from(input.labels ?? []).map(l => l.textContent ?? '')].join(' ');
      if (/search|captcha|otp|one-time/i.test(label) || input.type === 'search') return;
      let score = 0;
      if (/username|email/.test(input.autocomplete)) score += 6;
      if (/user|email|e-mail|login|log-in|mobile|phone|customer|account|member|client|signin|\bid\b|userid|cif/i.test(label)) score += 3;
      if (password && input.form && input.form === (password as HTMLInputElement).form) score += 2;
      if (password && (input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING)) score += 1;
      score -= i * 0.01; // the earlier of two equals
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }, TEXT_INPUT);
  return index < 0 ? undefined : scope.locator(TEXT_INPUT).nth(index);
}

/** Presses the form's primary button (Sign in, Continue, Next…), or Enter in the field. */
async function pressPrimary(page: Page, scope: Scope, field: ReturnType<Scope['locator']>, configured: LocatorDescriptor | undefined, options: LoginOptions): Promise<void> {
  let button: ReturnType<Scope['locator']> | undefined;
  if (configured) {
    button = (await resolveLocator(scope, configured, { timeoutMs: options.actionTimeoutMs })).locator;
  } else {
    const form = field.locator('xpath=ancestor::form[1]');
    if (await form.count().catch(() => 0) > 0) {
      const inForm = form.locator('button[type="submit"], input[type="submit"], button:not([type])').filter({ visible: true });
      for (let i = 0; i < await inForm.count().catch(() => 0); i++) {
        const name = (await inForm.nth(i).innerText().catch(() => '')) || (await inForm.nth(i).getAttribute('value').catch(() => '')) || '';
        if (!NOT_PRIMARY.test(name)) { button = inForm.nth(i); break; }
      }
    }
    if (!button) {
      const named = scope.getByRole('button', { name: PRIMARY_BUTTON }).filter({ visible: true });
      for (let i = 0; i < await named.count().catch(() => 0); i++) {
        const name = await named.nth(i).innerText().catch(() => '');
        if (!NOT_PRIMARY.test(name)) { button = named.nth(i); break; }
      }
    }
  }

  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: options.navigationTimeoutMs }).catch(() => undefined),
    button ? button.click({ timeout: options.actionTimeoutMs }) : field.press('Enter', { timeout: options.actionTimeoutMs })
  ]);
}

/** Waits for a password field, a one-time-code prompt, or the page to settle without either. */
async function waitForNextStep(page: Page, timeoutMs: number): Promise<'password' | 'otp' | 'neither'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return 'neither';
    for (const frame of page.frames()) {
      if (await frame.locator(PASSWORD_INPUT).count().catch(() => 0) > 0) return 'password';
    }
    if (await findOtpField(page)) return 'otp';
    if (await hasVisibleError(page)) return 'neither';
    await page.waitForTimeout(150);
  }
  return 'neither';
}

/**
 * Fills the user name and password and submits, in one step or two.
 *
 * Banks and identity providers often ask for the user id, then show the password (or a
 * one-time code) on the next screen. When no password field is beside the user id, the
 * form's primary button is pressed and the next screen is answered.
 */
async function fillSignInForm(page: Page, auth: AuthConfig, options: LoginOptions): Promise<LoginResult> {
  let actions = 0;
  const scope = await waitForLoginFrame(page, options.actionTimeoutMs);
  if (!scope) {
    return fail(`No sign-in form appeared on ${page.url()} within ${Math.round(options.actionTimeoutMs / 1000)}s.${await describeVisibleForm(page)}`, actions);
  }

  const username = auth.usernameLocator
    ? (await resolveLocator(scope, auth.usernameLocator, { timeoutMs: options.actionTimeoutMs })).locator
    : await findUsernameField(scope);
  if (!username) return fail(`No field for the user name was found on the sign-in page.${await describeVisibleForm(page)}`, actions);
  await username.fill(auth.username!, { timeout: options.actionTimeoutMs });
  actions++;

  let passwordScope: Scope = scope;
  let password = auth.passwordLocator
    ? (await resolveLocator(scope, auth.passwordLocator, { timeoutMs: options.actionTimeoutMs })).locator
    : scope.locator(PASSWORD_INPUT).first();

  if (!auth.passwordLocator && await password.count().catch(() => 0) === 0) {
    // Two steps: the user id first, then whatever the application asks for next.
    await pressPrimary(page, scope, username, undefined, options);
    actions++;
    const next = await waitForNextStep(page, options.actionTimeoutMs);
    if (next === 'otp') return { succeeded: true, message: 'User id accepted; a one-time code is asked for next.', actionsUsed: actions };
    if (next === 'neither') {
      return fail(`After the user name was entered and the form's button pressed, no password field or one-time-code prompt appeared.${await describeVisibleForm(page)}`, actions);
    }
    for (const frame of page.frames()) {
      if (await frame.locator(PASSWORD_INPUT).count().catch(() => 0) > 0) {
        passwordScope = frame === page.mainFrame() ? page : frame;
        break;
      }
    }
    password = passwordScope.locator(PASSWORD_INPUT).first();
  }

  if (!auth.password) {
    return fail('The application asks for a password and none is configured. Edit the application and enter the test account\'s password.', actions);
  }
  await password.fill(auth.password, { timeout: options.actionTimeoutMs });
  actions++;

  await pressPrimary(page, passwordScope, password, auth.submitLocator, options);
  actions++;
  return { succeeded: true, message: 'Sign-in form submitted.', actionsUsed: actions };
}

/**
 * What the worker could see when it could not sign in: the fields and buttons, by type,
 * name and label, never their values. Enough to tell a two-step login, a renamed field or
 * a page that is not the login page at all, without opening the screenshot.
 */
async function describeVisibleForm(page: Page): Promise<string> {
  const seen: string[] = [];
  for (const frame of page.frames()) {
    const items = await frame.evaluate(() => {
      const visible = (el: Element) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const out: string[] = [];
      document.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]), select, textarea').forEach(el => {
        if (!visible(el) || out.length >= 10) return;
        const label = Array.from((el as HTMLInputElement).labels ?? []).map(l => l.textContent?.trim()).filter(Boolean)[0]
          ?? el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? '';
        out.push(`${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ''}${el.name ? ` name="${el.name}"` : ''}${el.id ? ` id="${el.id}"` : ''}${label ? ` "${label.slice(0, 40)}"` : ''}`);
      });
      document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach(el => {
        if (!visible(el) || out.length >= 16) return;
        const text = ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').trim();
        if (text) out.push(`button "${text.slice(0, 30)}"`);
      });
      return out;
    }).catch(() => [] as string[]);
    const where = frame === page.mainFrame() ? '' : ` (in frame ${frame.url().slice(0, 80)})`;
    seen.push(...items.map(item => item + where));
  }
  return seen.length === 0
    ? ` The page at ${page.url()} showed no fields or buttons.`
    : ` The page at ${page.url()} showed: ${seen.slice(0, 16).join('; ')}.`;
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

interface OtpField { kind: 'single' | 'digits'; count: number; selector: string; scope: Scope }

/** The one-time-code field, in whichever frame shows it. */
async function findOtpField(page: Page): Promise<OtpField | undefined> {
  for (const frame of page.frames()) {
    const found = await findOtpFieldIn(frame === page.mainFrame() ? page : frame).catch(() => undefined);
    if (found) return found;
  }
  return undefined;
}

async function findOtpFieldIn(page: Scope): Promise<OtpField | undefined> {
  for (const selector of OTP_FIELD_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count === 1) return { kind: 'single', count, selector, scope: page };
    if (count >= 4 && count <= 8) return { kind: 'digits', count, selector, scope: page };
  }
  // A label naming the code, for forms that give the input no telling name.
  for (const label of [/one[- ]time/i, /verification code/i, /security code/i, /authenticat(ion|or) code/i, /\b(otp|2fa|mfa)\b/i]) {
    const field = page.getByLabel(label);
    if (await field.count().catch(() => 0) === 1 && await field.isVisible().catch(() => false)
      && await field.evaluate(element => element instanceof HTMLInputElement).catch(() => false)) {
      const id = await field.evaluate(element => (element as HTMLInputElement).id).catch(() => '');
      if (id) return { kind: 'single', count: 1, selector: `[id="${id}"]`, scope: page };
    }
  }
  const digits = await page.locator(OTP_DIGIT_BOXES).count().catch(() => 0);
  if (digits >= 4 && digits <= 8) return { kind: 'digits', count: digits, selector: OTP_DIGIT_BOXES, scope: page };
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
      await field.scope.locator(field.selector).first().fill(code, { timeout: options.actionTimeoutMs });
      actions++;
    } else {
      const boxes = field.scope.locator(field.selector);
      // Typing into the first box suits applications that move focus themselves; filling
      // each box covers the ones that do not.
      for (let index = 0; index < Math.min(field.count, code.length); index++) {
        await boxes.nth(index).fill(code[index]!, { timeout: options.actionTimeoutMs });
        actions++;
      }
    }

    const submit = await resolveLocator(field.scope, defaultOtpSubmitLocator(), { timeoutMs: 1500 }).catch(() => undefined);
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
  return anyFrameHas(page, '[role="alert"]:visible, [data-testid*="error"]:visible, .error:visible');
}

async function hasVisiblePasswordField(page: Page): Promise<boolean> {
  return anyFrameHas(page, PASSWORD_INPUT);
}

async function anyFrameHas(page: Page, selector: string): Promise<boolean> {
  for (const frame of page.frames()) {
    if (await frame.locator(selector).count().catch(() => 0) > 0) return true;
  }
  return false;
}

function fail(message: string, actionsUsed: number): LoginResult {
  return { succeeded: false, message, actionsUsed };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
}
