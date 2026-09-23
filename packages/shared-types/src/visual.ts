/**
 * Visual regression, as a test step.
 *
 * The hard part of visual testing is not comparing pixels — it is deciding what a
 * difference *means*. Most visual differences are intentional: somebody changed the
 * design. A check that fails the build on every deliberate change is one a team switches
 * off within a fortnight, and a switched-off check finds nothing.
 *
 * So the default verdict for a difference is REVIEW, not FAIL. A person looks, and either
 * accepts the new appearance as the baseline or files a defect. Failing outright is
 * available and has to be asked for.
 *
 * The second hard part is noise. A comparison that reports a difference because a clock
 * ticked, a cursor blinked or a font loaded late teaches its readers that diffs are
 * meaningless, which is the same outcome as failing on every change. Everything in
 * `VisualCaptureOptions` exists to remove a specific, named source of noise.
 */

/** What a comparison decided. */
export const VISUAL_VERDICTS = ['match', 'differs', 'newBaseline', 'sizeChanged'] as const;
export type VisualVerdict = (typeof VISUAL_VERDICTS)[number];

/** What a difference should do to the run. */
export const VISUAL_ON_DIFFERENCE = ['review', 'fail', 'ignore'] as const;
export type VisualOnDifference = (typeof VISUAL_ON_DIFFERENCE)[number];

export interface VisualCaptureOptions {
  /**
   * CSS selectors whose contents are painted over before the comparison.
   *
   * For regions that legitimately change every run — a timestamp, a session id, an advert,
   * a chart of live data. Masking is recorded in the result, so a reader can always see
   * what was not compared. That matters: masking the region that keeps failing is the
   * obvious way to make a visual check useless while appearing to run it.
   */
  mask?: string[];

  /** Confine the capture to one element rather than the whole page. */
  selector?: string;

  /** Capture the whole scrollable page rather than the viewport. Defaults to false. */
  fullPage?: boolean;

  /**
   * Viewport size for the capture.
   *
   * Part of the baseline's identity: a baseline taken at 1280×720 says nothing about how
   * the page looks at 375 wide, and comparing across the two would report a difference on
   * every run.
   */
  viewport?: { width: number; height: number };

  /**
   * Wait this long after the page settles before capturing.
   *
   * A blunt instrument, and sometimes the only one that works — a CSS transition with no
   * event to wait for, a late-loading web font. Kept small by default because a delay in
   * every visual step is a slow suite.
   */
  settleMs?: number;
}

export interface VisualCheckDescriptor extends VisualCaptureOptions {
  /**
   * The baseline's name within this test.
   *
   * Defaults to the step's order. Naming it explicitly is what lets a baseline survive a
   * step being inserted above it — otherwise adding a step renumbers everything below and
   * every baseline appears to be a new one.
   */
  name?: string;

  /**
   * Proportion of pixels that may differ before the verdict is `differs`, as a percentage.
   *
   * Not zero by default. Anti-aliasing differs between machines and between browser
   * versions, so a zero threshold reports a difference on an identical page whenever the
   * runner changes — which is the fastest way to teach a team to ignore this check.
   */
  maxDifferencePercent?: number;

  /**
   * How different a single pixel must be before it counts, 0 to 1.
   *
   * Passed to the comparison as its matching tolerance. Raising it hides real differences;
   * lowering it counts imperceptible ones.
   */
  pixelThreshold?: number;

  /** What a difference does. Defaults to `review`. */
  onDifference?: VisualOnDifference;

  /**
   * Accept whatever is captured as the new baseline.
   *
   * Set by a person approving a change, never by a schedule or a pipeline. A run that
   * updates its own baselines cannot regress: it agrees with itself every time.
   */
  updateBaseline?: boolean;
}

export interface VisualComparison {
  name: string;
  verdict: VisualVerdict;
  /** Pixels that differed, and what proportion of the image that is. */
  differingPixels: number;
  totalPixels: number;
  differencePercent: number;
  /** The threshold this was judged against, so a result explains its own verdict. */
  maxDifferencePercent: number;
  width: number;
  height: number;
  /** The baseline's dimensions, when they differ from the capture's. */
  baselineWidth?: number;
  baselineHeight?: number;
  /** Storage keys for the three images a reviewer needs. */
  baselineKey?: string;
  actualKey?: string;
  diffKey?: string;
  masked: string[];
  viewport: { width: number; height: number };
  browser: string;
  capturedAt: string;
}

export const DEFAULT_MAX_DIFFERENCE_PERCENT = 0.1;
export const DEFAULT_PIXEL_THRESHOLD = 0.1;
export const DEFAULT_VISUAL_VIEWPORT = { width: 1280, height: 720 };
export const DEFAULT_ON_DIFFERENCE: VisualOnDifference = 'review';

/**
 * One line describing a comparison.
 *
 * Every branch says what happens next, because a verdict a reader cannot act on is a
 * verdict they learn to skip.
 */
export function describeVisual(comparison: VisualComparison): string {
  const where = `${comparison.name} at ${comparison.viewport.width}×${comparison.viewport.height}`;

  switch (comparison.verdict) {
    case 'newBaseline':
      return `${where}: no baseline existed, so this capture became one. `
        + 'Nothing was compared — the next run is the first that can regress.';

    case 'sizeChanged':
      return `${where}: the page is now ${comparison.width}×${comparison.height}, `
        + `the baseline was ${comparison.baselineWidth}×${comparison.baselineHeight}. `
        + 'Images of different sizes cannot be compared pixel by pixel, so this needs a person.';

    case 'differs':
      return `${where}: ${comparison.differencePercent.toFixed(3)}% of pixels differ `
        + `(${comparison.differingPixels} of ${comparison.totalPixels}), over the `
        + `${comparison.maxDifferencePercent}% allowed.`;

    case 'match':
      return `${where}: matches the baseline `
        + `(${comparison.differencePercent.toFixed(3)}% differing, within ${comparison.maxDifferencePercent}%).`;
  }
}

/** Whether this verdict means the step should not simply pass. */
export function needsAttention(verdict: VisualVerdict): boolean {
  return verdict === 'differs' || verdict === 'sizeChanged';
}
