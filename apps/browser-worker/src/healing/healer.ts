import type { Page } from 'playwright';
import type {
  ElementFingerprint, HealingEventReport, HealingSettings, LocatorDescriptor, RankedLocator
} from '@qa-nxt/shared-types';
import { describeLocator } from '@qa-nxt/shared-types';
import { resolveLocator } from '../browser/locator-resolver.js';
import { extractPage, type RawPageCapture } from '../discovery/page-extractor.js';
import type { Logger } from '../util/logger.js';
import { scoreCandidates, toRankedLocators, type ScoredCandidate } from './scorer.js';

/**
 * Recovers from a locator that no longer resolves.
 *
 * Three rules govern everything here, because self-healing is the feature most capable of
 * doing quiet damage:
 *
 *  1. Nothing is healed below the project's confidence threshold, whatever the policy.
 *  2. A heal is only accepted if the action then actually worked — a locator that resolves
 *     to the wrong element is worse than one that resolves to nothing.
 *  3. The stored test is never rewritten here. The worker records a proposal; applying it
 *     is a separate, authorised, audited decision in the control plane.
 */

export interface HealAttempt {
  /** The locator that failed. */
  brokenLocator: LocatorDescriptor;
  fingerprint?: ElementFingerprint;
  testStepId: string;
  timeoutMs: number;
}

export type HealOutcome =
  | { kind: 'healed'; locator: LocatorDescriptor; confidence: number; alternatives: RankedLocator[]; event: HealingEventReport }
  | { kind: 'proposed'; confidence: number; alternatives: RankedLocator[]; event: HealingEventReport }
  | { kind: 'none'; reason: string; alternatives: RankedLocator[] };

export class LocatorHealer {
  constructor(
    private readonly settings: HealingSettings,
    private readonly logger: Logger
  ) {}

  /**
   * Looks for the element the step meant to reach. `verify` is invoked with a candidate
   * locator and must report whether the intended action actually succeeded; a candidate
   * that fails verification is discarded and the next one tried.
   */
  async attempt(
    page: Page,
    attempt: HealAttempt,
    verify: (locator: LocatorDescriptor) => Promise<boolean>
  ): Promise<HealOutcome> {
    if (this.settings.policy === 'never') {
      return { kind: 'none', reason: 'Healing is disabled for this project.', alternatives: [] };
    }

    let capture: RawPageCapture;
    try {
      capture = await page.evaluate(extractPage, 400) as RawPageCapture;
    } catch (error) {
      return {
        kind: 'none',
        reason: `The page could not be inspected for healing candidates: ${String(error)}`,
        alternatives: []
      };
    }

    const scored = scoreCandidates({
      brokenLocator: attempt.brokenLocator,
      fingerprint: attempt.fingerprint,
      candidates: capture.elements
    });

    const alternatives = toRankedLocators(scored);
    if (scored.length === 0) {
      return { kind: 'none', reason: 'No element on the page resembled the original target.', alternatives };
    }

    const best = scored[0]!;
    if (best.score < this.settings.confidenceThreshold) {
      // Deliberately reported rather than used: a low-confidence guess that happens to
      // work is how a test quietly starts asserting the wrong thing.
      const event = this.buildEvent(attempt, best, scored, false, false);
      this.logger.info('Healing candidate found but below the confidence threshold', {
        testStepId: attempt.testStepId,
        confidence: best.score,
        threshold: this.settings.confidenceThreshold
      });
      return { kind: 'proposed', confidence: best.score, alternatives, event };
    }

    if (this.settings.policy === 'suggest') {
      const event = this.buildEvent(attempt, best, scored, false, false);
      this.logger.info('Healing proposal recorded for review', {
        testStepId: attempt.testStepId, confidence: best.score
      });
      return { kind: 'proposed', confidence: best.score, alternatives, event };
    }

    // policy === 'auto': try candidates in order, but only accept one that demonstrably works.
    for (const candidate of scored) {
      if (candidate.score < this.settings.confidenceThreshold) break;

      const resolved = await this.canResolve(page, candidate.descriptor, attempt.timeoutMs);
      if (!resolved) continue;

      const worked = await verify(candidate.descriptor).catch(() => false);
      if (!worked) {
        this.logger.warn('Healing candidate resolved but the action did not achieve its intent; discarding it', {
          testStepId: attempt.testStepId,
          candidate: describeLocator(candidate.descriptor)
        });
        continue;
      }

      const event = this.buildEvent(attempt, candidate, scored, true, true);
      this.logger.info('Healed a broken locator', {
        testStepId: attempt.testStepId,
        from: describeLocator(attempt.brokenLocator),
        to: describeLocator(candidate.descriptor),
        confidence: candidate.score
      });
      return { kind: 'healed', locator: candidate.descriptor, confidence: candidate.score, alternatives, event };
    }

    const event = this.buildEvent(attempt, best, scored, false, false);
    return { kind: 'proposed', confidence: best.score, alternatives, event };
  }

  private async canResolve(page: Page, locator: LocatorDescriptor, timeoutMs: number): Promise<boolean> {
    try {
      await resolveLocator(page, locator, { timeoutMs: Math.min(timeoutMs, 5000) });
      return true;
    } catch {
      return false;
    }
  }

  private buildEvent(
    attempt: HealAttempt,
    chosen: ScoredCandidate,
    all: ScoredCandidate[],
    applied: boolean,
    verified: boolean
  ): HealingEventReport {
    return {
      testStepId: attempt.testStepId,
      originalLocator: attempt.brokenLocator,
      healedLocator: chosen.descriptor,
      reason: explain(attempt.brokenLocator, chosen, all),
      confidence: chosen.score,
      breakdown: chosen.breakdown as Record<string, number>,
      outcomeVerified: verified,
      applied,
      occurredAt: new Date().toISOString()
    };
  }
}

/**
 * Turns a score breakdown into the sentence a reviewer actually needs: what changed, what
 * stayed the same, and how clear-cut the choice was.
 */
function explain(broken: LocatorDescriptor, chosen: ScoredCandidate, all: ScoredCandidate[]): string {
  const strong: string[] = [];
  const weak: string[] = [];

  for (const [signal, points] of Object.entries(chosen.breakdown)) {
    if (signal === 'uniqueness') continue;
    const ratio = points / weightOf(signal);
    if (ratio >= 0.8) strong.push(signal);
    else if (ratio <= 0.2) weak.push(signal);
  }

  const parts: string[] = [
    `${describeLocator(broken)} no longer matched any element.`,
    `The closest candidate is ${describeLocator(chosen.descriptor)} (${chosen.score}% confidence).`
  ];

  if (strong.length > 0) parts.push(`Unchanged: ${strong.join(', ')}.`);
  if (weak.length > 0) parts.push(`Changed: ${weak.join(', ')}.`);

  const runnerUp = all[1];
  if (runnerUp) {
    const margin = chosen.similarity - runnerUp.similarity;
    parts.push(margin >= 15
      ? `The next best candidate scored ${runnerUp.similarity}%, a clear margin of ${margin} points.`
      : `The next best candidate scored ${runnerUp.similarity}%, only ${margin} points behind — review this one carefully.`);
  } else {
    parts.push('No other element came close.');
  }

  return parts.join(' ');
}

function weightOf(signal: string): number {
  const weights: Record<string, number> = {
    testId: 24, role: 16, accessibleName: 20, label: 8, placeholder: 5,
    text: 7, tagName: 4, attributes: 4, ancestry: 6, neighbours: 4, geometry: 2
  };
  return weights[signal] ?? 1;
}
