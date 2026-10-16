import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { AuthConfig } from '@qa-nxt/shared-types';

/**
 * What the worker learns about an application's sign-in, and acts on.
 *
 * Two behaviours common in banking and other high-security applications break a tester
 * that treats every page as an address to load:
 *
 * - The session lives only in the page's memory. Loading any page by its address starts
 *   the application afresh and signed out, so a crawl that opens each page by address
 *   maps nineteen empty shells and no forms, and every test that opens its page by
 *   address is signed out. Such an application has to be moved through from inside: by
 *   following its own links, or by asking its router to change route.
 *
 * - One session per user. A second sign-in with the same account is refused, or ends the
 *   first. Tests that each sign in, several at a time, then mostly never start; and a
 *   session left open at the end of one job refuses the next.
 *
 * Both are learned rather than configured, because nobody filling in the application form
 * knows which kind of session their application keeps. What is learned holds for the life
 * of the worker process.
 */

/** One application and test account. The user name is hashed, never kept as text. */
export function sessionKey(auth: AuthConfig): string {
  const who = createHash('sha256').update(auth.username ?? '').digest('hex').slice(0, 16);
  return `${auth.loginUrl ?? ''}|${who}`;
}

/** Words an application uses to refuse a second session. */
export const CONCURRENT_SESSION = /already (logged|signed)|another (session|device|browser|location|tab)|active session|session (is )?(already )?(active|in use|open)|logged in (elsewhere|from)|multiple (sessions|logins)|concurrent|simultaneous/i;

class SessionGate {
  private readonly single = new Set<string>();
  private readonly unlocked = new Map<string, number>();
  private readonly lock = new Map<string, Promise<void>>();
  private readonly loadSafe = new Map<string, boolean>();

  isSingle(key: string): boolean { return this.single.has(key); }

  /**
   * Joins the application's sessions. Once it is known to allow only one, this waits for
   * the others to finish. Returns what to call when the job is over.
   */
  async enter(key: string): Promise<() => void> {
    if (this.single.has(key)) return this.acquire(key);
    this.unlocked.set(key, (this.unlocked.get(key) ?? 0) + 1);
    let left = false;
    return () => { if (!left) { left = true; this.unlocked.set(key, Math.max(0, (this.unlocked.get(key) ?? 1) - 1)); } };
  }

  /**
   * The application refused a second session: from now on one job at a time. The caller
   * leaves the unlocked group, takes the lock, and waits for every job that started before
   * this was known to finish (and sign out). Returns what to call when the job is over.
   */
  async becomeExclusive(key: string, leaveUnlocked: () => void, maxWaitMs = 15 * 60_000): Promise<() => void> {
    this.single.add(key);
    leaveUnlocked();
    const release = await this.acquire(key);
    const deadline = Date.now() + maxWaitMs;
    while ((this.unlocked.get(key) ?? 0) > 0 && Date.now() < deadline) await sleep(500);
    return release;
  }

  private async acquire(key: string): Promise<() => void> {
    const previous = this.lock.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    this.lock.set(key, previous.then(() => mine));
    await previous;
    let released = false;
    return () => { if (!released) { released = true; release(); } };
  }

  /** Whether a fresh page load keeps this application signed in, asked once. */
  async survivesLoad(key: string, check: () => Promise<boolean>): Promise<boolean> {
    const known = this.loadSafe.get(key);
    if (known !== undefined) return known;
    const answer = await check();
    this.loadSafe.set(key, answer);
    return answer;
  }
}

export const sessionGate = new SessionGate();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Signs of the sign-in page: its address, or a password field (a masked text box counts). */
async function looksSignedOut(page: Page, auth: AuthConfig): Promise<boolean> {
  if (auth.loginUrl && page.url().startsWith(auth.loginUrl)) return true;
  return page.locator('input[type="password"]:visible, input[name*="password" i]:visible, input[id*="password" i]:visible')
    .count().then(count => count > 0).catch(() => false);
}

/**
 * Opens the page the user is on in a second tab and sees whether it is signed in there.
 * A second tab shares cookies and local storage but not the first tab's memory, so an
 * application whose session lives in memory comes up signed out. The first tab is not
 * touched, so its session is kept either way.
 */
export async function checkSessionSurvivesLoad(page: Page, auth: AuthConfig, timeoutMs: number): Promise<boolean> {
  const probe = await page.context().newPage();
  try {
    await probe.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const deadline = Date.now() + Math.min(timeoutMs, 8000);
    while (Date.now() < deadline) {
      if (await looksSignedOut(probe, auth)) return false;
      await probe.waitForTimeout(250);
    }
    return true;
  } catch {
    // Cannot tell; loading by address is what worked before, so keep it.
    return true;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

/**
 * Moves to a page of the same application without loading it: through a link to it, if
 * the page has one, or by asking the router to change route. Another origin is loaded.
 */
export async function navigateInApp(page: Page, url: string, timeoutMs: number): Promise<'link' | 'route' | 'load' | 'here'> {
  const target = new URL(url);
  let here: URL;
  try { here = new URL(page.url()); } catch { here = new URL('about:blank'); }

  if (target.origin !== here.origin) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return 'load';
  }
  if (target.href === here.href) return 'here';

  const how = await page.evaluate(({ href, path, hash, samePath }) => {
    const bare = (value: string) => value.split('#')[0];
    // A link the application itself renders goes through its router (and its guards).
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .find(a => a.href === href || (hash === '' && bare(a.href) === bare(href)));
    if (link) { link.click(); return 'link' as const; }
    if (samePath && hash !== location.hash) { location.hash = hash; return 'route' as const; }
    history.pushState(history.state, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    return 'route' as const;
  }, {
    href: target.href,
    path: target.pathname + target.search + target.hash,
    hash: target.hash,
    samePath: target.pathname === here.pathname && target.search === here.search
  });

  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  return how;
}

/**
 * Signs out at the end of a job, so an application that allows one session per user lets
 * the next job in. Best effort: a control named Log out or Sign out, then a confirmation if
 * the application asks for one.
 */
export async function performLogout(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  if (await clickLogout(page)) return true;
  // Often behind the user's menu: open the likely ones in turn and look again.
  const menus = page.locator('[aria-haspopup="true"]:visible, [aria-haspopup="menu"]:visible')
    .or(page.getByRole('button', { name: /profile|account|my account|user|avatar|settings|menu/i }).filter({ visible: true }));
  const count = Math.min(await menus.count().catch(() => 0), 4);
  for (let i = 0; i < count; i++) {
    try {
      await menus.nth(i).click({ timeout: 2000 });
      if (await clickLogout(page)) return true;
      await page.keyboard.press('Escape').catch(() => undefined);
    } catch {
      // Not a menu after all.
    }
  }
  return false;
}

async function clickLogout(page: Page): Promise<boolean> {
  const name = /^\s*(log ?out|sign ?out|log ?off|sign ?off|logout|signout)\s*$/i;
  const candidates = [
    page.getByRole('button', { name }), page.getByRole('link', { name }), page.getByRole('menuitem', { name }),
    page.locator('a[href*="logout" i], a[href*="signout" i], a[href*="logoff" i]')
  ];
  for (const candidate of candidates) {
    const control = candidate.filter({ visible: true }).first();
    if (await control.count().catch(() => 0) === 0) continue;
    try {
      await control.click({ timeout: 3000 });
      const confirm = page.getByRole('button', { name: /^\s*(yes|ok|confirm|log ?out|sign ?out|logout)\s*$/i }).filter({ visible: true }).first();
      await confirm.waitFor({ state: 'visible', timeout: 1500 }).then(() => confirm.click({ timeout: 2000 })).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      return true;
    } catch {
      // Try the next way out.
    }
  }
  return false;
}
