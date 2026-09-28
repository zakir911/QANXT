import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';

import {
  ACCESSIBILITY_IMPACTS,
  ACCESSIBILITY_STANDARDS,
  DEFAULT_ACCESSIBILITY_FAIL_ON,
  DEFAULT_ACCESSIBILITY_STANDARDS,
  describeAccessibility,
  meetsThreshold,
  type AccessibilityCheckDescriptor,
  type AccessibilityImpact,
  type AccessibilityResult,
  type AccessibilityViolation
} from '@qa-nxt/shared-types';

/**
 * Runs axe-core against the page in front of us.
 *
 * axe is injected as a script into the page rather than driven through a helper library,
 * for two reasons. It is one dependency instead of two, and it makes the boundary explicit:
 * everything axe sees, it sees from inside the page, the same as a screen reader would.
 *
 * The result is read back as data. Nothing axe returns is executed, and nothing from the
 * page decides what QA NXT does next except through the typed shape below — an application
 * under test is not trusted input.
 */

const require = createRequire(import.meta.url);

/** Read once per process: the file is ~600KB and does not change between runs. */
let axeSource: string | null = null;

async function loadAxe(): Promise<string> {
  if (axeSource !== null) return axeSource;
  const path = require.resolve('axe-core/axe.min.js');
  axeSource = await readFile(path, 'utf8');
  return axeSource;
}

export class AccessibilityError extends Error {
  constructor(message: string, readonly result: AccessibilityResult) {
    super(message);
    this.name = 'AccessibilityError';
  }
}

/**
 * Scans the page and returns what axe found.
 *
 * Never throws on violations — the caller decides what a violation means, because that is a
 * policy question and this is a measurement.
 */
export async function checkAccessibility(
  page: Page,
  descriptor: AccessibilityCheckDescriptor = {}
): Promise<AccessibilityResult> {
  const standards = normaliseStandards(descriptor.standards);
  const exclude = (descriptor.exclude ?? []).filter(selector => selector.trim().length > 0);
  const ignored = descriptor.ignoreRules ?? [];

  await page.addScriptTag({ content: await loadAxe() });

  // The context and options are built here and passed as data. Building them inside the
  // evaluate callback would mean interpolating selectors into a script, which is an
  // injection waiting to happen the first time a selector contains a quote.
  const context = buildContext(descriptor.include, exclude);
  const options = {
    runOnly: { type: 'tag' as const, values: standards },
    resultTypes: ['violations', 'incomplete'] as const,
    rules: Object.fromEntries(ignored.map(entry => [entry.rule, { enabled: false }]))
  };

  const raw = await page.evaluate(
    async ([evalContext, evalOptions]) => {
      const axe = (window as unknown as { axe?: { run: Function; version: string } }).axe;
      if (!axe) throw new Error('axe-core did not load into the page.');

      const outcome = await axe.run(evalContext ?? document, evalOptions);
      return {
        version: axe.version,
        url: window.location.href,
        violations: (outcome.violations ?? []).map((violation: any) => ({
          id: violation.id,
          impact: violation.impact ?? null,
          description: violation.description ?? '',
          help: violation.help ?? '',
          helpUrl: violation.helpUrl ?? '',
          tags: violation.tags ?? [],
          nodes: (violation.nodes ?? []).slice(0, 20).map((node: any) => ({
            target: Array.isArray(node.target) ? node.target.join(' ') : String(node.target ?? ''),
            failureSummary: node.failureSummary ?? undefined,
            // Truncated: a node's markup can be an entire subtree, and the selector is
            // what somebody actually uses to find it.
            html: typeof node.html === 'string' ? node.html.slice(0, 400) : undefined
          }))
        })),
        passCount: (outcome.passes ?? []).length,
        incompleteCount: (outcome.incomplete ?? []).length
      };
    },
    [context, options] as const
  );

  const violations = raw.violations as AccessibilityViolation[];

  const counts = Object.fromEntries(
    ACCESSIBILITY_IMPACTS.map(impact => [
      impact,
      violations.filter(violation => violation.impact === impact).length
    ])
  ) as Record<AccessibilityImpact, number>;

  return {
    url: raw.url,
    standards,
    violations,
    passCount: raw.passCount,
    incompleteCount: raw.incompleteCount,
    counts,
    excluded: exclude,
    ignoredRules: ignored,
    engine: { name: 'axe-core', version: raw.version },
    scannedAt: new Date().toISOString()
  };
}

/**
 * Scans, and throws when the result crosses the step's threshold.
 *
 * The threshold is the policy half. `failOn: null` means measure and never fail, which is
 * how a team adopts this on an application that already has findings: the numbers go into
 * the report from day one, and the build starts failing when they choose.
 */
export async function runAccessibilityCheck(
  page: Page,
  descriptor: AccessibilityCheckDescriptor = {}
): Promise<AccessibilityResult> {
  const result = await checkAccessibility(page, descriptor);

  const threshold = descriptor.failOn === null
    ? null
    : descriptor.failOn ?? DEFAULT_ACCESSIBILITY_FAIL_ON;

  if (threshold === null) return result;

  const breaching = result.violations.filter(violation => meetsThreshold(violation.impact, threshold));
  if (breaching.length === 0) return result;

  throw new AccessibilityError(
    `${describeAccessibility(result)} ${breaching.length} at ${threshold} or worse: `
    + `${breaching.slice(0, 5).map(describeViolation).join('; ')}`
    + `${breaching.length > 5 ? `; and ${breaching.length - 5} more` : ''}.`,
    result);
}

/** One violation, with where to find it and where to read about it. */
function describeViolation(violation: AccessibilityViolation): string {
  const where = violation.nodes[0]?.target;
  return `${violation.id} (${violation.impact}) ${violation.help}`
    + `${where ? ` at ${where}` : ''}`
    + `${violation.nodes.length > 1 ? ` and ${violation.nodes.length - 1} other element(s)` : ''}`
    + ` — ${violation.helpUrl}`;
}

/**
 * axe's include/exclude shape.
 *
 * Returns null for "the whole document", which axe accepts as an omitted context. Passing
 * `{include: []}` instead would scan nothing and report a clean result, which is the worst
 * possible failure mode for a check like this.
 */
function buildContext(include: string | undefined, exclude: string[]): object | null {
  const hasInclude = include !== undefined && include.trim().length > 0;
  if (!hasInclude && exclude.length === 0) return null;

  const context: { include?: string[][]; exclude?: string[][] } = {};
  if (hasInclude) context.include = [[include!.trim()]];
  if (exclude.length > 0) context.exclude = exclude.map(selector => [selector]);
  return context;
}

/** Keeps only rule sets axe knows, and never returns an empty list. */
function normaliseStandards(requested: readonly string[] | undefined): string[] {
  const known = new Set<string>(ACCESSIBILITY_STANDARDS);
  const chosen = (requested ?? []).filter(standard => known.has(standard));

  // An unrecognised standard would otherwise scan nothing and report no violations, which
  // reads as a pass. Falling back to the defaults is the safe direction.
  return chosen.length > 0 ? chosen : [...DEFAULT_ACCESSIBILITY_STANDARDS];
}
