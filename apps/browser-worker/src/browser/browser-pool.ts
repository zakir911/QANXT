import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType } from 'playwright';
import type { BrowserName } from '@qa-nxt/shared-types';
import type { Logger } from '../util/logger.js';

/**
 * Owns browser processes. Launching a browser costs seconds; creating a context costs
 * milliseconds, and a context is already a clean profile with its own cookies, storage
 * and cache. So browsers are pooled per engine and every job gets a fresh context —
 * isolation without paying the launch cost per test.
 */
export class BrowserPool {
  /** Keyed by engine and mode: a watched run gets its own windowed browser beside the headless one. */
  private readonly browsers = new Map<string, Browser>();
  private closing = false;
  private warnedNoDisplay = false;

  constructor(
    private readonly headless: boolean,
    private readonly logger: Logger,
    private readonly displayAvailable: () => boolean = hasDisplay
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
    if (existing?.isConnected()) return existing;

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
    return browser;
  }

  /**
   * A context per job: cookies, storage and permissions never leak between tests, and a
   * test that corrupts its session cannot affect the next one.
   */
  async createContext(name: BrowserName, options: ContextOptions): Promise<BrowserContext> {
    const browser = await this.acquire(name, options.watch);
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
    for (const [name, browser] of this.browsers) {
      try {
        await browser.close();
        this.logger.info('Closed browser', { browser: name });
      } catch (error) {
        this.logger.error('Failed to close browser cleanly', error, { browser: name });
      }
    }
    this.browsers.clear();
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
