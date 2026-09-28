import type { ElementFingerprint, LocatorDescriptor, RankedLocator } from '@qa-nxt/shared-types';
import { locatorStability } from '@qa-nxt/shared-types';
import { buildLocatorFor } from '../browser/locator-builder.js';
import type { RawElement } from '../discovery/page-extractor.js';

/**
 * Deterministic locator-similarity scoring.
 *
 * Most real locator breakage is mundane — a renamed button, a moved control, a changed
 * test id — and can be resolved by comparing semantic signals. Doing that arithmetically
 * rather than by asking a model means healing is cheap, reproducible, and explainable:
 * every score comes with the breakdown that produced it, which is what a reviewer needs
 * in order to approve or reject the proposal.
 *
 * A model is consulted only when the top candidates are too close to separate, and even
 * then it adjudicates between candidates this scorer produced — it never invents one.
 */

/** Weights sum to 100. Semantic identity dominates; geometry only breaks ties. */
export const SIGNAL_WEIGHTS = {
  testId: 24,
  role: 16,
  accessibleName: 20,
  label: 8,
  placeholder: 5,
  text: 7,
  tagName: 4,
  attributes: 4,
  ancestry: 6,
  neighbours: 4,
  geometry: 2
} as const;

export type SignalName = keyof typeof SIGNAL_WEIGHTS;
/** Signal contributions, plus the uniqueness adjustment applied to the chosen candidate. */
export type ScoreBreakdown = Partial<Record<SignalName | 'uniqueness', number>>;

export interface ScoredCandidate {
  element: RawElement;
  descriptor: LocatorDescriptor;
  /** Final confidence: signal similarity adjusted for how unambiguous the match is. */
  score: number;
  /** Similarity alone, before the uniqueness adjustment. */
  similarity: number;
  breakdown: ScoreBreakdown;
  stability: number;
}

export interface ScoringInput {
  /** The locator that stopped working. */
  brokenLocator: LocatorDescriptor;
  /** What the element looked like when the step was written, if the platform recorded it. */
  fingerprint?: ElementFingerprint;
  /** Everything currently on the page. */
  candidates: RawElement[];
  /** Candidates below this score are not returned at all. */
  minimumScore?: number;
}

/**
 * Scores every element on the page against what the step was looking for and returns
 * them best first.
 */
export function scoreCandidates(input: ScoringInput): ScoredCandidate[] {
  const target = deriveTarget(input.brokenLocator, input.fingerprint);
  const minimum = input.minimumScore ?? 40;

  const plausible = input.candidates.filter(candidate => isPlausible(candidate, target));

  // A signal only discriminates between candidates if some candidate carries it. When a
  // team strips every data-testid from a page, the target's remembered test id no longer
  // tells us which element is the right one — it tells us the page changed. Counting it as
  // a mismatch would penalise every candidate equally while making the best of them look
  // 24 points worse than it is, which is how a correct heal gets rejected by a threshold.
  const informative = informativeSignals(plausible);

  const scored = plausible
    .map(candidate => scoreOne(candidate, target, informative))
    .filter(candidate => candidate.similarity >= minimum);

  scored.sort((a, b) =>
    b.similarity - a.similarity
    || b.stability - a.stability
    // A stable, repeatable order matters: two runs must produce the same proposal.
    || (a.element.domPath ?? '').localeCompare(b.element.domPath ?? ''));

  return applyUniquenessAdjustment(scored);
}

/**
 * Confidence is not similarity alone. Two questions decide whether a replacement is safe:
 * how much does it resemble the original, and how clearly is it the *only* thing that
 * does? An element that resembles the target 75% and is the sole plausible candidate on
 * the page is a far safer substitution than one that resembles it 75% while three others
 * resemble it 74%.
 *
 * The adjustment is deliberately bounded to +/-12 points, so it can tip a strong match
 * over a threshold or hold an ambiguous one back, but can never manufacture confidence
 * out of a poor resemblance.
 */
const MAX_UNIQUENESS_ADJUSTMENT = 12;

function applyUniquenessAdjustment(scored: ScoredCandidate[]): ScoredCandidate[] {
  if (scored.length === 0) return scored;

  const best = scored[0]!;
  const runnerUp = scored[1];
  let adjustment: number;

  if (!runnerUp) {
    adjustment = MAX_UNIQUENESS_ADJUSTMENT;
  } else {
    const margin = best.similarity - runnerUp.similarity;
    adjustment = margin < 5
      // Two near-identical candidates: the choice between them is close to a coin toss.
      ? -MAX_UNIQUENESS_ADJUSTMENT
      : Math.min(MAX_UNIQUENESS_ADJUSTMENT, Math.round(margin / 4));
  }

  return scored.map((candidate, index) => index === 0
    ? {
        ...candidate,
        score: clamp(candidate.similarity + adjustment),
        breakdown: { ...candidate.breakdown, uniqueness: adjustment }
      }
    // Runners-up are reported at their raw similarity: the adjustment describes the
    // choice that was made, not the ones that were not.
    : { ...candidate, score: candidate.similarity });
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** What we know about the element we are trying to find again. */
interface TargetProfile {
  testId?: string;
  role?: string;
  accessibleName?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  tagName?: string;
  type?: string;
  name?: string;
  elementId?: string;
  domPath?: string;
  parentSignature?: string;
  neighbourText?: string;
  bounding?: { x: number; y: number; width: number; height: number };
  /** Roles the broken locator implies the element can interact as. */
  interactive: boolean;
}

function deriveTarget(locator: LocatorDescriptor, fingerprint?: ElementFingerprint): TargetProfile {
  const profile: TargetProfile = {
    testId: fingerprint?.testId,
    role: fingerprint?.ariaRole,
    accessibleName: fingerprint?.accessibleName,
    label: fingerprint?.label,
    placeholder: fingerprint?.placeholder,
    text: fingerprint?.text,
    tagName: fingerprint?.tagName,
    type: fingerprint?.type,
    name: fingerprint?.name,
    elementId: fingerprint?.elementId,
    domPath: fingerprint?.domPath,
    parentSignature: fingerprint?.parentSignature,
    neighbourText: fingerprint?.neighbourText,
    bounding: fingerprint?.bounding,
    interactive: false
  };

  // The broken locator is itself evidence: "role=button name=Sign in" tells us the target
  // was a button called "Sign in", even with no fingerprint stored.
  switch (locator.strategy) {
    case 'role':
      profile.role ??= locator.value;
      profile.accessibleName ??= locator.name;
      break;
    case 'testId':
      profile.testId ??= locator.value;
      break;
    case 'label':
      profile.label ??= locator.value;
      profile.accessibleName ??= locator.value;
      break;
    case 'placeholder':
      profile.placeholder ??= locator.value;
      break;
    case 'text':
      profile.text ??= locator.value;
      profile.accessibleName ??= locator.value;
      break;
    case 'altText':
    case 'title':
      profile.accessibleName ??= locator.value;
      break;
    default:
      break;
  }

  profile.interactive = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'tab', 'menuitem']
    .includes(profile.role ?? '');

  return profile;
}

/**
 * Cheap rejection before scoring. A candidate that cannot possibly be the target — an
 * invisible element, or a heading where a button is wanted — should not dilute the ranking.
 */
function isPlausible(candidate: RawElement, target: TargetProfile): boolean {
  if (!candidate.isVisible && !candidate.testId) return false;

  if (target.interactive) {
    const candidateInteractive = ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(candidate.tagName)
      || ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'tab', 'menuitem'].includes(candidate.ariaRole ?? '');
    if (!candidateInteractive) return false;
  }

  // An input of a different type is a different control, however similar its label.
  if (target.type && candidate.type && target.type !== candidate.type) {
    const compatible = ['text', 'search', 'email', 'tel', 'url'];
    if (!(compatible.includes(target.type) && compatible.includes(candidate.type))) return false;
  }

  return true;
}

/** Which signals at least one candidate on the page actually carries. */
function informativeSignals(candidates: RawElement[]): Set<SignalName> {
  const signals = new Set<SignalName>();
  // Structural signals are always computable, so they always discriminate.
  signals.add('tagName');
  signals.add('ancestry');
  signals.add('geometry');

  for (const candidate of candidates) {
    if (candidate.testId) signals.add('testId');
    if (candidate.ariaRole) signals.add('role');
    if (candidate.accessibleName) signals.add('accessibleName');
    if (candidate.label) signals.add('label');
    if (candidate.placeholder) signals.add('placeholder');
    if (candidate.text) signals.add('text');
    if (candidate.name || candidate.elementId) signals.add('attributes');
    if (candidate.neighbourText) signals.add('neighbours');
  }

  return signals;
}

function scoreOne(candidate: RawElement, target: TargetProfile, informative: Set<SignalName>): ScoredCandidate {
  const breakdown: ScoreBreakdown = {};
  let total = 0;
  let available = 0;

  const award = (signal: SignalName, similarity: number): void => {
    // Skipped entirely, not scored as zero: an uninformative signal must not move the ratio.
    if (!informative.has(signal)) return;
    const weight = SIGNAL_WEIGHTS[signal];
    available += weight;
    const points = Math.round(weight * similarity);
    if (points !== 0) breakdown[signal] = points;
    total += points;
  };

  if (target.testId !== undefined) {
    award('testId', candidate.testId ? stringSimilarity(target.testId, candidate.testId) : 0);
  }
  if (target.role !== undefined) {
    award('role', candidate.ariaRole === target.role ? 1 : 0);
  }
  if (target.accessibleName !== undefined) {
    award('accessibleName', candidate.accessibleName ? stringSimilarity(target.accessibleName, candidate.accessibleName) : 0);
  }
  if (target.label !== undefined) {
    award('label', candidate.label ? stringSimilarity(target.label, candidate.label) : 0);
  }
  if (target.placeholder !== undefined) {
    award('placeholder', candidate.placeholder ? stringSimilarity(target.placeholder, candidate.placeholder) : 0);
  }
  if (target.text !== undefined) {
    award('text', candidate.text ? stringSimilarity(target.text, candidate.text) : 0);
  }
  if (target.tagName !== undefined) {
    award('tagName', candidate.tagName === target.tagName ? 1 : 0);
  }
  if (target.name !== undefined || target.elementId !== undefined) {
    const nameMatch = target.name && candidate.name ? stringSimilarity(target.name, candidate.name) : 0;
    const idMatch = target.elementId && candidate.elementId ? stringSimilarity(target.elementId, candidate.elementId) : 0;
    award('attributes', Math.max(nameMatch, idMatch));
  }
  if (target.domPath !== undefined) {
    award('ancestry', pathSimilarity(target.domPath, candidate.domPath ?? ''));
  }
  if (target.neighbourText !== undefined) {
    award('neighbours', candidate.neighbourText ? stringSimilarity(target.neighbourText, candidate.neighbourText) : 0);
  }
  if (target.bounding !== undefined) {
    award('geometry', geometrySimilarity(target.bounding, candidate.bounding));
  }

  // Normalise to the signals that were actually available. Scoring against absent
  // evidence would systematically under-rate candidates when little was recorded.
  const similarity = available === 0 ? 0 : Math.max(0, Math.min(100, Math.round((total / available) * 100)));
  const built = buildLocatorFor(candidate);

  return {
    element: candidate,
    descriptor: built.preferred,
    score: similarity,
    similarity,
    breakdown,
    stability: locatorStability(built.preferred)
  };
}

/**
 * Token-aware similarity: "Sign in" vs "Log in" shares a token and is clearly closer than
 * "Sign in" vs "Delete account", while pure edit distance would rank both as distant.
 */
export function stringSimilarity(left: string, right: string): number {
  const a = normalise(left);
  const b = normalise(right);
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.includes(b) || b.includes(a)) return 0.85;

  const tokensA = new Set(a.split(' ').filter(Boolean));
  const tokensB = new Set(b.split(' ').filter(Boolean));
  const shared = [...tokensA].filter(token => tokensB.has(token)).length;
  const jaccard = shared / (tokensA.size + tokensB.size - shared);

  const edit = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  // Weighted towards token overlap: word-level change is the common case in UI copy.
  return Math.max(0, Math.min(1, jaccard * 0.6 + edit * 0.4));
}

/** Longest common suffix of two tag chains, as a fraction of the longer chain. */
export function pathSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = left.split('/').filter(Boolean);
  const b = right.split('/').filter(Boolean);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[a.length - 1 - shared] === b[b.length - 1 - shared]) shared++;
  return shared / Math.max(a.length, b.length);
}

/**
 * Geometric proximity, normalised against a typical viewport. Weak on purpose: an element
 * that merely happens to sit where the old one did is not the same element, but when two
 * candidates are otherwise identical, the one in the same place is the better bet.
 */
export function geometrySimilarity(
  target: { x: number; y: number; width: number; height: number },
  candidate: { x: number; y: number; width: number; height: number }
): number {
  const distance = Math.hypot(target.x - candidate.x, target.y - candidate.y);
  const positional = Math.max(0, 1 - distance / 800);
  const targetArea = Math.max(1, target.width * target.height);
  const candidateArea = Math.max(1, candidate.width * candidate.height);
  const sizeRatio = Math.min(targetArea, candidateArea) / Math.max(targetArea, candidateArea);
  return positional * 0.6 + sizeRatio * 0.4;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/** Projects scored candidates into the shape reported back to the control plane. */
export function toRankedLocators(candidates: ScoredCandidate[], limit = 5): RankedLocator[] {
  return candidates.slice(0, limit).map((candidate, index) => ({
    descriptor: candidate.descriptor,
    score: candidate.score,
    rank: index + 1,
    breakdown: candidate.breakdown as Record<string, number>,
    stability: candidate.stability
  }));
}
