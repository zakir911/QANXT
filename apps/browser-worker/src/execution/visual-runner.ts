import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Page } from 'playwright';

import {
  DEFAULT_MAX_DIFFERENCE_PERCENT,
  DEFAULT_ON_DIFFERENCE,
  DEFAULT_PIXEL_THRESHOLD,
  DEFAULT_VISUAL_VIEWPORT,
  describeVisual,
  type VisualCheckDescriptor,
  type VisualComparison,
  type VisualVerdict
} from '@qa-nxt/shared-types';

/**
 * Captures the page and compares it with a stored baseline.
 *
 * Two things dominate whether a visual check is worth having, and neither is the
 * comparison itself.
 *
 * **Determinism.** A screenshot taken twice of an unchanged page must be the same
 * screenshot. Animations, carets, late fonts and lazy images each break that, and each is
 * dealt with explicitly below rather than papered over with a sleep. A check that reports
 * a difference because a caret blinked teaches its readers that diffs are meaningless.
 *
 * **What a difference means.** Most are intentional. The verdict is reported; the policy
 * of what it does to the run belongs to the caller, and defaults to asking a person.
 */

export class VisualError extends Error {
  constructor(message: string, readonly comparison: VisualComparison) {
    super(message);
    this.name = 'VisualError';
  }
}

/** A baseline's identity: which check, at which size. */
export interface BaselineKey {
  name: string;
  viewport: { width: number; height: number };
}

export interface BaselineStore {
  /** The stored baseline for this key, or null when there is none yet. */
  load(key: BaselineKey): Promise<Buffer | null>;
  /** Stores a capture as the baseline for this key. */
  save(key: BaselineKey, png: Buffer): Promise<string>;
  /** Stores an image for a reviewer to look at. Returns its storage key. */
  attach(name: string, kind: 'actual' | 'diff' | 'baseline', png: Buffer): Promise<string>;
}

/**
 * CSS that removes the things which differ between two screenshots of an unchanged page.
 *
 * Injected rather than passed to Playwright's own animation option because that covers CSS
 * animations and transitions only. A blinking caret, a smooth-scroll behaviour and a
 * lazy-loaded image are three separate sources of the same problem.
 */
const DETERMINISM_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
}
/* A text caret blinks, so a screenshot of a focused field differs from itself. */
* { caret-color: transparent !important; }
/* Lazy images decode when they scroll into view, so a full-page capture can catch one
   mid-load. Forcing eager loading is not possible from CSS, so the worker sets the
   attribute directly; this only stops the placeholder transition. */
img { image-rendering: auto !important; }
`;

export interface VisualCheckOptions {
  descriptor: VisualCheckDescriptor;
  store: BaselineStore;
  browser: string;
  /** Falls back to the step's order when the descriptor does not name the baseline. */
  defaultName: string;
}

export async function runVisualCheck(
  page: Page,
  { descriptor, store, browser, defaultName }: VisualCheckOptions
): Promise<VisualComparison> {
  const name = (descriptor.name ?? defaultName).trim() || defaultName;
  const viewport = descriptor.viewport ?? DEFAULT_VISUAL_VIEWPORT;
  const maxDifferencePercent = descriptor.maxDifferencePercent ?? DEFAULT_MAX_DIFFERENCE_PERCENT;
  const pixelThreshold = descriptor.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const masked = (descriptor.mask ?? []).filter(selector => selector.trim().length > 0);

  const actual = await capture(page, { ...descriptor, viewport }, masked);
  const captured = PNG.sync.read(actual);

  const base = {
    name,
    masked,
    viewport,
    browser,
    width: captured.width,
    height: captured.height,
    totalPixels: captured.width * captured.height,
    maxDifferencePercent,
    capturedAt: new Date().toISOString()
  };

  // Asked for explicitly by a person approving a change. A run that updates its own
  // baselines cannot regress, because it agrees with itself every time.
  if (descriptor.updateBaseline) {
    const key = await store.save({ name, viewport }, actual);
    return { ...base, verdict: 'newBaseline', differingPixels: 0, differencePercent: 0, baselineKey: key };
  }

  const baselineBytes = await store.load({ name, viewport });

  if (baselineBytes === null) {
    // The first capture becomes the baseline and nothing is compared. Reported as its own
    // verdict rather than as a pass: "nothing to compare against" and "identical to the
    // baseline" are different statements, and a first run reported as a pass would be a
    // green tick for a check that did not happen.
    const key = await store.save({ name, viewport }, actual);
    return { ...base, verdict: 'newBaseline', differingPixels: 0, differencePercent: 0, baselineKey: key };
  }

  const baseline = PNG.sync.read(baselineBytes);

  if (baseline.width !== captured.width || baseline.height !== captured.height) {
    // pixelmatch requires equal dimensions, and a resize is itself a visual change worth
    // a person's attention — scaling one to fit the other would hide it.
    const [baselineKey, actualKey] = await Promise.all([
      store.attach(name, 'baseline', baselineBytes),
      store.attach(name, 'actual', actual)
    ]);

    return {
      ...base,
      verdict: 'sizeChanged',
      differingPixels: 0,
      differencePercent: 0,
      baselineWidth: baseline.width,
      baselineHeight: baseline.height,
      baselineKey,
      actualKey
    };
  }

  const diff = new PNG({ width: captured.width, height: captured.height });
  const differingPixels = pixelmatch(
    baseline.data, captured.data, diff.data, captured.width, captured.height,
    { threshold: pixelThreshold, includeAA: false });

  const differencePercent = base.totalPixels === 0
    ? 0
    : (differingPixels / base.totalPixels) * 100;

  const verdict: VisualVerdict = differencePercent > maxDifferencePercent ? 'differs' : 'match';

  if (verdict === 'match') {
    // Nothing stored on a match. Three images per passing step is a storage bill for
    // pictures nobody opens.
    return { ...base, verdict, differingPixels, differencePercent };
  }

  const [baselineKey, actualKey, diffKey] = await Promise.all([
    store.attach(name, 'baseline', baselineBytes),
    store.attach(name, 'actual', actual),
    store.attach(name, 'diff', PNG.sync.write(diff))
  ]);

  return { ...base, verdict, differingPixels, differencePercent, baselineKey, actualKey, diffKey };
}

/**
 * Runs the check and throws when the caller's policy says a difference should fail.
 *
 * `review` — the default — does not throw. The verdict travels with the step and the
 * quality gate decides, because "somebody should look at this" is not the same as "this
 * build is broken", and conflating them is what gets a visual suite deleted.
 */
export async function runVisualStep(
  page: Page,
  options: VisualCheckOptions
): Promise<VisualComparison> {
  const comparison = await runVisualCheck(page, options);
  const policy = options.descriptor.onDifference ?? DEFAULT_ON_DIFFERENCE;

  if (policy === 'fail' && (comparison.verdict === 'differs' || comparison.verdict === 'sizeChanged')) {
    throw new VisualError(describeVisual(comparison), comparison);
  }

  return comparison;
}

/**
 * Takes the screenshot, having first removed everything that differs between two shots of
 * an unchanged page.
 */
async function capture(
  page: Page,
  options: VisualCheckDescriptor & { viewport: { width: number; height: number } },
  masked: string[]
): Promise<Buffer> {
  await page.setViewportSize(options.viewport);

  await page.addStyleTag({ content: DETERMINISM_CSS });

  // Lazy images decode when they scroll into view, so a full-page capture can otherwise
  // catch one part-loaded. Forcing eager loading has to happen in the page.
  await page.evaluate(() => {
    for (const image of Array.from(document.querySelectorAll('img[loading="lazy"]'))) {
      image.setAttribute('loading', 'eager');
    }
  });

  // A web font that arrives after the screenshot changes every glyph in it. This is the
  // one wait that is not guesswork.
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);

  // Focus leaves a ring on whichever control has it, and which control that is depends on
  // what the previous step did.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => undefined);

  if (options.settleMs && options.settleMs > 0) {
    await page.waitForTimeout(Math.min(options.settleMs, 10_000));
  }

  const target = options.selector
    ? page.locator(options.selector).first()
    : page;

  return target.screenshot({
    ...(options.selector ? {} : { fullPage: options.fullPage ?? false }),
    animations: 'disabled',
    caret: 'hide',
    // Painted over rather than cut out: removing an element reflows the page, so the
    // comparison would then report every pixel below it as different.
    mask: masked.map(selector => page.locator(selector)),
    maskColor: '#FF00FF',
    type: 'png'
  });
}
