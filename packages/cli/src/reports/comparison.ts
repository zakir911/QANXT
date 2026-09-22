/**
 * A run-over-run comparison, as a pull request comment.
 *
 * Separate from the run summary because it answers a different question. A run summary says
 * what is broken; this says what changed. A release decision turns on the second: twelve
 * failing tests are not a reason to stop a release if the same twelve failed last week and
 * somebody already knows why, and one test that used to pass is.
 *
 * So the order is not negotiable — newly failing first, then fixed, then everything already
 * known, collapsed. A comment that opens with thirty still-failing tests buries the one
 * line the reader needed.
 */

/**
 * The wire values, which are camelCase.
 *
 * Spelled exactly as the API emits them, because the only symptom of getting this wrong is
 * a count that reads as zero: `counts.NewlyFailing` on a camelCase payload is `undefined`,
 * `undefined > 0` is false, and a pipeline gated on regressions silently stops gating.
 */
export type TestMovement =
  | 'newlyFailing' | 'fixed' | 'stillFailing' | 'stillPassing' | 'added' | 'removed';

export interface TestComparison {
  testCaseId: string;
  reference: string;
  name: string;
  suite?: string | null;
  movement: TestMovement;
  currentStatus?: string | null;
  previousStatus?: string | null;
  currentDurationMs: number;
  previousDurationMs: number;
  errorMessage?: string | null;
  failureCategory?: string | null;
}

export interface RunSide {
  id: string;
  name: string;
  status: string;
  completedAt?: string | null;
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  healed: number;
  flaky: number;
  durationMs: number;
  commitSha?: string | null;
  branch?: string | null;
  environmentKey?: string | null;
  qualityGatePassed?: boolean | null;
}

export interface RunComparison {
  current: RunSide;
  previous: RunSide;
  tests: TestComparison[];
  counts: Record<TestMovement, number>;
  unchanged: boolean;
  summary: string;
}

export interface ReleaseQualityReport {
  projectId: string;
  projectName: string;
  buildRef: string;
  runCount: number;
  firstRunAt?: string | null;
  lastRunAt?: string | null;
  testsCovered: number;
  passed: number;
  failed: number;
  blocked: number;
  healed: number;
  flaky: number;
  passRatePercent: number;
  outstandingFailures: TestComparison[];
  unstable: TestComparison[];
  breakingContractChanges: number;
  potentiallyBreakingContractChanges: number;
  comparedWith?: string | null;
  comparison?: RunComparison | null;
  summary: string;
}

export function renderComparison(comparison: RunComparison): string {
  const lines: string[] = [];

  lines.push(`#### ${headline(comparison)}`);
  lines.push('');
  lines.push(comparison.summary);
  lines.push('');
  lines.push(`\`${short(comparison.previous)}\` → \`${short(comparison.current)}\``);
  lines.push('');

  // Newly failing is never collapsed. It is the list the decision is made from.
  const newlyFailing = comparison.tests.filter(test => test.movement === 'newlyFailing');
  if (newlyFailing.length > 0) {
    lines.push('**Newly failing**');
    lines.push('');
    for (const test of newlyFailing.slice(0, 20)) {
      lines.push(`- **${test.reference}** ${test.name}`
        + (test.failureCategory ? ` — ${humanise(test.failureCategory)}` : ''));
      if (test.errorMessage) {
        lines.push('  ```');
        lines.push(`  ${test.errorMessage.split('\n')[0]}`);
        lines.push('  ```');
      }
    }
    if (newlyFailing.length > 20) lines.push(`- …and ${newlyFailing.length - 20} more.`);
    lines.push('');
  }

  const fixed = comparison.tests.filter(test => test.movement === 'fixed');
  if (fixed.length > 0) {
    lines.push(`**Fixed** — ${fixed.map(test => test.reference).join(', ')}`);
    lines.push('');
  }

  // Everything already known, behind a fold. It is context, not news.
  collapse(lines, 'Still failing', comparison.tests.filter(t => t.movement === 'stillFailing'));
  collapse(lines, 'Ran that did not run before', comparison.tests.filter(t => t.movement === 'added'));

  const removed = comparison.tests.filter(test => test.movement === 'removed');
  if (removed.length > 0) {
    // Not collapsed: a test that quietly stopped being selected is coverage nobody
    // decided to drop, and it is invisible unless something says so.
    lines.push(`**Ran before, not this time** — ${removed.map(test => test.reference).join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

function headline(comparison: RunComparison): string {
  if (comparison.counts.newlyFailing > 0) {
    return `❌ ${comparison.counts.newlyFailing} test(s) that used to pass now fail`;
  }
  if (comparison.counts.fixed > 0 && comparison.counts.stillFailing === 0) {
    return `✅ ${comparison.counts.fixed} test(s) fixed, nothing newly broken`;
  }
  if (comparison.counts.stillFailing > 0) {
    return `⚠️ Nothing newly broken — ${comparison.counts.stillFailing} still failing`;
  }
  return '✅ Nothing changed, and nothing is failing';
}

function collapse(lines: string[], label: string, tests: TestComparison[]): void {
  if (tests.length === 0) return;
  lines.push(`<details><summary>${label} (${tests.length})</summary>`);
  lines.push('');
  for (const test of tests) lines.push(`- ${test.reference} ${test.name}`);
  lines.push('');
  lines.push('</details>');
  lines.push('');
}

const short = (side: RunSide): string =>
  `${side.name}${side.commitSha ? ` @ ${side.commitSha.slice(0, 8)}` : ''}`;

function humanise(category: string): string {
  const spaced = category.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
