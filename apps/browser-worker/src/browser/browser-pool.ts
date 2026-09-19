import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType } from 'playwright';
import type { BrowserName } from '@aira/shared-types';
import type { Logger } from '../util/logger.js';

/**
 * Owns browser processes. Launching a browser costs seconds; creating a context costs
 * milliseconds, and a context is already a clean profile with its own cookies, storage
 * and cache. So browsers are pooled per engine and every job gets a fresh context —
 * isolation without paying the launch cost per test.
 */
export class BrowserPool {
  private readonly browsers = new Map<BrowserName, Browser>();
  private closing = false;

  constructor(
    private readonly headless: boolean,
    private readonly logger: Logger
  ) {}

  async acquire(name: BrowserName): Promise<Browser> {
    if (this.closing) throw new Error('The browser pool is shutting down.');

    const existing = this.browsers.get(name);
    if (existing?.isConnected()) return existing;

    const engine = this.engineFor(name);
    this.logger.info('Launching browser', { browser: name, headless: this.headless });

    const browser = await engine.launch({
      headless: this.headless,
      args: name === 'chromium'
        // Required for containerised runs; the worker is itself the sandbox boundary.
        ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        : undefined
    });

    browser.on('disconnected', () => {
      this.logger.warn('Browser disconnected', { browser: name });
      this.browsers.delete(name);
    });

    this.browsers.set(name, browser);
    return browser;
  }

  /**
   * A context per job: cookies, storage and permissions never leak between tests, and a
   * test that corrupts its session cannot affect the next one.
   */
  async createContext(name: BrowserName, options: ContextOptions): Promise<BrowserContext> {
    const browser = await this.acquire(name);
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
}
