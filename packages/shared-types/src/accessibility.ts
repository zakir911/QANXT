/**
 * Accessibility checks, as a test step.
 *
 * AIRA runs axe-core against the page and reports what it finds. Two things about that are
 * worth stating plainly, because a tool that overstates them does real damage.
 *
 * **Automated checks find a minority of accessibility problems.** axe-core's own
 * documentation puts it at roughly a third of WCAG issues. A page with no violations has
 * not been shown to be accessible; it has been shown to have no violations a machine can
 * find. AIRA never reports a clean result as "accessible" — it reports the number of
 * violations found, and the rules it ran.
 *
 * **A violation is a finding, not a verdict.** Some are unambiguous (an image with no
 * alternative text). Some depend on context a machine does not have. The step's threshold
 * decides what fails a build, and the default is deliberately not "any violation".
 */

/** axe-core's impact levels, worst first. */
export const ACCESSIBILITY_IMPACTS = ['critical', 'serious', 'moderate', 'minor'] as const;
export type AccessibilityImpact = (typeof ACCESSIBILITY_IMPACTS)[number];

/**
 * The rule sets a check may ask for.
 *
 * These are axe-core tag names. `wcag2a`/`wcag2aa`/`wcag21aa` are the conformance levels
 * teams are usually held to; `best-practice` is axe's own advice and is not a WCAG
 * requirement, so it is separate and off by default — failing a build on advice nobody
 * agreed to is how a check gets switched off.
 */
export const ACCESSIBILITY_STANDARDS = [
  'wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'
] as const;
export type AccessibilityStandard = (typeof ACCESSIBILITY_STANDARDS)[number];

export interface AccessibilityCheckDescriptor {
  /** Rule sets to run. Defaults to wcag2a + wcag2aa + wcag21aa. */
  standards?: AccessibilityStandard[];

  /**
   * Fail the step at this impact or worse. Null means find and report, never fail.
   *
   * The default is `serious`, not `minor`: a step that fails on every minor finding is a
   * step a team disables in week two, and a disabled check finds nothing at all.
   */
  failOn?: AccessibilityImpact | null;

  /** A CSS selector to confine the scan to. The whole page when absent. */
  include?: string;

  /**
   * Selectors to leave out.
   *
   * Honest use: a third-party widget nobody here can fix. Dishonest use: the part of the
   * page that fails. The exclusions are recorded in the result either way, so a reader can
   * see what was not looked at.
   */
  exclude?: string[];

  /**
   * Rule ids to skip, with a reason.
   *
   * A reason is required. An unexplained suppression outlives whoever added it and nobody
   * can tell later whether it was a considered decision or a way to get a build green.
   */
  ignoreRules?: { rule: string; because: string }[];
}

export interface AccessibilityNode {
  /** The element, as a CSS selector a person can paste into dev tools. */
  target: string;
  /** axe's own explanation of what is wrong with this element. */
  failureSummary?: string;
  /** A short, truncated fragment of the element's markup. */
  html?: string;
}

export interface AccessibilityViolation {
  id: string;
  impact: AccessibilityImpact | null;
  description: string;
  help: string;
  helpUrl: string;
  /** The WCAG criteria and rule sets this rule belongs to. */
  tags: string[];
  nodes: AccessibilityNode[];
}

export interface AccessibilityResult {
  url: string;
  standards: string[];
  violations: AccessibilityViolation[];
  /** How many rules ran and found nothing. Reported so a clean result is not mistaken for no check. */
  passCount: number;
  /**
   * Checks axe could not decide, which a person must.
   *
   * Reported rather than dropped: "12 things need a human to look at them" is information,
   * and a report that silently discards them overstates how much was checked.
   */
  incompleteCount: number;
  counts: Record<AccessibilityImpact, number>;
  /** What was deliberately not looked at. */
  excluded: string[];
  ignoredRules: { rule: string; because: string }[];
  engine: { name: string; version: string };
  scannedAt: string;
}

/** The default rule sets: the conformance levels teams are actually held to. */
export const DEFAULT_ACCESSIBILITY_STANDARDS: AccessibilityStandard[] =
  ['wcag2a', 'wcag2aa', 'wcag21aa'];

export const DEFAULT_ACCESSIBILITY_FAIL_ON: AccessibilityImpact = 'serious';

/** True when this impact is at least as bad as the threshold. */
export function meetsThreshold(
  impact: AccessibilityImpact | null,
  threshold: AccessibilityImpact
): boolean {
  if (impact === null) return false;
  return ACCESSIBILITY_IMPACTS.indexOf(impact) <= ACCESSIBILITY_IMPACTS.indexOf(threshold);
}

/**
 * One line summarising a result, for a step's message.
 *
 * Says what was found and what was run. "No violations" alone would be read as "the page
 * is accessible", which is a claim automated checks cannot support.
 */
export function describeAccessibility(result: AccessibilityResult): string {
  const total = result.violations.length;
  const standards = result.standards.join(', ');

  if (total === 0) {
    return `No violations found by ${standards} (${result.passCount} rule(s) passed, `
      + `${result.incompleteCount} need a person to check). Automated checks find roughly a `
      + 'third of accessibility problems.';
  }

  const bands = ACCESSIBILITY_IMPACTS
    .filter(impact => result.counts[impact] > 0)
    .map(impact => `${result.counts[impact]} ${impact}`)
    .join(', ');

  return `${total} violation(s) against ${standards}: ${bands}.`;
}
