import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType } from 'playwright';
import type { BrowserName } from '@qa-nxt/shared-types';
import type { Logger } from '../util/logger.js';

/**
 * Owns browser processes. Launching a browser costs seconds; creating a context costs
 * milliseconds, and a context is already a clean profile with its own cookies, storage
 * and cache. So browsers are pooled per engine and every job gets a fresh context —
 * isolation without paying the launch cost per test.
 *
 * A pooled browser is retired after a bounded number of contexts, which is not about
 * memory. Playwright writes a trace's screenshots and DOM snapshots into a scratch
 * directory that belongs to the browser process and is shared by all of its contexts, and
 * that directory is removed when the *browser* closes — not when a context does. A trace
 * that is discarded rather than saved still leaves its blobs there.
 *
 * Measured on this project's own lab: a 6,372-test run left 45 of those directories
 * totalling 13GB, one of them 11GB with 7GB of blobs, on top of the 13GB of artifacts the
 * run meant to keep. The disk filled and every browser-backed test then failed with
 * ERR_INSUFFICIENT_RESOURCES. Closing the context per execution, which the executor
 * already does, frees none of it.
 */
export class BrowserPool {
  /** Keyed by engine and mode: a watched run gets its own windowed browser beside the headless one. */
  private readonly browsers = new Map<string, Browser>();
  /** Contexts handed out by each pooled browser, against CONTEXTS_PER_BROWSER. */
  private readonly served = new Map<string, number>();
  /** Browsers taken out of the pool, closing as soon as their last context goes. */
  private readonly retiring = new Set<Browser>();
  private closing = false;
  private warnedNoDisplay = false;

  /**
   * How many contexts a browser serves before it is replaced.
   *
   * Low enough that the scratch cannot grow unbounded, high enough that the launch cost is
   * noise: at roughly a second a launch and a few seconds a test, 150 amortises to well
   * under one percent. The cost of getting it wrong in the other direction is a run that
   * cannot finish. Settable because it trades launch time against disk, and because a test
   * should not have to create 150 contexts to show that the trade is made.
   */
  static readonly DEFAULT_CONTEXTS_PER_BROWSER = 150;

  constructor(
    private readonly headless: boolean,
    private readonly logger: Logger,
    private readonly displayAvailable: () => boolean = hasDisplay,
    private readonly contextsPerBrowser: number = BrowserPool.DEFAULT_CONTEXTS_PER_BROWSER
  ) {}

  /**
   * Whether a job's browser opens a window. The worker's own setting (WORKER_HEADLESS=false)
   * shows every job; a job can also ask to be watched. Either way a window needs a screen,
   * and without one the job runs headless rather than failing.
   */
  resolveHeadless(watch?: boolean): boolean {
    const wantsWindow = !this.headless || watch === true;
    if (!wantsWindow) return true;
    if (this.displayAvailable()) return false;
    if (!this.warnedNoDisplay) {
      this.warnedNoDisplay = true;
      this.logger.warn('A browser window was asked for, but this worker has no screen; running headless', {});
    }
    return true;
  }

  async acquire(name: BrowserName, watch?: boolean): Promise<Browser> {
    if (this.closing) throw new Error('The browser pool is shutting down.');

    const headless = this.resolveHeadless(watch);
    const key = `${name}:${headless ? 'headless' : 'headed'}`;
    const existing = this.browsers.get(key);
    if (existing?.isConnected() && (this.served.get(key) ?? 0) < this.contextsPerBrowser) {
      return existing;
    }

    // Past its allowance: out of the pool, and closed once its last context is gone. It
    // cannot be closed here — with more than one job in flight another context may still
    // be mid-test on it, and closing a browser closes its contexts underneath them.
    if (existing?.isConnected()) {
      this.browsers.delete(key);
      this.served.delete(key);
      this.retire(existing, name);
    }

    const engine = this.engineFor(name);
    this.logger.info('Launching browser', { browser: name, headless });

    const browser = await engine.launch({
      headless,
      args: name === 'chromium'
        // Required for containerised runs; the worker is itself the sandbox boundary.
        ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        : undefined
    });

    browser.on('disconnected', () => {
      this.logger.warn('Browser disconnected', { browser: name });
      this.browsers.delete(key);
    });

    this.browsers.set(key, browser);
    this.served.set(key, 0);
    return browser;
  }

  /**
   * Drops a browser from the pool and closes it when it falls idle.
   *
   * `browser.contexts()` is the only thing that says whether a test is still running on
   * it. Polling that is unlovely, and the alternative — reference counting every context
   * the pool hands out — means the pool must also be told when each one closes, which it
   * is not. The poll is cheap, bounded and does not hold a job up.
   */
  private retire(browser: Browser, name: BrowserName): void {
    this.retiring.add(browser);
    const started = Date.now();

    const attempt = async (): Promise<void> => {
      if (!browser.isConnected()) { this.retiring.delete(browser); return; }
      // Given up on after five minutes: a context leaked by a crashed test must not keep
      // a retired browser, and its scratch, alive for the life of the worker.
      if (browser.contexts().length === 0 || Date.now() - started > 300_000) {
        try {
          await browser.close();
          this.logger.info('Retired a browser so its trace scratch is released', {
            browser: name, contextsServed: this.contextsPerBrowser
          });
        } catch (error) {
          this.logger.warn('Failed to close a retired browser', { error: String(error) });
        }
        this.retiring.delete(browser);
        return;
      }
      setTimeout(() => void attempt(), 2_000).unref();
    };

    void attempt();
  }

  /**
   * A context per job: cookies, storage and permissions never leak between tests, and a
   * test that corrupts its session cannot affect the next one.
   */
  async createContext(name: BrowserName, options: ContextOptions): Promise<BrowserContext> {
    const browser = await this.acquire(name, options.watch);
    const key = `${name}:${this.resolveHeadless(options.watch) ? 'headless' : 'headed'}`;
    this.served.set(key, (this.served.get(key) ?? 0) + 1);
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1440, height: 900 },
      ignoreHTTPSErrors: options.ignoreHttpsErrors ?? false,
      recordVideo: options.videoDir ? { dir: options.videoDir, size: { width: 1280, height: 800 } } : undefined,
      storageState: options.storageState as never,
      extraHTTPHeaders: options.extraHeaders,
      httpCredentials: options.httpCredentials,
      // A stable, honest user agent: pretending to be something else would make the
      // application under test behave differently than it does for real users.
      userAgent: options.userAgent
    });

    context.setDefaultTimeout(options.defaultTimeoutMs);
    context.setDefaultNavigationTimeout(options.navigationTimeoutMs);
    return context;
  }

  async version(name: BrowserName): Promise<string> {
    const browser = await this.acquire(name);
    return browser.version();
  }

  async close(): Promise<void> {
    this.closing = true;
    // Retired browsers first: each one is holding a scratch directory, and on shutdown
    // there is nothing left to wait for.
    for (const browser of this.retiring) {
      await browser.close().catch(() => undefined);
    }
    this.retiring.clear();
    for (const [name, browser] of this.browsers) {
      try {
        await browser.close();
        this.logger.info('Closed browser', { browser: name });
      } catch (error) {
        this.logger.error('Failed to close browser cleanly', error, { browser: name });
      }
    }
    this.browsers.clear();
    this.served.clear();
  }

  private engineFor(name: BrowserName): BrowserType {
    switch (name) {
      case 'chromium': return chromium;
      case 'firefox': return firefox;
      case 'webkit': return webkit;
      default: {
        const exhaustive: never = name;
        throw new Error(`Unknown browser: ${String(exhaustive)}`);
      }
    }
  }
}

export interface ContextOptions {
  defaultTimeoutMs: number;
  navigationTimeoutMs: number;
  viewport?: { width: number; height: number };
  ignoreHttpsErrors?: boolean;
  videoDir?: string;
  storageState?: unknown;
  extraHeaders?: Record<string, string>;
  httpCredentials?: { username: string; password: string };
  userAgent?: string;
  /** Open this job's browser in a window when the worker has a screen. */
  watch?: boolean;
}

/** macOS and Windows always have a desktop; Linux has one only under X11 or Wayland. */
export function hasDisplay(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
